// Content hashing used for reliable change/conflict detection.
//
// mtime and size are only a fast pre-filter — clocks differ between devices and a file
// can change without changing size. A content hash is the source of truth for "are these
// two versions actually the same bytes?". crypto.subtle is available in both the desktop
// (Electron) and mobile (iOS/Android WebView) runtimes Obsidian ships.

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i] ?? 0;
		hex += b.toString(16).padStart(2, "0");
	}
	return hex;
}
