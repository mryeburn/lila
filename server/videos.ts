// `find_video`: lets the tutor show a short stretch of a YouTube video (15 to
// 40 seconds) where one point is shown, instead of linking a long video. It
// searches YouTube through SerpApi (the same free key as Google Images photos)
// and reads the top videos' timed transcripts, so the tutor can pick the exact
// stretch. The page plays only that stretch.

import type { ToolDefinition } from "./engine/conversation.ts";
import { Type } from "typebox";
import { loadSettings } from "./config.ts";
import { getJson } from "./images.ts";

/** Most clips in one lesson: videos stay a rare treat, not the main course. */
export const MAX_CLIPS = 2;
/** Videos to read transcripts of per search (each costs one SerpApi search). */
const CANDIDATES = 2;
/** Longest video worth searching for a clip, in seconds. */
const MAX_VIDEO_SECONDS = 30 * 60;
/** Transcript text per video given to the tutor. */
const MAX_TRANSCRIPT_CHARS = 9000;

/** A clip as the tutor writes it in a ```youtube block. */
export const CLIP_BLOCK = /```youtube\s*\n([\s\S]*?)```/g;

const Params = Type.Object({
	point: Type.String({ description: "The one thing the clip should show, e.g. 'how a thrombus forms on a ruptured coronary plaque'." }),
	query: Type.String({ description: "YouTube search words, e.g. 'coronary artery thrombus formation animation'." }),
});

export const VIDEO_GUIDELINES = [
	`Use find_video only where a moving picture really helps: a process, a technique, how something moves, forms or sounds. Usually one clip per lesson, none in some lessons, never more than ${MAX_CLIPS}. Never in the pre-test or the Final quiz.`,
	"Search words work best short and specific, often with 'animation' or 'demonstration'.",
	"You get the top videos' transcripts with timings. Pick one stretch of 15 to 40 seconds where the narration shows exactly your point. If no stretch fits, skip the video and use a picture instead; never show a long video.",
	"Embed it by writing the ```youtube block exactly as the result says, right where you talk about it, then one short line in italics on what to watch for.",
];

interface Video {
	id: string;
	title: string;
	channel: string;
	seconds: number;
}

/** "4:12" or "1:02:03" in seconds. */
export function parseLength(text: unknown): number {
	if (typeof text !== "string" || !/^\d+(:\d{1,2}){1,2}$/.test(text.trim())) return 0;
	return text
		.trim()
		.split(":")
		.reduce((total, part) => total * 60 + Number(part), 0);
}

export function videoId(link: unknown): string | undefined {
	try {
		const u = new URL(String(link));
		const id = u.searchParams.get("v") ?? (u.hostname === "youtu.be" ? u.pathname.slice(1) : "");
		return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Transcript segments merged into lines of about 10 seconds: "[1:35] text". */
export function timedLines(segments: Array<{ start_ms?: number; snippet?: string }>): string {
	const lines: string[] = [];
	let start = -1;
	let text = "";
	for (const seg of segments) {
		const at = Math.floor((Number(seg.start_ms) || 0) / 1000);
		const words = String(seg.snippet ?? "").replace(/\s+/g, " ").trim();
		if (!words) continue;
		if (start < 0) start = at;
		text += `${text ? " " : ""}${words}`;
		if (at - start >= 10) {
			lines.push(`[${clock(start)}] ${text}`);
			start = -1;
			text = "";
		}
	}
	if (text) lines.push(`[${clock(Math.max(start, 0))}] ${text}`);
	return lines.join("\n");
}

const cache = new Map<string, unknown>();
async function serp(params: Record<string, string>, signal?: AbortSignal): Promise<any> {
	const key = loadSettings().photoSearchKey;
	if (!key) throw new Error("no key");
	const cacheKey = JSON.stringify(params);
	if (cache.has(cacheKey)) return cache.get(cacheKey);
	const url = new URL("https://serpapi.com/search.json");
	url.search = new URLSearchParams({ ...params, api_key: key }).toString();
	const data = await getJson(url.href, signal);
	cache.set(cacheKey, data);
	return data;
}

export async function searchVideos(query: string, signal?: AbortSignal): Promise<Video[]> {
	const data = await serp({ engine: "youtube", search_query: query }, signal);
	const out: Video[] = [];
	for (const r of data?.video_results ?? []) {
		const id = videoId(r.link);
		const seconds = parseLength(r.length);
		if (!id || seconds === 0 || seconds > MAX_VIDEO_SECONDS) continue;
		out.push({ id, title: String(r.title ?? "").slice(0, 200), channel: String(r.channel?.name ?? "").slice(0, 100), seconds });
	}
	return out;
}

export async function transcript(id: string, signal?: AbortSignal): Promise<string> {
	const data = await serp({ engine: "youtube_video_transcript", v: id, language_code: "en" }, signal);
	return timedLines(data?.transcript ?? []);
}

export function createVideoTool(clipsShown: () => number): ToolDefinition<typeof Params> {
	const reply = (text: string, details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details });
	return {
		name: "find_video",
		label: "Video search",
		description:
			"Find a short stretch (15 to 40 seconds) of a YouTube video that shows one point, to play in the lesson. Returns the top videos' timed transcripts so you can pick the stretch.",
		parameters: Params,

		async execute(_toolCallId, params, signal) {
			if (!loadSettings().photoSearchKey) {
				return reply("Videos aren't set up in this LILA (no SerpApi key in Settings). Use a picture instead.", { status: "off" });
			}
			if (clipsShown() >= MAX_CLIPS) {
				return reply(`This lesson already has ${MAX_CLIPS} video clips, the most allowed. Use a picture instead.`, { status: "limit" });
			}
			let videos: Video[];
			try {
				videos = await searchVideos(params.query, signal);
			} catch {
				return reply("The video search didn't work just now. Use a picture instead.", { status: "error" });
			}
			const found: string[] = [];
			for (const v of videos) {
				if (found.length >= CANDIDATES) break;
				const text = await transcript(v.id, signal).catch(() => "");
				if (!text) continue;
				const clipped = text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n[…rest of transcript left out]` : text;
				found.push(
					`Video ${found.length + 1}: "${v.title}" by ${v.channel || "unknown channel"}, ${clock(v.seconds)} long\nid: ${v.id}\nTranscript:\n${clipped}`,
				);
			}
			if (found.length === 0) {
				return reply(`No usable video found for "${params.query}" (none had a transcript). Use a picture instead.`, { status: "none", query: params.query });
			}
			const how = [
				`Point to show: ${params.point}`,
				"",
				"Pick ONE stretch of 15 to 40 seconds, from one video, where the narration shows exactly this point. Use the timings in the transcript (whole seconds). If nothing fits closely, don't show a video.",
				"To show it, write this block where you talk about it, with that video's id, title and channel, and your start and end in seconds:",
				'```youtube\n{"id": "VIDEO_ID", "start": 95, "end": 120, "title": "VIDEO TITLE", "channel": "CHANNEL"}\n```',
				"Then one short line in italics saying what to watch for.",
				"",
				...found,
			];
			return reply(how.join("\n"), { status: "found", query: params.query, count: found.length });
		},
	};
}
