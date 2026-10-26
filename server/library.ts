// How the learner has organised their lessons: their own names for them,
// folders, and the sort order. Kept in one small file next to the lessons, so
// the lesson files themselves are never renamed or moved.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";

export type LessonSort = "newest" | "oldest" | "name";

export interface Library {
	/** Lesson file name -> the learner's own title. */
	names: Record<string, string>;
	/** Folder names, in the order they were made. */
	folders: string[];
	/** Lesson file name -> its folder. */
	folderOf: Record<string, string>;
	sort: LessonSort;
}

const LIBRARY_FILE = path.join(DATA_DIR, "library.json");

export function loadLibrary(): Library {
	const empty: Library = { names: {}, folders: [], folderOf: {}, sort: "newest" };
	if (!existsSync(LIBRARY_FILE)) return empty;
	try {
		const saved = JSON.parse(readFileSync(LIBRARY_FILE, "utf8"));
		return {
			names: saved.names ?? {},
			folders: Array.isArray(saved.folders) ? saved.folders : [],
			folderOf: saved.folderOf ?? {},
			sort: ["newest", "oldest", "name"].includes(saved.sort) ? saved.sort : "newest",
		};
	} catch {
		return empty;
	}
}

export function saveLibrary(library: Library): void {
	writeFileSync(LIBRARY_FILE, `${JSON.stringify(library, null, "\t")}\n`);
}

/** The key a lesson is stored under: its file name, so it survives the data folder moving. */
export function lessonKey(lessonPath: string): string {
	return path.basename(lessonPath);
}

/** A folder or lesson name as typed, tidied; empty when there's nothing usable. */
export function cleanName(name: unknown): string {
	return String(name ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}
