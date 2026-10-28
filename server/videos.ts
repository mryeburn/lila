// `find_video`: lets the tutor show a short stretch of a YouTube video (15 to
// 40 seconds) where one point is shown, instead of linking a long video. It
// searches YouTube through SerpApi (the same free key as Google Images photos)
// and reads the top videos' timed transcripts, so the tutor can pick the exact
// stretch. The page plays only that stretch.

import type { ToolDefinition } from "./engine/conversation.ts";
import { Type } from "typebox";
import { loadSettings } from "./config.ts";
import { getJson } from "./images.ts";

/** Most clips in one lesson: videos stay a treat, not the main course. */
export const MAX_CLIPS = 2;
/** While LILA is being tested: every lesson shows at least one clip. Set to false to make clips optional again. */
export const CLIP_EVERY_LESSON = true;
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
	`Show one clip in ${CLIP_EVERY_LESSON ? "every lesson" : "most lessons"}, in the section where a moving picture helps most: a process, a technique, how something moves, forms or sounds, or real footage of an event. Never more than ${MAX_CLIPS} per lesson. Never in the pre-test or the Final quiz.`,
	"Search words work best short and specific, often with 'animation' or 'demonstration'.",
	`You get the top videos' transcripts with timings. Pick one stretch of 15 to 40 seconds where the narration shows exactly your point. If no stretch fits, ${CLIP_EVERY_LESSON ? "search again with other words (once or twice), and only then" : ""} skip the video and use a picture instead; never show a long video.`,
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
	// Searched as from the learner's country, so country-blocked videos are less likely.
	const region = loadSettings().region;
	const data = await serp({ engine: "youtube", search_query: query, ...(region ? { gl: region.toLowerCase() } : {}) }, signal);
	const out: Video[] = [];
	for (const r of data?.video_results ?? []) {
		const id = videoId(r.link);
		const seconds = parseLength(r.length);
		if (!id || seconds === 0 || seconds > MAX_VIDEO_SECONDS) continue;
		out.push({ id, title: String(r.title ?? "").slice(0, 200), channel: String(r.channel?.name ?? "").slice(0, 100), seconds });
	}
	return out;
}

/** How long one transcript may take before the search goes on without it. */
const TRANSCRIPT_WAIT_MS = 15_000;

/** The text, or "" if it fails or takes longer than `ms`. */
function withLimit(text: Promise<string>, ms: number): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<string>((resolve) => {
		timer = setTimeout(() => resolve(""), ms);
	});
	return Promise.race([text.catch(() => ""), late]).finally(() => clearTimeout(timer));
}

/**
 * Whether the video can be played inside another site. YouTube's oEmbed
 * answers 401 when the owner has turned that off, and 404 when the video is
 * gone or private. Free (not a SerpApi search). Unsure (no answer) counts as yes.
 */
export async function embeddable(id: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, {
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
		});
		return res.status !== 401 && res.status !== 403 && res.status !== 404;
	} catch {
		return true;
	}
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
			const start = Date.now();
			// Only videos that can play inside LILA (checked for the first few, all at once).
			const checked = videos.slice(0, 8);
			const ok = await Promise.all(checked.map((v) => embeddable(v.id, signal)));
			const blocked = checked.filter((_, i) => !ok[i]).length;
			videos = [...checked.filter((_, i) => ok[i]), ...videos.slice(8)];
			const found: string[] = [];
			// Transcripts a few at a time, all at once (each costs one search, so no more than needed),
			// and never more than a couple of rounds.
			let next = 0;
			for (let round = 0; round < 2 && found.length < CANDIDATES && next < videos.length; round++) {
				const batch = videos.slice(next, next + CANDIDATES - found.length);
				next += batch.length;
				const texts = await Promise.all(batch.map((v) => withLimit(transcript(v.id, signal), TRANSCRIPT_WAIT_MS)));
				for (const [i, v] of batch.entries()) {
					const text = texts[i];
					if (!text) continue;
					const clipped = text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n[…rest of transcript left out]` : text;
					found.push(
						`Video ${found.length + 1}: "${v.title}" by ${v.channel || "unknown channel"}, ${clock(v.seconds)} long\nid: ${v.id}\nTranscript:\n${clipped}`,
					);
				}
			}
			const timing = `${((Date.now() - start) / 1000).toFixed(1)}s for ${next} transcripts, ${found.length} usable${blocked ? `, ${blocked} not playable outside YouTube skipped` : ""}`;
			if (found.length === 0) {
				return reply(`No usable video found for "${params.query}" (none had a transcript). Use a picture instead.`, { status: "none", query: params.query, timing });
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
			return reply(how.join("\n"), { status: "found", query: params.query, count: found.length, timing });
		},
	};
}
