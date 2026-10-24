import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Everything this app writes lives under one folder in the user's home
// directory, so lessons survive reinstalls and nothing lands in the repo.
export const DATA_DIR = process.env.PI_LEARN_DATA_DIR || path.join(os.homedir(), ".pi-learn-web");
export const WORKSPACE_DIR = path.join(DATA_DIR, "workspace");
export const SESSIONS_DIR = path.join(DATA_DIR, "lessons");
export const SKILLS_DIR = path.join(DATA_DIR, "skills");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

// Amos's teaching skill is fetched from the original repo rather than copied
// into this one: his repo has no license, and fetching keeps it up to date.
const LEARN_REPO_RAW = "https://raw.githubusercontent.com/amosblomqvist/learn/main";
const TEACH_SKILL_PATH = "skills/teach/SKILL.md";

export interface AppSettings {
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
}

export function ensureDirs(): void {
	for (const dir of [DATA_DIR, WORKSPACE_DIR, SESSIONS_DIR, SKILLS_DIR]) {
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

/**
 * Make sure the teach skill is on disk, downloading it on first run. Returns
 * the skill's directory. A failed refresh keeps the cached copy.
 */
export async function ensureTeachSkill(): Promise<string> {
	const dir = path.join(SKILLS_DIR, "teach");
	const file = path.join(dir, "SKILL.md");
	fs.mkdirSync(dir, { recursive: true });
	try {
		const res = await fetch(`${LEARN_REPO_RAW}/${TEACH_SKILL_PATH}`, { signal: AbortSignal.timeout(15000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		if (!text.includes("name: teach")) throw new Error("unexpected content");
		fs.writeFileSync(file, text);
	} catch (err) {
		if (!fs.existsSync(file)) {
			throw new Error(
				`Could not download the Pi Learn teaching skill from GitHub (${(err as Error).message}). Check your internet connection and start the app again.`,
			);
		}
		console.warn(`[pi-learn] Using cached teach skill; refresh failed: ${(err as Error).message}`);
	}
	return dir;
}
