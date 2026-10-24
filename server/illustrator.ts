// Makes sure lessons have pictures. Asking the tutor to draw more wasn't
// enough: the teaching method tells it to draw rarely, and it does. So the app
// asks the same AI, in separate small requests whose only job is the picture,
// for one image for a stretch of the lesson, and shows it under that part.
//
// Real images come first: the AI names the Wikipedia article and search words
// most likely to find a good one, the app searches the libraries, and the AI
// picks the best candidate. Only when none fits does it draw a diagram or chart.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Context, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { type Candidate, fetchThumb, KINDS, searchImages } from "./images.ts";

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
	try {
		// A broken diagram is redrawn rather than searched for again.
		if (!req.retryAfterBroken) {
			const plan = parseFind(await ask(runtime, model, FIND, describe(req), signal));
			if (plan === "none" && !req.required) return {};
			if (plan && plan !== "none") {
				const image = await pickImage(runtime, model, req, plan, signal);
				if (image) return { markdown: image };
			}
		}
		const drawing = parseDrawing(await ask(runtime, model, DRAW, `${describe(req)}\n\nDraw it yourself.`, signal));
		if (drawing) return { markdown: drawing };
		return { error: "The AI didn't make a picture this time." };
	} catch (err) {
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
	find: Find,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const options = { article: find.article, limit: 8 };
	let candidates: Candidate[] = await searchImages(find.search, "any", find.kind, signal, options);
	if (candidates.length === 0 && find.kind !== "any") {
		candidates = await searchImages(find.search, "any", "any", signal, options);
	}
	candidates = candidates.filter((c) => !req.shown?.some((s) => s.includes(c.url)));
	if (candidates.length === 0) return undefined;

	const vision = model.input?.includes("image") ?? false;
	const content: (TextContent | ImageContent)[] = [
		{
			type: "text",
			text: `${describe({ ...req, shown: undefined })}\n\nThese images were found.${
				vision ? " Each is shown after its description." : " You can't see them, so go by the descriptions."
			} Choose the one that best shows what this part of the lesson is about: it must be accurate and clearly relevant. Prefer clear, labelled, good-quality images.\n\nReply with only: <number> | <short, accurate caption>\nReply 0 if none clearly fits.`,
		},
	];
	for (const [i, c] of candidates.entries()) {
		content.push({ type: "text", text: `\nImage ${i + 1}: ${c.title}\nSource: ${c.credit}` });
		if (vision) {
			const img = await fetchThumb(c.thumb, signal);
			if (img) content.push({ type: "image", ...img });
		}
	}
	const reply = await ask(
		runtime,
		model,
		"You pick pictures for a medical learning app. Only pick an image that fits; it's fine to reply 0.",
		content,
		signal,
	);
	const m = /^\s*(\d+)\s*(?:\|\s*(.+))?$/m.exec(reply);
	const chosen = m ? candidates[Number(m[1]) - 1] : undefined;
	if (!chosen) return undefined;
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
