// Minimal WebDAV multistatus (PROPFIND) parser.
//
// We use the runtime's DOMParser (present on desktop and mobile) and match elements by
// their namespace-local name in the "DAV:" namespace, so it works regardless of whether a
// given server uses the "d:", "D:", or "lp1:" prefix.

const DAV_NS = "DAV:";

export interface PropfindEntry {
	/** Decoded absolute path on the server, e.g. "/obsidian/MyVault/notes/idea.md". */
	href: string;
	size: number;
	etag: string | null;
	lastModified: number; // epoch ms; 0 if absent/unparseable
	isDir: boolean;
}

function firstChildText(parent: Element, local: string): string | null {
	const els = parent.getElementsByTagNameNS(DAV_NS, local);
	const el = els.item(0);
	return el ? (el.textContent ?? "").trim() : null;
}

function decodeHref(href: string): string {
	// Servers may return either an absolute URL or an absolute path, URL-encoded.
	let path = href;
	try {
		// Resolve against a dummy origin so both "http://h/x" and "/x" normalize to a path.
		path = new URL(href, "http://placeholder.invalid").pathname;
	} catch {
		// Keep the raw href if URL parsing fails.
	}
	try {
		path = decodeURIComponent(path);
	} catch {
		// Leave as-is on malformed encoding.
	}
	return path;
}

export function parseMultistatus(xml: string): PropfindEntry[] {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	const responses = doc.getElementsByTagNameNS(DAV_NS, "response");
	const out: PropfindEntry[] = [];

	for (let i = 0; i < responses.length; i++) {
		const resp = responses.item(i);
		if (!resp) continue;

		const rawHref = firstChildText(resp, "href");
		if (!rawHref) continue;
		const href = decodeHref(rawHref);

		const resourceType = resp.getElementsByTagNameNS(DAV_NS, "resourcetype").item(0);
		const isDir = !!resourceType &&
			resourceType.getElementsByTagNameNS(DAV_NS, "collection").length > 0;

		const lenText = firstChildText(resp, "getcontentlength");
		const size = lenText ? Number.parseInt(lenText, 10) || 0 : 0;

		let etag = firstChildText(resp, "getetag");
		if (etag === "") etag = null;

		const modText = firstChildText(resp, "getlastmodified");
		let lastModified = 0;
		if (modText) {
			const parsed = Date.parse(modText);
			if (!Number.isNaN(parsed)) lastModified = parsed;
		}

		out.push({ href, size, etag, lastModified, isDir });
	}

	return out;
}
