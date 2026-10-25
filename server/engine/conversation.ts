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
	models: { streamSimple: Models["streamSimple"] };
	file: LessonFile;
	model: Model<Api> | undefined;
	thinkingLevel: ModelThinkingLevel;
	systemPrompt: string;
	tools: ToolDefinition<any, any>[];
}

export class Conversation {
	private readonly models: ConversationOptions["models"];
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
	/** A reply being written ahead of time, for a message the learner hasn't sent yet. */
	private prepared: Prepared | undefined;

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
		this.discardPrepared();
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
		this.discardPrepared();
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
		this.discardPrepared();
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
		const prepared = this.prepared;
		this.prepared = undefined;
		const ready = prepared && prepared.text === text && prepared.base === this.history.length;
		if (!ready) prepared?.abort.abort();
		this.queued.push(userMessage(text));
		this.running = (ready ? this.runPrepared(prepared) : this.run()).finally(() => {
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
		this.discardPrepared();
		this.queued = [];
		this.abortController?.abort();
		await this.running?.catch(() => {});
	}

	/**
	 * Starts writing the reply to `text` in the background, before the
	 * learner sends it, so it can be shown at once when they do. Only the
	 * tools in `tools` (searches, which the learner doesn't see) run ahead;
	 * if the reply calls another (a card), the rest is written live instead.
	 * Thrown away if the learner sends anything else, or the lesson changes.
	 */
	prepare(text: string, tools: string[]): void {
		if (this.running || !this._model) return;
		if (this.prepared?.text === text && this.prepared.base === this.history.length) return;
		this.discardPrepared();
		const prepared: Prepared = {
			text,
			base: this.history.length,
			abort: new AbortController(),
			messages: [],
			partial: undefined,
			adopted: undefined,
			finished: false,
			done: Promise.resolve(),
		};
		prepared.done = this.writeAhead(prepared, tools);
		this.prepared = prepared;
	}

	private discardPrepared(): void {
		this.prepared?.abort.abort();
		this.prepared = undefined;
	}

	private async writeAhead(prepared: Prepared, tools: string[]): Promise<void> {
		const signal = prepared.abort.signal;
		const history = [...this.history, userMessage(prepared.text)];
		const keep = (message: Message) => {
			history.push(message);
			prepared.messages.push(message);
			prepared.adopted?.(message);
		};
		// A few rounds at most: a reply, its searches, the reply that uses them.
		for (let round = 0; round < 4 && !signal.aborted; round++) {
			const reply = await this.stream(signal, history, (partial) => {
				prepared.partial = partial;
				prepared.adopted?.(partial, true);
			});
			prepared.partial = undefined;
			if (reply.stopReason === "error" || reply.stopReason === "aborted") return;
			const calls = reply.content.filter((b): b is ToolCall => b.type === "toolCall");
			// A card has to be shown live, so the reply that asks for it is written live too.
			if (calls.some((c) => !tools.includes(c.name))) return;
			keep(reply);
			if (calls.length === 0) {
				prepared.finished = true;
				return;
			}
			for (const call of calls) {
				if (signal.aborted) return;
				keep(await this.runTool(call, signal, false));
			}
		}
	}

	/** Shows a reply written ahead (finishing it live if it isn't done), then carries on as usual. */
	private async runPrepared(prepared: Prepared): Promise<void> {
		this.abortController = prepared.abort;
		const signal = prepared.abort.signal;
		this.emit({ type: "agent_start" });
		for (const message of this.queued.splice(0)) this.add(message);
		let streaming = false;
		const show = (message: Message, partial = false) => {
			if (partial) {
				if (!streaming) this.emit({ type: "message_start", message });
				else this.emit({ type: "message_update", message: message as AssistantMessage });
				streaming = true;
				return;
			}
			// Stamped with when the learner sees it, after the message it answers.
			message = { ...message, timestamp: Date.now() } as Message;
			this.add(message, streaming);
			if (message.role === "toolResult")
				this.emit({ type: "tool_execution_end", toolCallId: message.toolCallId, toolName: message.toolName, result: message, isError: message.isError });
			streaming = false;
		};
		for (const message of prepared.messages) show(message);
		prepared.adopted = show;
		if (prepared.partial) show(prepared.partial, true);
		await prepared.done;
		prepared.adopted = undefined;
		if (signal.aborted) return;
		// Not finished ahead (a card, an error, or a message typed meanwhile): carry on live.
		if (!prepared.finished || this.queued.length > 0) await this.run(false);
	}

	private async run(start = true): Promise<void> {
		const abort = new AbortController();
		this.abortController = abort;
		const signal = abort.signal;
		if (start) this.emit({ type: "agent_start" });
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
	private async stream(
		signal: AbortSignal,
		messages: Message[] = this.history,
		onUpdate?: (partial: AssistantMessage) => void,
	): Promise<AssistantMessage> {
		const model = this._model;
		if (!model) return failed("No AI model is selected. Sign in under Settings.");
		const context = {
			systemPrompt: this.systemPrompt,
			messages,
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
					if (onUpdate) onUpdate(event.partial);
					else this.emit({ type: "message_start", message: event.partial });
				} else if ("partial" in event && started) {
					if (onUpdate) onUpdate(event.partial);
					else this.emit({ type: "message_update", message: event.partial });
				}
			}
			const message = await response.result();
			if (!started && !onUpdate) this.emit({ type: "message_start", message });
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

	private async runTool(call: ToolCall, signal: AbortSignal, announce = true): Promise<ToolResultMessage> {
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
					recoverArguments(call),
				);
				result = await tool.execute(call.id, args, signal);
			} catch (err) {
				result = errorResult((err as Error).message);
				isError = true;
			}
		}
		if (announce) this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError });
		return toolResult(call, result, isError);
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	/** Adds a message to the lesson and saves it. `started`: the page already saw it begin. */
	private add(message: Message, started = false): void {
		// The lesson moved on: a reply written ahead no longer fits.
		if (this.prepared && !this.running) this.discardPrepared();
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

interface Prepared {
	/** The learner's message it answers. */
	text: string;
	/** How long the lesson was when it started: it only fits that lesson. */
	base: number;
	abort: AbortController;
	/** Finished messages so far (replies and search results). */
	messages: Message[];
	/** The reply being written now. */
	partial: AssistantMessage | undefined;
	/** Set once the learner has sent the message: shows each piece as it arrives. */
	adopted: ((message: Message, partial?: boolean) => void) | undefined;
	/** Whether the whole reply was written ahead. */
	finished: boolean;
	done: Promise<void>;
}

/**
 * Models sometimes send a tool's arguments followed by stray text (an extra
 * brace, or a second copy), which isn't valid JSON. When the text starts with
 * one complete JSON object, use that object.
 */
function recoverArguments(call: ToolCall): ToolCall {
	const error = (call as ToolCall & { argumentsError?: string }).argumentsError;
	const marker = "Received arguments:\n";
	const at = error?.indexOf(marker) ?? -1;
	if (!error || at < 0) return call;
	const text = error.slice(at + marker.length).trimStart();
	const end = firstObjectEnd(text);
	if (end < 0) return call;
	try {
		const parsed = JSON.parse(text.slice(0, end));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return call;
		const { argumentsError: _, ...rest } = call as ToolCall & { argumentsError?: string };
		return { ...rest, arguments: parsed };
	} catch {
		return call;
	}
}

/** Where the JSON object at the start of `text` ends, or -1. */
function firstObjectEnd(text: string): number {
	if (text[0] !== "{") return -1;
	let depth = 0;
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i + 1;
	}
	return -1;
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
