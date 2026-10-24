// Self-update for copies set up with the one-step installers. The installer
// records which version it installed in `.version`; updating just runs the
// same installer again in the background, which replaces the app, keeps the
// learner's data and restarts Pi Learn. The page reloads itself when it sees
// the new version.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.ts";

export interface UpdateStatus {
	/** False when Pi Learn wasn't set up with an installer (for example a git clone). */
	supported: boolean;
	state: "idle" | "checking" | "current" | "available" | "updating" | "error";
	current?: string;
	latest?: string;
	error?: string;
}

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function installed(): { repo: string; sha: string } | undefined {
	try {
		const v = JSON.parse(fs.readFileSync(path.join(APP_DIR, ".version"), "utf8"));
		if (typeof v.repo === "string" && typeof v.sha === "string") return v;
	} catch {
		// Not installed with an installer.
	}
	return undefined;
}

/** Identifies this copy of the app, so the page can notice it was updated. */
export const APP_VERSION = installed()?.sha ?? `dev-${Date.now()}`;

export function initialStatus(): UpdateStatus {
	const v = installed();
	return v ? { supported: true, state: "idle", current: v.sha.slice(0, 7) } : { supported: false, state: "idle" };
}

export async function checkForUpdate(): Promise<UpdateStatus> {
	const v = installed();
	if (!v) return initialStatus();
	try {
		// Git's own ref listing: unlike GitHub's API it has no hourly limit.
		const res = await fetch(`https://github.com/${v.repo}.git/info/refs?service=git-upload-pack`, {
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
		const latest = /([0-9a-f]{40}) refs\/heads\/main\b/.exec(await res.text())?.[1];
		if (!latest) throw new Error("No main branch found");
		return {
			supported: true,
			state: latest === v.sha ? "current" : "available",
			current: v.sha.slice(0, 7),
			latest: latest.slice(0, 7),
		};
	} catch {
		return {
			supported: true,
			state: "error",
			current: v.sha.slice(0, 7),
			error: "Couldn't reach GitHub to check for updates. Check the internet connection and try again.",
		};
	}
}

/** Runs the installer in the background. It stops this server when it's ready to swap versions. */
export function startUpdate(): void {
	const v = installed();
	if (!v) throw new Error("Updates are only available when Pi Learn was set up with an installer.");
	const base = `https://raw.githubusercontent.com/${v.repo}/main/scripts`;
	const log = fs.openSync(path.join(DATA_DIR, "update.log"), "a");
	const env = { ...process.env, PI_LEARN_RESTART: "1" };
	const child =
		process.platform === "win32"
			? spawn(
					"powershell.exe",
					["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", `irm ${base}/install-windows.ps1 | iex`],
					{ detached: true, windowsHide: true, stdio: ["ignore", log, log], env },
				)
			: spawn("bash", ["-c", `curl -fsSL ${base}/install.sh | bash`], {
					detached: true,
					stdio: ["ignore", log, log],
					env,
				});
	child.unref();
}
