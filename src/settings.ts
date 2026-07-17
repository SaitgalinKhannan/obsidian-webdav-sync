import { WebDavConfig } from "./webdav/client";

/** Everything the plugin persists. Stored in the vault's plugin data.json. */
export interface WebDavSyncSettings {
	host: string; // IP or domain, no scheme
	port: number;
	useHttps: boolean;
	username: string;
	password: string;
	/** Server-absolute base dir for this vault. Auto-filled on first setup. */
	remoteBaseDir: string;
	/** Human label for this device, used in conflict-copy filenames. */
	deviceName: string;
	syncIntervalMinutes: number; // 0 = off
	syncOnStartup: boolean;
	syncOnFileChange: boolean;
	/** True once a successful primary setup / connect has happened on this device. */
	configured: boolean;
}

export const DEFAULT_SETTINGS: WebDavSyncSettings = {
	host: "",
	port: 443,
	useHttps: true,
	username: "",
	password: "",
	remoteBaseDir: "",
	deviceName: "",
	syncIntervalMinutes: 5,
	syncOnStartup: true,
	syncOnFileChange: true,
	configured: false,
};

/** The subset of settings that make up a connection, shareable across devices. */
export interface ConnectionConfig {
	host: string;
	port: number;
	useHttps: boolean;
	username: string;
	password: string;
	remoteBaseDir: string;
}

export function connectionOf(s: WebDavSyncSettings): ConnectionConfig {
	return {
		host: s.host,
		port: s.port,
		useHttps: s.useHttps,
		username: s.username,
		password: s.password,
		remoteBaseDir: s.remoteBaseDir,
	};
}

export function webDavConfigOf(s: WebDavSyncSettings): WebDavConfig {
	return {
		host: s.host,
		port: s.port,
		useHttps: s.useHttps,
		username: s.username,
		password: s.password,
		baseDir: s.remoteBaseDir,
	};
}

export function hasConnection(s: WebDavSyncSettings): boolean {
	return s.host.trim() !== "" && s.username.trim() !== "" && s.password !== "";
}

/** A safe default base dir derived from the vault name, e.g. "/obsidian/My Notes". */
export function defaultBaseDir(vaultName: string): string {
	const cleaned = vaultName.trim().replace(/^\/+|\/+$/g, "") || "vault";
	return `/obsidian/${cleaned}`;
}

/** A short, friendly device id like "device-7f3a". */
export function generateDeviceName(): string {
	const suffix = Math.random().toString(16).slice(2, 6);
	return `device-${suffix}`;
}
