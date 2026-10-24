// Makes sure lessons have pictures. Asking the tutor to draw more wasn't
// enough: models drift back to plain text. So the app
// asks the same AI, in separate small requests whose only job is the picture,
// for one image for a stretch of the lesson, and shows it under that part.
//
// Real images come first. When a lesson starts, the app gathers a library of
// real images for its topic: the pictures in the main Wikipedia article and in
// a few related ones, plus Wikimedia Commons and Open-i search results. For
// each picture the app also runs one search aimed at that part of the lesson,
// and the AI picks from both. Only when nothing relates does it draw a diagram
// or chart, and never twice in a row while real images remain. Every step is
// written to the picture log (server/picturelog.ts).

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Context, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import {
	type Candidate,
	fetchThumb,
	KINDS,
	searchCommons,
	searchImages,
	searchOpenI,
	searchWikipedia,
} from "./images.ts";
import { logPicture } from "./picturelog.ts";

export interface IllustrateRequest {
	/** The lesson's title, for context. */
	topic: string;
	/** The part of the lesson to illustrate. */
	content: string;
	/** "section": teaching text. "explanation": an answered quiz question and why its answer is right. */
	purpose: "section" | "explanation";
	/** True when the learner asked for a picture; otherwise the AI may decline when none would help. */
	required: boolean;
	/** Pictures already shown for this part, so a second one is different. */
	shown?: string[];
	/** Set when the previous diagram couldn't be drawn. */
	retryAfterBroken?: boolean;
	/** Real images gathered for this lesson's topic. */
	library?: Candidate[];
	/** Image addresses already used in this lesson, so each appears once. */
	used?: string[];
	/** The lesson's last picture was drawn, so a real image is strongly preferred. */
	lastWasDrawing?: boolean;
	/** Names this picture in the log. */
	label?: string;
}

const GATHER = `You collect real teaching images for a lesson in a medical learning app. Learners are doctors and medical students.

Name the English Wikipedia articles most likely to contain good teaching images for this lesson: the main article for the topic first, then 3 to 5 closely related ones (anatomy, physiology, investigations, signs, treatments). For glaucoma, for example: Glaucoma, Optic disc, Aqueous humour, Gonioscopy, Visual field test, Trabecular meshwork. Then give 2 to 4 short Wikimedia Commons search phrases for images the articles may lack (clinical photos, scans, histology).

Reply with only these lines:
ARTICLE: <exact article title>
SEARCH: <search words>`;

/** Gathers real images for a lesson's topic. Never throws; may return none. */
export async function buildLibrary(
	runtime: ModelRuntime,
	model: Model<Api>,
	topic: string,
	start: string,
	signal?: AbortSignal,
): Promise<Candidate[]> {
	try {
		const reply = await ask(runtime, model, GATHER, `Lesson topic: ${topic}\n\nHow the lesson began:\n${start.slice(0, 4000)}`, signal);
		const lines = (name: string) =>
			[...reply.matchAll(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "gim"))].map((m) => m[1].replace(/^"|"$/g, ""));
		const articles = lines("ARTICLE").slice(0, 6);
		const searches = lines("SEARCH").slice(0, 4);
		if (articles.length === 0) articles.push(topic);
		const found = await Promise.all([
			...articles.map((a) => searchWikipedia(a, signal, 10).catch(() => [])),
			...searches.map((q) => searchCommons(q, signal).catch(() => [])),
			searchOpenI(topic, "", signal).catch(() => []),
		]);
		const library: Candidate[] = [];
		for (const c of found.flat()) {
			if (library.length < 48 && !library.some((l) => l.url === c.url)) library.push(c);
		}
		logPicture(
			`library for "${topic}": ${library.length} images from articles [${articles.join("; ")}] and searches [${searches.join("; ")}]; per source: ${found.map((f) => f.length).join(", ")}`,
		);
		return library;
	} catch (err) {
		logPicture(`library for "${topic}" failed: ${(err as Error).message}`);
		return [];
	}
}

const KIND_NAMES = Object.keys(KINDS).join(", ");

const FIND = `You find one real image for a lesson in a medical learning app: a professional illustration, labelled diagram, chart, X-ray or scan, clinical photo, or micrograph. Learners are doctors and medical students.

Reply with exactly these three lines and nothing else:
ARTICLE: <the English Wikipedia article most likely to contain a good image for this part, e.g. "Renin-angiotensin system">
SEARCH: <3 to 6 plain search words for the image itself, e.g. "renin angiotensin aldosterone diagram" or "tension pneumothorax chest x-ray">
KIND: <one of: ${KIND_NAMES}>

If you were told a picture is optional and no image would genuinely help, reply NONE instead.`;

const DRAW = `You draw one picture for a lesson in a medical learning app. Learners are doctors and medical students, so it must be accurate and clinically sound.

Reply with exactly one of these, and nothing else:
1. A diagram in a \`\`\`mermaid code block: flowchart, decision tree, timeline or sequence diagram.
2. A chart in a \`\`\`mermaid code block: \`xychart-beta\` (line or bar) or \`pie\`. Prefer a chart whenever the text involves numbers that change with something (time, dose, age, severity) or proportions. Use only numbers stated in the text or well-established values; label axes with units.
3. A labelled drawing in a \`\`\`svg code block: schematics, anatomy sketches, curves, waveforms. Use a viewBox no larger than 640x400, font-size 14 or more, and colors that read on white and dark backgrounds.

After it, add one line: CAPTION: <a short caption>.

Rules:
- One picture that supports the text: the key mechanism, pathway, decision, comparison or trend. A few nodes, short labels.
- Make diagrams clear and attractive: group related nodes with mermaid classDef colors (for example classDef cause fill:#fee2e2,stroke:#dc2626; classDef effect fill:#dcfce7,stroke:#16a34a; classDef drug fill:#e0e7ff,stroke:#4f46e5), and use subgraphs for stages.
- Double-check every label, number and arrow.
- Never give away the answer to a question the learner hasn't answered yet.
- Make diagrams tall rather than wide so the text stays readable: top to bottom (flowchart TD), no more than 4 boxes side by side, and labels of a few words.
- Mermaid: put labels with spaces or symbols in double quotes, like A["Na+ influx"]. Don't use parentheses, colons or semicolons in unquoted labels. Use plain hyphens and ASCII arrows.`;

export interface IllustrateResult {
	markdown?: string;
	error?: string;
}

/** Asks the AI for one picture. Never throws. */
export async function illustrate(
	runtime: ModelRuntime,
	model: Model<Api>,
	req: IllustrateRequest,
	signal?: AbortSignal,
): Promise<IllustrateResult> {
	const log = (message: string) => logPicture(`${req.label ?? "picture"}: ${message}`);
	try {
		// A broken diagram is redrawn rather than searched for again.
		if (!req.retryAfterBroken) {
			const plan = parseFind(await ask(runtime, model, FIND, describe(req), signal));
			if (plan === "none" && !req.required) {
				log("the AI said no picture would help here");
				return {};
			}
			const image = await pickImage(runtime, model, req, plan === "none" ? undefined : plan, log, signal);
			if (image) return { markdown: image };
		}
		const drawing = parseDrawing(await ask(runtime, model, DRAW, `${describe(req)}\n\nDraw it yourself.`, signal));
		if (drawing) {
			log(`drew a ${/^```svg/.test(drawing) ? "picture" : /xychart|pie/.test(drawing) ? "chart" : "diagram"}`);
			return { markdown: drawing };
		}
		log("no picture: the drawing reply couldn't be used");
		return { error: "The AI didn't make a picture this time." };
	} catch (err) {
		log(`failed: ${(err as Error).message}`);
		return { error: (err as Error).message || "The picture request failed." };
	}
}

function describe(req: IllustrateRequest): string {
	const lines = [
		`Lesson topic: ${req.topic || "(not named yet)"}`,
		"",
		req.purpose === "section"
			? "Make a picture for this part of the lesson:"
			: "Make a picture for this answered quiz question that helps explain why the answer is right:",
		"<lesson-part>",
		req.content.slice(0, 12000),
		"</lesson-part>",
		"",
		req.required ? "The learner asked for a picture, so make one (not NONE)." : "A picture is optional here; reply NONE if none would genuinely help.",
	];
	if (req.shown?.length) {
		lines.push("", "Already shown for this part (make something different):", ...req.shown.map((s) => s.slice(0, 1500)));
	}
	if (req.retryAfterBroken) lines.push("", "Your previous diagram for this part had a syntax error. Use simple, safe syntax.");
	return lines.join("\n");
}

interface Find {
	article: string;
	search: string;
	kind: string;
}

function parseFind(reply: string): Find | "none" | undefined {
	if (/^\s*NONE\b/i.test(reply)) return "none";
	const line = (name: string) => new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "im").exec(reply)?.[1]?.replace(/^"|"$/g, "");
	const search = line("SEARCH");
	const article = line("ARTICLE") ?? "";
	if (!search && !article) return undefined;
	const kind = line("KIND")?.toLowerCase() ?? "any";
	return { article, search: search || article, kind: kind in KINDS ? kind : "any" };
}

function parseDrawing(reply: string): string | undefined {
	const block = /```(mermaid|svg)[^\n]*\n([\s\S]*?)```/.exec(reply);
	if (!block) return undefined;
	const code = block[2].trim();
	if (block[1] === "svg" && !/<svg[\s>]/.test(code)) return undefined;
	const caption = /^\s*CAPTION:\s*(.+)$/im.exec(reply)?.[1]?.trim();
	return `\`\`\`${block[1]}\n${code}\n\`\`\`${caption ? `\n\n*${caption}*` : ""}`;
}

async function pickImage(
	runtime: ModelRuntime,
	model: Model<Api>,
	req: IllustrateRequest,
	find: Find | undefined,
	log: (message: string) => void,
	signal?: AbortSignal,
): Promise<string | undefined> {
	// One search aimed at this part of the lesson, plus the lesson's library.
	let aimed: Candidate[] = [];
	if (find) {
		const options = { article: find.article, limit: 8 };
		aimed = await searchImages(find.search, "any", find.kind, signal, options);
		if (aimed.length === 0 && find.kind !== "any") aimed = await searchImages(find.search, "any", "any", signal, options);
	}
	const taken = new Set([...(req.used ?? []), ...(req.shown ?? []).flatMap((s) => s.match(/https:\/\/[^\s)"]+/g) ?? [])]);
	const pool: Candidate[] = [];
	for (const c of [...aimed, ...(req.library ?? [])]) {
		if (!taken.has(c.url) && !pool.some((p) => p.url === c.url)) pool.push(c);
	}
	const searched = find ? `searched "${find.search}" (article "${find.article}", ${find.kind}): ${aimed.length} found` : "no search";
	if (pool.length === 0) {
		log(`${searched}; library ${req.library?.length ?? 0}; nothing unused to choose from`);
		return undefined;
	}

	// First narrow the pool down from the descriptions alone, then (when the
	// AI can see images) look at the shortlist before choosing.
	const leniency = req.lastWasDrawing
		? "The last picture in this lesson was a drawing, so pick a real image unless none of them is about this topic at all."
		: "It doesn't have to show exactly the same detail as the text, as long as it is accurate and helps the learner picture this part of the topic.";
	const list = pool.map((c, i) => `${i + 1}. ${c.title.slice(0, 220)} [${c.credit.slice(0, 60)}]`).join("\n");
	const shortReply = await ask(
		runtime,
		model,
		"You pick real images for a medical learning app. Real images (photos, scans, professional illustrations) are much better for learners than drawn flowcharts.",
		`${describe({ ...req, shown: undefined })}\n\nImages available:\n${list}\n\nWhich images would best illustrate this part of the lesson? ${leniency}\nReply with up to 3 numbers, best first, like: 7, 2, 15\nReply 0 only if none of them relates to this part.`,
		signal,
	);
	const shortlist = [...new Set((shortReply.match(/\d+/g) ?? []).map(Number))]
		.map((n) => pool[n - 1])
		.filter((c): c is Candidate => !!c)
		.slice(0, 3);
	if (shortlist.length === 0) {
		log(`${searched}; library ${req.library?.length ?? 0}; pool ${pool.length}; the AI found none relevant`);
		return undefined;
	}

	const vision = model.input?.includes("image") ?? false;
	const content: (TextContent | ImageContent)[] = [
		{
			type: "text",
			text: `${describe({ ...req, shown: undefined })}\n\nThese images were shortlisted.${
				vision ? " Each is shown after its description." : " You can't see them, so go by the descriptions."
			} Choose the one that best illustrates this part of the lesson. ${leniency}\n\nReply with only: <number> | <short, accurate caption that says what to look at>\nReply 0 if none is accurate and relevant.`,
		},
	];
	for (const [i, c] of shortlist.entries()) {
		content.push({ type: "text", text: `\nImage ${i + 1}: ${c.title}\nSource: ${c.credit}` });
		if (vision) {
			const img = await fetchThumb(c.thumb, signal);
			if (img) content.push({ type: "image", ...img });
		}
	}
	const reply = await ask(runtime, model, "You pick real images for a medical learning app.", content, signal);
	const m = /^\s*(\d+)\s*(?:\|\s*(.+))?$/m.exec(reply);
	const chosen = m ? shortlist[Number(m[1]) - 1] : undefined;
	if (!chosen) {
		log(`${searched}; pool ${pool.length}; shortlisted ${shortlist.length} but rejected them after looking`);
		return undefined;
	}
	log(`${searched}; pool ${pool.length}; chose "${chosen.title.slice(0, 80)}" (${chosen.credit.slice(0, 60)})`);
	const caption = (m?.[2] ?? chosen.title).replace(/[[\]]/g, "").trim().slice(0, 200);
	return `![${caption}](${chosen.url} "${chosen.credit.replace(/"/g, "'")}")`;
}

async function ask(
	runtime: ModelRuntime,
	model: Model<Api>,
	systemPrompt: string,
	content: string | (TextContent | ImageContent)[],
	signal?: AbortSignal,
): Promise<string> {
	const context: Context = { systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] };
	const reply = await runtime.completeSimple(model, context, { signal });
	if (reply.stopReason === "error" || reply.stopReason === "aborted") {
		throw new Error(reply.errorMessage || "The picture request failed.");
	}
	return reply.content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("");
}
