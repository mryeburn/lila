// LILA's conversation with the AI tutor: sends the lesson so far to the AI,
// streams its reply, runs the tools it calls (quiz cards, questions, picture
// and video search), and keeps going until the tutor has nothing left to do.
//
// The AI connection itself (Claude, OpenAI, Google, and the sign-ins) comes
// from pi-ai.

import {
	type Api,
	type AssistantMessage,
	type ImageContent,
	isRetryableAssistantError,
	type Message,
	type Model,
	type Models,
	type ModelThinkingLevel,
	getSupportedThinkingLevels,
	clampThinkingLevel,
	type TextContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { LessonFile } from "./lessonfile.ts";

export interface ToolResult<TDetails = unknown> {
	content: (TextContent | ImageContent)[];
	details?: TDetails;
}

/** A tool the tutor can call. */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	/** Short name for people (not shown to the AI). */
	label: string;
	description: string;
	parameters: TParams;
	/** Cards wait for the learner, so they run one at a time. */
	executionMode?: "sequential" | "parallel";
	execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined): Promise<ToolResult<TDetails>>;
}

export type ConversationEvent =
	/** The tutor started working. */
	| { type: "agent_start" }
	/** The tutor finished and is waiting for the learner. */
	| { type: "agent_settled" }
	| { type: "message_start"; message: Message }
	/** Part of the tutor's reply has arrived. */
	| { type: "message_update"; message: AssistantMessage }
	| { type: "message_end"; message: Message }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }
	/** The AI service was busy; trying again after a wait. */
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean }
	| { type: "session_info_changed" };

/** Busy AI servers ("Overloaded") usually recover within a minute or two. */
const RETRY = { maxRetries: 6, baseDelayMs: 3000, maxDelayMs: 30_000 };

export interface ConversationOptions {
	models: Models;
	file: LessonFile;
	model: Model<Api> | undefined;
	thinkingLevel: ModelThinkingLevel;
	systemPrompt: string;
	tools: ToolDefinition<any, any>[];
}

export class Conversation {
	private readonly models: Models;
	private readonly file: LessonFile;
	private readonly systemPrompt: string;
	private readonly tools: ToolDefinition<any, any>[];
	private readonly listeners = new Set<(event: ConversationEvent) => void>();
	private history: Message[];
	private _model: Model<Api> | undefined;
	private _thinkingLevel: ModelThinkingLevel;
	/** Messages the learner typed while the tutor was working, delivered at its next step. */
	private queued: UserMessage[] = [];
	private abortController: AbortController | undefined;
	private running: Promise<void> | undefined;

	constructor(options: ConversationOptions) {
		this.models = options.models;
		this.file = options.file;
		this.systemPrompt = options.systemPrompt;
		this.tools = options.tools;
		this.history = options.file.messages();
		this._model = options.model;
		this._thinkingLevel = options.thinkingLevel;
		if (this._model) {
			const saved = options.file.model;
			if (saved?.provider !== this._model.provider || saved?.modelId !== this._model.id)
				options.file.setModel(this._model.provider, this._model.id);
			this._thinkingLevel = this.clamp(this._thinkingLevel);
		}
		if (options.file.thinkingLevel !== this._thinkingLevel) options.file.setThinkingLevel(this._thinkingLevel);
	}

	// ── State ─────────────────────────────────────────────────────────────────

	get messages(): Message[] {
		return this.history;
	}
	get sessionFile(): string {
		return this.file.path;
	}
	get sessionName(): string | undefined {
		return this.file.name;
	}
	setSessionName(name: string): void {
		this.file.setName(name);
		this.emit({ type: "session_info_changed" });
	}
	get model(): Model<Api> | undefined {
		return this._model;
	}
	async setModel(model: Model<Api>): Promise<void> {
		this._model = model;
		this.file.setModel(model.provider, model.id);
		this.setThinkingLevel(this._thinkingLevel);
	}
	get thinkingLevel(): ModelThinkingLevel {
		return this._thinkingLevel;
	}
	setThinkingLevel(level: ModelThinkingLevel): void {
		const next = this.clamp(level);
		if (next === this._thinkingLevel) return;
		this._thinkingLevel = next;
		this.file.setThinkingLevel(next);
	}
	supportsThinking(): boolean {
		return !!this._model?.reasoning;
	}
	getAvailableThinkingLevels(): ModelThinkingLevel[] {
		return this._model ? getSupportedThinkingLevels(this._model) : [];
	}
	get isStreaming(): boolean {
		return this.running !== undefined;
	}

	subscribe(listener: (event: ConversationEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.abortController?.abort();
		this.listeners.clear();
	}

	// ── Talking to the tutor ──────────────────────────────────────────────────

	/** Sends the learner's message and resolves once the tutor has finished. */
	async prompt(text: string): Promise<void> {
		if (this.running) {
			this.steer(text);
			return this.running;
		}
		this.queued.push(userMessage(text));
		this.running = this.run().finally(() => {
			this.running = undefined;
			this.abortController = undefined;
			this.emit({ type: "agent_settled" });
		});
		return this.running;
	}

	/** A message typed while the tutor is working: it reads it at its next step. */
	async steer(text: string): Promise<void> {
		this.queued.push(userMessage(text));
	}

	/** Stops the tutor and waits until it has stopped. */
	async abort(): Promise<void> {
		this.queued = [];
		this.abortController?.abort();
		await this.running?.catch(() => {});
	}

	private async run(): Promise<void> {
		const abort = new AbortController();
		this.abortController = abort;
		const signal = abort.signal;
		this.emit({ type: "agent_start" });
		while (!signal.aborted) {
			for (const message of this.queued.splice(0)) this.add(message);
			const reply = await this.reply(signal);
			if (reply.stopReason === "error" || reply.stopReason === "aborted") break;
			const calls = reply.content.filter((b): b is ToolCall => b.type === "toolCall");
			if (calls.length > 0) await this.runTools(calls, signal);
			// The tutor carries on after its tools, or to read a message typed meanwhile.
			if (calls.length === 0 && this.queued.length === 0) break;
		}
		// Typed after the tutor stopped: start again so it isn't lost.
		if (this.queued.length > 0 && !signal.aborted) await this.run();
	}

	/** One reply from the AI, tried again (with growing waits) while its servers are busy. */
	private async reply(signal: AbortSignal): Promise<AssistantMessage> {
		let retried = 0;
		while (true) {
			const message = await this.stream(signal);
			const retry = isRetryableAssistantError(message) && retried < RETRY.maxRetries && !signal.aborted;
			if (!retry) {
				this.add(message, true);
				if (retried > 0) this.emit({ type: "auto_retry_end", success: message.stopReason !== "error" });
				return message;
			}
			retried++;
			const delayMs = Math.min(RETRY.baseDelayMs * 2 ** (retried - 1), RETRY.maxDelayMs);
			this.emit({
				type: "auto_retry_start",
				attempt: retried,
				maxAttempts: RETRY.maxRetries,
				delayMs,
				errorMessage: message.errorMessage ?? "",
			});
			await sleep(delayMs, signal);
		}
	}

	/** Streams one reply, telling the page about each piece as it arrives. */
	private async stream(signal: AbortSignal): Promise<AssistantMessage> {
		const model = this._model;
		if (!model) return failed("No AI model is selected. Sign in under Settings.");
		const context = {
			systemPrompt: this.systemPrompt,
			messages: this.history,
			tools: this.tools.map(
				(t): Tool => ({ name: t.name, description: t.description, parameters: t.parameters }),
			),
		};
		const level = this._thinkingLevel;
		let started = false;
		try {
			const response = this.models.streamSimple(model, context, {
				signal,
				reasoning: level === "off" ? undefined : level,
				sessionId: this.file.id,
			});
			for await (const event of response) {
				if (event.type === "start") {
					started = true;
					this.emit({ type: "message_start", message: event.partial });
				} else if ("partial" in event && started) {
					this.emit({ type: "message_update", message: event.partial });
				}
			}
			const message = await response.result();
			if (!started) this.emit({ type: "message_start", message });
			return { ...message, thinkingLevel: level };
		} catch (err) {
			return failed((err as Error).message, signal.aborted);
		}
	}

	private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<void> {
		const sequential =
			calls.length < 2 || calls.some((c) => this.tools.find((t) => t.name === c.name)?.executionMode === "sequential");
		if (sequential) {
			for (const call of calls) {
				// Stopped: the rest never run, and the AI is told so next time.
				if (signal.aborted) this.add(toolResult(call, errorResult("Not run: the learner stopped the lesson."), true));
				else this.add(await this.runTool(call, signal));
			}
		} else {
			for (const result of await Promise.all(calls.map((call) => this.runTool(call, signal)))) this.add(result);
		}
	}

	private async runTool(call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
		const tool = this.tools.find((t) => t.name === call.name);
		let result: ToolResult;
		let isError = false;
		if (!tool) {
			result = errorResult(`Tool ${call.name} not found`);
			isError = true;
		} else {
			try {
				const args = validateToolArguments(
					{ name: tool.name, description: tool.description, parameters: tool.parameters },
					call,
				);
				result = await tool.execute(call.id, args, signal);
			} catch (err) {
				result = errorResult((err as Error).message);
				isError = true;
			}
		}
		this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError });
		return toolResult(call, result, isError);
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	/** Adds a message to the lesson and saves it. `started`: the page already saw it begin. */
	private add(message: Message, started = false): void {
		this.history = [...this.history, message];
		this.file.appendMessage(message);
		if (!started) this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
	}

	private clamp(level: ModelThinkingLevel): ModelThinkingLevel {
		return this._model ? clampThinkingLevel(this._model, level) : level;
	}

	private emit(event: ConversationEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				console.error(err);
			}
		}
	}
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], details: {} };
}

function toolResult(call: ToolCall, result: ToolResult, isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

/** A reply that never came, recorded like the AI's own error replies. */
function failed(errorMessage: string, aborted = false): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "unknown",
		provider: "unknown",
		model: "unknown",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
	});
}
