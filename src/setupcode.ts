import { ConnectionConfig } from "./settings";

// A "setup code" packs a whole connection (including the password) into one copy-paste
// string, so a phone can be configured by pasting it instead of retyping everything.
//
// Two formats:
//   WDS1:<base64(json)>            — plain, convenient, but readable by anyone who sees it.
//   WDSX:<base64(salt|iv|cipher)>  — AES-GCM encrypted with a passphrase (PBKDF2-derived key).
//
// Because the code contains a password, the UI nudges toward the encrypted form and warns
// that the plain form is a secret.

const PLAIN_PREFIX = "WDS1:";
const ENC_PREFIX = "WDSX:";
const PBKDF2_ITERATIONS = 150_000;

export function encodeSetupCodePlain(cfg: ConnectionConfig): string {
	const json = JSON.stringify(cfg);
	return PLAIN_PREFIX + bytesToBase64(new TextEncoder().encode(json));
}

export async function encodeSetupCodeEncrypted(
	cfg: ConnectionConfig,
	passphrase: string,
): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveKey(passphrase, salt);
	const plaintext = new TextEncoder().encode(JSON.stringify(cfg));
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(plaintext)),
	);
	const packed = new Uint8Array(salt.length + iv.length + cipher.length);
	packed.set(salt, 0);
	packed.set(iv, salt.length);
	packed.set(cipher, salt.length + iv.length);
	return ENC_PREFIX + bytesToBase64(packed);
}

export function isEncryptedCode(code: string): boolean {
	return code.trim().startsWith(ENC_PREFIX);
}

/**
 * Decode a setup code. Pass the passphrase only for encrypted codes.
 * Throws with a clear message on a bad code or wrong passphrase.
 */
export async function decodeSetupCode(
	code: string,
	passphrase?: string,
): Promise<ConnectionConfig> {
	const trimmed = code.trim();
	if (trimmed.startsWith(PLAIN_PREFIX)) {
		const json = new TextDecoder().decode(base64ToBytes(trimmed.slice(PLAIN_PREFIX.length)));
		return parseConfig(json);
	}
	if (trimmed.startsWith(ENC_PREFIX)) {
		if (!passphrase) throw new Error("This code is encrypted — enter its passphrase.");
		const packed = base64ToBytes(trimmed.slice(ENC_PREFIX.length));
		if (packed.length < 28) throw new Error("Setup code is too short or corrupted.");
		const salt = packed.slice(0, 16);
		const iv = packed.slice(16, 28);
		const cipher = packed.slice(28);
		const key = await deriveKey(passphrase, salt);
		let plain: ArrayBuffer;
		try {
			plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(cipher));
		} catch {
			throw new Error("Wrong passphrase, or the code is corrupted.");
		}
		return parseConfig(new TextDecoder().decode(plain));
	}
	throw new Error("Not a valid setup code (must start with WDS1: or WDSX:).");
}

function parseConfig(json: string): ConnectionConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		throw new Error("Setup code content is not valid.");
	}
	if (typeof raw !== "object" || raw === null) throw new Error("Setup code content is not valid.");
	const o = raw as Record<string, unknown>;
	const host = typeof o.host === "string" ? o.host : "";
	const username = typeof o.username === "string" ? o.username : "";
	const password = typeof o.password === "string" ? o.password : "";
	const remoteBaseDir = typeof o.remoteBaseDir === "string" ? o.remoteBaseDir : "";
	if (!host || !username || !remoteBaseDir) {
		throw new Error("Setup code is missing required connection fields.");
	}
	return {
		host,
		port: typeof o.port === "number" ? o.port : 443,
		useHttps: typeof o.useHttps === "boolean" ? o.useHttps : true,
		username,
		password,
		remoteBaseDir,
	};
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
	const baseKey = await crypto.subtle.importKey(
		"raw",
		bs(new TextEncoder().encode(passphrase)),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: bs(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** WebCrypto wants a plain BufferSource; the generic Uint8Array type needs a nudge. */
function bs(v: Uint8Array): BufferSource {
	return v as unknown as BufferSource;
}

function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
	return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64.trim());
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
