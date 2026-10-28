// `find_image`: lets the tutor show real photos and illustrations from two
// trusted, openly licensed libraries instead of typing image links from memory
// (models invent links that don't exist). The page only displays images from
// these same hosts, so a made-up link can never appear.
//
// - Wikipedia: the freely licensed images in the best-matching article, with
//   the article's captions. Often the best teaching images there are.
// - Wikimedia Commons: freely licensed photos, illustrations and diagrams.
// - Open-i (US National Library of Medicine): clinical images (X-rays, CT,
//   MRI, ultrasound, clinical photos, microscopy) from open-access journals.
// - Google Images, through SerpApi's free plan, once the learner has pasted a
//   SerpApi key in Settings. LILA keeps a copy of each photo it shows and
//   serves it from /photos/, so these photos also can't be invented.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "./engine/conversation.ts";
import { Type } from "typebox";
import { DATA_DIR, loadSettings } from "./config.ts";
import { logPicture } from "./picturelog.ts";

/** Hosts the page will load images from. Keep in sync with web/src/components/Markdown.tsx. */
export const IMAGE_HOSTS = ["upload.wikimedia.org", "openi.nlm.nih.gov"];

/** A shown image's address: from a trusted library, or a web photo LILA keeps a copy of. */
export const IMAGE_URL = /(?:https:\/\/|\/photos\/)[^\s)"]+/g;

const USER_AGENT = "LILA/1.0 (https://github.com/mryeburn/lila)";

/**
 * Some libraries refuse LILA's own requests (Wikipedia and Commons answered
 * 503 and Open-i a web page) yet answer the learner's web browser. Once a
 * library refuses, its searches go through the open page instead.
 */
export type BrowserFetch = (url: string, as: "json" | "image", waitMs: number) => Promise<any>;
let browserFetch: BrowserFetch | undefined;
export function setBrowserFetch(fn: BrowserFetch): void {
	browserFetch = fn;
}
/** Libraries whose requests can go through the page (they allow it), and the ones that refused LILA. */
const BROWSER_HOSTS = ["en.wikipedia.org", "commons.wikimedia.org", "upload.wikimedia.org", "openi.nlm.nih.gov"];
const refused = new Set<string>();

/** Fetches with LILA's own request, or through the page for a library that refused LILA. */
async function viaServerOrBrowser<T>(url: string, as: "json" | "image", waitMs: number, own: () => Promise<T>): Promise<T> {
	const host = new URL(url).host;
	const canUsePage = !!browserFetch && BROWSER_HOSTS.includes(host);
	if (canUsePage && refused.has(host)) return browserFetch!(url, as, waitMs);
	try {
		return await own();
	} catch (err) {
		if (!canUsePage || (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") throw err;
		refused.add(host);
		return browserFetch!(url, as, waitMs);
	}
}
const MAX_RESULTS = 6;
/** Once this long has passed and a few images have arrived, the search stops waiting for slower libraries. */
const ENOUGH_WAIT_MS = 10_000;
/** The longest a search waits for any library. */
const MAX_WAIT_MS = 25_000;
/** How many images count as "a few". */
const ENOUGH_FOUND = 3;

export interface Candidate {
	url: string;
	thumb: string;
	title: string;
	credit: string;
	page: string;
}

export const KINDS = {
	any: "",
	xray: "x",
	ct: "c",
	mri: "m",
	ultrasound: "u",
	photo: "p",
	microscopy: "mc",
	illustration: "g",
} as const;

const Params = Type.Object({
	query: Type.String({ description: "What the image should show, in plain English, e.g. 'tension pneumothorax chest x-ray'." }),
	source: Type.Optional(
		Type.Union([Type.Literal("any"), Type.Literal("wikimedia"), Type.Literal("clinical")], {
			description:
				"'clinical' searches real medical images from journals (NLM Open-i), 'wikimedia' searches Wikimedia Commons, 'any' (default) searches both and Google Images.",
		}),
	),
	kind: Type.Optional(
		Type.Union(
			Object.keys(KINDS).map((k) => Type.Literal(k)),
			{ description: "For clinical searches: the type of image wanted. Default any." },
		),
	),
});

export const IMAGE_GUIDELINES = [
	"Use find_image in nearly every teaching section, wherever there is something real to see: what a finding looks like on an X-ray, a skin lesion, an instrument, an anatomical specimen, a microscope slide, a place, a person, an object, a historical photo. Use your own mermaid/svg drawings for processes, relationships and simple schematics, alongside the photos.",
	"Leave source out (it searches every library) unless you need only clinical images.",
	"Look at the returned images before choosing. Only use one that clearly shows what you will say it shows; if none fits, say nothing about it and draw a diagram instead, or skip the picture.",
	"Embed the chosen image by copying its markdown line from the result exactly (the URL and the credit in quotes). Never type or edit an image URL yourself; images from anywhere else will not be shown.",
	"If none of the results fits, search again with other words (the common name, a synonym, or adding 'photo' or 'clinical photo') before giving up. Never tell the learner you can't show a real photo or suggest they search for one themselves.",
	"Prefer images from trusted sources (the Wikipedia article, Wikimedia Commons, Open-i). Use one marked \"found with Google Images\" only when no trusted image fits, and check its labels and text carefully: copies on ordinary websites can be wrong or blurry.",
	"Give it a short, accurate caption as the alt text, point out what to look at in your text, and don't use more than one or two photos per section.",
];

export function createImageTool(canSeeImages: () => boolean): ToolDefinition<typeof Params> {
	return {
		name: "find_image",
		label: "Image search",
		description:
			"Search for a real photo, scan or illustration to show the learner: images from the matching Wikipedia article, Wikimedia Commons, the US National Library of Medicine's Open-i clinical image collection and, when set up, Google Images. Returns up to six candidates, each with a ready-to-paste markdown line.",
		parameters: Params,

		async execute(_toolCallId, params, signal) {
			const { found: mixed, timing, allFailed } = await searchImagesTimed(params.query, params.source ?? "any", params.kind ?? "any", signal);
			if (mixed.length === 0) {
				const text = allFailed
					? "The picture libraries couldn't be reached just now, so no photo this time. Draw a diagram instead, and don't mention the missing photo."
					: `No images found for "${params.query}". Try simpler or different words, or draw a diagram instead.`;
				return { content: [{ type: "text" as const, text }], details: { query: params.query, count: 0, timing } };
			}

			const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
			const vision = canSeeImages();
			// All the previews at once, not one after another.
			const thumbs = vision ? await fetchThumbs(mixed.map((c) => c.thumb), signal) : [];
			content.push({
				type: "text",
				text: `Found ${mixed.length} image${mixed.length === 1 ? "" : "s"} for "${params.query}".${vision ? " Each is shown below its description; check it really shows what you need." : " You can't see them, so rely on the descriptions and only use one whose description clearly matches."}`,
			});
			for (const [i, c] of mixed.entries()) {
				content.push({
					type: "text",
					text: `\nImage ${i + 1}: ${c.title}\nCredit: ${c.credit}\nMarkdown to embed it: ![SHORT CAPTION](${c.url} "${c.credit.replace(/"/g, "'")}")`,
				});
				const img = thumbs[i];
				if (img) content.push({ type: "image", ...img });
			}
			return { content, details: { query: params.query, count: mixed.length, timing } };
		},
	};
}

/** For the AI choosing a picture: which sources to trust first. */
export const TRUSTED_SOURCES =
	'Prefer trusted sources (Wikipedia, Wikimedia Commons, Open-i). Choose an image "found with Google Images" only when no trusted one fits, and only if its labels and text are clearly correct.';

/**
 * Searches the libraries and returns candidates, trusted sources first:
 * images from the matching Wikipedia article (curated, captioned), then
 * Open-i and Wikimedia Commons search results, taking turns, and Google
 * Images results last (a couple of places are kept for them).
 */
export async function searchImages(
	query: string,
	source: "any" | "wikimedia" | "clinical",
	kindName: string,
	signal?: AbortSignal,
	options: { article?: string; limit?: number } = {},
): Promise<Candidate[]> {
	return (await searchImagesTimed(query, source, kindName, signal, options)).found;
}

/** searchImages, plus how long each library took and what it found ("Commons 1.2s 6"), for the logs. */
export async function searchImagesTimed(
	query: string,
	source: "any" | "wikimedia" | "clinical",
	kindName: string,
	signal?: AbortSignal,
	options: { article?: string; limit?: number } = {},
): Promise<{ found: Candidate[]; timing: string; allFailed: boolean }> {
	const limit = options.limit ?? MAX_RESULTS;
	const kind = KINDS[kindName as keyof typeof KINDS] ?? "";
	const libraries: Record<string, () => Promise<Candidate[]>> = {};
	if (source !== "clinical") libraries.Wikipedia = () => searchWikipedia(options.article || query, signal);
	if (source !== "wikimedia") libraries["Open-i"] = () => searchOpenI(query, kind, signal);
	if (source !== "clinical") libraries.Commons = () => searchCommons(query, signal);
	if (source === "any") libraries.Google = () => searchWeb(query, signal);
	const { results, timing, allFailed } = await gather(libraries);
	const article = results.Wikipedia ?? [];
	const lists = [results["Open-i"] ?? [], results.Commons ?? []];
	const found = results.Google ?? [];
	const mixed: Candidate[] = [];
	const add = (c: Candidate | undefined) => {
		if (c && mixed.length < limit && !mixed.some((m) => m.url === c.url)) mixed.push(c);
	};
	// Trusted first, keeping a couple of places for Google Images when it found any.
	const trustedRoom = found.length > 0 ? limit - Math.min(2, found.length) : limit;
	const trusted: Candidate[] = [];
	const addTrusted = (c: Candidate | undefined) => {
		if (c && trusted.length < trustedRoom && !trusted.some((m) => m.url === c.url)) trusted.push(c);
	};
	// Leave room for at least a couple of search results after the article's images.
	for (const c of article.slice(0, Math.max(1, trustedRoom - 2))) addTrusted(c);
	for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) {
		for (const l of lists) addTrusted(l[i]);
	}
	for (const c of trusted) add(c);
	for (const c of found) add(c);
	logPicture(`find "${query}": ${timing}`);
	return { found: mixed, timing, allFailed };
}

/** Why a search failed, in a few words for the logs ("HTTP 429", "ECONNRESET", "timed out"). */
function whyFailed(err: unknown): string {
	const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
	if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timed out";
	return (e?.cause?.code || e?.cause?.message || e?.message || "unknown").slice(0, 60);
}

/** A search that fails quickly (a dropped connection, a busy server) is tried once more. */
async function retryOnce(search: () => Promise<Candidate[]>): Promise<Candidate[]> {
	const start = Date.now();
	try {
		return await search();
	} catch (err) {
		if (Date.now() - start > 3000 || /timed out|HTTP 4(0[0-4])/.test(whyFailed(err))) throw err;
		await new Promise((r) => setTimeout(r, 800));
		return search();
	}
}

/**
 * Runs the library searches at the same time. Waits for all of them, but no
 * longer than MAX_WAIT_MS, and stops at ENOUGH_WAIT_MS if a few images have
 * already arrived. A library that fails or is still going counts as none.
 */
async function gather(
	libraries: Record<string, () => Promise<Candidate[]>>,
): Promise<{ results: Record<string, Candidate[]>; timing: string; allFailed: boolean }> {
	const start = Date.now();
	const results: Record<string, Candidate[]> = {};
	const took: Record<string, string> = {};
	let total = 0;
	let failed = 0;
	let finish!: () => void;
	const done = new Promise<void>((resolve) => (finish = resolve));
	const names = Object.keys(libraries);
	let left = names.length;
	const settle = () => {
		if (--left === 0) finish();
	};
	for (const name of names) {
		retryOnce(libraries[name])
			.then((found) => {
				results[name] = found;
				total += found.length;
				took[name] = `${((Date.now() - start) / 1000).toFixed(1)}s ${found.length}`;
			})
			.catch((err) => {
				took[name] = `${((Date.now() - start) / 1000).toFixed(1)}s failed (${whyFailed(err)})`;
				failed++;
			})
			.finally(settle);
	}
	if (left === 0) finish();
	const enough = setInterval(() => {
		if (Date.now() - start >= ENOUGH_WAIT_MS && total >= ENOUGH_FOUND) finish();
	}, 250);
	const timer = setTimeout(finish, MAX_WAIT_MS);
	await done;
	clearInterval(enough);
	clearTimeout(timer);
	// Copies, so a library that answers later doesn't change what was used.
	const used: Record<string, Candidate[]> = {};
	for (const name of names) used[name] = results[name] ? [...results[name]] : [];
	const timing = names.map((n) => `${n} ${took[n] ?? "still waiting, left out"}`).join(", ");
	return { results: used, timing, allFailed: names.length > 0 && failed === names.length };
}

// Images in an article that are decoration, not teaching material.
const NOT_TEACHING = /icon|logo|symbol|flag|portal|disambig|question_book|edit-clear|padlock|wiki|commons-|ambox|stub|red_pog|crystal_clear|nuvola|gnome-|speakerlink|sound/i;

/** Images used in the best-matching English Wikipedia article, with their captions. */
export async function searchWikipedia(query: string, signal?: AbortSignal, max = 12): Promise<Candidate[]> {
	const search = new URL("https://en.wikipedia.org/w/api.php");
	search.search = new URLSearchParams({
		action: "query",
		format: "json",
		origin: "*",
		list: "search",
		srsearch: query,
		srnamespace: "0",
		srlimit: "1",
	}).toString();
	const title: string | undefined = (await getJson(search.href, signal))?.query?.search?.[0]?.title;
	if (!title) return [];

	// The media list has the article's own captions. If that service is
	// unavailable, fall back to the plain list of files the article uses.
	const captions = new Map<string, string>();
	const keep = (file: unknown, caption: string) => {
		if (typeof file !== "string" || NOT_TEACHING.test(file) || captions.size >= max) return;
		captions.set(file.replace(/_/g, " "), caption);
	};
	try {
		const media = await getJson(
			`https://en.wikipedia.org/api/rest_v1/page/media-list/${encodeURIComponent(title.replace(/ /g, "_"))}`,
			signal,
		);
		for (const item of media?.items ?? []) {
			if (item?.type === "image") keep(item.title, plain(item.caption?.text ?? item.caption?.html ?? ""));
		}
	} catch {
		const list = new URL("https://en.wikipedia.org/w/api.php");
		list.search = new URLSearchParams({
			action: "query",
			format: "json",
			origin: "*",
			titles: title,
			prop: "images",
			imlimit: "40",
		}).toString();
		const pages = Object.values<any>((await getJson(list.href, signal))?.query?.pages ?? {});
		for (const image of pages[0]?.images ?? []) keep(image.title, "");
	}
	if (captions.size === 0) return [];

	// Only images on Commons are freely licensed; Wikipedia's own uploads may be
	// non-free, and Commons doesn't have them, so they drop out here.
	const found = await commonsImages({ titles: [...captions.keys()].join("|") }, signal);
	const order = [...captions.keys()];
	return found
		.filter((c) => c.width >= 200)
		.sort((x, y) => order.indexOf(x.file) - order.indexOf(y.file))
		.map((c) => {
			const caption = captions.get(c.file);
			return { ...c, title: caption ? `${caption} (from the Wikipedia article "${title}")` : `${c.title} (from the Wikipedia article "${title}")` };
		});
}

export async function getJson(url: string, signal?: AbortSignal, waitMs = 20_000): Promise<any> {
	return viaServerOrBrowser(url, "json", waitMs, async () => {
		const res = await fetch(url, {
			headers: { "user-agent": USER_AGENT, accept: "application/json" },
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(waitMs)]) : AbortSignal.timeout(waitMs),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		if (!/json/.test(res.headers.get("content-type") ?? "")) throw new Error("sent a web page, not results");
		return res.json();
	});
}

export async function searchCommons(query: string, signal?: AbortSignal): Promise<Candidate[]> {
	return (await commonsImages({ generator: "search", gsrnamespace: "6", gsrsearch: query, gsrlimit: "8" }, signal)).slice(
		0,
		MAX_RESULTS,
	);
}

/** Looks up Commons files (by search or by name) with their thumbnails, size and credits. */
async function commonsImages(
	query: Record<string, string>,
	signal?: AbortSignal,
): Promise<Array<Candidate & { file: string; width: number }>> {
	const url = new URL("https://commons.wikimedia.org/w/api.php");
	url.search = new URLSearchParams({
		action: "query",
		format: "json",
		origin: "*",
		...query,
		prop: "imageinfo",
		iiprop: "url|extmetadata|mime|size",
		iiurlwidth: "800",
		iiextmetadatafilter: "LicenseShortName|Artist|ImageDescription|ObjectName",
	}).toString();
	const data = await getJson(url.href, signal);
	const pages = Object.values<any>(data?.query?.pages ?? {}).sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
	const out: Array<Candidate & { file: string; width: number }> = [];
	for (const p of pages) {
		const info = p.imageinfo?.[0];
		if (!info?.thumburl || !/^image\/(jpeg|png|gif|svg\+xml|webp)$/.test(info.mime ?? "")) continue;
		const meta = info.extmetadata ?? {};
		const title = plain(meta.ImageDescription?.value) || plain(meta.ObjectName?.value) || String(p.title ?? "").replace(/^File:/, "");
		const artist = plain(meta.Artist?.value);
		const license = plain(meta.LicenseShortName?.value);
		out.push({
			file: String(p.title ?? ""),
			width: Number(info.width) || 0,
			url: info.thumburl,
			thumb: info.thumburl.replace(/\/\d+px-/, "/400px-"),
			title: title.slice(0, 300),
			credit: [artist, license, "Wikimedia Commons"].filter(Boolean).join(", "),
			page: info.descriptionurl ?? "",
		});
	}
	return out.filter((c) => isAllowedImage(c.url));
}

export async function searchOpenI(query: string, kind: string, signal?: AbortSignal): Promise<Candidate[]> {
	const url = new URL("https://openi.nlm.nih.gov/api/search");
	url.search = new URLSearchParams({ query, m: "1", n: "8", ...(kind ? { it: kind } : {}) }).toString();
	const data = await getJson(url.href, signal);
	const out: Candidate[] = [];
	for (const item of data?.list ?? []) {
		const path = item.imgLarge || item.imgThumbLarge || item.imgThumb;
		if (!path) continue;
		const abs = (p: string) => new URL(p, "https://openi.nlm.nih.gov/").href;
		const caption = plain(item.image?.caption) || plain(item.title);
		const journal = [plain(item.journal_title), item.pub_year].filter(Boolean).join(" ");
		out.push({
			url: abs(path),
			thumb: abs(item.imgThumbLarge || path),
			title: caption.slice(0, 300),
			credit: [journal, "via NLM Open-i"].filter(Boolean).join(", "),
			page: item.pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${item.pmcid}/` : "",
		});
	}
	return out.filter((c) => isAllowedImage(c.url)).slice(0, MAX_RESULTS);
}

/** Previews a few at a time: quicker than one by one, without flooding one site with requests. */
export async function fetchThumbs(urls: string[], signal?: AbortSignal): Promise<Array<{ data: string; mimeType: string } | undefined>> {
	const out: Array<{ data: string; mimeType: string } | undefined> = new Array(urls.length);
	let next = 0;
	const worker = async () => {
		while (next < urls.length) {
			const i = next++;
			out[i] = await fetchThumb(urls[i], signal);
		}
	};
	await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker));
	return out;
}

export async function fetchThumb(url: string, signal?: AbortSignal): Promise<{ data: string; mimeType: string } | undefined> {
	try {
		const thumb: { data: string; mimeType: string } = await viaServerOrBrowser(url, "image", 8_000, async () => {
			const res = await fetch(url, {
				headers: { "user-agent": USER_AGENT },
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType: (res.headers.get("content-type") ?? "").split(";")[0] };
		});
		if (!/^image\/(jpeg|png|gif|webp)$/.test(thumb.mimeType) || thumb.data.length > 2_000_000) return undefined;
		return thumb;
	} catch {
		return undefined;
	}
}

export function isAllowedImage(src: string): boolean {
	if (WEB_PHOTO_PATH.test(src)) return true;
	try {
		const u = new URL(src);
		return u.protocol === "https:" && IMAGE_HOSTS.includes(u.hostname);
	} catch {
		return false;
	}
}

/** Strips HTML from library metadata. */
function plain(html: unknown): string {
	if (typeof html !== "string") return "";
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}

// Google Images through SerpApi. The free plan has 250 searches a month and
// never charges; past that SerpApi refuses, and the search finds nothing.
// Searches are kept for a month, so asking again costs nothing.
const PHOTOS_DIR = path.join(DATA_DIR, "photos");
const WEB_INDEX = path.join(PHOTOS_DIR, "index.json");
const WEB_PHOTO_PATH = /^\/photos\/([a-f0-9]{24})$/;
const SEARCH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PHOTO_BYTES = 8_000_000;

interface WebIndex {
	/** Each photo's id, with the addresses to fetch it from. */
	photos: Record<string, { original: string; thumbnail: string }>;
	/** Recent searches and what they found. */
	searches: Record<string, { at: number; found: Candidate[] }>;
}

let webIndex: WebIndex | undefined;
function index(): WebIndex {
	if (!webIndex) {
		try {
			webIndex = JSON.parse(fs.readFileSync(WEB_INDEX, "utf8")) as WebIndex;
		} catch {
			webIndex = { photos: {}, searches: {} };
		}
	}
	return webIndex;
}
function saveIndex(): void {
	const idx = index();
	const now = Date.now();
	for (const [q, s] of Object.entries(idx.searches)) if (now - s.at > SEARCH_KEEP_MS) delete idx.searches[q];
	fs.mkdirSync(PHOTOS_DIR, { recursive: true });
	fs.writeFileSync(WEB_INDEX, JSON.stringify(idx));
}

/** True once the learner has pasted a SerpApi key in Settings. */
export function webPhotosOn(): boolean {
	return !!loadSettings().photoSearchKey;
}

export async function searchWeb(query: string, signal?: AbortSignal): Promise<Candidate[]> {
	const key = loadSettings().photoSearchKey;
	if (!key) return [];
	const q = query.trim().toLowerCase();
	const kept = index().searches[q];
	if (kept && Date.now() - kept.at < SEARCH_KEEP_MS) return kept.found.filter((c) => !SOCIAL.test(c.credit));

	const url = new URL("https://serpapi.com/search.json");
	url.search = new URLSearchParams({ engine: "google_images", q: query, api_key: key, safe: "active" }).toString();
	// Google Images through SerpApi is the slowest library: give it nearly all of the search's time.
	const data = await getJson(url.href, signal, MAX_WAIT_MS - 1000);
	const out: Candidate[] = [];
	for (const r of data?.images_results ?? []) {
		if (out.length >= MAX_RESULTS) break;
		const original = typeof r.original === "string" && r.original.startsWith("https://") ? r.original : "";
		const thumbnail = typeof r.thumbnail === "string" && r.thumbnail.startsWith("https://") ? r.thumbnail : "";
		if (!original && !thumbnail) continue;
		if (r.is_product || (Number(r.original_width) > 0 && Number(r.original_width) < 200)) continue;
		// Never from social media: anyone can post there, and copies are often wrong or blurry.
		if ([r.link, r.original, r.thumbnail].some((u) => SOCIAL_HOST.test(hostOf(u))) || SOCIAL.test(plain(r.source))) continue;
		const id = createHash("sha256").update(original || thumbnail).digest("hex").slice(0, 24);
		index().photos[id] = { original, thumbnail };
		const site = plain(r.source) || hostOf(r.link) || "the web";
		out.push({
			url: `/photos/${id}`,
			thumb: thumbnail || original,
			title: plain(r.title).slice(0, 300),
			credit: `${site}, found with Google Images`,
			page: typeof r.link === "string" ? r.link : "",
		});
	}
	index().searches[q] = { at: Date.now(), found: out };
	saveIndex();
	return out;
}

/** Social media sites, by name and by web address (including their image servers). */
const SOCIAL = /\b(facebook|instagram|pinterest|twitter|tiktok|reddit|linkedin|threads|tumblr)\b|^x$|^x\.com/i;
const SOCIAL_HOST =
	/(^|\.)(facebook\.com|fb\.com|fbcdn\.net|instagram\.com|cdninstagram\.com|pinterest\.[a-z.]+|pinimg\.com|twitter\.com|x\.com|twimg\.com|tiktok\.com|tiktokcdn\.com|reddit\.com|redd\.it|redditmedia\.com|linkedin\.com|licdn\.com|threads\.net|tumblr\.com)$/i;

function hostOf(link: unknown): string {
	try {
		return new URL(String(link)).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/**
 * The image for a page address like /photos/<id>: LILA's copy, fetched the
 * first time it's shown. Undefined if it isn't one of LILA's web photos.
 */
export async function webPhoto(pathname: string): Promise<{ data: Buffer; mimeType: string } | undefined> {
	const id = WEB_PHOTO_PATH.exec(pathname)?.[1];
	const source = id ? index().photos[id] : undefined;
	if (!id || !source) return undefined;
	const file = path.join(PHOTOS_DIR, id);
	try {
		const kept = JSON.parse(fs.readFileSync(`${file}.json`, "utf8"));
		return { data: fs.readFileSync(file), mimeType: kept.mimeType };
	} catch {
		// Not fetched yet.
	}
	for (const url of [source.original, source.thumbnail]) {
		if (!url) continue;
		try {
			const res = await fetch(url, {
				headers: { "user-agent": "Mozilla/5.0 (compatible; LILA/1.0)", accept: "image/*" },
				signal: AbortSignal.timeout(20_000),
			});
			const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
			if (!res.ok || !/^image\/(jpeg|png|gif|webp)$/.test(mimeType)) continue;
			const data = Buffer.from(await res.arrayBuffer());
			if (data.length === 0 || data.length > MAX_PHOTO_BYTES) continue;
			fs.mkdirSync(PHOTOS_DIR, { recursive: true });
			fs.writeFileSync(file, data);
			fs.writeFileSync(`${file}.json`, JSON.stringify({ mimeType, from: url }));
			return { data, mimeType };
		} catch {
			// Try the next address.
		}
	}
	return undefined;
}
