import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { type AppSettings, loadSettings, SESSIONS_DIR, saveSettings, WORKSPACE_DIR } from "./config.ts";
import { BASE_PROMPT, buildTeachingPrompt } from "./prompt.ts";
import { createAskTool, createQuizTool, type InteractionBroker, type PendingInteraction } from "./tools.ts";
import type { LessonSummary, ServerMessage, TranscriptItem, TutorState } from "./protocol.ts";

const TOOL_NAMES = ["quiz", "ask_user_question"];
// Default model per provider when the learner hasn't picked one: the newest
// matching id wins.
const DEFAULT_MODELS: Array<[string, RegExp]> = [
	["anthropic", /^claude-sonnet-[\d-]+$/],
	["openai", /^gpt-[\d.]+$/],
	["google", /^gemini-([\d.]+-pro|pro-latest)$/],
	["openrouter", /^anthropic\/claude-sonnet/],
];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type Thinking = (typeof THINKING_LEVELS)[number];

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("");
}

/**
 * Owns the one active lesson (a pi AgentSession) and translates between pi's
 * event stream and the simple messages the web page understands.
 */
export class Tutor implements InteractionBroker {
	private session: AgentSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private pending = new Map<string, { interaction: PendingInteraction; resolve: (answer: unknown) => void }>();
	private streamingText: string | null = null;
	private lastError: string | undefined;
	private settings: AppSettings = loadSettings();
	private busy = false;

	constructor(
		readonly runtime: ModelRuntime,
		private readonly teachSkillDir: string,
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
			const onAbort = () => finish(undefined);
			signal?.addEventListener("abort", onAbort);
			this.pending.set(interaction.id, { interaction, resolve: finish });
			this.broadcast({ type: "interaction", interaction });
		});
	}

	answer(id: string, answer: unknown): void {
		this.pending.get(id)?.resolve(answer ?? {});
	}

	// ── State snapshots for the page ─────────────────────────────────────────

	async state(): Promise<TutorState> {
		const available = await this.runtime.getAvailable().catch(() => []);
		const model = this.session?.model;
		return {
			signedIn: available.length > 0,
			model: model ? { provider: model.provider, id: model.id, name: model.name ?? model.id } : null,
			thinkingLevel: this.session?.thinkingLevel ?? this.settings.thinkingLevel ?? "medium",
			thinkingLevels: this.session?.supportsThinking() ? this.session.getAvailableThinkingLevels() : [],
			busy: this.busy,
			lessonPath: this.session?.sessionFile ?? null,
			lessonTitle: this.session?.sessionName ?? null,
			error: this.lastError ?? null,
		};
	}

	async sendSnapshot(send: (msg: ServerMessage) => void): Promise<void> {
		send({ type: "state", state: await this.state() });
		send({ type: "transcript", items: this.transcript() });
		send({ type: "streaming", text: this.streamingText });
		for (const { interaction } of this.pending.values()) send({ type: "interaction", interaction });
		send({ type: "lessons", lessons: await this.lessons() });
	}

	private async pushState(): Promise<void> {
		this.broadcast({ type: "state", state: await this.state() });
	}

	transcript(): TranscriptItem[] {
		if (!this.session) return [];
		const items: TranscriptItem[] = [];
		const byToolCall = new Map<string, TranscriptItem & { kind: "quiz" | "ask" }>();
		for (const msg of this.session.messages as any[]) {
			if (msg.role === "user") {
				const text = textOf(msg.content).trim();
				if (text) items.push({ kind: "user", text });
			} else if (msg.role === "assistant") {
				let text = "";
				for (const block of msg.content ?? []) {
					if (block.type === "text") text += block.text;
					if (block.type === "toolCall" && TOOL_NAMES.includes(block.name)) {
						if (text.trim()) items.push({ kind: "assistant", text });
						text = "";
						const item = {
							kind: block.name === "quiz" ? ("quiz" as const) : ("ask" as const),
							id: block.id as string,
							question: String(block.arguments?.question ?? ""),
							details: block.arguments?.details as string | undefined,
							result: null,
						};
						byToolCall.set(item.id, item);
						items.push(item);
					}
				}
				if (text.trim()) items.push({ kind: "assistant", text });
				if (msg.stopReason === "error" && msg.errorMessage) items.push({ kind: "error", text: msg.errorMessage });
			} else if (msg.role === "toolResult") {
				const item = byToolCall.get(msg.toolCallId);
				if (item) item.result = msg.details ?? { status: "unavailable", message: textOf(msg.content) };
			}
		}
		return items;
	}

	async lessons(): Promise<LessonSummary[]> {
		const list = await SessionManager.list(WORKSPACE_DIR, SESSIONS_DIR).catch(() => []);
		return list
			.filter((s) => s.messageCount > 0)
			.sort((a, b) => b.modified.getTime() - a.modified.getTime())
			.map((s) => ({
				path: s.path,
				title: s.name || s.firstMessage.slice(0, 80) || "Untitled lesson",
				modified: s.modified.toISOString(),
			}));
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
		this.lastError = undefined;

		const model = await this.pickModel();
		const loader = new DefaultResourceLoader({
			cwd: WORKSPACE_DIR,
			agentDir: getAgentDir(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: BASE_PROMPT,
			appendSystemPrompt: buildTeachingPrompt(this.teachSkillDir),
		});
		await loader.reload();

		const sessionManager =
			path && fs.existsSync(path)
				? SessionManager.open(path, SESSIONS_DIR)
				: SessionManager.create(WORKSPACE_DIR, SESSIONS_DIR);

		const thinking = THINKING_LEVELS.includes(this.settings.thinkingLevel as Thinking)
			? (this.settings.thinkingLevel as Thinking)
			: "medium";
		const { session } = await createAgentSession({
			cwd: WORKSPACE_DIR,
			modelRuntime: this.runtime,
			model,
			thinkingLevel: thinking,
			resourceLoader: loader,
			sessionManager,
			tools: TOOL_NAMES,
			customTools: [createQuizTool(this), createAskTool(this)],
		});
		this.session = session;
		this.unsubscribe = session.subscribe((event) => this.onEvent(event));
		this.broadcast({ type: "transcript", items: this.transcript() });
		this.broadcast({ type: "streaming", text: null });
		this.broadcast({ type: "lessons", lessons: await this.lessons() });
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

	async prompt(text: string): Promise<void> {
		if (!this.session) await this.openLesson();
		const session = this.session!;
		if (!session.model) {
			this.lastError = "Sign in to an AI provider first (Settings).";
			await this.pushState();
			return;
		}
		if (!session.sessionName) session.setSessionName(text.replace(/\s+/g, " ").trim().slice(0, 80));
		this.lastError = undefined;
		// A card is waiting: the run is paused inside that tool call, so a normal
		// message would queue behind it forever. Use the text as the card's answer.
		if (this.pending.size > 0) {
			for (const { interaction, resolve } of [...this.pending.values()]) {
				if (interaction.kind === "quiz") resolve({ skippedWith: text });
				else if (interaction.mode === "text") resolve({ text });
				else resolve({ other: text });
			}
			return;
		}
		try {
			if (session.isStreaming) {
				await session.steer(text);
			} else {
				await session.prompt(text);
			}
		} catch (err) {
			this.lastError = (err as Error).message;
			await this.pushState();
		}
	}

	async abort(): Promise<void> {
		await this.session?.abort();
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		const model = this.runtime.getModel(provider, modelId);
		if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);
		this.settings = { ...this.settings, provider, modelId };
		saveSettings(this.settings);
		if (this.session) await this.session.setModel(model);
		await this.pushState();
	}

	async setThinking(level: string): Promise<void> {
		if (!THINKING_LEVELS.includes(level as Thinking)) return;
		this.settings = { ...this.settings, thinkingLevel: level };
		saveSettings(this.settings);
		this.session?.setThinkingLevel(level as Thinking);
		await this.pushState();
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
		for (const item of this.transcript()) {
			if (item.kind === "user") lines.push(`> **You:** ${item.text.replace(/\n/g, "\n> ")}`, "");
			else if (item.kind === "assistant") lines.push(item.text, "");
			else if (item.kind === "error") lines.push(`> ⚠️ ${item.text}`, "");
			else {
				const r = item.result as any;
				lines.push(`**${item.kind === "quiz" ? "Quiz" : "Question"}:** ${item.question}`, "");
				for (const o of r?.options ?? []) {
					const chosen = (r.answers ?? []).some((a: any) => a.index === o.index);
					const key = (r.correctIndices ?? []).includes(o.index);
					const mark = item.kind === "quiz" ? (key ? "✓" : chosen ? "✗" : "-") : chosen ? "●" : "-";
					lines.push(`${mark} ${o.label}`);
				}
				if (r?.dontKnow) lines.push("", "_Answered: I don't know_");
				for (const a of r?.answers ?? []) if (a.type === "other" || a.type === "text") lines.push("", `_Answer: ${a.label}_`);
				if (r?.note) lines.push("", `_Note: ${r.note}_`);
				if (r?.explanation) lines.push("", r.explanation);
				lines.push("");
			}
		}
		return lines.join("\n");
	}

	// ── pi events → page ─────────────────────────────────────────────────────

	private lastStreamPush = 0;

	private onEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				if (!this.busy) {
					this.busy = true;
					void this.pushState();
				}
				break;
			case "agent_settled":
				this.busy = false;
				this.streamingText = null;
				this.broadcast({ type: "streaming", text: null });
				this.broadcast({ type: "transcript", items: this.transcript() });
				void this.pushState();
				void this.lessons().then((lessons) => this.broadcast({ type: "lessons", lessons }));
				break;
			case "message_update": {
				const partial = (event as any).message;
				if (partial?.role !== "assistant") break;
				let text = "";
				for (const block of partial.content ?? []) {
					if (block.type === "text") text += block.text;
				}
				this.streamingText = text;
				const now = Date.now();
				if (now - this.lastStreamPush > 50) {
					this.lastStreamPush = now;
					this.broadcast({ type: "streaming", text });
				}
				break;
			}
			case "message_end":
			case "tool_execution_end":
				this.streamingText = null;
				this.broadcast({ type: "streaming", text: null });
				this.broadcast({ type: "transcript", items: this.transcript() });
				break;
			case "session_info_changed":
				void this.pushState();
				break;
		}
	}
}
