// Messages exchanged between the server and the web page over the WebSocket.
// Shared by both sides, so keep it free of Node-only imports.

import type { PendingInteraction } from "./tools.ts";

export type { DisplayOption, PendingInteraction, QuizAnswer, AskAnswer } from "./tools.ts";

export type TranscriptItem =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "error"; text: string }
	| {
			kind: "quiz" | "ask";
			id: string;
			question: string;
			details?: string;
			/** The tool's result details once answered; null while waiting. */
			result: any | null;
	  };

export interface TutorState {
	signedIn: boolean;
	model: { provider: string; id: string; name: string } | null;
	thinkingLevel: string;
	thinkingLevels: string[];
	busy: boolean;
	lessonPath: string | null;
	lessonTitle: string | null;
	error: string | null;
}

export interface LessonSummary {
	path: string;
	title: string;
	modified: string;
}

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
	| { type: "state"; state: TutorState }
	| { type: "transcript"; items: TranscriptItem[] }
	| { type: "streaming"; text: string | null }
	| { type: "interaction"; interaction: PendingInteraction }
	| { type: "interaction_done"; id: string }
	| { type: "lessons"; lessons: LessonSummary[] }
	| { type: "providers"; providers: ProviderInfo[]; models: ModelInfo[] }
	| { type: "login_prompt"; id: string; prompt: LoginPrompt }
	| { type: "login_event"; event: LoginEvent }
	| { type: "login_done"; ok: boolean; error?: string }
	| { type: "export"; filename: string; markdown: string }
	| { type: "error"; message: string };

export type ClientMessage =
	| { type: "prompt"; text: string }
	| { type: "answer"; id: string; answer: unknown }
	| { type: "abort" }
	| { type: "new_lesson" }
	| { type: "open_lesson"; path: string }
	| { type: "export_lesson" }
	| { type: "list_providers" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking"; level: string }
	| { type: "login_start"; provider: string; method: "api_key" | "oauth" }
	| { type: "login_reply"; id: string; value: string }
	| { type: "login_cancel" }
	| { type: "logout"; provider: string };
