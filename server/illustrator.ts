// Makes sure lessons have pictures. Asking the tutor to draw more wasn't
// enough: the teaching method tells it to draw rarely, and it does. So the app
// asks the same AI, in a separate small request whose only job is the picture,
// for one diagram, chart or library photo for a stretch of the lesson, and
// shows it under that part.

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

const SYSTEM = `You add one picture to a lesson in a learning app. Learners are doctors and medical students, so pictures must be accurate and clinically sound.

Reply with exactly one of these, and nothing else:

1. A diagram in a \`\`\`mermaid code block: flowchart, decision tree, timeline, sequence diagram, \`xychart-beta\` line or bar chart, or \`pie\` chart.
2. A labelled drawing in a \`\`\`svg code block: schematics, anatomy sketches, curves, waveforms. Use a viewBox no larger than 640x400, font-size 13 or more, and stroke/fill colors that read on white and dark backgrounds.
3. PHOTO: <search words> | <kind>
   when what something really looks like matters most (an X-ray finding, a skin lesion, a histology slide, an instrument). Search words are short and plain, like "pneumothorax chest x-ray". kind is one of: ${KIND_NAMES}.
4. NONE, only if you were told a picture is optional and no picture would genuinely help.

After a diagram or drawing, add one line: CAPTION: <a short caption>.

Rules:
- One picture that supports the text: the key mechanism, pathway, decision, comparison or appearance. Keep it small: a few nodes, short labels.
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
		const first = await ask(runtime, model, SYSTEM, describe(req), signal);
		const parsed = parse(first);
		if (parsed.kind === "drawing") return { markdown: parsed.markdown };
		if (parsed.kind === "photo") {
			const photo = await pickPhoto(runtime, model, req, parsed.query, parsed.photoKind, signal);
			if (photo) return { markdown: photo };
			// No library photo fits: draw instead.
			const second = await ask(
				runtime,
				model,
				SYSTEM,
				`${describe(req)}\n\nNo suitable photo was found in the libraries. Draw a mermaid diagram or svg instead.`,
				signal,
			);
			const drawing = parse(second);
			if (drawing.kind === "drawing") return { markdown: drawing.markdown };
		}
		if (parsed.kind === "none" && !req.required) return {};
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

type Parsed =
	| { kind: "drawing"; markdown: string }
	| { kind: "photo"; query: string; photoKind: string }
	| { kind: "none" }
	| { kind: "unknown" };

function parse(reply: string): Parsed {
	const block = /```(mermaid|svg)[^\n]*\n([\s\S]*?)```/.exec(reply);
	if (block) {
		const code = block[2].trim();
		if (block[1] === "svg" && !/<svg[\s>]/.test(code)) return { kind: "unknown" };
		const caption = /^\s*CAPTION:\s*(.+)$/im.exec(reply)?.[1]?.trim();
		return { kind: "drawing", markdown: `\`\`\`${block[1]}\n${code}\n\`\`\`${caption ? `\n\n*${caption}*` : ""}` };
	}
	const photo = /^\s*PHOTO:\s*([^|\n]+?)\s*(?:\|\s*(\w+))?\s*$/im.exec(reply);
	if (photo) {
		const kind = photo[2]?.toLowerCase() ?? "any";
		return { kind: "photo", query: photo[1], photoKind: kind in KINDS ? kind : "any" };
	}
	if (/^\s*NONE\b/i.test(reply)) return { kind: "none" };
	return { kind: "unknown" };
}

async function pickPhoto(
	runtime: ModelRuntime,
	model: Model<Api>,
	req: IllustrateRequest,
	query: string,
	kind: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	let candidates: Candidate[] = await searchImages(query, "any", kind, signal);
	if (candidates.length === 0 && kind !== "any") candidates = await searchImages(query, "any", "any", signal);
	candidates = candidates.filter((c) => !req.shown?.some((s) => s.includes(c.url)));
	if (candidates.length === 0) return undefined;

	const vision = model.input?.includes("image") ?? false;
	const content: (TextContent | ImageContent)[] = [
		{
			type: "text",
			text: `${describe({ ...req, shown: undefined })}\n\nThese images were found for "${query}".${
				vision ? " Each is shown after its description." : " You can't see them, so go by the descriptions."
			} Choose the one that clearly shows what this part of the lesson is about.\n\nReply with only: <number> | <short, accurate caption>\nReply 0 if none clearly fits.`,
		},
	];
	for (const [i, c] of candidates.entries()) {
		content.push({ type: "text", text: `\nImage ${i + 1}: ${c.title}\nSource: ${c.credit}` });
		if (vision) {
			const img = await fetchThumb(c.thumb, signal);
			if (img) content.push({ type: "image", ...img });
		}
	}
	const reply = await ask(runtime, model, "You pick pictures for a medical learning app. Be strict: only pick an image that clearly fits.", content, signal);
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
