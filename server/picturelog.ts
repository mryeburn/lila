// A plain log of how each picture was chosen: what was searched, what was
// found and what the AI picked. When a lesson comes up short on pictures, the
// learner can copy the end of it from Settings and share it.

import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR } from "./config.ts";

const LOG_FILE = path.join(DATA_DIR, "pictures.log");
const MAX_BYTES = 1_000_000;
const SHARE_LINES = 300;

export function logPicture(message: string): void {
	try {
		if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) {
			// Keep the newer half.
			const text = fs.readFileSync(LOG_FILE, "utf8");
			fs.writeFileSync(LOG_FILE, text.slice(text.length / 2));
		}
		const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
		fs.appendFileSync(LOG_FILE, `${stamp}  ${message.replace(/\s*\n\s*/g, " / ")}\n`);
	} catch {
		// Logging must never break a lesson.
	}
}

export function readPictureLog(): string {
	try {
		const lines = fs.readFileSync(LOG_FILE, "utf8").trimEnd().split("\n");
		return lines.slice(-SHARE_LINES).join("\n");
	} catch {
		return "";
	}
}
