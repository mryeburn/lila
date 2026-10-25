// LILA's two interactive cards. `quiz_question` is a graded multiple-choice
// question; `ask_learner` asks something with no right answer (a goal, a
// choice, a free-text reply). Both hand the card to the web page and wait for
// the learner.
//
// Which choice is right, and the explanation, stay on the server until the
// learner has answered.

import type { ToolDefinition } from "./engine/conversation.ts";
import { Type } from "typebox";

export interface DisplayOption {
	index: number; // 1-based, in display order
	label: string;
	description?: string;
}

export type PendingInteraction =
	| {
			kind: "quiz";
			id: string;
			question: string;
			details?: string;
			multiSelect: boolean;
			options: DisplayOption[];
	  }
	| {
			kind: "ask";
			id: string;
			question: string;
			details?: string;
			mode: "text" | "single-select" | "multi-select";
			options: DisplayOption[];
	  }
	| {
			/** Before a quiz that follows a teaching section: "Any questions about this section?" */
			kind: "pause";
			id: string;
	  }
	| {
			/** A graded quiz, shown until the learner clicks "Next question". */
			kind: "graded";
			id: string;
			result: QuizResultDetails;
	  };

export type QuizResultDetails = Record<string, unknown>;

export interface QuizAnswer {
	/** Set when the learner typed a message instead of answering. */
	skippedWith?: string;
	dontKnow?: boolean;
	selected?: number[];
	note?: string;
}

export interface AskAnswer {
	selected?: number[];
	other?: string;
	text?: string;
}

/** Hands interactions to whoever is showing the page, and waits for answers. */
export interface InteractionBroker {
	request<T>(interaction: PendingInteraction, signal: AbortSignal | undefined): Promise<T | undefined>;
	/**
	 * Called before a quiz is shown. Returns what the learner typed when they
	 * had a question about the section just taught, else undefined.
	 */
	beforeQuiz?(toolCallId: string, signal: AbortSignal | undefined): Promise<string | undefined>;
	/**
	 * True when the learner wrote something the tutor hasn't read yet. Cards the
	 * tutor queued before that are held back, so it can answer first.
	 */
	learnerWaiting?(): boolean;
	/** What the learner asked, while the tutor is trying to show this card without having answered it. */
	unansweredQuestion?(toolCallId: string): string | undefined;
	/** A quiz question is about to be shown: a picture for its explanation can be started now. */
	quizShown?(toolCallId: string, quiz: QuizAbout): void;
	/** The learner's open-ended answer to this question still has no written feedback before this card. */
	feedbackMissing?(toolCallId: string): string | undefined;
	/** The learner answered an open-ended question; the tutor owes them feedback on it. */
	openAnswered?(question: string): void;
	/**
	 * Why this card is too early (the tutor is wrapping up with plan sections
	 * still to teach), else undefined.
	 */
	sectionsLeft?(toolCallId: string, question: string, openEnded: boolean): string | undefined;
	/** Where the lesson is in the plan, for the tutor after each answer. */
	planProgress?(): string | undefined;
	/** Why a quiz question can't be shown now (the plan's sections are being taught), else undefined. */
	quizWhileTeaching?(toolCallId: string): string | undefined;
}

/** What a quiz question is about, for making a picture of its answer. */
export interface QuizAbout {
	question: string;
	context?: string;
	options: DisplayOption[];
	correctIndices: number[];
	explanation?: string;
}

const unanswered = (asked: string) =>
	`Not shown: the learner asked "${asked}" and you haven't answered it. Your next reply must START with a clear, full written answer to that question, before any tool call. Only after that, ask this again.`;
const noFeedback = (question: string) =>
	`Not shown: the learner answered your question "${question}" and you haven't given feedback on their answer. In this same reply, first write your feedback as normal text: what they got right, anything important they missed, and any mistakes corrected. Then call ask_learner again for this question. Never type a question as plain text for the learner to answer.`;
const HELD =
	"Not shown: the learner wrote something before this came up. Respond to what they wrote first, then ask this again if it still fits.";

/** Tool names, as the tutor sees them. */
export const QUIZ_TOOL = "quiz_question";
export const ASK_TOOL = "ask_learner";

function shuffled<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

// Models sometimes send booleans as strings.
const isTrue = (v: unknown) => v === true || v === "true";

// Rules for each tool; prompt.ts puts them in the system prompt.
export const QUIZ_GUIDELINES = [
	`Use ${QUIZ_TOOL} for the pre-test and the Final quiz only, never while teaching the plan's sections. For anything without a right answer, use ${ASK_TOOL}.`,
	"About 1 in 4 questions is a picture question: put a labelled svg drawing (markers A, B, C, D on the parts) or a find_image photo in context, and ask about it. The picture must not name or give away the answer.",
	"One question per call. Several short questions, each adjusted to the last answer, find gaps better than one long question.",
	"Mark the right choice with correct: true. If more than one choice is right, mark them all; the learner then has to pick exactly those.",
	"Every call needs an explanation, shown after the learner answers, saying why the right answer is right.",
	"Give a wrong choice a short feedback line when you can: what thinking leads to it and where it goes wrong. The learner sees it only if they pick that choice.",
	"Make wrong choices believable mistakes a real learner might make, but clearly wrong once understood. No trick questions.",
	"Keep all choices similar in length and style, so the right one doesn't stand out.",
	"Every choice must be a real possibility to someone who doesn't know this topic. Common sense, outside knowledge or the wording alone must never rule a choice out.",
	"Every choice must make sense on its own. No choice may contradict itself, the question, or well-known facts.",
	"All choices must be the same kind of thing (for example all doses, all nerves, or all time frames), in a similar range.",
	"Before asking, check each wrong choice: could someone who never studied this rule it out by logic alone? If so, replace it.",
	"The page always adds an \"I don't know yet\" button. Don't add your own. When the learner uses it, they didn't guess: treat it as something to teach, not as a mistake.",
	"The learner can add a note to their answer. If they did, read it and respond to it.",
	"Choices are shuffled before they're shown. Set fixed_order: true only when the order matters (for example numbers in order, or \"All of the above\" last).",
	"question, context and explanation are markdown and can include math ($...$), a mermaid or svg diagram, a chart, or a find_image photo. Use pictures here regularly (see Visuals).",
];

export const ASK_GUIDELINES = [
	"One question per call. It must be the only card in that reply: wait for the answer before anything else.",
	"Give choices when there are obvious answers; leave them out for a free-text reply. The learner can always type their own answer instead.",
	"Set pick_several: true only when the learner may choose more than one.",
	"If you'd suggest a choice, put it first and end it with \" (suggested)\".",
];

const QuizParams = Type.Object({
	question: Type.String({ description: "The question, in markdown." }),
	context: Type.Optional(Type.String({ description: "Optional extra material shown under the question: a case, a diagram, a photo." })),
	choices: Type.Array(
		Type.Object({
			text: Type.String({ description: "What the learner sees for this choice." }),
			correct: Type.Optional(Type.Boolean({ description: "true for each right choice." })),
			feedback: Type.Optional(
				Type.String({ description: "For a wrong choice: why someone might pick it and why it's wrong. Shown only if picked." }),
			),
		}),
		{ description: "2 to 6 choices, with at least one marked correct.", minItems: 2 },
	),
	explanation: Type.String({ description: "Shown after the learner answers: why the right answer is right." }),
	fixed_order: Type.Optional(Type.Boolean({ description: "true to show choices in the given order instead of shuffled." })),
});

export function createQuizTool(broker: InteractionBroker): ToolDefinition<typeof QuizParams> {
	return {
		name: QUIZ_TOOL,
		label: "Quiz",
		description:
			"Show the learner a multiple-choice question that has a right answer. The page marks their answer right or wrong, shows the right answer and your explanation, and waits for them to click Next question. Returns how they answered.",
		parameters: QuizParams,
		// One card at a time. In parallel mode, results are held back until the
		// whole batch is answered, so answered cards would go blank.
		executionMode: "sequential",

		async execute(toolCallId, params, signal) {
			const question = params.question;
			const details = params.context?.trim() || undefined;
			const explanation = params.explanation.trim();
			const unusable = (message: string) =>
				textResult(`This question couldn't be shown: ${message}. Fix it and ask again.`, { status: "unavailable", question, message });

			let choices = (params.choices ?? [])
				.map((c) => ({ text: c.text?.trim() ?? "", correct: isTrue(c.correct), feedback: c.feedback?.trim() || undefined }))
				.filter((c) => c.text);
			if (choices.length < 2) return unusable("it needs at least two choices");
			if (!choices.some((c) => c.correct)) return unusable("no choice is marked correct: true");
			if (!isTrue(params.fixed_order)) choices = shuffled(choices);

			const multiSelect = choices.filter((c) => c.correct).length > 1;
			const mode = multiSelect ? "multi-select" : "single-select";
			const options: DisplayOption[] = choices.map((c, i) => ({ index: i + 1, label: c.text }));
			const correctIndices = options.filter((o) => choices[o.index - 1].correct).map((o) => o.index);

			if (broker.learnerWaiting?.()) return textResult(HELD, { status: "held", question });
			const open = broker.unansweredQuestion?.(toolCallId);
			if (open) return textResult(unanswered(open), { status: "unanswered", question });
			const owed = broker.feedbackMissing?.(toolCallId);
			if (owed) return textResult(noFeedback(owed), { status: "unanswered", question });
			const early = broker.sectionsLeft?.(toolCallId, question, false);
			if (early) return textResult(early, { status: "unanswered", question });
			const teaching = broker.quizWhileTeaching?.(toolCallId);
			if (teaching) return textResult(teaching, { status: "unanswered", question });
			const asked = await broker.beforeQuiz?.(toolCallId, signal);
			if (asked) {
				const message = `The learner had a question about the section you just taught, so this quiz question wasn't shown yet. They asked: ${asked}\nAnswer them first, then ask this quiz question again.`;
				return textResult(message, { status: "paused", question, mode, message: "You asked a question first", skippedWith: asked });
			}

			broker.quizShown?.(toolCallId, { question, context: details, options, correctIndices, explanation });
			const answer = await broker.request<QuizAnswer>(
				{ kind: "quiz", id: toolCallId, question, details, multiSelect, options },
				signal,
			);
			if (!answer) return textResult("The quiz question was cancelled.", { status: "cancelled", question, mode, message: "Cancelled" });
			if (answer.skippedWith !== undefined) {
				return textResult(`The learner didn't answer the quiz question. They wrote instead: ${answer.skippedWith}`, {
					status: "cancelled",
					question,
					mode,
					message: "Skipped",
					skippedWith: answer.skippedWith,
				});
			}

			const note = answer.note?.trim() || undefined;
			const dontKnow = answer.dontKnow === true;
			const selected = dontKnow
				? []
				: [...new Set(answer.selected ?? [])].filter((i) => i >= 1 && i <= options.length).sort((a, b) => a - b);
			const correct =
				!dontKnow && selected.length === correctIndices.length && selected.every((v, i) => v === correctIndices[i]);
			const feedback = selected
				.filter((i) => !choices[i - 1].correct && choices[i - 1].feedback)
				.map((i) => choices[i - 1].feedback as string);
			const quote = (i: number) => `"${options[i - 1].label}"`;
			const rightAnswer = correctIndices.map(quote).join(" and ");

			const lines = [`Question: ${question}`];
			if (dontKnow) lines.push(`The learner pressed "I don't know yet" (an honest gap, not a guess). The right answer: ${rightAnswer}.`);
			else if (correct) lines.push(`The learner got it right: ${selected.map(quote).join(" and ")}.`);
			else lines.push(`The learner got it wrong. They chose ${selected.map(quote).join(" and ") || "nothing"}; the right answer: ${rightAnswer}.`);
			if (note) lines.push(`Their note: ${note}`);
			lines.push("They have seen your explanation. Build on what this answer shows about their understanding.");
			const progress = broker.planProgress?.();
			if (progress) lines.push(progress);

			const result = {
				status: "answered",
				question,
				context: details,
				mode,
				options,
				answers: selected.map((i) => ({ index: i, label: options[i - 1].label })),
				correctIndices,
				correct,
				dontKnow,
				note,
				explanation,
				feedback,
			};
			// Let the learner read the feedback; the lesson goes on when they click
			// "Next question" (or type a message).
			await broker.request({ kind: "graded", id: toolCallId, result }, signal);
			return textResult(lines.join("\n"), result);
		},
	};
}

const AskParams = Type.Object({
	question: Type.String({ description: "The question, in markdown." }),
	context: Type.Optional(Type.String({ description: "Optional extra detail shown under the question." })),
	choices: Type.Optional(
		Type.Array(Type.String(), { description: "Answers to pick from. Leave out for a free-text reply." }),
	),
	pick_several: Type.Optional(Type.Boolean({ description: "true if the learner may pick more than one choice." })),
});

export function createAskTool(broker: InteractionBroker): ToolDefinition<typeof AskParams> {
	return {
		name: ASK_TOOL,
		label: "Question",
		description:
			"Ask the learner something that has no right answer, such as their goal, a choice about the lesson, or a free-text reply, and wait for their answer.",
		parameters: AskParams,
		executionMode: "sequential",

		async execute(toolCallId, params, signal) {
			const question = params.question;
			const details = params.context?.trim() || undefined;
			const labels = [...new Set((params.choices ?? []).map((c) => String(c).trim()).filter(Boolean))];
			const mode = labels.length === 0 ? "text" : isTrue(params.pick_several) ? "multi-select" : "single-select";
			const options: DisplayOption[] = labels.map((label, i) => ({ index: i + 1, label }));

			if (broker.learnerWaiting?.()) return textResult(HELD, { status: "held", question, mode });
			const open = broker.unansweredQuestion?.(toolCallId);
			if (open) return textResult(unanswered(open), { status: "unanswered", question, mode });
			const owed = broker.feedbackMissing?.(toolCallId);
			if (owed) return textResult(noFeedback(owed), { status: "unanswered", question, mode });
			const early = broker.sectionsLeft?.(toolCallId, question, mode === "text");
			if (early) return textResult(early, { status: "unanswered", question, mode });
			const answer = await broker.request<AskAnswer>(
				{ kind: "ask", id: toolCallId, question, details, mode, options },
				signal,
			);
			if (!answer) return textResult("The question was cancelled.", { status: "cancelled", question, mode, message: "Cancelled" });

			const answers: Array<{ type: "text" | "option" | "other"; label: string; index?: number }> = [];
			if (mode === "text") {
				answers.push({ type: "text", label: answer.text?.trim() ?? "" });
			} else {
				for (const i of [...new Set(answer.selected ?? [])].sort((a, b) => a - b)) {
					if (i >= 1 && i <= options.length) answers.push({ type: "option", label: options[i - 1].label, index: i });
				}
				const other = answer.other?.trim();
				if (other) answers.push({ type: "other", label: other });
			}

			const said = answers.map((a) => (a.type === "other" ? `(in their own words) ${a.label}` : a.label)).filter(Boolean);
			let text = said.length
				? `Question: ${question}\nThe learner answered: ${said.join("; ")}`
				: `Question: ${question}\nThe learner sent an empty answer.`;
			// An answer in their own words gets feedback before anything else.
			if (mode === "text" && said.length) {
				broker.openAnswered?.(question);
				text += "\nBefore asking anything else, give written feedback on this answer: what they got right, anything important they missed, and any mistakes corrected.";
			}
			return textResult(text, { status: "answered", question, context: details, mode, options, answers });
		},
	};
}
