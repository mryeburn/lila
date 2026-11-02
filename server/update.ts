// Self-update for copies set up with the one-step installers. The installer
// records which version it installed in `.version`; updating just runs the
// same installer again in the background, which replaces the app, keeps the
// learner's data and restarts LILA. The page reloads itself when it sees
// the new version.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.ts";

export interface UpdateStatus {
	/** False when LILA wasn't set up with an installer (for example a git clone). */
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

/**
 * A read-only GitHub key, so updates keep working once the repository is
 * private: the one that comes with the app (scripts/update-key, stored
 * reversed and base64-encoded so it isn't mistaken for a leaked key), else one
 * saved as github-token in the data folder, else the installer's LILA_TOKEN.
 * The app's own comes first, so an update can replace an expired key.
 */
export function githubToken(): string {
	for (const [file, decode] of [
		[path.join(APP_DIR, "scripts", "update-key"), (s: string) => [...Buffer.from(s, "base64").toString("utf8")].reverse().join("")],
		[path.join(DATA_DIR, "github-token"), (s: string) => s],
	] as const) {
		try {
			const token = decode(fs.readFileSync(file, "utf8").trim()).trim();
			if (/^[\w-]{20,}$/.test(token)) return token;
		} catch {
			// No key there.
		}
	}
	return process.env.LILA_TOKEN?.trim() ?? "";
}

function githubHeaders(token: string): Record<string, string> {
	return token ? { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` } : {};
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
			headers: githubHeaders(githubToken()),
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

/**
 * Downloads the latest installer and runs it in the background. It stops this
 * server when it's ready to swap versions.
 */
export async function startUpdate(): Promise<void> {
	const v = installed();
	if (!v) throw new Error("Updates are only available when LILA was set up with an installer.");
	const windows = process.platform === "win32";
	const name = windows ? "install-windows.ps1" : "install.sh";
	const token = githubToken();
	// With a key, through GitHub's API: it also works once the repository is private.
	// Without one (or if the key stopped working), the public address.
	const get = (url: string, headers: Record<string, string> = {}) =>
		fetch(url, { headers, signal: AbortSignal.timeout(30_000) }).then((r) => (r.ok ? r : undefined), () => undefined);
	const res =
		(token
			? await get(`https://api.github.com/repos/${v.repo}/contents/scripts/${name}?ref=main`, {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github.raw",
				})
			: undefined) ?? (await get(`https://raw.githubusercontent.com/${v.repo}/main/scripts/${name}`));
	if (!res) throw new Error("Couldn't download the update from GitHub. Check the internet connection and try again.");
	const script = path.join(DATA_DIR, name);
	// Windows PowerShell reads a script without a byte-order mark as ANSI, so mark it UTF-8.
	fs.writeFileSync(script, (windows ? "\ufeff" : "") + (await res.text()));
	const log = fs.openSync(path.join(DATA_DIR, "update.log"), "a");
	const env = { ...process.env, LILA_RESTART: "1", ...(token ? { LILA_TOKEN: token } : {}) };
	const child = windows
		? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script], {
				detached: true,
				windowsHide: true,
				stdio: ["ignore", log, log],
				env,
			})
		: spawn("bash", [script], { detached: true, stdio: ["ignore", log, log], env });
	child.unref();
}
