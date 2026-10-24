// Browser versions of Pi Learn's two interactive tools, `quiz` and
// `ask_user_question`. The originals draw popups in the terminal, which pi's
// SDK can't show in a browser, so these keep the same names, parameters and
// model-facing results but hand the question to the web page and wait for the
// learner's answer.
//
// The correct answer and explanation never leave the server until the learner
// has answered.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
}

interface Option {
	label: string;
	value: string;
	description?: string;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option." }),
	value: Type.Optional(
		Type.String({ description: "Optional machine-readable value for the option. Defaults to the label." }),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

function normalizeOptions(raw: Array<{ label: string; value?: string; description?: string }> | undefined): Option[] {
	const seen = new Set<string>();
	const out: Option[] = [];
	for (const o of raw ?? []) {
		const label = o.label?.trim() ?? "";
		if (!label) continue;
		const value = o.value?.trim() || label;
		if (seen.has(value)) throw new Error(`duplicate option value "${value}"`);
		seen.add(value);
		out.push({ label, value, description: o.description?.trim() || undefined });
	}
	return out;
}

function shuffled<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function toDisplay(options: Option[]): DisplayOption[] {
	return options.map((o, i) => ({ index: i + 1, label: o.label, description: o.description }));
}

function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

// Models sometimes send a multi-select answer list as a JSON string.
function correctValues(correctAnswer: string | string[]): string[] {
	if (Array.isArray(correctAnswer)) return correctAnswer.map(String);
	const trimmed = correctAnswer.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch {
			// Not JSON; treat it as one literal value.
		}
	}
	return [correctAnswer];
}

// pi only adds promptGuidelines to its default system prompt, and this app
// replaces that prompt, so prompt.ts also includes these lists itself.
export const QUIZ_GUIDELINES = [
	"quiz is GRADED; ask_user_question is not. If the question has a correct answer, use quiz. For a preference, decision, or open-ended input, use ask_user_question.",
	"correctAnswer is REQUIRED and is the option value, not a position number. Single-select: one string. Multi-select: an array of strings.",
	"explanation is REQUIRED: always say why the correct answer is correct.",
	"Multi-select is graded as an exact-set match.",
	"An 'I don't know' choice is ALWAYS added automatically. Provide ONLY the real, gradable options (at least two). Never add your own 'I don't know' or 'Not sure' option.",
	"If a result comes back as \"I don't know\", the user honestly did not know and did NOT guess: treat it as a genuine knowledge gap to teach into, not as a wrong answer.",
	"Any answer may carry an optional note the user typed. When present, read it and let it steer your follow-up.",
	"Make each wrong option a specific, believable mistake (a common misconception or an easily-confused neighbour), so WHICH wrong answer the user picks reveals which part of their understanding is off.",
	"Every distractor must be unambiguously wrong on the intended reading: tempting, not a trick.",
	"Don't let the correct answer stand out by form (longest, most precise, most hedged). Keep options similar in length, specificity and phrasing.",
	"Set multiSelect: true only when more than one option is correct.",
	"Options are shuffled before display by default. Set shuffle: false only when order is meaningful.",
	"To probe nuance, ask several quick quiz questions and adapt each to the previous answers, rather than one giant question.",
	"Math in questions, options and explanations renders as LaTeX: use $...$ inline.",
];

export const ASK_GUIDELINES = [
	"Ask exactly one question per tool call; use separate calls for separate questions.",
	'Users can always select "Other" to type a custom answer when options are provided.',
	"Use multiSelect: true only when you need multiple answers to the same question.",
	'If you recommend an option, make it first and add "(Recommended)" to its label.',
];

const QuizParams = Type.Object({
	question: Type.String({ description: "The single quiz question to ask. Ask exactly one question per tool call." }),
	details: Type.Optional(Type.String({ description: "Optional extra context shown under the question." })),
	options: Type.Array(OptionSchema, {
		description:
			"The answer options (2 or more). Options only, no free text. Give each option a stable `value`; reference the correct one by that value in correctAnswer.",
		minItems: 2,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set to true when more than one option is correct and the user must select all of them." }),
	),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			'REQUIRED. The correct option value(s). Single-select: one string (e.g. "mercury"). Multi-select: an array of strings; the user is correct only if their selection matches this set exactly.',
	}),
	explanation: Type.String({
		description: "REQUIRED. Explanation revealed AFTER the user answers, right or wrong. Say why the correct answer is correct.",
	}),
	shuffle: Type.Optional(
		Type.Boolean({
			description:
				"Defaults to true: options are shuffled before display. Set false only when order is meaningful (ordered values, or 'All/None of the above' that must stay last).",
		}),
	),
});

export function createQuizTool(broker: InteractionBroker): ToolDefinition<typeof QuizParams> {
	return {
		name: "quiz",
		label: "Quiz",
		description:
			"Ask the user a GRADED question with a known correct answer, then instantly grade and give feedback. Unlike ask_user_question (preferences/decisions with no right answer), quiz always has a correct answer supplied by you, marks the user's selection right or wrong, reveals the correct answer, and shows your explanation. Use it to (1) assess what the learner already understands before teaching, and (2) run practice/retrieval checks after explaining. Options only: single-select or multi-select, plus an automatic 'I don't know' choice so the user can signal a genuine gap instead of guessing. The user can attach an optional free-text note to any answer.",
		promptSnippet:
			"Use the quiz tool to test the user with a graded multiple-choice or multi-select question (required correct answer + required explanation). For non-graded questions, use ask_user_question.",
		promptGuidelines: QUIZ_GUIDELINES,
		parameters: QuizParams,
		// One card at a time. In parallel mode, pi holds back every result until
		// the whole batch is answered, so answered cards would go blank.
		executionMode: "sequential",

		async execute(toolCallId, params, signal) {
			const question = params.question;
			const details = params.details?.trim() || undefined;
			const multiSelect = params.multiSelect === true;
			const explanation = params.explanation.trim();
			const mode = multiSelect ? "multi-select" : "single-select";
			const fail = (message: string) => textResult(message, { status: "unavailable", question, mode, message });

			let options: Option[];
			try {
				options = normalizeOptions(params.options);
			} catch (e) {
				return fail(`quiz ${(e as Error).message}`);
			}
			if (options.length < 2) return fail("quiz requires at least two options");
			if (params.shuffle !== false) options = shuffled(options);

			// Resolve correct indices AFTER shuffling so grading matches what the user sees.
			const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
			const correctIndices: number[] = [];
			for (const raw of correctValues(params.correctAnswer as string | string[])) {
				const idx = byValue.get(raw.trim());
				if (idx === undefined) {
					const known = options.map((o) => `"${o.value}"`).join(", ");
					return fail(`quiz correctAnswer "${raw}" does not match any option value (${known})`);
				}
				if (!correctIndices.includes(idx)) correctIndices.push(idx);
			}
			correctIndices.sort((a, b) => a - b);
			if (correctIndices.length === 0) return fail("quiz correctAnswer is required");

			const displayOptions = toDisplay(options);
			const answer = await broker.request<QuizAnswer>(
				{ kind: "quiz", id: toolCallId, question, details, multiSelect, options: displayOptions },
				signal,
			);
			if (!answer) {
				const message = "User cancelled the quiz";
				return textResult(message, { status: "cancelled", question, mode, message });
			}

			if (answer.skippedWith !== undefined) {
				const message = `User skipped the quiz without answering and wrote instead: ${answer.skippedWith}`;
				return textResult(message, {
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
				!dontKnow &&
				selected.length === correctIndices.length &&
				selected.every((v, i) => v === correctIndices[i]);
			const ref = (i: number) => `${i}. ${options[i - 1].label}`;
			const correctStr = correctIndices.map(ref).join(", ");

			let text: string;
			if (dontKnow) {
				text = `User selected "I don't know" — they did not attempt an answer (a genuine knowledge gap, not a wrong guess).\nCorrect: ${correctStr}`;
			} else {
				text = `User answered ${correct ? "correctly" : "incorrectly"}.\nSelected: ${selected.map(ref).join(", ")}\nCorrect: ${correctStr}`;
			}
			if (note) text += `\nUser's note: ${note}`;
			if (explanation) text += `\nExplanation: ${explanation}`;

			const result = {
				status: "answered",
				question,
				context: details,
				mode,
				options: displayOptions,
				answers: selected.map((i) => ({ index: i, label: options[i - 1].label, value: options[i - 1].value })),
				correctIndices,
				correct,
				dontKnow,
				note,
				explanation,
			};
			// Let the learner read the feedback; the lesson goes on when they click
			// "Next question" (or type a message).
			await broker.request({ kind: "graded", id: toolCallId, result }, signal);
			return textResult(text, result);
		},
	};
}

const AskParams = Type.Object({
	question: Type.String({ description: "The single question to ask the user. Ask exactly one question per tool call." }),
	details: Type.Optional(Type.String({ description: "Optional extra context shown under the question." })),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String({
					description:
						'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
				}),
				value: Type.Optional(Type.String({ description: "Optional machine-readable value. Defaults to the label." })),
				description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
			}),
			{
				description:
					"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users can always choose Other and type a custom answer when options are provided.",
			},
		),
	),
	multiSelect: Type.Optional(Type.Boolean({ description: "Set to true to allow multiple answers to be selected." })),
});

export function createAskTool(broker: InteractionBroker): ToolDefinition<typeof AskParams> {
	return {
		name: "ask_user_question",
		label: "Question",
		description:
			"Ask the user a single question and pause until they answer. Use this when requirements are ambiguous, user preferences are needed, or a decision would materially affect what you do next. Ask exactly one question per tool call.",
		promptSnippet:
			"Use this tool to ask exactly one clarifying, preference, or decision question (no right answer) before continuing.",
		promptGuidelines: ASK_GUIDELINES,
		parameters: AskParams,
		executionMode: "sequential",

		async execute(toolCallId, params, signal) {
			const question = params.question;
			const details = params.details?.trim() || undefined;
			let options: Option[];
			try {
				options = normalizeOptions(params.options);
			} catch {
				options = (params.options ?? []).map((o) => ({ label: o.label.trim(), value: o.label.trim() }));
			}
			const mode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";
			const displayOptions = toDisplay(options);

			const answer = await broker.request<AskAnswer>(
				{ kind: "ask", id: toolCallId, question, details, mode, options: displayOptions },
				signal,
			);
			if (!answer) {
				const message = "User cancelled the question";
				return textResult(message, { status: "cancelled", question, mode, message });
			}

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

			const fmt = (a: (typeof answers)[number]) =>
				a.type === "option" ? `${a.index}. ${a.label}` : a.type === "other" ? `Other: ${a.label}` : a.label;
			let text: string;
			if (mode === "text") {
				text = answers[0].label ? `User answered: ${answers[0].label}` : "User submitted an empty response";
			} else if (answers.length === 0) {
				text = "User submitted without choosing an option";
			} else if (mode === "single-select") {
				text = `User selected: ${fmt(answers[0])}`;
			} else {
				text = `User selected:\n${answers.map((a) => `- ${fmt(a)}`).join("\n")}`;
			}

			return textResult(text, { status: "answered", question, context: details, mode, options: displayOptions, answers });
		},
	};
}
