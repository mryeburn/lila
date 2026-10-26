// Which part of the lesson each transcript item is in, from the tutor's
// headings so far. Shared by the page (card labels, start buttons) and the
// lesson download.

import type { TranscriptItem } from "./protocol.ts";

export type QuizPhase = "pre-test" | "lesson" | "final" | "review";

/** What a quiz card is called in each part of the lesson. */
export const QUIZ_LABEL: Record<QuizPhase, string> = {
	"pre-test": "Pre-test",
	lesson: "Quiz",
	final: "Final quiz",
	review: "Review quiz",
};

export function quizPhases(items: TranscriptItem[]): QuizPhase[] {
	let phase: QuizPhase = "pre-test";
	return items.map((item) => {
		if (item.kind === "assistant") {
			const headings = item.text.match(/^\s*(#{1,6}\s.*|\*\*[^*]+\*\*\s*)$/gm) ?? [];
			for (const h of headings) {
				if (/pre-?test complete|learning plan/i.test(h) && phase === "pre-test") phase = "lesson";
				if (/final quiz/i.test(h)) phase = "final";
				if (/review quiz/i.test(h)) phase = "review";
			}
		}
		return phase;
	});
}
