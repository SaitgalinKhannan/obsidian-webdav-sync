import { WebDavClient } from "../webdav/client";
import { sha256Hex } from "./hash";
import {
	IndexEntry,
	RemoteEntry,
	SyncIndex,
	SyncSummary,
	emptySummary,
} from "./types";

/** Local filesystem abstraction (implemented over Obsidian's vault in main.ts). */
export interface LocalStat {
	mtime: number;
	size: number;
}
export interface LocalFile extends LocalStat {
	path: string;
}
export interface LocalFs {
	listFiles(): Promise<LocalFile[]>;
	stat(path: string): Promise<LocalStat | null>;
	read(path: string): Promise<ArrayBuffer>;
	write(path: string, data: ArrayBuffer): Promise<void>;
	remove(path: string): Promise<void>;
}

export interface EngineOptions {
	deviceName: string;
	/** Move remote deletions into a recoverable trash folder instead of deleting outright. */
	serverTrash: boolean;
	/** Called with a short progress note so the UI can show what's happening. */
	onProgress?: (note: string) => void;
}

/** Server-side trash folder (relative to the vault's base dir). Excluded from the sync walk. */
const TRASH_DIR = ".webdav-trash";

export interface SyncOutcome {
	summary: SyncSummary;
	index: SyncIndex;
}

/**
 * Two-way sync with a stored index as the common ancestor (three-way merge of file
 * *existence and content*, not line-level text). The guiding rule is: never lose a byte.
 * When two sides changed the same file differently, we keep both — the local version stays
 * canonical and the remote version is written next to it as a "(conflict …)" copy on every
 * device. Deletions are only propagated when the other side did not also change the file.
 */
export class SyncEngine {
	private readonly ensuredRemoteDirs = new Set<string>();

	constructor(
		private readonly client: WebDavClient,
		private readonly local: LocalFs,
		private readonly opts: EngineOptions,
	) {}

	async sync(previousIndex: SyncIndex): Promise<SyncOutcome> {
		const summary = emptySummary();
		this.ensuredRemoteDirs.clear();

		this.progress("Preparing remote folder…");
		await this.client.ensureBaseDir();

		this.progress("Scanning local files…");
		const localList = await this.local.listFiles();
		const localMap = new Map<string, LocalFile>();
		for (const f of localList) localMap.set(f.path, f);

		this.progress("Scanning remote files…");
		const remoteMap = await this.walkRemote();

		const index = previousIndex;
		const nextIndex: SyncIndex = {};

		const allPaths = new Set<string>();
		for (const p of localMap.keys()) allPaths.add(p);
		for (const p of remoteMap.keys()) allPaths.add(p);
		for (const p of Object.keys(index)) allPaths.add(p);

		for (const path of allPaths) {
			const lf = localMap.get(path) ?? null;
			const rf = remoteMap.get(path) ?? null;
			const li = index[path] ?? null;
			try {
				const kept = await this.reconcile(path, lf, rf, li, summary, nextIndex);
				if (!kept && li) {
					// reconcile decided the entry no longer exists on either side.
				}
			} catch (e) {
				summary.errors.push(`${path}: ${errText(e)}`);
				// Preserve the previous index row so we retry next run instead of thrashing.
				if (li) nextIndex[path] = li;
			}
		}

		return { summary, index: nextIndex };
	}

	// --- per-file reconciliation ---------------------------------------------------------

	/** Returns true if an index row was written for this path. */
	private async reconcile(
		path: string,
		lf: LocalFile | null,
		rf: RemoteEntry | null,
		li: IndexEntry | null,
		summary: SyncSummary,
		nextIndex: SyncIndex,
	): Promise<boolean> {
		const localPresent = lf !== null;
		const remotePresent = rf !== null && !rf.isDir;

		// Both gone -> drop from index.
		if (!localPresent && !remotePresent) return false;

		// Only local -> new local file or resurrected after remote delete.
		if (localPresent && !remotePresent) {
			if (li && !(await this.localChanged(path, lf!, li))) {
				// Was synced before, unchanged locally, and vanished remotely => remote deleted it.
				this.progress(`Deleting local ${path}`);
				await this.local.remove(path);
				summary.deletedLocal++;
				return false;
			}
			// New, or changed locally after a remote delete: (re)upload and keep.
			await this.upload(path, lf!, summary);
			nextIndex[path] = await this.freshIndex(path, lf!);
			return true;
		}

		// Only remote -> new remote file or resurrected after local delete.
		if (!localPresent && remotePresent) {
			if (li && !this.remoteChanged(rf!, li)) {
				// Synced before, unchanged remotely, gone locally => local deleted it.
				this.progress(`Deleting remote ${path}`);
				await this.removeRemote(path);
				summary.deletedRemote++;
				return false;
			}
			// New remotely, or changed remotely after a local delete: download and keep.
			await this.download(path, summary);
			const stat = await this.local.stat(path);
			nextIndex[path] = await this.indexFromDisk(path, stat, rf!);
			return true;
		}

		// Present on both sides.
		const lChanged = li ? await this.localChanged(path, lf!, li) : true;
		const rChanged = li ? this.remoteChanged(rf!, li) : true;

		if (li && !lChanged && !rChanged) {
			nextIndex[path] = li; // untouched
			summary.skipped++;
			return true;
		}
		if (lChanged && !rChanged) {
			await this.upload(path, lf!, summary);
			nextIndex[path] = await this.freshIndex(path, lf!);
			return true;
		}
		if (!lChanged && rChanged) {
			await this.download(path, summary);
			const stat = await this.local.stat(path);
			nextIndex[path] = await this.indexFromDisk(path, stat, rf!);
			return true;
		}

		// Both changed (or first-ever sight of a file on both sides): resolve safely.
		return this.resolveConflict(path, lf!, rf!, summary, nextIndex);
	}

	/**
	 * Both sides diverged. If the bytes are actually identical, just adopt. Otherwise keep
	 * the local file as canonical and save the remote version as a conflict copy — on every
	 * device — so nothing is ever lost and all devices converge to the same file set.
	 */
	private async resolveConflict(
		path: string,
		lf: LocalFile,
		rf: RemoteEntry,
		summary: SyncSummary,
		nextIndex: SyncIndex,
	): Promise<boolean> {
		const localBytes = await this.local.read(path);
		const remoteBytes = await this.client.getBinary(path);
		const localHash = await sha256Hex(localBytes);
		const remoteHash = await sha256Hex(remoteBytes);

		if (localHash === remoteHash) {
			// Same content — no real conflict. Push local up to normalize, adopt into index.
			nextIndex[path] = await this.freshIndex(path, lf, localHash);
			summary.skipped++;
			return true;
		}

		this.progress(`Conflict on ${path} — keeping both`);
		// 1) local stays canonical: make sure the server has our version.
		await this.ensureRemoteParent(path);
		await this.client.putBinary(path, localBytes);
		nextIndex[path] = await this.freshIndex(path, lf, localHash);

		// 2) remote version is preserved as a conflict copy, mirrored to both sides.
		const copyPath = conflictName(path, this.opts.deviceName);
		await this.local.write(copyPath, remoteBytes);
		await this.ensureRemoteParent(copyPath);
		await this.client.putBinary(copyPath, remoteBytes);
		const copyStat = await this.local.stat(copyPath);
		nextIndex[copyPath] = await this.indexFromBytes(copyPath, copyStat, remoteBytes, remoteHash);

		summary.conflicts.push(path);
		return true;
	}

	// --- transfers -----------------------------------------------------------------------

	private async upload(path: string, lf: LocalFile, summary: SyncSummary): Promise<void> {
		this.progress(`Uploading ${path}`);
		const bytes = await this.local.read(path);
		await this.ensureRemoteParent(path);
		await this.client.putBinary(path, bytes);
		summary.uploaded++;
	}

	private async download(path: string, summary: SyncSummary): Promise<void> {
		this.progress(`Downloading ${path}`);
		const bytes = await this.client.getBinary(path);
		await this.local.write(path, bytes);
		summary.downloaded++;
	}

	/**
	 * Remove a file from the server. With server trash on, the file is copied into
	 * [TRASH_DIR] first and only deleted once that copy succeeds — so a failed backup never
	 * costs you the file. With it off, it's a plain delete.
	 */
	private async removeRemote(path: string): Promise<void> {
		if (this.opts.serverTrash) {
			let bytes: ArrayBuffer;
			try {
				bytes = await this.client.getBinary(path);
			} catch {
				return; // already gone on the server — nothing to trash or delete
			}
			const trashPath = `${TRASH_DIR}/${path}.${trashStamp()}`;
			await this.ensureRemoteParent(trashPath);
			await this.client.putBinary(trashPath, bytes); // if this throws, the delete below is skipped
		}
		await this.client.delete(path);
	}

	private async ensureRemoteParent(path: string): Promise<void> {
		const idx = path.lastIndexOf("/");
		if (idx <= 0) return;
		const dir = path.slice(0, idx);
		if (this.ensuredRemoteDirs.has(dir)) return;
		await this.client.ensureDir(dir);
		this.ensuredRemoteDirs.add(dir);
	}

	// --- change detection ----------------------------------------------------------------

	private async localChanged(path: string, lf: LocalFile, li: IndexEntry): Promise<boolean> {
		// Fast path: same size and mtime as last sync => assume unchanged.
		if (lf.size === li.size && lf.mtime === li.mtime) return false;
		if (lf.size !== li.size) return true;
		// Size matches but mtime differs — confirm with a content hash to avoid needless uploads.
		const hash = await sha256Hex(await this.local.read(path));
		return hash !== li.hash;
	}

	private remoteChanged(rf: RemoteEntry, li: IndexEntry): boolean {
		if (li.remoteEtag && rf.etag) return rf.etag !== li.remoteEtag;
		// No usable etag on one side — fall back to size (best-effort for etag-less servers).
		return rf.size !== li.remoteSize;
	}

	// --- index construction --------------------------------------------------------------

	/** Build an index row after we uploaded local content (re-stat remote for a fresh etag). */
	private async freshIndex(path: string, lf: LocalFile, knownHash?: string): Promise<IndexEntry> {
		const hash = knownHash ?? (await sha256Hex(await this.local.read(path)));
		const remote = await this.client.stat(path);
		return {
			size: lf.size,
			mtime: lf.mtime,
			hash,
			remoteEtag: remote?.etag ?? null,
			remoteSize: remote?.size ?? lf.size,
		};
	}

	/** Build an index row after we wrote downloaded content to disk. */
	private async indexFromDisk(
		path: string,
		stat: LocalStat | null,
		rf: RemoteEntry,
	): Promise<IndexEntry> {
		const bytes = await this.local.read(path);
		const hash = await sha256Hex(bytes);
		return {
			size: stat?.size ?? bytes.byteLength,
			mtime: stat?.mtime ?? Date.now(),
			hash,
			remoteEtag: rf.etag,
			remoteSize: rf.size,
		};
	}

	private async indexFromBytes(
		path: string,
		stat: LocalStat | null,
		bytes: ArrayBuffer,
		hash: string,
	): Promise<IndexEntry> {
		const remote = await this.client.stat(path);
		return {
			size: stat?.size ?? bytes.byteLength,
			mtime: stat?.mtime ?? Date.now(),
			hash,
			remoteEtag: remote?.etag ?? null,
			remoteSize: remote?.size ?? bytes.byteLength,
		};
	}

	// --- remote walk ---------------------------------------------------------------------

	private async walkRemote(): Promise<Map<string, RemoteEntry>> {
		const files = new Map<string, RemoteEntry>();
		const visited = new Set<string>();
		const queue: string[] = [""];
		while (queue.length > 0) {
			const dir = queue.shift()!;
			if (visited.has(dir)) continue;
			visited.add(dir);
			const entries = await this.client.list(dir);
			for (const e of entries) {
				// Never surface the trash folder as syncable content.
				if (e.path === TRASH_DIR || e.path.startsWith(TRASH_DIR + "/")) continue;
				if (e.isDir) {
					if (!visited.has(e.path)) queue.push(e.path);
				} else {
					files.set(e.path, e);
				}
			}
		}
		return files;
	}

	private progress(note: string): void {
		this.opts.onProgress?.(note);
	}
}

/** Insert a "(conflict <device> <timestamp>)" marker before the file extension. */
export function conflictName(path: string, device: string): string {
	const now = new Date();
	const ts =
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
		`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const marker = ` (conflict ${device} ${ts})`;
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return `${dir}${name}${marker}`;
	return `${dir}${name.slice(0, dot)}${marker}${name.slice(dot)}`;
}

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

/** Filesystem-safe timestamp used to make trashed copies unique. */
function trashStamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function errText(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
