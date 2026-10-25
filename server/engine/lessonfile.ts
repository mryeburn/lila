// A lesson saved on disk: one JSON object per line. The first line describes
// the lesson; every later line is an entry (a message, the lesson's name, a
// change of AI model or thinking level) that points to the entry before it.
//
// The format is the one pi used, so lessons saved before LILA had its own
// engine open as they are.

import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";

const VERSION = 3;

interface Header {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
}

interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: any;
}

export interface LessonInfo {
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: Date;
}

function readLines(file: string): any[] {
	const lines: any[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			lines.push(JSON.parse(line));
		} catch {
			// A half-written last line (the app stopped mid-write): skip it.
		}
	}
	return lines;
}

function textOf(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text)
		.join(" ");
}

export class LessonFile {
	private header: Header;
	private entries: Entry[];
	/** Whether the file exists yet. A new lesson is written once its first message arrives. */
	private written: boolean;

	private constructor(
		readonly path: string,
		header: Header,
		entries: Entry[],
		written: boolean,
	) {
		this.header = header;
		this.entries = entries;
		this.written = written;
	}

	static create(dir: string, cwd: string): LessonFile {
		const timestamp = new Date().toISOString();
		const id = randomUUID();
		const file = path.join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
		return new LessonFile(file, { type: "session", version: VERSION, id, timestamp, cwd }, [], false);
	}

	static open(file: string): LessonFile {
		const lines = readLines(file);
		const header = lines.find((l) => l?.type === "session") as Header | undefined;
		if (!header) throw new Error("This doesn't look like a LILA lesson.");
		const all = lines.filter((l) => l !== header && typeof l?.type === "string") as Entry[];
		// Follow the chain back from the last entry: that's the lesson as it
		// stands. (pi could branch a conversation; LILA never does.)
		const byId = new Map(all.map((e) => [e.id, e]));
		const chain: Entry[] = [];
		for (let e = all.at(-1); e; e = e.parentId ? byId.get(e.parentId) : undefined) chain.push(e);
		chain.reverse();
		return new LessonFile(file, header, chain, true);
	}

	/** Every saved lesson in `dir` that has at least one message. */
	static list(dir: string): LessonInfo[] {
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			return [];
		}
		const lessons: LessonInfo[] = [];
		for (const f of files) {
			const file = path.join(dir, f);
			try {
				const lines = readLines(file);
				if (lines[0]?.type !== "session") continue;
				let name: string | undefined;
				let firstMessage = "";
				let messageCount = 0;
				let last = 0;
				for (const e of lines) {
					if (e.type === "session_info") name = e.name?.trim() || undefined;
					if (e.type !== "message") continue;
					messageCount++;
					const m = e.message;
					if (m?.role !== "user" && m?.role !== "assistant") continue;
					const t = typeof m.timestamp === "number" ? m.timestamp : new Date(e.timestamp).getTime();
					if (!Number.isNaN(t)) last = Math.max(last, t);
					if (!firstMessage && m.role === "user") firstMessage = textOf(m);
				}
				const modified = last > 0 ? new Date(last) : fs.statSync(file).mtime;
				lessons.push({ path: file, name, firstMessage, messageCount, modified });
			} catch {
				// Unreadable file: leave it out of the list.
			}
		}
		return lessons;
	}

	get id(): string {
		return this.header.id;
	}

	get name(): string | undefined {
		let name: string | undefined;
		for (const e of this.entries) if (e.type === "session_info") name = e.name?.trim() || undefined;
		return name;
	}

	/** The AI model the lesson last used, if any. */
	get model(): { provider: string; modelId: string } | undefined {
		let model: { provider: string; modelId: string } | undefined;
		for (const e of this.entries) {
			if (e.type === "model_change") model = { provider: e.provider, modelId: e.modelId };
			else if (e.type === "message" && e.message?.role === "assistant")
				model = { provider: e.message.provider, modelId: e.message.model };
		}
		return model;
	}

	get thinkingLevel(): string | undefined {
		let level: string | undefined;
		for (const e of this.entries) if (e.type === "thinking_level_change") level = e.thinkingLevel;
		return level;
	}

	/**
	 * The conversation so far. If pi ever shortened a long lesson (a
	 * "compaction"), the summary stands in for what came before it.
	 */
	messages(): Message[] {
		let start = 0;
		let summary: string | undefined;
		let summaryTime = 0;
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const e = this.entries[i];
			if (e.type !== "compaction") continue;
			const kept = this.entries.findIndex((k) => k.id === e.firstKeptEntryId);
			start = kept >= 0 && kept < i ? kept : i + 1;
			summary = e.summary;
			summaryTime = new Date(e.timestamp).getTime();
			break;
		}
		const messages: Message[] = [];
		if (summary) {
			messages.push({
				role: "user",
				content: [{ type: "text", text: `<summary>\nThe lesson so far, in short:\n${summary}\n</summary>` }],
				timestamp: summaryTime,
			});
		}
		for (const e of this.entries.slice(start)) {
			if (e.type === "message") {
				const m = e.message;
				if (m?.role === "user" || m?.role === "assistant" || m?.role === "toolResult")
					messages.push({ ...m, content: m.content ?? [] });
			} else if (e.type === "custom_message" && e.content) {
				messages.push({
					role: "user",
					content: typeof e.content === "string" ? [{ type: "text", text: e.content }] : e.content,
					timestamp: new Date(e.timestamp).getTime(),
				});
			}
		}
		return messages;
	}

	appendMessage(message: Message): void {
		this.append({ type: "message", message });
	}

	setName(name: string): void {
		this.append({ type: "session_info", name });
	}

	setModel(provider: string, modelId: string): void {
		this.append({ type: "model_change", provider, modelId });
	}

	setThinkingLevel(thinkingLevel: string): void {
		this.append({ type: "thinking_level_change", thinkingLevel });
	}

	private append(fields: { type: string; [key: string]: unknown }): void {
		const ids = new Set(this.entries.map((e) => e.id));
		let id: string;
		do id = randomBytes(4).toString("hex");
		while (ids.has(id));
		const entry: Entry = {
			...fields,
			id,
			parentId: this.entries.at(-1)?.id ?? null,
			timestamp: new Date().toISOString(),
		};
		this.entries.push(entry);
		this.save(entry);
	}

	private save(entry: Entry): void {
		if (this.written) {
			fs.appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
			return;
		}
		// Settings alone (model, thinking level) don't make a lesson: wait for
		// the first message, so opening LILA without learning leaves no file.
		if (!this.entries.some((e) => e.type === "message")) return;
		fs.mkdirSync(path.dirname(this.path), { recursive: true });
		const lines = [this.header, ...this.entries].map((e) => `${JSON.stringify(e)}\n`).join("");
		fs.writeFileSync(this.path, lines, { flag: "wx" });
		this.written = true;
	}
}
