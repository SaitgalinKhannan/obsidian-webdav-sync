import { requestUrl } from "obsidian";
import { parseMultistatus, PropfindEntry } from "./xml";
import { RemoteEntry } from "../sync/types";

export interface WebDavConfig {
	host: string; // IP or domain, no scheme
	port: number;
	useHttps: boolean;
	username: string;
	password: string;
	/** Server-absolute base directory for this vault, e.g. "/obsidian/MyVault". No trailing slash. */
	baseDir: string;
}

export interface ConnectResult {
	ok: boolean;
	status: number;
	message: string;
}

/**
 * A small WebDAV client built on Obsidian's `requestUrl`, which routes through native code
 * and bypasses browser CORS — the reason WebDAV can work from the mobile app at all.
 *
 * Everything here is data-safe by construction: there is no method that overwrites the
 * whole remote in one shot, and directory creation is idempotent. The sync engine decides
 * what to transfer; this class only moves bytes.
 */
export class WebDavClient {
	private readonly origin: string;
	private readonly authHeader: string;
	private readonly baseDir: string;

	constructor(private readonly cfg: WebDavConfig) {
		const scheme = cfg.useHttps ? "https" : "http";
		this.origin = `${scheme}://${cfg.host}:${cfg.port}`;
		this.authHeader = "Basic " + toBase64(`${cfg.username}:${cfg.password}`);
		this.baseDir = trimTrailingSlash(cfg.baseDir);
	}

	// --- URL helpers ---------------------------------------------------------------------

	private encodePath(serverPath: string): string {
		return serverPath
			.split("/")
			.map((seg) => (seg === "" ? "" : encodeURIComponent(seg)))
			.join("/");
	}

	/** Full URL for a vault-relative path (e.g. "notes/a.md"). "" → the base dir itself. */
	private urlFor(vaultRel: string): string {
		const clean = vaultRel.replace(/^\/+/, "");
		const serverPath = clean ? `${this.baseDir}/${clean}` : this.baseDir;
		return this.origin + this.encodePath(serverPath);
	}

	/**
	 * Like [urlFor] but guarantees a trailing slash. Collections MUST be addressed with a
	 * trailing slash: without one, Apache/mod_dav answers PROPFIND/MKCOL with a 301 redirect
	 * to the slash form, and iOS (CFNetwork) drops the Authorization header when following
	 * that redirect — which surfaces as a bogus 401 "wrong password". Desktop/Electron keeps
	 * the header, which is why this only bit mobile.
	 */
	private urlForDir(vaultRel: string): string {
		const u = this.urlFor(vaultRel);
		return u.endsWith("/") ? u : u + "/";
	}

	/** Convert a decoded server path from a PROPFIND href into a vault-relative path. */
	private toVaultRel(serverPath: string): string | null {
		let p = serverPath.replace(/\/+$/, "");
		const base = this.baseDir;
		if (p === base) return "";
		if (p.startsWith(base + "/")) return p.slice(base.length + 1);
		return null; // outside our base dir — ignore
	}

	// --- low-level request ---------------------------------------------------------------

	private async raw(
		method: string,
		url: string,
		body?: string | ArrayBuffer,
		extraHeaders?: Record<string, string>,
	): Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }> {
		const headers: Record<string, string> = {
			Authorization: this.authHeader,
			...(extraHeaders ?? {}),
		};
		const res = await requestUrl({
			url,
			method,
			headers,
			body,
			throw: false,
		});
		return { status: res.status, text: res.text, arrayBuffer: res.arrayBuffer };
	}

	// --- public API ----------------------------------------------------------------------

	/** Verify host/credentials without changing anything on the server. */
	async connect(): Promise<ConnectResult> {
		try {
			const res = await this.raw("PROPFIND", this.urlForDir(""), PROPFIND_BODY, {
				Depth: "0",
				"Content-Type": "application/xml; charset=utf-8",
			});
			if (res.status === 401 || res.status === 403) {
				return { ok: false, status: res.status, message: "Wrong username or password." };
			}
			if (res.status === 405) {
				return { ok: false, status: res.status, message: "Server does not speak WebDAV at this address." };
			}
			// 207 = base dir exists; 404 = base dir not created yet (fine, setup will create it).
			if (res.status === 207 || res.status === 200 || res.status === 404) {
				return { ok: true, status: res.status, message: "Connected." };
			}
			return { ok: false, status: res.status, message: `Unexpected server response (HTTP ${res.status}).` };
		} catch (e) {
			return { ok: false, status: 0, message: `Cannot reach server: ${errText(e)}` };
		}
	}

	/** Create the base dir and every parent, idempotently. */
	async ensureBaseDir(): Promise<void> {
		const segments = this.baseDir.split("/").filter((s) => s.length > 0);
		let acc = "";
		for (const seg of segments) {
			acc += "/" + seg;
			await this.mkcolServerPath(acc);
		}
	}

	/** Create a directory for a vault-relative path (and its parents). "" is the base dir. */
	async ensureDir(vaultRelDir: string): Promise<void> {
		const clean = vaultRelDir.replace(/^\/+|\/+$/g, "");
		if (!clean) {
			await this.ensureBaseDir();
			return;
		}
		await this.ensureBaseDir();
		let acc = this.baseDir;
		for (const seg of clean.split("/")) {
			acc += "/" + seg;
			await this.mkcolServerPath(acc);
		}
	}

	private async mkcolServerPath(serverPath: string): Promise<void> {
		// Trailing slash avoids the 301 redirect that strips auth on iOS (see urlForDir).
		const res = await this.raw("MKCOL", this.origin + this.encodePath(serverPath) + "/");
		// 201 created; 405 already exists; 301/302 some servers redirect an existing dir.
		if (res.status === 201 || res.status === 405 || res.status === 301 || res.status === 302) return;
		if (res.status === 401 || res.status === 403) {
			throw new Error(`Not allowed to create "${serverPath}" (HTTP ${res.status}).`);
		}
		// 409 = a parent is missing; our callers always create parents first, so treat other
		// codes as soft failures the caller can retry, but surface clearly.
		throw new Error(`Could not create directory "${serverPath}" (HTTP ${res.status}).`);
	}

	/** List the immediate children (files and dirs) of a vault-relative directory. */
	async list(vaultRelDir: string): Promise<RemoteEntry[]> {
		const res = await this.raw("PROPFIND", this.urlForDir(vaultRelDir), PROPFIND_BODY, {
			Depth: "1",
			"Content-Type": "application/xml; charset=utf-8",
		});
		if (res.status === 404) return [];
		if (res.status !== 207 && res.status !== 200) {
			throw new Error(`PROPFIND "${vaultRelDir || "/"}" failed (HTTP ${res.status}).`);
		}
		const parsed: PropfindEntry[] = parseMultistatus(res.text);
		const out: RemoteEntry[] = [];
		for (const p of parsed) {
			const rel = this.toVaultRel(p.href);
			if (rel === null) continue;
			if (rel === "" || rel === vaultRelDir.replace(/^\/+|\/+$/g, "")) continue; // the dir itself
			out.push({
				path: rel,
				size: p.size,
				etag: p.etag,
				lastModified: p.lastModified,
				isDir: p.isDir,
			});
		}
		return out;
	}

	/** Fetch metadata for a single remote file, or null if it does not exist. */
	async stat(vaultRel: string): Promise<RemoteEntry | null> {
		const res = await this.raw("PROPFIND", this.urlFor(vaultRel), PROPFIND_BODY, {
			Depth: "0",
			"Content-Type": "application/xml; charset=utf-8",
		});
		if (res.status === 404) return null;
		if (res.status !== 207 && res.status !== 200) {
			throw new Error(`PROPFIND "${vaultRel}" failed (HTTP ${res.status}).`);
		}
		const parsed = parseMultistatus(res.text);
		const target = vaultRel.replace(/^\/+|\/+$/g, "");
		for (const p of parsed) {
			const rel = this.toVaultRel(p.href);
			if (rel === target) {
				return { path: rel, size: p.size, etag: p.etag, lastModified: p.lastModified, isDir: p.isDir };
			}
		}
		const only = parsed[0];
		if (only) {
			return { path: target, size: only.size, etag: only.etag, lastModified: only.lastModified, isDir: only.isDir };
		}
		return null;
	}

	async getBinary(vaultRel: string): Promise<ArrayBuffer> {
		const res = await this.raw("GET", this.urlFor(vaultRel));
		if (res.status !== 200) {
			throw new Error(`Download of "${vaultRel}" failed (HTTP ${res.status}).`);
		}
		return res.arrayBuffer;
	}

	async putBinary(vaultRel: string, data: ArrayBuffer): Promise<void> {
		const res = await this.raw("PUT", this.urlFor(vaultRel), data, {
			"Content-Type": "application/octet-stream",
		});
		if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
			throw new Error(`Upload of "${vaultRel}" failed (HTTP ${res.status}).`);
		}
	}

	async delete(vaultRel: string): Promise<void> {
		const res = await this.raw("DELETE", this.urlFor(vaultRel));
		// 404 = already gone; treat as success so deletes are idempotent.
		if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
			throw new Error(`Delete of "${vaultRel}" failed (HTTP ${res.status}).`);
		}
	}
}

const PROPFIND_BODY =
	`<?xml version="1.0" encoding="utf-8"?>` +
	`<d:propfind xmlns:d="DAV:"><d:prop>` +
	`<d:getcontentlength/><d:getlastmodified/><d:getetag/><d:resourcetype/>` +
	`</d:prop></d:propfind>`;

function trimTrailingSlash(s: string): string {
	return s.replace(/\/+$/, "");
}

function toBase64(s: string): string {
	// btoa needs a binary string; encode UTF-8 first so non-ASCII credentials survive.
	const utf8 = new TextEncoder().encode(s);
	let bin = "";
	for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i] ?? 0);
	return btoa(bin);
}

function errText(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
