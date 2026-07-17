import { App } from "obsidian";
import { LocalFile, LocalFs, LocalStat } from "./sync/engine";

/**
 * [LocalFs] over Obsidian's vault. We go through the low-level `adapter` (not the Vault
 * cache) for reads/writes so that files we download are written straight to disk; Obsidian's
 * file watcher then folds them into its own index. `getFiles()` gives us notes and
 * attachments while naturally excluding the hidden `.obsidian` config (which holds this
 * plugin's own password and volatile workspace state — never sync that).
 */
export class VaultFs implements LocalFs {
	constructor(private readonly app: App) {}

	private get adapter() {
		return this.app.vault.adapter;
	}

	async listFiles(): Promise<LocalFile[]> {
		return this.app.vault.getFiles().map((f) => ({
			path: f.path,
			mtime: f.stat.mtime,
			size: f.stat.size,
		}));
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
