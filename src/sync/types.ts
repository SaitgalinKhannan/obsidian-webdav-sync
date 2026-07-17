// Shared data shapes for the sync layer.

/** A file that exists on the WebDAV server, described relative to the vault root. */
export interface RemoteEntry {
	/** Vault-relative path, e.g. "notes/idea.md". Never starts with "/". */
	path: string;
	size: number;
	etag: string | null;
	lastModified: number; // epoch ms; 0 when the server did not report it
	isDir: boolean;
}

/**
 * One row of the sync index: the agreed state of a file the last time this device
 * successfully synced it. Used as the common ancestor for three-way change detection,
 * which is what lets us tell "someone edited this" apart from "nothing happened".
 */
export interface IndexEntry {
	size: number;
	mtime: number; // local mtime (ms) at last sync
	hash: string; // sha-256 hex of the content at last sync
	remoteEtag: string | null;
	remoteSize: number;
}

export type SyncIndex = Record<string, IndexEntry>;

export interface SyncSummary {
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: string[];
	errors: string[];
	skipped: number;
}

export function emptySummary(): SyncSummary {
	return {
		uploaded: 0,
		downloaded: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: [],
		errors: [],
		skipped: 0,
	};
}

export function summaryLine(s: SyncSummary): string {
	const parts: string[] = [];
	if (s.uploaded) parts.push(`↑${s.uploaded}`);
	if (s.downloaded) parts.push(`↓${s.downloaded}`);
	if (s.deletedLocal) parts.push(`−local ${s.deletedLocal}`);
	if (s.deletedRemote) parts.push(`−remote ${s.deletedRemote}`);
	if (s.conflicts.length) parts.push(`⚠${s.conflicts.length}`);
	if (s.errors.length) parts.push(`✖${s.errors.length}`);
	if (parts.length === 0) return "up to date";
	return parts.join("  ");
}
