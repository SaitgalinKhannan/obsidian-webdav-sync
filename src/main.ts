import { Notice, Plugin, TAbstractFile, debounce } from "obsidian";
import {
	DEFAULT_SETTINGS,
	WebDavSyncSettings,
	ConnectionConfig,
	connectionOf,
	hasConnection,
	webDavConfigOf,
	defaultBaseDir,
	generateDeviceName,
} from "./settings";
import { SyncIndex, summaryLine } from "./sync/types";
import { SyncEngine } from "./sync/engine";
import { VaultFs } from "./vaultFs";
import { WebDavClient, ConnectResult } from "./webdav/client";
import { WebDavSettingTab } from "./settingsTab";

type StatusState = "idle" | "syncing" | "ok" | "conflict" | "error";

interface PersistedData {
	settings: WebDavSyncSettings;
	index: SyncIndex;
}

export default class WebDavSyncPlugin extends Plugin {
	settings: WebDavSyncSettings = { ...DEFAULT_SETTINGS };
	private index: SyncIndex = {};

	private readonly local = new VaultFs(this.app);
	private statusEl: HTMLElement | null = null;
	private syncing = false;
	private intervalId: number | null = null;
	private scheduleSoon: () => void = () => {};

	async onload(): Promise<void> {
		await this.loadAll();

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("wds-status");
		this.setStatus("idle", "WebDAV");
		this.statusEl.onClickEvent(() => this.runSync("manual"));

		this.addSettingTab(new WebDavSettingTab(this.app, this));

		this.addCommand({
			id: "webdav-sync-now",
			name: "Sync now",
			callback: () => this.runSync("manual"),
		});

		// Debounced auto-sync on local edits (fires 12s after the last change settles).
		this.scheduleSoon = debounce(() => {
			if (this.settings.syncOnFileChange && !this.syncing) this.runSync("file-change");
		}, 12_000, false);

		this.registerFileWatchers();
		this.applyAutoSyncInterval();

		if (this.settings.syncOnStartup && hasConnection(this.settings)) {
			this.app.workspace.onLayoutReady(() => this.runSync("startup"));
		}
	}

	onunload(): void {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
	}

	// --- persistence ---------------------------------------------------------------------

	private async loadAll(): Promise<void> {
		const raw = (await this.loadData()) as Partial<PersistedData> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) };
		this.index = raw?.index ?? {};
		if (!this.settings.deviceName) this.settings.deviceName = generateDeviceName();
		if (!this.settings.remoteBaseDir) {
			this.settings.remoteBaseDir = defaultBaseDir(this.app.vault.getName());
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ settings: this.settings, index: this.index });
		this.applyAutoSyncInterval();
	}

	private async saveIndex(): Promise<void> {
		await this.saveData({ settings: this.settings, index: this.index });
	}

	// --- connection helpers used by the settings tab -------------------------------------

	newClient(): WebDavClient {
		return new WebDavClient(webDavConfigOf(this.settings));
	}

	async testConnection(): Promise<ConnectResult> {
		if (!hasConnection(this.settings)) {
			return { ok: false, status: 0, message: "Fill in host, username and password first." };
		}
		return this.newClient().connect();
	}

	/** First-time setup on this device: verify, create the remote folder, do a full sync. */
	async runInitialSetup(): Promise<boolean> {
		const check = await this.testConnection();
		if (!check.ok) {
			new Notice(`WebDAV Sync: ${check.message}`);
			return false;
		}
		try {
			await this.newClient().ensureBaseDir();
		} catch (e) {
			new Notice(`WebDAV Sync: cannot create remote folder — ${errText(e)}`);
			return false;
		}
		this.settings.configured = true;
		await this.saveSettings();
		await this.runSync("setup");
		return true;
	}

	/**
	 * Lightweight "just connect" for a second device: verify the credentials and sync.
	 * No explicit folder creation / "setup" step — the vault already lives on the server,
	 * so this device only needs to connect and pull it down.
	 */
	async connectAndSync(): Promise<boolean> {
		const check = await this.testConnection();
		if (!check.ok) {
			new Notice(`WebDAV Sync: ${check.message}`);
			return false;
		}
		this.settings.configured = true;
		await this.saveSettings();
		await this.runSync("connect");
		return true;
	}

	/** Apply a connection pasted from another device, then just connect + sync here. */
	async applyConnection(cfg: ConnectionConfig): Promise<boolean> {
		this.settings.host = cfg.host;
		this.settings.port = cfg.port;
		this.settings.useHttps = cfg.useHttps;
		this.settings.username = cfg.username;
		this.settings.password = cfg.password;
		this.settings.remoteBaseDir = cfg.remoteBaseDir;
		await this.saveSettings();
		return this.connectAndSync();
	}

	currentConnection(): ConnectionConfig {
		return connectionOf(this.settings);
	}

	// --- sync orchestration --------------------------------------------------------------

	async runSync(reason: string): Promise<void> {
		if (this.syncing) return;
		if (!hasConnection(this.settings)) {
			new Notice("WebDAV Sync: set up a connection in settings first.");
			return;
		}
		this.syncing = true;
		this.setStatus("syncing", "syncing…");
		try {
			const engine = new SyncEngine(this.newClient(), this.local, {
				deviceName: this.settings.deviceName,
				onProgress: (note) => this.setStatus("syncing", note),
			});
			const outcome = await engine.sync(this.index);
			this.index = outcome.index;

			const line = summaryLine(outcome.summary);
			if (outcome.summary.errors.length > 0) {
				await this.recordSync("error", line);
				this.setStatus("error", line);
				new Notice(
					`WebDAV Sync: finished with ${outcome.summary.errors.length} error(s).\n` +
						outcome.summary.errors.slice(0, 5).join("\n"),
					10_000,
				);
			} else if (outcome.summary.conflicts.length > 0) {
				await this.recordSync("conflict", line);
				this.setStatus("conflict", line);
				new Notice(
					`WebDAV Sync: ${outcome.summary.conflicts.length} conflict(s) kept as copies — nothing lost:\n` +
						outcome.summary.conflicts.slice(0, 5).join("\n"),
					10_000,
				);
			} else {
				await this.recordSync("ok", line);
				this.setStatus("ok", line);
			}
		} catch (e) {
			await this.recordSync("error", errText(e));
			this.setStatus("error", "error");
			new Notice(`WebDAV Sync error: ${errText(e)}`, 10_000);
		} finally {
			this.syncing = false;
		}
	}

	/** Persist the outcome of a sync so the settings status card can show it. */
	private async recordSync(state: "ok" | "conflict" | "error", text: string): Promise<void> {
		this.settings.lastSyncAt = Date.now();
		this.settings.lastSyncState = state;
		this.settings.lastSyncText = text;
		await this.saveIndex();
	}

	// --- side effects --------------------------------------------------------------------

	private registerFileWatchers(): void {
		const onChange = (_file: TAbstractFile) => this.scheduleSoon();
		this.registerEvent(this.app.vault.on("modify", onChange));
		this.registerEvent(this.app.vault.on("create", onChange));
		this.registerEvent(this.app.vault.on("delete", onChange));
		this.registerEvent(this.app.vault.on("rename", onChange));
	}

	applyAutoSyncInterval(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		const minutes = this.settings.syncIntervalMinutes;
		if (minutes > 0 && hasConnection(this.settings)) {
			this.intervalId = window.setInterval(() => {
				if (!this.syncing) this.runSync("interval");
			}, minutes * 60_000);
			this.registerInterval(this.intervalId);
		}
	}

	private setStatus(state: StatusState, text: string): void {
		const el = this.statusEl;
		if (!el) return;
		el.removeClass("wds-idle", "wds-syncing", "wds-ok", "wds-conflict", "wds-error");
		el.addClass(`wds-${state}`);
		const short = text.length > 40 ? text.slice(0, 39) + "…" : text;
		el.setText(`⟳ ${short}`);
	}
}

function errText(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
