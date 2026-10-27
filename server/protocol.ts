// Messages exchanged between the server and the web page over the WebSocket.
// Shared by both sides, so keep it free of Node-only imports.

import type { PendingInteraction } from "./tools.ts";
import type { UpdateStatus } from "./update.ts";

export type { DisplayOption, PendingInteraction, QuizAnswer, AskAnswer } from "./tools.ts";
export type { UpdateStatus } from "./update.ts";

export type TranscriptItem =
	| { kind: "user"; text: string }
	| {
			kind: "assistant";
			/** Identifies this part of the tutor's message, for pictures. */
			id: string;
			text: string;
			/** Pictures the app added (markdown), shown after the text. */
			pictures?: string[];
			/** True while the app is making a picture for it. */
			drawing?: boolean;
	  }
	| { kind: "error"; text: string; /** The lesson can carry on from here with Try again. */ retry?: boolean }
	/** The learner's own learning material (a file or web page), shown compactly. */
	| { kind: "resource"; name: string; source: string; chars: number; truncated: boolean }
	| {
			kind: "quiz" | "ask";
			id: string;
			question: string;
			details?: string;
			/** The tool's result details once answered; null while waiting. */
			result: any | null;
			pictures?: string[];
			drawing?: boolean;
	  };

export interface TutorState {
	signedIn: boolean;
	model: { provider: string; id: string; name: string } | null;
	thinkingLevel: string;
	thinkingLevels: string[];
	/** Whether LILA directs each step of the lesson. */
	guidedSteps: boolean;
	busy: boolean;
	lessonPath: string | null;
	lessonTitle: string | null;
	error: string | null;
	/** Photos from Google Images are set up. */
	webPhotos: boolean;
	/** Set while LILA waits to try a busy AI service again. */
	retrying: string | null;
}

export interface LessonSummary {
	path: string;
	title: string;
	modified: string;
	/** The folder the learner put it in, if any. */
	folder?: string;
}

export type LessonSort = "newest" | "oldest" | "name";

export interface ProviderInfo {
	id: string;
	name: string;
	apiKeyName?: string;
	oauthName?: string;
	configured: boolean;
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
}

export type LoginPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: { id: string; label: string; description?: string }[] };

export type LoginEvent =
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string }
	| { type: "progress"; message: string };

export type ServerMessage =
	/** First message on every connection; a new version means the page should reload. */
	| { type: "hello"; version: string }
	| { type: "state"; state: TutorState }
	| { type: "update"; status: UpdateStatus }
	/** A learning resource finished loading (or failed). */
	| { type: "resource_done"; ok: boolean; error?: string }
	| { type: "transcript"; items: TranscriptItem[] }
	| { type: "streaming"; text: string | null }
	/** What the tutor is busy with, for the spinner; null when it's just working. */
	| { type: "activity"; text: string | null }
	| { type: "interaction"; interaction: PendingInteraction }
	| { type: "interaction_done"; id: string }
	| { type: "lessons"; lessons: LessonSummary[]; folders: string[]; sort: LessonSort }
	| { type: "providers"; providers: ProviderInfo[]; models: ModelInfo[] }
	| { type: "login_prompt"; id: string; prompt: LoginPrompt }
	| { type: "login_event"; event: LoginEvent }
	| { type: "login_done"; ok: boolean; error?: string }
	| { type: "export"; filename: string; markdown: string }
	/** The end of the picture log, for the learner to copy and share. */
	| { type: "picture_log"; text: string }
	| { type: "error"; message: string };

export type ClientMessage =
	| { type: "prompt"; text: string; /** Typed into a "Questions?" box. */ question?: boolean }
	| { type: "answer"; id: string; answer: unknown }
	| { type: "abort" }
	| { type: "retry" }
	| { type: "new_lesson" }
	| { type: "open_lesson"; path: string }
	| { type: "export_lesson" }
	| { type: "list_providers" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking"; level: string }
	| { type: "set_guided"; on: boolean }
	| { type: "set_photo_key"; key: string }
	| { type: "login_start"; provider: string; method: "api_key" | "oauth" }
	| { type: "login_reply"; id: string; value: string }
	| { type: "login_cancel" }
	| { type: "logout"; provider: string }
	| { type: "add_file"; name: string; data: string }
	| { type: "add_link"; url: string }
	/** The lesson list's right-click menu. */
	| { type: "delete_lesson"; path: string }
	| { type: "rename_lesson"; path: string; title: string }
	| { type: "move_lesson"; path: string; folder: string | null }
	| { type: "new_folder"; name: string; path?: string }
	| { type: "rename_folder"; from: string; to: string }
	| { type: "delete_folder"; name: string }
	| { type: "sort_lessons"; sort: LessonSort }
	/** Opens a past lesson and starts a quiz on it with all-new questions. */
	| { type: "review_lesson"; path: string }
	/** A picture the app added couldn't be shown. */
	| { type: "picture_broken"; id: string; picture: string }
	| { type: "check_update" }
	| { type: "get_picture_log" }
	| { type: "start_update" };
