import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Everything this app writes lives under one folder in the user's home
// directory, so lessons survive reinstalls and nothing lands in the repo.
export const DATA_DIR = process.env.LILA_DATA_DIR || path.join(os.homedir(), ".lila");
export const WORKSPACE_DIR = path.join(DATA_DIR, "workspace");
export const SESSIONS_DIR = path.join(DATA_DIR, "lessons");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

// LILA's own teaching method, kept at the top of the repo so it's easy to find
// and edit.
export const TEACHING_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../teaching-instructions.md");

export interface AppSettings {
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	/** SerpApi key, for photos from Google Images. */
	photoSearchKey?: string;
	/** false: the tutor runs the lesson by itself, without LILA directing each step. */
	guidedSteps?: boolean;
}

export function ensureDirs(): void {
	for (const dir of [DATA_DIR, WORKSPACE_DIR, SESSIONS_DIR]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

export function loadSettings(): AppSettings {
	try {
		return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as AppSettings;
	} catch {
		return {};
	}
}

export function saveSettings(settings: AppSettings): void {
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
