import type { Api, Model } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import path from "node:path";
import { type AppSettings, loadSettings, SESSIONS_DIR, saveSettings, WORKSPACE_DIR } from "./config.ts";
import { Conversation, type ConversationEvent, STALLED, type ToolDefinition } from "./engine/conversation.ts";
import { LessonFile } from "./engine/lessonfile.ts";
import type { AiModels } from "./engine/models.ts";
import { nextStep, offStep } from "./director.ts";
import { buildLibrary, illustrate } from "./illustrator.ts";
import { cleanName, type Library, type LessonSort, lessonKey, loadLibrary, saveLibrary } from "./library.ts";
import { type Candidate, createImageTool, IMAGE_URL } from "./images.ts";
import { CLIP_BLOCK, CLIP_EVERY_LESSON, createVideoTool } from "./videos.ts";
import { asMessage, type Material, parseMessage } from "./materials.ts";
import { QUIZ_LABEL, quizPhases } from "./phases.ts";
import { BASE_PROMPT, buildTeachingPrompt } from "./prompt.ts";
import {
	ASK_TOOL,
	createAskTool,
	createQuizTool,
	type InteractionBroker,
	type PendingInteraction,
	QUIZ_TOOL,
	type QuizAbout,
} from "./tools.ts";
import type { LessonSummary, ServerMessage, TranscriptItem, TutorState } from "./protocol.ts";

const TOOL_NAMES = [QUIZ_TOOL, ASK_TOOL];
// Default model per provider when the learner hasn't picked one: the newest
// matching id wins.
const DEFAULT_MODELS: Array<[string, RegExp]> = [
	["anthropic", /^claude-sonnet-[\d-]+$/],
	["openai", /^gpt-[\d.]+$/],
	["google", /^gemini-([\d.]+-pro|pro-latest)$/],
	["openrouter", /^anthropic\/claude-sonnet/],
];
// A diagram, chart or photo in a tutor reply (text or quiz/question card).
const VISUAL = /```(mermaid|svg|youtube)|!\[[^\]]*\]\((https:\/\/|\/photos\/)/;
// Hidden notes from the app to the tutor, appended to the learner's messages.
/** Added, out of the learner's sight, to a question they asked, so the tutor answers it rather than quizzing them on it. */
const ANSWER_NOTE =
	"\n\n<app-note>The learner asked this. Answer it clearly and fully before anything else, even during the pre-test. Don't turn it into a quiz question. Then carry on where you left off.</app-note>";
const APP_NOTE = /\s*<app-note>[\s\S]*?<\/app-note>\s*$/;

// Teaching text at least this long, with no picture, gets one from the app.
const MIN_SECTION_LENGTH = 400;
/** After this many pre-test answers, the tutor is told to move on to the plan. */
const PRETEST_ENOUGH = 5;
// A tutor reply at least this long, after the pre-test, is teaching (pre-test explanations are short).
const TEACHING_LENGTH = 2000;
/** Written feedback on an open-ended answer is at least this long. */
const FEEDBACK_LENGTH = 80;
/** Outcomes of a quiz or question card the learner actually saw. */
const SHOWN = ["answered", "cancelled", "paused"];
/** What the page sends when the learner has no questions after a section. */
const CONTINUE_TEXT = "No questions, please continue.";
// What the spinner says while the tutor uses each tool.
const ACTIVITY: Record<string, string> = {
	quiz_question: "Preparing a quiz question…",
	ask_learner: "Preparing a question…",
	find_image: "Finding a photo…",
	find_video: "Finding a video clip…",
	// Not tools: what happens between them.
	answer: "Checking your answer…",
	feedback: "Writing feedback on your answer…",
};
const REVIEW_TEXT = "I'm back to review this lesson. Please give me a new quiz on it.";
const REVIEW_NOTE =
	'\n\n<app-note>The learner opened this finished lesson again to review it. Start a new part with the heading "Review quiz". Ask 5 to 8 new quiz_question cards, one at a time, covering the lesson\'s main areas. Every question must be new: never repeat or reword a question already asked anywhere in this lesson. Only ask about what this lesson taught. About 1 in 4 can be a picture question. After the last answer, write the heading "How you did" and compare briefly, area by area, with how they did in the lesson\'s Final quiz. Don\'t reteach the lesson.</app-note>';

/** Identifies one part of a tutor message (the text between its cards). */
function partId(msg: any, part: number): string {
	return `m${msg.timestamp}-${part}`;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type Thinking = (typeof THINKING_LEVELS)[number];

/**
 * True when the message before `at` is the learner asking something: a question
 * typed instead of a quiz answer or before one, a follow-up typed right after a
 * quiz answer, or any message with a question mark.
 */
/** The text without its "Your learning plan" part (from that heading to the next heading). */
export function withoutPlan(text: string): string {
	const lines = text.split("\n");
	const heading = (line: string) => /^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*$)/.test(line);
	const start = lines.findIndex((line) => heading(line) && /learning plan/i.test(line));
	if (start < 0) return text;
	let end = lines.findIndex((line, i) => i > start && heading(line));
	if (end < 0) end = lines.length;
	return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

const HEADING = /^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*$)/;
const SECTION_HEADING = /^\s*(?:#{1,6}\s*|\*\*)\s*Section\s+(\d+)\b/i;
const WRAP_UP_HEADING = /^\s*(?:#{1,6}\s*|\*\*)\s*(Final quiz|Summary|What to learn next)/im;

export interface Plan {
	/** The plan's section names, in order. */
	sections: string[];
	/** Section numbers with their own "Section N" heading since the plan. */
	taught: Set<number>;
}

/** The lesson's latest learning plan, and which of its sections have been taught. */
export function findPlan(texts: string[]): Plan | undefined {
	let plan: Plan | undefined;
	for (const text of texts) {
		const lines = text.split("\n");
		const start = lines.findIndex((line) => HEADING.test(line) && /learning plan/i.test(line));
		if (start >= 0) {
			const sections: string[] = [];
			for (const line of lines.slice(start + 1)) {
				if (HEADING.test(line)) break;
				const item = /^\s*\d+[.)]\s+(.+)/.exec(line);
				if (item) sections.push(item[1].replace(/\*\*/g, "").trim());
			}
			if (sections.length > 0) plan = { sections, taught: new Set() };
		}
		if (!plan) continue;
		for (const line of lines.slice(start + 1)) {
			const n = Number(SECTION_HEADING.exec(line)?.[1]);
			if (n) plan.taught.add(n);
		}
	}
	return plan;
}

/** An AI service error, in words the learner can act on. */
export function friendlyError(raw: string): string {
	if (raw === STALLED) return "The AI stopped responding, so the lesson paused. Nothing is lost. Click Try again.";
	if (/overloaded|server_busy|too many requests|rate.?limit|capacity|(?<![0-9])(429|500|502|503|504|529)(?![0-9])/i.test(raw)) {
		return "Claude's servers are too busy right now, so the lesson paused. Nothing is lost. Wait a minute, then click Try again.";
	}
	if (/fetch failed|network|ENOTFOUND|EAI_AGAIN|connection|timed? ?out|socket/i.test(raw)) {
		return "LILA couldn't reach the AI service. Check that this computer is online, then click Try again.";
	}
	return `The AI service sent an error: ${raw}`;
}

function learnerAsked(messages: any[], at: number): boolean {
	const prev = messages[at - 1];
	if (prev?.role === "toolResult") return prev.details?.status === "paused" || !!prev.details?.skippedWith;
	if (prev?.role !== "user") return false;
	const raw = textOf(prev.content);
	if (raw.includes(ANSWER_NOTE.trim())) return true;
	const text = raw.replace(APP_NOTE, "").trim();
	if (!text || text === CONTINUE_TEXT || parseMessage(text)) return false;
	const before = messages[at - 2];
	return text.includes("?") || (before?.role === "toolResult" && Array.isArray(before.details?.correctIndices));
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("");
}

/** Pictures the app added to one lesson, kept in a file beside the lesson. */
class LessonPictures {
	readonly byId = new Map<string, string[]>();
	/** Parts of the lesson a picture is being made for right now. */
	readonly drawing = new Set<string>();
	/** Parts whose broken diagram was already replaced once. */
	readonly retried = new Set<string>();
	/** Quiz pictures LILA started on its own: dropped if not ready when the learner moves on. */
	readonly autoQuiz = new Set<string>();
	/** Pictures that came too late to show. */
	readonly dropped = new Set<string>();
	/** Real images gathered for this lesson's topic (server/illustrator.ts). */
	library: Candidate[] | undefined;
	private libraryBuild: Promise<Candidate[]> | undefined;
	private libraryEmptyAt = 0;
	/** The last picture added was drawn rather than a real image. */
	lastWasDrawing = false;

	constructor(private readonly file: string | undefined) {
		try {
			const saved = this.libraryFile && fs.existsSync(this.libraryFile) ? JSON.parse(fs.readFileSync(this.libraryFile, "utf8")) : undefined;
			if (Array.isArray(saved) && saved.length > 0) this.library = saved;
		} catch {
			// Gathered again when needed.
		}
		try {
			const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
			for (const [id, list] of Object.entries(saved)) {
				if (Array.isArray(list)) this.byId.set(id, list.filter((p) => typeof p === "string"));
			}
		} catch {
			// A damaged file only loses the pictures.
		}
	}

	add(id: string, markdown: string): void {
		this.byId.set(id, [...(this.byId.get(id) ?? []), markdown]);
		this.lastWasDrawing = markdown.startsWith("```");
		this.save();
	}

	/** Every image address already shown in this lesson. */
	usedImages(): string[] {
		return [...this.byId.values()].flat().flatMap((p) => p.match(IMAGE_URL) ?? []);
	}

	/** The lesson's image library, gathered once (and again after a while if that found nothing). */
	getLibrary(build: () => Promise<Candidate[]>): Promise<Candidate[]> {
		if (this.library) return Promise.resolve(this.library);
		if (!this.libraryBuild && Date.now() - this.libraryEmptyAt < 10 * 60_000) return Promise.resolve([]);
		this.libraryBuild ??= build().then((library) => {
			this.libraryBuild = undefined;
			if (library.length === 0) this.libraryEmptyAt = Date.now();
			if (library.length > 0) {
				this.library = library;
				try {
					if (this.libraryFile) fs.writeFileSync(this.libraryFile, JSON.stringify(library));
				} catch {
					// Gathered again next time.
				}
			}
			return library;
		});
		return this.libraryBuild;
	}

	private get libraryFile(): string | undefined {
		return this.file?.replace(/\.pictures\.json$/, ".library.json");
	}

	remove(id: string, picture: string): void {
		const list = this.byId.get(id);
		const index = list?.indexOf(picture) ?? -1;
		if (!list || index < 0) return;
		list.splice(index, 1);
		if (list.length === 0) this.byId.delete(id);
		this.save();
	}

	private save(): void {
		if (!this.file) return;
		try {
			fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.byId)));
		} catch {
			// Not fatal: the pictures just won't be there next time.
		}
	}
}

/** What an answered quiz was about, for making a picture of it. */
function quizContent(result: any): string {
	const options: any[] = result?.options ?? [];
	const correct = options.filter((o) => (result?.correctIndices ?? []).includes(o.index)).map((o) => o.label);
	return [
		`Question: ${result?.question ?? ""}`,
		result?.context ? `Context shown with the question: ${result.context}` : "",
		`Options: ${options.map((o) => o.label).join(" / ")}`,
		`Correct answer: ${correct.join(", ")}`,
		result?.explanation ? `Explanation: ${result.explanation}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * Owns the one active lesson (a Conversation) and translates between its
 * events and the simple messages the web page understands.
 */
export class Tutor implements InteractionBroker {
	private session: Conversation | undefined;
	private unsubscribe: (() => void) | undefined;
	private pending = new Map<string, { interaction: PendingInteraction; resolve: (answer: unknown) => void }>();
	private streamingText: string | null = null;
	private lastError: string | undefined;
	/** What the page shows while LILA waits to try a busy AI service again. */
	private retrying: string | null = null;
	private settings: AppSettings = loadSettings();
	private busy = false;
	/** Results of answered cards whose tool-result message isn't in the lesson yet. */
	private finishedResults = new Map<string, unknown>();
	private pictures = new LessonPictures(undefined);
	/** Every other quiz gets a picture when it has none of its own. */
	private lastQuizHadPicture = false;
	/** The model of the last lesson, kept while switching lessons. */
	private lastModel: Model<Api> | undefined;

	constructor(
		readonly runtime: AiModels,
		private readonly broadcast: (msg: ServerMessage) => void,
	) {}

	// ── InteractionBroker ────────────────────────────────────────────────────

	request<T>(interaction: PendingInteraction, signal: AbortSignal | undefined): Promise<T | undefined> {
		return new Promise((resolve) => {
			if (signal?.aborted) return resolve(undefined);
			const finish = (answer: unknown) => {
				if (!this.pending.delete(interaction.id)) return;
				signal?.removeEventListener("abort", onAbort);
				this.broadcast({ type: "interaction_done", id: interaction.id });
				resolve(answer as T | undefined);
			};
			const onAbort = () => (this.pending.get(interaction.id)?.resolve ?? finish)(undefined);
			signal?.addEventListener("abort", onAbort);
			this.pending.set(interaction.id, { interaction, resolve: finish });
			this.broadcast({ type: "interaction", interaction });
			// LILA's own picture for a quiz is dropped when the learner moves on from
			// the graded card before it's ready (it would pop up late), and when the
			// question goes unanswered (it would give the answer away when re-asked).
			if (interaction.kind === "graded" || interaction.kind === "quiz") {
				const pics = this.pictures;
				const id = interaction.id;
				this.pending.set(id, {
					interaction,
					resolve: (answer: unknown) => {
						const unanswered = interaction.kind === "quiz" && (!answer || (answer as any).skippedWith !== undefined);
						if (pics.autoQuiz.has(id) && (pics.drawing.has(id) || unanswered)) {
							pics.dropped.add(id);
							pics.drawing.delete(id);
							if (unanswered) for (const picture of [...(pics.byId.get(id) ?? [])]) pics.remove(id, picture);
						}
						finish(answer);
					},
				});
			}
		});
	}

	/**
	 * Set when the learner says something while the tutor is mid-reply. The tutor
	 * may have queued several cards at once and only reads the message after
	 * they've all run, so the rest are held back until it has read it.
	 */
	private holdCardsUntil: "user" | "assistant" | null = null;

	learnerWaiting(): boolean {
		return this.holdCardsUntil !== null;
	}

	/** The tutor's text just before a card, and whether it's the first thing in its reply. */
	private textBefore(toolCallId: string): { messages: any[]; at: number; text: string; firstPart: boolean } {
		const messages = (this.session?.messages ?? []) as any[];
		const at = messages.findIndex(
			(m) => m.role === "assistant" && (m.content ?? []).some((b: any) => b.type === "toolCall" && b.id === toolCallId),
		);
		let text = "";
		let firstPart = true;
		for (const block of messages[at]?.content ?? []) {
			if (block.type === "text") text += block.text;
			if (block.type !== "toolCall") continue;
			if (block.id === toolCallId) break;
			if (TOOL_NAMES.includes(block.name)) text = "";
			firstPart = false;
		}
		return { messages, at, text, firstPart };
	}

	/**
	 * Something the learner asked that the tutor hasn't answered in writing yet.
	 * Until it has, its cards are sent back (up to a few times, so a stubborn
	 * model can't stall the lesson).
	 */
	private openQuestion: { text: string; refusals: number } | null = null;

	unansweredQuestion(toolCallId: string): string | undefined {
		// Not yet delivered to the tutor: those cards are held instead.
		if (!this.openQuestion || this.holdCardsUntil) return undefined;
		const msg = (this.session?.messages as any[] | undefined)?.find(
			(m) => m.role === "assistant" && (m.content ?? []).some((b: any) => b.type === "toolCall" && b.id === toolCallId),
		);
		let written = "";
		for (const block of msg?.content ?? []) {
			if (block.type === "toolCall" && block.id === toolCallId) break;
			if (block.type === "text") written += block.text;
		}
		if (written.trim().length >= 20 || this.openQuestion.refusals >= 3) {
			this.openQuestion = null;
			return undefined;
		}
		this.openQuestion.refusals++;
		return this.openQuestion.text;
	}

	/** An open-ended question the learner answered that the tutor hasn't given feedback on yet. */
	private feedbackDue: { question: string; answer: string; refusals: number } | null = null;

	openAnswered(question: string, answer: string): void {
		this.feedbackDue = { question, answer, refusals: 0 };
	}

	/**
	 * The tutor is told once to give feedback first. If it still goes straight
	 * on (it did, four times in a row), LILA writes the feedback itself.
	 */
	feedbackMissing(toolCallId: string): { question: string; write: boolean } | undefined {
		const due = this.feedbackDue;
		if (!due) return undefined;
		const { text } = this.textBefore(toolCallId);
		if (text.trim().length >= FEEDBACK_LENGTH) {
			this.feedbackDue = null;
			return undefined;
		}
		due.refusals++;
		return { question: due.question, write: due.refusals > 1 };
	}

	async writeFeedback(signal: AbortSignal | undefined): Promise<string | undefined> {
		const due = this.feedbackDue;
		const model = this.session?.model;
		this.feedbackDue = null;
		if (!due || !model) return undefined;
		this.setActivity("feedback");
		// What the lesson taught, so the feedback matches it (the most recent part if it's long).
		const taught = this.assistantTexts().join("\n\n").slice(-40_000);
		try {
			const reply = await this.runtime.completeSimple(
				model,
				{
					systemPrompt:
						"You are a friendly, expert tutor. Write feedback on the learner's answer in 3 to 6 short sentences or bullets: what they got right, anything important they missed, and any mistakes corrected. Base it on what the lesson taught. Plain markdown, no heading, no question at the end.",
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: `The lesson so far:\n\n${taught}\n\n---\n\nQuestion: ${due.question}\nThe learner's answer: ${due.answer}`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ signal },
			);
			const text = reply.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("")
				.trim();
			return text || undefined;
		} catch {
			return undefined;
		}
	}

	private plan(): Plan | undefined {
		const texts = ((this.session?.messages ?? []) as any[])
			.filter((m) => m.role === "assistant")
			.map((m) => textOf(m.content));
		return findPlan(texts);
	}

	/** Sections of the plan still to teach, as "Section 3: Name". */
	private untaught(plan: Plan): string[] {
		return plan.sections.map((name, i) => `Section ${i + 1}: ${name}`).filter((_, i) => !plan.taught.has(i + 1));
	}

	/** How many quiz questions were sent back for coming while the sections were taught. */
	private teachingQuizRefusals = 0;

	quizWhileTeaching(toolCallId: string): string | undefined {
		if (this.teachingQuizRefusals >= 3) return undefined;
		// The lesson so far, up to this card: earlier replies in full, this one up to
		// the card (all of its text, including before any earlier cards in it).
		const { messages, at } = this.textBefore(toolCallId);
		const sofar = [
			...messages.slice(0, Math.max(at, 0)).filter((m) => m.role === "assistant").map((m) => textOf(m.content)),
			this.textUpTo(messages[at], toolCallId),
		];
		const has = (re: RegExp) => sofar.some((t) => t.split("\n").some((l) => HEADING.test(l) && re.test(l)));
		if (!has(/pre-?test complete|learning plan/i) || has(/final quiz/i)) return undefined;
		// Every section is taught: this is the Final quiz, even without its heading.
		const plan = this.plan();
		if (plan && this.untaught(plan).length === 0) return undefined;
		this.teachingQuizRefusals++;
		return "Not shown: there are no quiz questions while you teach the plan's sections. Quiz questions belong only in the pre-test and the Final quiz. Instead, finish teaching this section with a real-life example, a visual and the key points, then stop your reply; the page asks the learner if they have questions.";
	}

	/** All of a reply's text before the given card. */
	private textUpTo(message: any, toolCallId: string): string {
		let text = "";
		for (const block of message?.content ?? []) {
			if (block.type === "toolCall" && block.id === toolCallId) break;
			if (block.type === "text") text += `${block.text}\n`;
		}
		return text;
	}

	/** How many times this lesson's wrap-up was sent back for sections still to teach. */
	private wrapUpRefusals = 0;

	sectionsLeft(toolCallId: string, question: string, openEnded: boolean): string | undefined {
		if (this.wrapUpRefusals >= 3) return undefined;
		// "In your own words" questions belong to the Final quiz; so does anything after a wrap-up heading.
		const { messages, at, text } = this.textBefore(toolCallId);
		const wrapping =
			(openEnded && /own words/i.test(question)) ||
			WRAP_UP_HEADING.test(text) ||
			WRAP_UP_HEADING.test(textOf(messages[at]?.content));
		if (!wrapping) return undefined;
		const plan = this.plan();
		if (!plan) {
			// Taught without writing a plan: there's nothing to check the sections against.
			if (this.teachingStarted()) return undefined;
			this.wrapUpRefusals++;
			return `Not shown: you haven't written the learning plan or taught anything yet. Finish the pre-test now: write "Pre-test complete" with what the learner already knows, then "Your learning plan", then teach each section in order. Only after the last section, start the Final quiz.`;
		}
		const left = this.untaught(plan);
		if (left.length === 0) return undefined;
		this.wrapUpRefusals++;
		return `Not shown: you haven't taught every section of your plan yet. Still to teach: ${left.join("; ")}. Teach ${left[0].replace(/:.*/, "")} now, under the heading "${left[0]}", one section per reply, then the rest in order. Only after the last section, start the Final quiz.`;
	}

	/** True once the tutor has summed up the pre-test or written the plan. */
	private pretestDone(): boolean {
		return this.assistantTexts().some((t) => t.split("\n").some((l) => HEADING.test(l) && /pre-?test complete|learning plan/i.test(l)));
	}

	/** True once the tutor has taught something: a "Section N" heading, or a long teaching reply after the pre-test. */
	private teachingStarted(): boolean {
		const texts = this.assistantTexts();
		if (texts.some((t) => t.split("\n").some((l) => SECTION_HEADING.test(l)))) return true;
		return this.quizAnswers() >= 3 && texts.some((t) => t.length >= TEACHING_LENGTH);
	}

	/** Quiz questions the learner has answered so far. */
	private quizAnswers(): number {
		return ((this.session?.messages ?? []) as any[]).filter(
			(m) => m.role === "toolResult" && m.toolName === QUIZ_TOOL && m.details?.status === "answered",
		).length;
	}

	private assistantTexts(): string[] {
		return ((this.session?.messages ?? []) as any[]).filter((m) => m.role === "assistant").map((m) => textOf(m.content));
	}

	/** Where the lesson is, so the tutor can pick up its place after an error. */
	private whereWeAre(): string {
		const plan = this.plan();
		if (!plan) {
			if (this.teachingStarted())
				return 'You were teaching the lesson\'s sections. Carry on with the next one under its own "Section N: name" heading, then the Final quiz.';
			if (this.pretestDone()) return "You had finished the pre-test. Write \"Your learning plan\" if you haven't yet, then teach Section 1.";
			return `You were giving the pre-test (${this.quizAnswers()} questions answered so far). Carry on with it, keeping it to about ${PRETEST_ENOUGH} questions in all, then write "Pre-test complete", then "Your learning plan", then teach Section 1.`;
		}
		const left = this.untaught(plan);
		if (left.length > 0) {
			return `You were teaching your plan: ${plan.taught.size} of ${plan.sections.length} sections taught. Carry on with ${left[0]} (finish it if you had started it), then the rest in order, then the Final quiz.`;
		}
		return "Every section of your plan is taught. Carry on with the Final quiz where you left off, then the Summary and What to learn next.";
	}

	// ── Writing the next section ahead ───────────────────────────────────────
	// While the learner reads a section, the tutor already writes the next one
	// in the background, so "Continue the lesson" shows it at once. If the
	// learner asks a question instead, the prepared section is thrown away.

	/** The message "Continue the lesson" will send, and how long the lesson was then. */
	private preparedContinue: { text: string; base: number } | undefined;

	private prepareNextSection(): void {
		const session = this.session;
		this.preparedContinue = undefined;
		if (!session || this.pending.size > 0 || this.lastError) return;
		const plan = this.plan();
		if (!plan || this.untaught(plan).length === 0) return;
		const messages = session.messages as any[];
		const last = messages.at(-1);
		if (last?.role !== "assistant" || last.stopReason !== "stop") return;
		// Only after a teaching section, when the page invites questions.
		let turn = "";
		for (let i = messages.length - 1; i >= 0 && messages[i].role !== "user"; i--)
			if (messages[i].role === "assistant") turn = `${textOf(messages[i].content)}\n${turn}`;
		if (turn.trim().length < MIN_SECTION_LENGTH) return;
		const text = CONTINUE_TEXT + this.nextSectionNote() + this.visualReminder(true);
		this.preparedContinue = { text, base: messages.length };
		session.prepare(text, ["find_image", "find_video"]);
	}

	/** After a section, when the learner has no questions: what to teach next. */
	private nextSectionNote(): string {
		const plan = this.plan();
		if (!plan) {
			if (!this.teachingStarted()) return "";
			return `\n\n<app-note>You started teaching without writing "Your learning plan". Carry on with the next section under its own heading "Section N: name", one section per reply. Once every section is taught, start the Final quiz under the heading "Final quiz".</app-note>`;
		}
		const left = this.untaught(plan);
		if (left.length === 0)
			return `\n\n<app-note>Every section is taught: start the Final quiz now. Begin with the heading "Final quiz", before any card. Open it by telling the learner the teaching part is done and it's time to see how much they've learned. Make about 1 in 4 of its questions picture questions, some with a real find_image photo.</app-note>`;
		let next = `Teach ${left[0]} next, in this reply, then stop at its end. Include at least one real find_image photo in it.`;
		if (!this.triedVideo()) {
			// While testing, every lesson has a clip: by the last section, insist.
			next +=
				CLIP_EVERY_LESSON && (left.length === 1 || plan.taught.size >= 1)
					? " The lesson has no video clip yet, and every lesson needs one: call find_video in this section for whatever in it happens or moves."
					: " The lesson has no video clip yet: if this section shows something happening or moving, include one find_video clip.";
		}
		return `\n\n<app-note>${next}</app-note>`;
	}

	/** Whether the tutor has searched for a video in this lesson. */
	private triedVideo(): boolean {
		return ((this.session?.messages ?? []) as any[]).some(
			(m) => m.role === "assistant" && (m.content ?? []).some((b: any) => b.type === "toolCall" && b.name === "find_video"),
		);
	}

	/** Quiz questions asked in a row, most recent first, with no picture in them (stops at teaching). */
	private quizQuestionsWithoutPicture(): number {
		let count = 0;
		const messages = (this.session?.messages ?? []) as any[];
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role !== "assistant") continue;
			if (textOf(msg.content).length > 600) break;
			for (const block of [...(msg.content ?? [])].reverse()) {
				if (block.type !== "toolCall" || block.name !== QUIZ_TOOL) continue;
				const a = block.arguments ?? {};
				if (VISUAL.test(`${a.context ?? ""}\n${a.question ?? ""}`)) return count;
				count++;
			}
		}
		return count;
	}

	planProgress(): string | undefined {
		const plan = this.plan();
		if (!plan) {
			// This answer isn't saved yet.
			const n = this.quizAnswers() + 1;
			if (this.pretestDone() || n < 3) return undefined;
			if (n < PRETEST_ENOUGH)
				return `Note from the LILA app: when the pre-test ends, before any teaching, write "Pre-test complete" with its summary, then "Your learning plan" as a numbered list, then teach Section 1 under the heading "Section 1: name".`;
			return `Note from the LILA app: that's ${n} pre-test questions, which is enough. Don't ask more. Now write "Pre-test complete" with what the learner already knows, then "Your learning plan", then teach Section 1.`;
		}
		const left = this.untaught(plan);
		if (left.length === 0) return undefined;
		return `Plan progress (from the LILA app): ${plan.taught.size} of ${plan.sections.length} sections taught. Still to teach, in order: ${left.join("; ")}. Don't start the Final quiz until all are taught.`;
	}

	/** After a long teaching section, the lesson pauses for questions before the quiz. */
	async beforeQuiz(toolCallId: string, signal: AbortSignal | undefined): Promise<string | undefined> {
		const { messages, at, text, firstPart } = this.textBefore(toolCallId);
		if (text.trim().length < MIN_SECTION_LENGTH) return undefined;
		// The text is the tutor's answer to something the learner just asked,
		// not a new section; they've had their say, so go straight to the quiz.
		if (firstPart && learnerAsked(messages, at)) return undefined;
		const answer = await this.request<{ text?: string }>({ kind: "pause", id: toolCallId }, signal);
		return answer?.text?.trim() || undefined;
	}

	answer(id: string, answer: unknown): void {
		this.pending.get(id)?.resolve(answer ?? {});
	}

	// ── State snapshots for the page ─────────────────────────────────────────

	async state(): Promise<TutorState> {
		const available = await this.runtime.getAvailable().catch(() => []);
		// Between lessons there's briefly no session; report the last model so
		// the page doesn't think the learner needs to sign in again.
		const model = this.session?.model ?? this.usableLastModel();
		return {
			signedIn: available.length > 0,
			model: model ? { provider: model.provider, id: model.id, name: model.name ?? model.id } : null,
			thinkingLevel: this.session?.thinkingLevel ?? this.settings.thinkingLevel ?? "medium",
			thinkingLevels: this.session?.supportsThinking() ? this.session.getAvailableThinkingLevels() : [],
			guidedSteps: this.settings.guidedSteps !== false,
			busy: this.busy,
			lessonPath: this.session?.sessionFile ?? null,
			lessonTitle: (this.session && this.titleOf(this.session.sessionFile, this.session.sessionName)) || null,
			error: this.lastError ?? null,
			retrying: this.retrying,
			webPhotos: !!this.settings.photoSearchKey,
		};
	}

	async sendSnapshot(send: (msg: ServerMessage) => void): Promise<void> {
		send({ type: "state", state: await this.state() });
		send({ type: "transcript", items: this.transcript() });
		send({ type: "streaming", text: this.streamingText });
		send({ type: "activity", text: this.activity });
		for (const { interaction } of this.pending.values()) send({ type: "interaction", interaction });
		send(await this.lessonsMessage());
	}

	/** What the tutor is busy with, for the page's spinner ("Finding a photo…"); null when just working. */
	private activity: string | null = null;

	private setActivity(step: string | null): void {
		const text = (step && ACTIVITY[step]) || null;
		if (text === this.activity) return;
		this.activity = text;
		this.broadcast({ type: "activity", text });
	}

	private async pushState(): Promise<void> {
		this.broadcast({ type: "state", state: await this.state() });
	}

	transcript(): TranscriptItem[] {
		if (!this.session) return [];
		const items: TranscriptItem[] = [];
		const byToolCall = new Map<string, TranscriptItem & { kind: "quiz" | "ask" }>();
		const messages = this.session.messages as any[];
		for (const msg of messages) {
			if (msg.role === "user") {
				const text = textOf(msg.content).replace(APP_NOTE, "").trim();
				const resource = parseMessage(text);
				if (resource) items.push({ kind: "resource", ...resource });
				else if (text) items.push({ kind: "user", text });
			} else if (msg.role === "assistant") {
				let text = "";
				let part = 0;
				for (const block of msg.content ?? []) {
					if (block.type === "text") text += block.text;
					if (block.type === "toolCall" && TOOL_NAMES.includes(block.name)) {
						if (text.trim()) items.push({ kind: "assistant", id: partId(msg, part), text });
						text = "";
						part++;
						const item = {
							kind: block.name === QUIZ_TOOL ? ("quiz" as const) : ("ask" as const),
							id: block.id as string,
							question: String(block.arguments?.question ?? ""),
							details: block.arguments?.context as string | undefined,
							result: null,
						};
						byToolCall.set(item.id, item);
						items.push(item);
					}
				}
				if (text.trim()) items.push({ kind: "assistant", id: partId(msg, part), text });
				// Errors that were retried successfully aren't worth showing.
				// Only the error the lesson stopped on: earlier ones were retried, and
				// while LILA is still trying again the page says so instead.
				if (msg.stopReason === "error" && msg.errorMessage && msg === messages[messages.length - 1] && !this.busy) {
					items.push({ kind: "error", text: friendlyError(msg.errorMessage), retry: true });
				}
			} else if (msg.role === "toolResult") {
				const item = byToolCall.get(msg.toolCallId);
				if (item) item.result = msg.details ?? { status: "unavailable", message: textOf(msg.content) };
				this.finishedResults.delete(msg.toolCallId);
			}
		}
		for (const [id, result] of this.finishedResults) {
			const item = byToolCall.get(id);
			if (item && !item.result) item.result = result as any;
		}
		for (const item of items) {
			if (item.kind !== "assistant" && item.kind !== "quiz") continue;
			const pictures = this.pictures.byId.get(item.id);
			if (pictures) item.pictures = pictures;
			if (this.pictures.drawing.has(item.id)) item.drawing = true;
		}
		// A card held back while LILA wrote feedback the tutor owed: show that feedback as the tutor's words.
		for (const [i, item] of items.entries()) {
			if (item.kind !== "quiz" && item.kind !== "ask") continue;
			const result = item.result as any;
			if (result?.status === "feedback" && result.feedback) items[i] = { kind: "assistant", id: item.id, text: result.feedback };
		}
		// A call that failed (bad arguments, a question that couldn't be shown)
		// never reached the learner and the tutor asks again, so leave it out
		// rather than show an empty card.
		return items.filter(
			(item) => !((item.kind === "quiz" || item.kind === "ask") && item.result && !SHOWN.includes((item.result as any).status)),
		);
	}

	async lessons(): Promise<LessonSummary[]> {
		const { sort, folderOf } = this.library;
		const lessons = LessonFile.list(SESSIONS_DIR)
			.filter((s) => s.messageCount > 0)
			.map((s) => ({
				path: s.path,
				title: this.titleOf(s.path, s.name) ?? (s.firstMessage.slice(0, 80) || "Untitled lesson"),
				modified: s.modified.toISOString(),
				folder: folderOf[lessonKey(s.path)],
			}));
		if (sort === "name") return lessons.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }));
		const newest = (a: LessonSummary, b: LessonSummary) => b.modified.localeCompare(a.modified);
		return lessons.sort(sort === "oldest" ? (a, b) => newest(b, a) : newest);
	}

	private async lessonsMessage(): Promise<ServerMessage> {
		const lessons = await this.lessons();
		return { type: "lessons", lessons, folders: this.library.folders, sort: this.library.sort };
	}

	// ── Organising lessons (the lesson list's right-click menu) ──────────────

	private library: Library = loadLibrary();

	/** A lesson's title: the learner's own name for it, else the one it was given. */
	private titleOf(lessonPath: string | undefined, name: string | undefined): string | undefined {
		return (lessonPath && this.library.names[lessonKey(lessonPath)]) || name || undefined;
	}

	/** Only lesson files LILA itself keeps can be renamed, moved or deleted. */
	private isLesson(lessonPath: string): boolean {
		const resolved = path.resolve(lessonPath);
		return path.dirname(resolved) === path.resolve(SESSIONS_DIR) && resolved.endsWith(".jsonl") && fs.existsSync(resolved);
	}

	private async libraryChanged(): Promise<void> {
		saveLibrary(this.library);
		this.broadcast(await this.lessonsMessage());
		await this.pushState();
	}

	async deleteLesson(lessonPath: string): Promise<void> {
		if (!this.isLesson(lessonPath)) return;
		const open = this.session?.sessionFile && path.resolve(this.session.sessionFile) === path.resolve(lessonPath);
		if (open) await this.openLesson();
		fs.rmSync(lessonPath, { force: true });
		fs.rmSync(lessonPath.replace(/\.jsonl$/, ".pictures.json"), { force: true });
		const key = lessonKey(lessonPath);
		delete this.library.names[key];
		delete this.library.folderOf[key];
		await this.libraryChanged();
	}

	async renameLesson(lessonPath: string, title: string): Promise<void> {
		const name = cleanName(title);
		if (!this.isLesson(lessonPath) || !name) return;
		this.library.names[lessonKey(lessonPath)] = name;
		await this.libraryChanged();
	}

	async moveLesson(lessonPath: string, folder: string | null): Promise<void> {
		if (!this.isLesson(lessonPath)) return;
		const key = lessonKey(lessonPath);
		if (folder && this.library.folders.includes(folder)) this.library.folderOf[key] = folder;
		else delete this.library.folderOf[key];
		await this.libraryChanged();
	}

	/** Makes a folder, and moves a lesson into it when one is given. */
	async newFolder(name: string, lessonPath?: string): Promise<void> {
		const folder = cleanName(name);
		if (!folder) return;
		if (!this.library.folders.includes(folder)) this.library.folders.push(folder);
		if (lessonPath && this.isLesson(lessonPath)) this.library.folderOf[lessonKey(lessonPath)] = folder;
		await this.libraryChanged();
	}

	async renameFolder(from: string, to: string): Promise<void> {
		const name = cleanName(to);
		const lib = this.library;
		if (!name || !lib.folders.includes(from) || (name !== from && lib.folders.includes(name))) return;
		lib.folders = lib.folders.map((f) => (f === from ? name : f));
		for (const [key, f] of Object.entries(lib.folderOf)) if (f === from) lib.folderOf[key] = name;
		await this.libraryChanged();
	}

	/** Removes a folder; its lessons move back out to the main list, never deleted. */
	async deleteFolder(name: string): Promise<void> {
		const lib = this.library;
		lib.folders = lib.folders.filter((f) => f !== name);
		for (const [key, f] of Object.entries(lib.folderOf)) if (f === name) delete lib.folderOf[key];
		await this.libraryChanged();
	}

	async sortLessons(sort: LessonSort): Promise<void> {
		if (!["newest", "oldest", "name"].includes(sort)) return;
		this.library.sort = sort;
		await this.libraryChanged();
	}

	/** Opens a past lesson and starts a quiz on it with all-new questions. */
	async reviewLesson(lessonPath: string): Promise<void> {
		if (!this.isLesson(lessonPath)) return;
		await this.openLesson(lessonPath);
		await this.prompt(`${REVIEW_TEXT}${REVIEW_NOTE}`, REVIEW_TEXT);
	}

	// ── Lesson lifecycle ─────────────────────────────────────────────────────

	private async pickModel() {
		const available = await this.runtime.getAvailable().catch(() => []);
		if (available.length === 0) return undefined;
		const saved =
			this.settings.provider && this.settings.modelId
				? available.find((m) => m.provider === this.settings.provider && m.id === this.settings.modelId)
				: undefined;
		if (saved) return saved;
		// No choice saved yet: prefer a strong general model from a provider the
		// learner signed in to here, over ones picked up from the environment.
		for (const [provider, pattern] of DEFAULT_MODELS) {
			if (!this.runtime.hasConfiguredAuth(provider)) continue;
			const candidates = available.filter((m) => m.provider === provider && pattern.test(m.id));
			if (candidates.length > 0) return candidates[candidates.length - 1];
		}
		return available.find((m) => this.runtime.hasConfiguredAuth(m.provider)) ?? available[0];
	}

	/** Opens an existing lesson file, or starts a fresh lesson when path is omitted. */
	async openLesson(path?: string): Promise<void> {
		if (this.busy && this.session) await this.session.abort();
		this.dispose();
		this.finishedResults.clear();
		this.lastQuizHadPicture = false;
		this.feedbackDue = null;
		this.wrapUpRefusals = 0;
		this.teachingQuizRefusals = 0;
		this.lastError = undefined;

		// If the provider list is briefly unavailable (for example while a sign-in
		// refreshes), carry on with the model the last lesson used.
		const model = (await this.pickModel()) ?? this.usableLastModel();
		const file = path && fs.existsSync(path) ? LessonFile.open(path) : LessonFile.create(SESSIONS_DIR, WORKSPACE_DIR);
		const thinking = THINKING_LEVELS.includes(this.settings.thinkingLevel as Thinking)
			? (this.settings.thinkingLevel as Thinking)
			: "medium";
		const session = new Conversation({
			models: this.runtime,
			file,
			model,
			thinkingLevel: thinking,
			systemPrompt: `${BASE_PROMPT}\n\n${buildTeachingPrompt()}`,
			tools: [
				this.withVisualReminder(createQuizTool(this)),
				this.withVisualReminder(createAskTool(this)),
				createImageTool(() => this.session?.model?.input?.includes("image") ?? false),
				createVideoTool(() => this.assistantTexts().join("\n").match(CLIP_BLOCK)?.length ?? 0),
			],
			// LILA directs each step of the lesson (unless turned off in Settings).
			director: (messages) =>
				this.settings.guidedSteps === false
					? undefined
					: nextStep(messages, !!this.openQuestion || learnerAsked(messages as any[], messages.length)),
			offStep,
		});
		this.session = session;
		if (session.model) this.lastModel = session.model;
		this.pictures = new LessonPictures(session.sessionFile?.replace(/\.jsonl$/, ".pictures.json"));
		this.unsubscribe = session.subscribe((event) => this.onEvent(event));
		this.broadcast({ type: "transcript", items: this.transcript() });
		this.broadcast({ type: "streaming", text: null });
		this.broadcast(await this.lessonsMessage());
		await this.pushState();
	}

	dispose(): void {
		for (const { resolve } of [...this.pending.values()]) resolve(undefined);
		this.unsubscribe?.();
		this.session?.dispose();
		this.session = undefined;
		this.streamingText = null;
		this.busy = false;
	}

	/** Materials are sent one at a time, so several dropped together don't trip over each other. */
	private materialsSent: Promise<void> = Promise.resolve();

	/** Adds the learner's own material to the lesson as a message to the tutor. */
	async addMaterial(material: Material): Promise<void> {
		const previous = this.materialsSent;
		let sent!: () => void;
		this.materialsSent = new Promise((resolve) => (sent = resolve));
		await previous;
		const run = this.prompt(asMessage(material), `I've added a learning resource: ${material.name}`, false, true);
		// The next one may go once the tutor is working on this one (it then
		// reads it as soon as it can), or once this run is over.
		const started = (async () => {
			for (let i = 0; i < 100 && !this.session?.isStreaming; i++) await new Promise((r) => setTimeout(r, 50));
		})();
		await Promise.race([run, started]);
		sent();
		await run;
	}

	/**
	 * Sends the learner's message. `cardText` is used instead when the message
	 * answers a waiting card (a short note in place of a whole document).
	 */
	async prompt(text: string, cardText = text, asked = false, material = false): Promise<void> {
		if (!this.session) await this.openLesson();
		const session = this.session!;
		if (!session.model) {
			this.lastError = "Sign in to an AI provider first (Settings).";
			await this.pushState();
			return;
		}
		if (!session.sessionName) {
			const title = parseMessage(text)?.name ?? text;
			session.setSessionName(title.replace(/\s+/g, " ").trim().slice(0, 80));
		}
		this.lastError = undefined;
		// A graded quiz just waits for "Next question", so it's dismissed and the
		// text goes to the tutor as a normal message: a follow-up question about it.
		for (const { interaction, resolve } of [...this.pending.values()]) {
			if (interaction.kind !== "graded") continue;
			asked = true;
			resolve({});
		}
		// Another card is waiting: the run is paused inside that tool call, so a
		// normal message would queue behind it forever. Use the text as the card's
		// answer. Typed instead of a quiz answer or at the questions pause, it's
		// something the tutor must respond to before the cards it had queued.
		if (this.pending.size > 0) {
			for (const { interaction, resolve } of [...this.pending.values()]) {
				if (interaction.kind === "graded") continue;
				if (interaction.kind === "pause" || interaction.kind === "quiz") {
					this.holdCardsUntil = "assistant";
					this.openQuestion = { text: cardText, refusals: 0 };
				}
				if (interaction.kind === "pause") resolve({ text: cardText });
				else if (interaction.kind === "quiz") resolve({ skippedWith: cardText });
				else if (interaction.mode === "text") resolve({ text: cardText });
				else resolve({ other: cardText });
			}
			// The whole document follows the card's answer as its own message.
			if (cardText === text) return;
		}
		// Typed while the tutor is busy (writing, or just past a quiz): it only
		// reads the message once its current reply's cards have run, so hold
		// those back until the message is delivered, and ask for an answer first.
		if (session.isStreaming) {
			this.holdCardsUntil = "user";
			// A file or link isn't a question to answer.
			if (!material) asked = true;
		}
		if (asked) this.openQuestion = { text, refusals: 0 };
		// The last reply stopped on an error (a busy AI service): remind the
		// tutor where the lesson was, so it doesn't lose its place.
		const last = (session.messages as any[]).at(-1);
		const resume =
			last?.role === "assistant" && last.stopReason === "error"
				? `\n\n<app-note>The lesson stopped because the AI service had an error. ${this.whereWeAre()} Don't repeat questions the learner already answered.</app-note>`
				: text === CONTINUE_TEXT
					? this.nextSectionNote()
					: "";
		let message = text + (asked ? ANSWER_NOTE : "") + resume + this.visualReminder(true);
		// The next section may already be written: send the exact message it answers.
		const prepared = this.preparedContinue;
		this.preparedContinue = undefined;
		if (text === CONTINUE_TEXT && !asked && !session.isStreaming && prepared?.base === session.messages.length) message = prepared.text;
		try {
			if (session.isStreaming) {
				await session.steer(message);
			} else {
				await session.prompt(message);
			}
		} catch (err) {
			this.lastError = (err as Error).message;
			await this.pushState();
		}
	}

	// ── Keeping the lesson visual ────────────────────────────────────────────
	// Models tend to drift back to plain text. When the tutor has gone two replies without a diagram, chart
	// or photo, the app reminds it, out of the learner's sight.

	private repliesWithoutVisual(): number {
		let count = 0;
		const messages = (this.session?.messages ?? []) as any[];
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role !== "assistant") continue;
			let text = "";
			let card = false;
			for (const block of msg.content ?? []) {
				if (block.type === "text") text += block.text;
				if (block.type === "toolCall" && TOOL_NAMES.includes(block.name)) {
					card = true;
					text += JSON.stringify(block.arguments ?? {});
				}
			}
			// Replies that only searched for an image don't count either way.
			if (!text.trim() && !card) continue;
			if (VISUAL.test(text) || this.hasPicture(msg)) return count;
			count++;
		}
		return count;
	}

	private visualReminder(tagged = false): string {
		// Not while the lesson is being set up (goal and materials questions):
		// a nudge there makes the tutor show a picture instead of waiting for files.
		const started = ((this.session?.messages ?? []) as any[]).some(
			(m) => m.role === "assistant" && (m.content ?? []).some((b: any) => b.type === "toolCall" && b.name === QUIZ_TOOL),
		);
		if (!started) return "";
		const n = this.repliesWithoutVisual();
		if (n < 2) return "";
		const note = `Note from the LILA app, not from the learner: your last ${n} replies had no visual. Include a fitting diagram, chart or find_image photo in your next reply, or in the context or explanation of your next quiz question.`;
		return tagged ? `\n\n<app-note>${note}</app-note>` : `\n\n[${note}]`;
	}

	/** Adds the visual reminder to a card's result when one is due. */
	private withVisualReminder<T extends ToolDefinition<any>>(tool: T): T {
		return {
			...tool,
			execute: async (...args: any[]) => {
				const result = await (tool.execute as (...a: any[]) => ReturnType<T["execute"]>)(...args);
				let note = this.visualReminder();
				if (tool.name === QUIZ_TOOL && !note && this.quizQuestionsWithoutPicture() >= 3)
					note = "\n\n[Note from the LILA app, not from the learner: your last 3 quiz questions had no picture. If you ask another, make it a picture question: a labelled svg or a real find_image photo in its context.]";
				return note ? { ...result, content: [...result.content, { type: "text" as const, text: note }] } : result;
			},
		};
	}

	private hasPicture(msg: any): boolean {
		const prefix = `m${msg.timestamp}-`;
		for (const id of [...this.pictures.byId.keys(), ...this.pictures.drawing]) {
			if (id.startsWith(prefix)) return true;
		}
		return (msg.content ?? []).some((b: any) => b.type === "toolCall" && this.pictures.byId.has(b.id));
	}

	// ── Pictures made by the app ─────────────────────────────────────────────
	// Prompting alone didn't get the tutor to draw, so the app makes sure of it:
	// a long stretch of teaching, and every other answered quiz, that arrives
	// without a picture gets one from a separate request (server/illustrator.ts).
	// The learner can also ask for a picture under any tutor message.

	/** A finished tutor message: illustrate its long teaching parts that have no picture. */
	private autoIllustrateMessage(msg: any): void {
		if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
		let text = "";
		let part = 0;
		const parts: Array<[string, string]> = [];
		for (const block of msg.content ?? []) {
			if (block.type === "text") text += block.text;
			if (block.type === "toolCall" && TOOL_NAMES.includes(block.name)) {
				parts.push([partId(msg, part++), text]);
				text = "";
			}
		}
		parts.push([partId(msg, part), text]);
		for (const [id, partText] of parts) {
			// The learning plan stays a plain list: only the teaching around it gets a picture.
			const teaching = withoutPlan(partText);
			if (teaching.trim().length >= MIN_SECTION_LENGTH && !VISUAL.test(partText) && !this.pictures.byId.has(id)) {
				this.draw(id, teaching, "section", false);
			}
		}
	}

	/**
	 * A quiz question is shown: start its picture now, so it's ready with the
	 * explanation (it only shows once the learner has answered).
	 */
	quizShown(id: string, quiz: QuizAbout): void {
		const own = VISUAL.test(`${quiz.context ?? ""}\n${quiz.explanation ?? ""}`);
		if (own || this.lastQuizHadPicture || this.pictures.byId.has(id)) {
			this.lastQuizHadPicture = own;
			return;
		}
		this.lastQuizHadPicture = true;
		this.pictures.autoQuiz.add(id);
		this.draw(id, quizContent(quiz), "explanation", false);
	}

	/** The page couldn't draw a picture (a diagram with a syntax error, or a photo that won't load). */
	pictureBroken(id: string, picture: string): void {
		const pics = this.pictures;
		pics.remove(id, picture);
		const part = this.partFor(id);
		if (part && !pics.retried.has(id) && !pics.byId.has(id)) {
			pics.retried.add(id);
			this.draw(id, part.content, part.purpose, true, true);
		} else {
			this.broadcast({ type: "transcript", items: this.transcript() });
		}
	}

	private partFor(id: string): { content: string; purpose: "section" | "explanation" } | undefined {
		for (const item of this.transcript()) {
			if (item.kind === "assistant" && item.id === id) return { content: item.text, purpose: "section" };
			if (item.kind === "quiz" && item.id === id) {
				const result = item.result ?? (this.pending.get(id)?.interaction as any)?.result;
				if (result?.status === "answered") return { content: quizContent(result), purpose: "explanation" };
			}
		}
		return undefined;
	}

	private draw(id: string, content: string, purpose: "section" | "explanation", required: boolean, retry = false): void {
		const session = this.session;
		const pics = this.pictures;
		if (!session?.model || pics.drawing.has(id)) return;
		pics.drawing.add(id);
		this.broadcast({ type: "transcript", items: this.transcript() });
		const model = session.model;
		const topic = session.sessionName ?? "";
		const library = pics.getLibrary(() => buildLibrary(this.runtime, model, topic, this.lessonStart()));
		void library
			.then((library) =>
				illustrate(this.runtime, model, {
					topic,
					content,
					purpose,
					required,
					shown: pics.byId.get(id),
					retryAfterBroken: retry,
					library,
					used: pics.usedImages(),
					lastWasDrawing: pics.lastWasDrawing,
					label: `${purpose} ${id}${required ? " (asked for)" : ""}`,
				}),
			)
			.then((result) => {
				pics.drawing.delete(id);
				if (pics.dropped.has(id)) return;
				if (result.markdown) pics.add(id, result.markdown);
				if (this.pictures !== pics) return;
				if (!result.markdown && required) {
					this.broadcast({ type: "error", message: "LILA couldn't make a picture this time. Please try again." });
				}
				this.broadcast({ type: "transcript", items: this.transcript() });
			});
	}

	/** The first part of the lesson as text: what the learner asked for and how the tutor began. */
	private lessonStart(): string {
		return this.transcript()
			.filter((i) => i.kind === "user" || i.kind === "assistant")
			.map((i) => (i as { text: string }).text)
			.join("\n\n")
			.slice(0, 4000);
	}

	/** Carries the lesson on after it stopped on an error. */
	async retry(): Promise<void> {
		await this.prompt("Please continue the lesson.");
	}

	async abort(): Promise<void> {
		await this.session?.abort();
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		const model = this.runtime.getModel(provider, modelId);
		if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);
		this.settings = { ...this.settings, provider, modelId };
		saveSettings(this.settings);
		this.lastModel = model;
		if (this.session) await this.session.setModel(model);
		await this.pushState();
	}

	/** Saves (or, when empty, removes) the SerpApi key for Google Images photos. */
	async setPhotoKey(key: string): Promise<void> {
		this.settings = { ...this.settings, photoSearchKey: key.trim() || undefined };
		saveSettings(this.settings);
		await this.pushState();
	}

	/** Whether LILA directs each step of the lesson. */
	async setGuided(on: boolean): Promise<void> {
		this.settings = { ...this.settings, guidedSteps: on };
		saveSettings(this.settings);
		await this.pushState();
	}

	async setThinking(level: string): Promise<void> {
		if (!THINKING_LEVELS.includes(level as Thinking)) return;
		this.settings = { ...this.settings, thinkingLevel: level };
		saveSettings(this.settings);
		this.session?.setThinkingLevel(level as Thinking);
		await this.pushState();
	}

	/** The last lesson's model, unless the learner has since signed out of its provider. */
	private usableLastModel(): Model<Api> | undefined {
		const model = this.lastModel;
		return model && this.runtime.hasConfiguredAuth(model.provider) ? model : undefined;
	}

	/** Called after sign-in changes, so a lesson without a model picks one up. */
	async refreshModel(): Promise<void> {
		if (this.session && !this.session.model) {
			const model = await this.pickModel();
			if (model) await this.session.setModel(model);
		}
		await this.pushState();
	}

	exportMarkdown(): string {
		const lines: string[] = [`# ${this.session?.sessionName ?? "Lesson"}`, ""];
		const items = this.transcript();
		const phases = quizPhases(items);
		for (const [i, item] of items.entries()) {
			if (item.kind === "user") lines.push(`> **You:** ${item.text.replace(/\n/g, "\n> ")}`, "");
			else if (item.kind === "resource") lines.push(`> 📎 **Learning resource:** ${item.name}`, "");
			else if (item.kind === "assistant") lines.push(item.text, "", ...(item.pictures ?? []).flatMap((p) => [p, ""]));
			else if (item.kind === "error") lines.push(`> ⚠️ ${item.text}`, "");
			else {
				const r = item.result as any;
				lines.push(`**${item.kind === "quiz" ? QUIZ_LABEL[phases[i]] : "Question"}:** ${item.question}`, "");
				for (const o of r?.options ?? []) {
					const chosen = (r.answers ?? []).some((a: any) => a.index === o.index);
					const key = (r.correctIndices ?? []).includes(o.index);
					const mark = item.kind === "quiz" ? (key ? "✓" : chosen ? "✗" : "-") : chosen ? "●" : "-";
					lines.push(`${mark} ${o.label}`);
				}
				if (r?.dontKnow) lines.push("", "_Answered: I don't know yet_");
				for (const f of r?.feedback ?? []) lines.push("", `_About your answer: ${f}_`);
				for (const a of r?.answers ?? []) if (a.type === "other" || a.type === "text") lines.push("", `_Answer: ${a.label}_`);
				if (r?.note) lines.push("", `_Note: ${r.note}_`);
				if (r?.explanation) lines.push("", r.explanation);
				lines.push("");
				if (item.kind === "quiz") for (const p of item.pictures ?? []) lines.push(p, "");
			}
		}
		lines.push(...this.troubleshootingLog());
		return lines.join("\n");
	}

	/**
	 * Everything the tutor saw and did, in order, including what the learner
	 * never sees (held cards, the app's notes). Folded away at the end of the
	 * download so a problem can be traced from the file.
	 */
	private troubleshootingLog(): string[] {
		const clip = (t: string, n = 300) => (t.length > n ? `${t.slice(0, n)}…` : t).replace(/\s+/g, " ").trim();
		const out = ["", "<details><summary>Details for troubleshooting</summary>", "", "```"];
		for (const msg of (this.session?.messages ?? []) as any[]) {
			const time = msg.timestamp ? new Date(msg.timestamp).toISOString().slice(11, 19) : "";
			if (msg.role === "user") out.push(`${time} learner: ${clip(textOf(msg.content), 600)}`);
			else if (msg.role === "assistant") {
				for (const block of msg.content ?? []) {
					if (block.type === "text" && block.text.trim()) out.push(`${time} tutor: ${clip(block.text)}`);
					if (block.type === "toolCall") out.push(`${time} tutor calls ${block.name}: ${clip(JSON.stringify(block.arguments ?? {}), 200)}`);
				}
				if (msg.stopReason && msg.stopReason !== "toolUse" && msg.stopReason !== "stop") out.push(`${time} (reply ended: ${msg.stopReason})`);
				if (msg.step) out.push(`${time} (step: ${msg.step})`);
			} else if (msg.role === "toolResult") {
				out.push(`${time} result: ${msg.details?.status ?? (msg.isError ? "error" : "?")}: ${clip(textOf(msg.content), 200)}`);
			}
		}
		out.push("```", "", "</details>", "");
		return out;
	}

	// ── Conversation events → page ─────────────────────────────────────────────────────

	private lastStreamPush = 0;

	private onEvent(event: ConversationEvent): void {
		switch (event.type) {
			case "agent_start":
				if (!this.busy) {
					this.busy = true;
					void this.pushState();
				}
				break;
			case "auto_retry_start": {
				const { attempt, maxAttempts, errorMessage } = event as any;
				this.retrying =
					errorMessage === STALLED
						? `The AI stopped responding. Trying again (${attempt} of ${maxAttempts})…`
						: `Claude's servers are busy right now. Trying again (${attempt} of ${maxAttempts})…`;
				void this.pushState();
				break;
			}
			case "auto_retry_end":
				this.retrying = null;
				void this.pushState();
				break;
			case "agent_settled":
				this.setActivity(null);
				this.busy = false;
				this.retrying = null;
				this.holdCardsUntil = null;
				this.openQuestion = null;
				this.feedbackDue = null;
				this.streamingText = null;
				this.broadcast({ type: "transcript", items: this.transcript() });
				this.broadcast({ type: "streaming", text: null });
				void this.pushState();
				void this.lessonsMessage().then((msg) => this.broadcast(msg));
				this.prepareNextSection();
				break;
			case "message_start":
				// Held until the learner's message reaches the tutor, or (when it
				// came as a card's answer) until the tutor's next reply starts.
				if ((event as any).message?.role === this.holdCardsUntil) this.holdCardsUntil = null;
				break;
			case "message_update": {
				const partial = (event as any).message;
				if (partial?.role !== "assistant") break;
				let text = "";
				for (const block of partial.content ?? []) {
					if (block.type === "text") text += block.text;
				}
				this.streamingText = text;
				// While the AI is still thinking, keep saying what it's thinking about.
				const lastBlock = (partial.content ?? []).at(-1);
				if (lastBlock?.type === "toolCall") this.setActivity(lastBlock.name);
				else if (lastBlock?.type === "text") this.setActivity(null);
				const now = Date.now();
				if (now - this.lastStreamPush > 50) {
					this.lastStreamPush = now;
					this.broadcast({ type: "streaming", text });
				}
				break;
			}
			case "tool_execution_end": {
				const { toolCallId, toolName, result } = event as any;
				if (TOOL_NAMES.includes(toolName) && result?.details) this.finishedResults.set(toolCallId, result.details);
			}
			// falls through
			case "message_end":
				// After the learner answers a card, the tutor's next step is to look at the answer.
				if (event.type === "tool_execution_end")
					this.setActivity((event as any).result?.details?.status === "answered" ? "answer" : null);
				if (event.type === "message_end" && (event as any).message?.role === "assistant") {
					const call = ((event as any).message.content ?? []).find((b: any) => b.type === "toolCall");
					this.setActivity(call?.name ?? null);
					this.autoIllustrateMessage((event as any).message);
					// A reply written after the question arrived, with real text: answered.
					const written = ((event as any).message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
					if (this.openQuestion && !this.holdCardsUntil && written.trim().length >= 20) this.openQuestion = null;
					if (this.feedbackDue && written.trim().length >= FEEDBACK_LENGTH) this.feedbackDue = null;
				}
				// Transcript first: the page swaps the streamed text for the saved
				// message without the page briefly getting shorter (which would
				// throw off its scroll position).
				this.streamingText = null;
				this.broadcast({ type: "transcript", items: this.transcript() });
				this.broadcast({ type: "streaming", text: null });
				break;
			case "session_info_changed":
				void this.pushState();
				break;
		}
	}
}
