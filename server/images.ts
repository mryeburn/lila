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

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Hosts the page will load images from. Keep in sync with web/src/components/Markdown.tsx. */
export const IMAGE_HOSTS = ["upload.wikimedia.org", "openi.nlm.nih.gov"];

const USER_AGENT = "PiLearn/1.0 (https://github.com/mryeburn/pi-learn-userfriendlyinterface)";
const MAX_RESULTS = 4;

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
				"'clinical' searches real medical images from journals (NLM Open-i), 'wikimedia' searches Wikimedia Commons, 'any' (default) searches both.",
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
	"Use find_image when a real photo or scan would genuinely help: what a finding looks like on an X-ray, a skin lesion, an instrument, an anatomical specimen, a microscope slide. Prefer your own mermaid/svg drawings for processes, relationships and simple schematics.",
	"Look at the returned images before choosing. Only use one that clearly shows what you will say it shows; if none fits, say nothing about it and draw a diagram instead, or skip the picture.",
	"Embed the chosen image by copying its markdown line from the result exactly (the URL and the credit in quotes). Never type or edit an image URL yourself; images from anywhere else will not be shown.",
	"Give it a short, accurate caption as the alt text, point out what to look at in your text, and don't use more than one or two photos per section.",
];

export function createImageTool(canSeeImages: () => boolean): ToolDefinition<typeof Params> {
	return {
		name: "find_image",
		label: "Image search",
		description:
			"Search trusted, openly licensed image libraries (images from the matching Wikipedia article; Wikimedia Commons; the US National Library of Medicine's Open-i clinical image collection) for a real photo, scan or illustration to show the learner. Returns up to four candidates, each with a ready-to-paste markdown line.",
		promptSnippet: "Use find_image to find a real photo, scan or illustration from a trusted library to show the learner.",
		promptGuidelines: IMAGE_GUIDELINES,
		parameters: Params,

		async execute(_toolCallId, params, signal) {
			const mixed = await searchImages(params.query, params.source ?? "any", params.kind ?? "any", signal);
			if (mixed.length === 0) {
				const text = `No images found for "${params.query}". Try simpler or different words, or draw a diagram instead.`;
				return { content: [{ type: "text" as const, text }], details: { query: params.query, count: 0 } };
			}

			const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
			const vision = canSeeImages();
			content.push({
				type: "text",
				text: `Found ${mixed.length} image${mixed.length === 1 ? "" : "s"} for "${params.query}".${vision ? " Each is shown below its description; check it really shows what you need." : " You can't see them, so rely on the descriptions and only use one whose description clearly matches."}`,
			});
			for (const [i, c] of mixed.entries()) {
				content.push({
					type: "text",
					text: `\nImage ${i + 1}: ${c.title}\nCredit: ${c.credit}\nMarkdown to embed it: ![SHORT CAPTION](${c.url} "${c.credit.replace(/"/g, "'")}")`,
				});
				if (vision) {
					const img = await fetchThumb(c.thumb, signal);
					if (img) content.push({ type: "image", ...img });
				}
			}
			return { content, details: { query: params.query, count: mixed.length } };
		},
	};
}

/**
 * Searches the libraries and returns candidates, best sources first:
 * images from the matching Wikipedia article (curated, captioned), then
 * Wikimedia Commons and Open-i search results, taking turns.
 */
export async function searchImages(
	query: string,
	source: "any" | "wikimedia" | "clinical",
	kindName: string,
	signal?: AbortSignal,
	options: { article?: string; limit?: number } = {},
): Promise<Candidate[]> {
	const limit = options.limit ?? MAX_RESULTS;
	const kind = KINDS[kindName as keyof typeof KINDS] ?? "";
	const wikipedia =
		source !== "clinical" ? searchWikipedia(options.article || query, signal).catch(() => []) : Promise.resolve([]);
	const searches: Promise<Candidate[]>[] = [];
	if (source !== "wikimedia") searches.push(searchOpenI(query, kind, signal).catch(() => []));
	if (source !== "clinical") searches.push(searchCommons(query, signal).catch(() => []));
	const [article, [a = [], b = []]] = await Promise.all([wikipedia, Promise.all(searches)]);
	const mixed: Candidate[] = [];
	const add = (c: Candidate | undefined) => {
		if (c && mixed.length < limit && !mixed.some((m) => m.url === c.url)) mixed.push(c);
	};
	// Leave room for at least a couple of search results after the article's images.
	for (const c of article.slice(0, Math.max(1, limit - 2))) add(c);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		add(a[i]);
		add(b[i]);
	}
	return mixed;
}

// Images in an article that are decoration, not teaching material.
const NOT_TEACHING = /icon|logo|symbol|flag|portal|disambig|question_book|edit-clear|padlock|wiki|commons-|ambox|stub|red_pog|crystal_clear|nuvola|gnome-|speakerlink|sound/i;

/** Images used in the best-matching English Wikipedia article, with their captions. */
async function searchWikipedia(query: string, signal?: AbortSignal): Promise<Candidate[]> {
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
		if (typeof file !== "string" || NOT_TEACHING.test(file) || captions.size >= 12) return;
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

async function getJson(url: string, signal?: AbortSignal): Promise<any> {
	const res = await fetch(url, {
		headers: { "user-agent": USER_AGENT, accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function searchCommons(query: string, signal?: AbortSignal): Promise<Candidate[]> {
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

async function searchOpenI(query: string, kind: string, signal?: AbortSignal): Promise<Candidate[]> {
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

export async function fetchThumb(url: string, signal?: AbortSignal): Promise<{ data: string; mimeType: string } | undefined> {
	try {
		const res = await fetch(url, {
			headers: { "user-agent": USER_AGENT },
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
		});
		const mimeType = (res.headers.get("content-type") ?? "").split(";")[0];
		if (!res.ok || !/^image\/(jpeg|png|gif|webp)$/.test(mimeType)) return undefined;
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > 1_500_000) return undefined;
		return { data: buf.toString("base64"), mimeType };
	} catch {
		return undefined;
	}
}

export function isAllowedImage(src: string): boolean {
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
