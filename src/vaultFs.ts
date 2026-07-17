import { App } from "obsidian";
import { LocalFile, LocalFs, LocalStat } from "./sync/engine";

/**
 * Paths under .obsidian that must never sync even when config sync is on:
 *  - workspace state is per-device and changes constantly (endless conflicts),
 *  - this plugin's own folder holds the WebDAV password in data.json and updates every sync.
 */
const EXCLUDED_CONFIG = [
	".obsidian/workspace.json",
	".obsidian/workspace-mobile.json",
	".obsidian/workspace",
	".obsidian/cache",
	".obsidian/plugins/khannan-webdav-sync",
];

function isExcludedConfig(path: string): boolean {
	return EXCLUDED_CONFIG.some((e) => path === e || path.startsWith(e + "/"));
}

/**
 * [LocalFs] over Obsidian's vault. We go through the low-level `adapter` (not the Vault
 * cache) for reads/writes so that files we download are written straight to disk; Obsidian's
 * file watcher then folds them into its own index. `getFiles()` gives us notes and
 * attachments while naturally excluding the hidden `.obsidian` config (which holds this
 * plugin's own password and volatile workspace state — never sync that).
 */
export class VaultFs implements LocalFs {
	constructor(
		private readonly app: App,
		/** Whether to also include the .obsidian config folder in the file list. */
		private readonly includeConfig: () => boolean,
	) {}

	private get adapter() {
		return this.app.vault.adapter;
	}

	async listFiles(): Promise<LocalFile[]> {
		const files: LocalFile[] = this.app.vault.getFiles().map((f) => ({
			path: f.path,
			mtime: f.stat.mtime,
			size: f.stat.size,
		}));
		if (this.includeConfig()) {
			files.push(...(await this.listConfigFiles()));
		}
		return files;
	}

	/**
	 * Enumerate files under `.obsidian` (which `getFiles()` deliberately hides). Volatile,
	 * device-specific, and secret-bearing paths are always excluded — in particular this
	 * plugin's own data.json, which holds the WebDAV password and changes on every sync.
	 */
	private async listConfigFiles(): Promise<LocalFile[]> {
		const root = ".obsidian";
		if (!(await this.adapter.exists(root))) return [];
		const out: LocalFile[] = [];
		const stack: string[] = [root];
		while (stack.length > 0) {
			const dir = stack.pop();
			if (dir === undefined) break;
			let listed;
			try {
				listed = await this.adapter.list(dir);
			} catch {
				continue; // unreadable folder — skip rather than fail the whole sync
			}
			for (const f of listed.files) {
				if (isExcludedConfig(f)) continue;
				const st = await this.adapter.stat(f);
				if (st && st.type === "file") out.push({ path: f, mtime: st.mtime, size: st.size });
			}
			for (const d of listed.folders) {
				if (isExcludedConfig(d)) continue;
				stack.push(d);
			}
		}
		return out;
	}

	async stat(path: string): Promise<LocalStat | null> {
		const s = await this.adapter.stat(path);
		if (!s || s.type !== "file") return null;
		return { mtime: s.mtime, size: s.size };
	}

	async read(path: string): Promise<ArrayBuffer> {
		return this.adapter.readBinary(path);
	}

	async write(path: string, data: ArrayBuffer): Promise<void> {
		await this.ensureParent(path);
		await this.adapter.writeBinary(path, data);
	}

	async remove(path: string): Promise<void> {
		if (await this.adapter.exists(path)) {
			await this.adapter.remove(path);
		}
	}

	private async ensureParent(path: string): Promise<void> {
		const idx = path.lastIndexOf("/");
		if (idx <= 0) return;
		await this.mkdirp(path.slice(0, idx));
	}

	private async mkdirp(dir: string): Promise<void> {
		if (!dir || dir === "/") return;
		if (await this.adapter.exists(dir)) return;
		const parentIdx = dir.lastIndexOf("/");
		if (parentIdx > 0) await this.mkdirp(dir.slice(0, parentIdx));
		if (!(await this.adapter.exists(dir))) {
			try {
				await this.adapter.mkdir(dir);
			} catch {
				// Ignore races where a concurrent op created the folder first.
			}
		}
	}
}
