// LILA directs the lesson one step at a time. Before each AI reply it works
// out, from the lesson so far, which step comes next ("pre-test question 3",
// "teach Section 2", "feedback on this answer") and tells the tutor only that
// step, with the tools that step needs. Cards from any other tool are sent
// back, so the tutor can't skip ahead or wander off.
//
// The order:
//   setup questions (goal, level, files) → pre-test (3 to 6 questions) →
//   "Pre-test complete" and "Your learning plan" → each section in turn →
//   Final quiz (multiple choice, then 2 or 3 "In your own words" questions,
//   each followed by feedback) → How you've progressed, Summary, What to
//   learn next.
// After that (a review quiz, a re-test, questions) the tutor is left free.

import { ASK_TOOL, QUIZ_TOOL } from "./tools.ts";

export interface Step {
	/** Short name, for the troubleshooting log. */
	name: string;
	/** What the tutor must do now, in words for the AI. */
	note: string;
	/** The only tools the tutor may use in this reply. */
	tools: string[];
}

const SEARCH = ["find_image", "find_video"];
const PRETEST_MIN = 3;
const PRETEST_MAX = 6;
const FINAL_MIN = 4;
const FINAL_MAX = 8;
const OPEN_MIN = 2;
const OPEN_MAX = 3;
/** How to ask the pre-test: every question in one reply, so the learner never waits between them. */
const ALL_PRETEST =
	"all the pre-test questions in this one reply, as quiz_question cards, one per main area of the topic (3 to 6 in all). The learner sees them one at a time. For a picture question, call find_image in this reply too, after the cards: the search runs while the learner answers, and you ask the picture question in your next reply.";

const HEADING = /^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*$)/;
const SECTION_HEADING = /^\s*(?:#{1,6}\s*|\*\*)\s*Section\s+(\d+)\b/i;

/** Where the lesson is, counted from its messages. */
interface Progress {
	/** Any card asked yet (the goal question comes first). */
	asked: boolean;
	pretestAnswers: number;
	/** "Pre-test complete" or "Your learning plan" written. */
	pretestDone: boolean;
	sections: string[];
	taught: Set<number>;
	finalStarted: boolean;
	finalAnswers: number;
	openAnswers: number;
	/** The last open-ended answer, still waiting for feedback. */
	feedbackDue: boolean;
	wrappedUp: boolean;
	/** A review quiz or anything after the end: the tutor is free. */
	free: boolean;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
}

function headings(text: string): string[] {
	return text.split("\n").filter((l) => HEADING.test(l));
}

export function progress(messages: any[]): Progress {
	const p: Progress = {
		asked: false,
		pretestAnswers: 0,
		pretestDone: false,
		sections: [],
		taught: new Set(),
		finalStarted: false,
		finalAnswers: 0,
		openAnswers: 0,
		feedbackDue: false,
		wrappedUp: false,
		free: false,
	};
	for (const m of messages) {
		if (m.role === "assistant") {
			const text = textOf(m.content);
			const lines = text.split("\n");
			for (const h of headings(text)) {
				if (/pre-?test complete|learning plan/i.test(h)) p.pretestDone = true;
				if (/final quiz/i.test(h)) p.finalStarted = true;
				if (/review quiz|how you did/i.test(h)) p.free = true;
				if (p.finalStarted && /how you.ve progressed|^\W*summary\b|what to learn next/i.test(h.replace(/^[\s#*]+/, ""))) p.wrappedUp = true;
				const n = Number(SECTION_HEADING.exec(h)?.[1]);
				if (n && !p.finalStarted) p.taught.add(n);
			}
			const plan = lines.findIndex((l) => HEADING.test(l) && /learning plan/i.test(l));
			if (plan >= 0) {
				const sections: string[] = [];
				for (const line of lines.slice(plan + 1)) {
					if (HEADING.test(line)) break;
					const item = /^\s*\d+[.)]\s+(.+)/.exec(line);
					if (item) sections.push(item[1].replace(/\*\*/g, "").trim());
				}
				if (sections.length > 0) {
					p.sections = sections;
					// Sections taught in the same reply as the plan.
					p.taught = new Set();
					for (const l of lines.slice(plan + 1)) {
						const n = Number(SECTION_HEADING.exec(l)?.[1]);
						if (n) p.taught.add(n);
					}
				}
			}
			// Feedback written after an open-ended answer.
			if (p.feedbackDue && text.trim().length >= 80) p.feedbackDue = false;
			if ((m.content ?? []).some((b: any) => b.type === "toolCall" && (b.name === QUIZ_TOOL || b.name === ASK_TOOL))) p.asked = true;
		} else if (m.role === "toolResult" && m.details?.status === "answered") {
			if (m.toolName === QUIZ_TOOL) {
				if (p.finalStarted) p.finalAnswers++;
				else if (!p.pretestDone) p.pretestAnswers++;
			} else if (m.toolName === ASK_TOOL && p.finalStarted && m.details?.mode === "text") {
				p.openAnswers++;
				p.feedbackDue = true;
			}
		} else if (m.role === "toolResult" && m.details?.status === "feedback") {
			// LILA wrote the owed feedback itself.
			p.feedbackDue = false;
		}
	}
	if (p.wrappedUp) p.free = true;
	return p;
}

/**
 * The step the tutor's next reply should take, or undefined to leave it free.
 * `asked`: the learner just asked something, which is answered first.
 */
export function nextStep(messages: any[], asked = false): Step | undefined {
	const last = messages.at(-1);
	// Only when the tutor is about to answer something.
	if (!last || (last.role !== "user" && last.role !== "toolResult")) return undefined;
	const p = progress(messages);
	if (p.free) return undefined;
	const step = stepFor(p);
	if (!step || !asked) return step;
	return {
		name: `answer, then ${step.name}`,
		note: `The learner asked something. First answer it clearly and fully in writing, with no card before your answer. Then carry on: ${step.note}`,
		tools: [...new Set([...step.tools, ...SEARCH])],
	};
}

function stepFor(p: Progress): Step | undefined {
	// Setup: the goal, the level and the learner's files, then the first pre-test question.
	if (!p.pretestDone && p.pretestAnswers === 0) {
		if (!p.asked)
			return {
				name: "goal question",
				note: "Ask what the learner wants out of the topic, with ask_learner and the five choices word for word. Nothing else in this reply.",
				tools: [ASK_TOOL],
			};
		return {
			name: "setup",
			note: `Finish the setup questions in order with ask_learner, one per reply (the level question only if the goal doesn't show it, then files and links). Once those are done, start the pre-test: one sentence on what's coming, then ${ALL_PRETEST}`,
			tools: [ASK_TOOL, QUIZ_TOOL, "find_image"],
		};
	}

	// Pre-test.
	if (!p.pretestDone) {
		const n = p.pretestAnswers + 1;
		const feedback = "No comment on the answers (their cards already explained them), and no teaching yet.";
		const finish =
			'write the heading "Pre-test complete" with its summary, then "Your learning plan" as a numbered list, then stop: Section 1 comes in your next reply, once the learner has read the plan. No cards, no pictures, no teaching yet.';
		if (n <= PRETEST_MIN)
			return {
				name: `pre-test questions from ${n}`,
				note: `${p.pretestAnswers} pre-test question${p.pretestAnswers === 1 ? " is" : "s are"} answered. ${feedback} Ask the rest of the pre-test now (at least ${PRETEST_MIN - p.pretestAnswers} more, on main areas not tested yet): ${ALL_PRETEST}`,
				tools: [QUIZ_TOOL, "find_image"],
			};
		if (n <= PRETEST_MAX)
			return {
				name: `pre-test question ${n} or plan`,
				note: `${p.pretestAnswers} pre-test questions are answered. ${feedback} If you searched for a photo for a picture question, ask that question now. If a main area of the topic still has no question, ask the questions still needed, all in this reply, with quiz_question. Otherwise the pre-test is done: ${finish}`,
				tools: [QUIZ_TOOL, ...SEARCH],
			};
		return {
			name: "pre-test summary and plan",
			note: `The pre-test is done (${p.pretestAnswers} questions). Ask no more. Now ${finish}`,
			tools: [],
		};
	}

	// Teaching, section by section.
	if (!p.finalStarted) {
		if (p.sections.length === 0) {
			if (p.taught.size === 0)
				return {
					name: "plan",
					note: 'Write "Your learning plan" as a numbered list, then stop: Section 1 comes in your next reply, once the learner has read the plan. No cards.',
					tools: SEARCH,
				};
			const next = Math.max(...p.taught) + 1;
			return {
				name: `section ${next} or Final quiz`,
				note: `Teach the next section under the heading "Section ${next}: name" and stop at its end, with no cards. If every part of the topic is already taught, start the Final quiz instead: the heading "Final quiz", one sentence saying the teaching part is done, then the first quiz_question.`,
				tools: [QUIZ_TOOL, ...SEARCH],
			};
		}
		const left = p.sections.map((name, i) => ({ n: i + 1, name })).filter((s) => !p.taught.has(s.n));
		if (left.length > 0) {
			const s = left[0];
			return {
				name: `section ${s.n}`,
				note: `Teach Section ${s.n} of ${p.sections.length} under the heading "Section ${s.n}: ${s.name}", then stop at its end. Only this section: no quiz or question cards, and don't start the next section. Before sending, check it for statements that seem to contradict each other and for comparisons that could be read two ways.`,
				tools: SEARCH,
			};
		}
		return {
			name: "start Final quiz",
			note: 'Every section is taught. Start the Final quiz: the heading "Final quiz", one sentence telling the learner the teaching part is done and it\'s time to see how much they\'ve learned, then the multiple-choice questions with quiz_question (you may send them all in this reply).',
			tools: [QUIZ_TOOL, "find_image"],
		};
	}

	// Final quiz: multiple choice, then open-ended questions with feedback, then the wrap-up.
	const wrapUp =
		'write the wrap-up: "How you\'ve progressed", then "Summary", then "What to learn next". No cards: the lesson ends there.';
	const open = (n: number) =>
		`ask "In your own words" question ${n} with one ask_learner card and no choices, as the only card in this reply.`;
	if (p.feedbackDue) {
		const then =
			p.openAnswers < OPEN_MIN
				? `Then ${open(p.openAnswers + 1)}`
				: p.openAnswers < OPEN_MAX
					? `Then either ${open(p.openAnswers + 1)} Or, if the big picture is covered, ${wrapUp}`
					: `Then ${wrapUp}`;
		return {
			name: `feedback on open answer ${p.openAnswers}`,
			note: `The learner just answered an open-ended question. Your reply must START with written feedback on their answer, before any card: what they got right, anything important they missed, and any mistakes corrected. ${then}`,
			tools: p.openAnswers < OPEN_MAX ? [ASK_TOOL, ...SEARCH] : SEARCH,
		};
	}
	if (p.openAnswers === 0) {
		if (p.finalAnswers < FINAL_MIN)
			return {
				name: "Final quiz questions",
				note: `Carry on with the Final quiz: multiple-choice questions with quiz_question (${p.finalAnswers} answered so far, about ${FINAL_MIN} to ${FINAL_MAX} in all).`,
				tools: [QUIZ_TOOL, "find_image"],
			};
		if (p.finalAnswers < FINAL_MAX)
			return {
				name: "Final quiz or open question 1",
				note: `${p.finalAnswers} Final quiz questions are answered. Ask the rest of your multiple-choice questions if any area isn't covered yet; otherwise ${open(1)}`,
				tools: [QUIZ_TOOL, ASK_TOOL, "find_image"],
			};
		return { name: "open question 1", note: `The multiple-choice part is done. Now ${open(1)}`, tools: [ASK_TOOL] };
	}
	if (p.openAnswers < OPEN_MAX) return { name: `open question ${p.openAnswers + 1}`, note: `Now ${open(p.openAnswers + 1)}`, tools: [ASK_TOOL] };
	return { name: "wrap-up", note: `Now ${wrapUp}`, tools: SEARCH };
}

/** What the tutor is told when it uses a tool that isn't part of this step. */
export function offStep(tool: string, step: Step): string {
	return `Not shown: ${tool} isn't part of this step of the lesson. ${step.note}`;
}
