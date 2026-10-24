// Turns the learner's own learning materials (uploaded files and web links)
// into plain text the tutor can read. The text goes into the lesson as a user
// message wrapped in a <learning-resource> tag, so it is saved with the lesson
// and the page can show it as a compact attachment instead of the full text.

import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/** About 40k tokens: enough for a long chapter without swamping the tutor. */
const MAX_CHARS = 160_000;
const MAX_DOWNLOAD = 25 * 1024 * 1024;

export interface Material {
	name: string;
	source: "file" | "link";
	text: string;
	truncated: boolean;
}

export class MaterialError extends Error {}

export async function readFile(name: string, data: Buffer): Promise<Material> {
	return finish(name, "file", await toText(name, data, ""));
}

export async function readLink(raw: string): Promise<Material> {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new MaterialError("That doesn't look like a web address. It should start with https://");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new MaterialError("Only web links (http or https) can be added.");
	}
	let res: Response;
	try {
		res = await fetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(30_000),
			headers: { "user-agent": "Mozilla/5.0 (Pi Learn)", accept: "text/html,application/pdf,text/plain,*/*" },
		});
	} catch {
		throw new MaterialError(`Couldn't open ${url.host}. Check the link and your internet connection.`);
	}
	if (!res.ok) throw new MaterialError(`${url.host} answered with an error (${res.status}). The page may need a sign-in.`);
	const data = Buffer.from(await res.arrayBuffer());
	if (data.length > MAX_DOWNLOAD) throw new MaterialError("That page is too large to read.");
	const type = res.headers.get("content-type") ?? "";
	const text = await toText(url.pathname, data, type);
	const title = type.includes("html") ? htmlTitle(data.toString("utf8")) : undefined;
	return finish(title ? `${title} (${url.host})` : url.href, "link", text);
}

/** The message the tutor receives. */
export function asMessage(m: Material): string {
	const attrs = `name="${escapeAttr(m.name)}" source="${m.source}" chars="${m.text.length}"${m.truncated ? ' truncated="yes"' : ""}`;
	const cut = m.truncated ? "\n\n[The rest of this resource was cut off because it is very long.]" : "";
	return `<learning-resource ${attrs}>\n${m.text}${cut}\n</learning-resource>\n\nI've added this learning resource for our lesson.`;
}

/** Recognizes a learning-resource message, for showing it compactly. */
export function parseMessage(text: string): { name: string; source: string; chars: number; truncated: boolean } | undefined {
	const m = /^<learning-resource name="([^"]*)" source="(\w+)" chars="(\d+)"( truncated="yes")?>/.exec(text);
	if (!m) return undefined;
	return { name: unescapeAttr(m[1]), source: m[2], chars: Number(m[3]), truncated: !!m[4] };
}

async function toText(name: string, data: Buffer, contentType: string): Promise<string> {
	const ext = name.toLowerCase().split(".").pop() ?? "";
	if (contentType.includes("pdf") || ext === "pdf" || data.subarray(0, 5).toString() === "%PDF-") {
		let pdf;
		try {
			pdf = await getDocumentProxy(new Uint8Array(data));
		} catch {
			throw new MaterialError("That PDF couldn't be opened. It may be damaged or password-protected.");
		}
		const { totalPages, text } = await extractText(pdf, { mergePages: true });
		if (text.replace(/\s/g, "").length < 40 * Math.min(totalPages, 5)) {
			throw new MaterialError(
				"This PDF seems to be scanned pages (pictures of text), which Pi Learn can't read yet. A PDF with selectable text will work.",
			);
		}
		return text;
	}
	if (ext === "docx" || contentType.includes("officedocument.wordprocessingml")) {
		try {
			return (await mammoth.extractRawText({ buffer: data })).value;
		} catch {
			throw new MaterialError("That Word document couldn't be opened.");
		}
	}
	if (ext === "doc") throw new MaterialError("Old .doc files can't be read. Save it as .docx or PDF and try again.");
	const str = data.toString("utf8");
	if (contentType.includes("html") || ext === "html" || ext === "htm" || /^\s*<(!doctype|html)/i.test(str)) {
		return htmlToText(str);
	}
	if (str.includes("\u0000")) {
		throw new MaterialError("That kind of file can't be read. PDF, Word (.docx), text and web pages work.");
	}
	return str;
}

function finish(name: string, source: Material["source"], raw: string): Material {
	const text = raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	if (!text) throw new MaterialError("No readable text was found in that resource.");
	const truncated = text.length > MAX_CHARS;
	return { name, source, text: truncated ? text.slice(0, MAX_CHARS) : text, truncated };
}

function htmlTitle(html: string): string | undefined {
	const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
	return t ? decodeEntities(t).replace(/\s+/g, " ").trim().slice(0, 120) || undefined : undefined;
}

function htmlToText(html: string): string {
	// Prefer the main article when the page marks one.
	const main = /<(main|article)[\s>][\s\S]*?<\/\1>/i.exec(html)?.[0] ?? html;
	const text = main
		.replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s>][\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\s*\/?>/gi, "\n")
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<[^>]+>/g, " ");
	return decodeEntities(text)
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.join("\n");
}

function decodeEntities(s: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
	return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => {
		if (e[0] === "#") {
			const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : all;
		}
		return named[e.toLowerCase()] ?? all;
	});
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, " ");
}

function unescapeAttr(s: string): string {
	return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
