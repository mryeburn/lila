import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { DATA_DIR, ensureDirs, ensureTeachSkill } from "./config.ts";
import type { ClientMessage, LoginPrompt, ModelInfo, ProviderInfo, ServerMessage } from "./protocol.ts";
import { Tutor } from "./tutor.ts";

const PORT = Number(process.env.PORT || 4747);
// Local only by default: the app can spend your AI credits, so it shouldn't be
// reachable from other machines unless you ask for that.
const HOST = process.env.HOST || "127.0.0.1";
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");

ensureDirs();
const teachSkillDir = await ensureTeachSkill();
const runtime = await ModelRuntime.create(
	process.env.PI_LEARN_MODELS_PATH ? { modelsPath: process.env.PI_LEARN_MODELS_PATH } : undefined,
);

const clients = new Set<WebSocket>();
function sendTo(ws: WebSocket, msg: ServerMessage) {
	if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg: ServerMessage) {
	for (const ws of clients) sendTo(ws, msg);
}

const tutor = new Tutor(runtime, teachSkillDir, broadcast);

// ── Sign-in ──────────────────────────────────────────────────────────────────

const FEATURED = ["anthropic", "openai", "google", "openrouter"];

async function providerList(): Promise<{ providers: ProviderInfo[]; models: ModelInfo[] }> {
	const providers = runtime
		.getProviders()
		.filter((p) => p.auth.apiKey?.login || p.auth.oauth)
		.map((p) => ({
			id: p.id,
			name: p.name,
			apiKeyName: p.auth.apiKey?.login ? p.auth.apiKey.name : undefined,
			oauthName: p.auth.oauth?.name,
			configured: runtime.hasConfiguredAuth(p.id),
		}))
		.sort((a, b) => {
			const fa = FEATURED.indexOf(a.id);
			const fb = FEATURED.indexOf(b.id);
			if (fa !== -1 || fb !== -1) return (fa === -1 ? 99 : fa) - (fb === -1 ? 99 : fb);
			return a.name.localeCompare(b.name);
		});
	const models = (await runtime.getAvailable().catch(() => [])).map((m) => ({
		provider: m.provider,
		id: m.id,
		name: m.name ?? m.id,
	}));
	return { providers, models };
}

let login:
	| { owner: WebSocket; abort: AbortController; replies: Map<string, (value: string) => void> }
	| undefined;
let loginPromptSeq = 0;

async function startLogin(ws: WebSocket, provider: string, method: "api_key" | "oauth") {
	login?.abort.abort();
	const current = { owner: ws, abort: new AbortController(), replies: new Map<string, (value: string) => void>() };
	login = current;
	try {
		await runtime.login(provider, method, {
			signal: current.abort.signal,
			prompt: (prompt) =>
				new Promise<string>((resolve, reject) => {
					const id = `p${++loginPromptSeq}`;
					current.replies.set(id, resolve);
					const cancel = () => reject(new Error("Sign-in cancelled"));
					current.abort.signal.addEventListener("abort", cancel, { once: true });
					prompt.signal?.addEventListener("abort", cancel, { once: true });
					const { signal: _s, ...rest } = prompt as any;
					sendTo(ws, { type: "login_prompt", id, prompt: rest as LoginPrompt });
				}),
			notify: (event) => sendTo(ws, { type: "login_event", event: event as any }),
		});
		sendTo(ws, { type: "login_done", ok: true });
		await tutor.refreshModel();
		broadcast({ type: "providers", ...(await providerList()) });
	} catch (err) {
		sendTo(ws, { type: "login_done", ok: false, error: (err as Error).message });
	} finally {
		if (login === current) login = undefined;
	}
}

// ── Messages from the page ───────────────────────────────────────────────────

async function handle(ws: WebSocket, msg: ClientMessage) {
	switch (msg.type) {
		case "prompt":
			if (msg.text.trim()) void tutor.prompt(msg.text.trim());
			break;
		case "answer":
			tutor.answer(msg.id, msg.answer);
			break;
		case "abort":
			await tutor.abort();
			break;
		case "new_lesson":
			await tutor.openLesson();
			break;
		case "open_lesson":
			await tutor.openLesson(msg.path);
			break;
		case "export_lesson": {
			const state = await tutor.state();
			const slug = (state.lessonTitle ?? "lesson").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50);
			sendTo(ws, { type: "export", filename: `${slug || "lesson"}.md`, markdown: tutor.exportMarkdown() });
			break;
		}
		case "list_providers":
			sendTo(ws, { type: "providers", ...(await providerList()) });
			break;
		case "set_model":
			await tutor.setModel(msg.provider, msg.modelId);
			break;
		case "set_thinking":
			await tutor.setThinking(msg.level);
			break;
		case "login_start":
			void startLogin(ws, msg.provider, msg.method);
			break;
		case "login_reply":
			login?.replies.get(msg.id)?.(msg.value);
			login?.replies.delete(msg.id);
			break;
		case "login_cancel":
			login?.abort.abort();
			break;
		case "logout":
			await runtime.logout(msg.provider);
			await tutor.refreshModel();
			broadcast({ type: "providers", ...(await providerList()) });
			break;
	}
}

// ── HTTP + WebSocket server ──────────────────────────────────────────────────

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".json": "application/json",
};

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	let file = path.normalize(path.join(WEB_DIR, decodeURIComponent(url.pathname)));
	if (!file.startsWith(WEB_DIR)) {
		res.writeHead(403).end();
		return;
	}
	if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, "index.html");
	if (!fs.existsSync(file)) {
		res.writeHead(500, { "content-type": "text/plain" }).end("The web page hasn't been built. Run: npm start");
		return;
	}
	res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
	fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: "/ws" });
// The WebSocket server re-emits the HTTP server's errors; those are handled below.
wss.on("error", () => {});
wss.on("connection", (ws, req) => {
	// Only accept the page this server serves, so other websites can't drive it.
	const origin = req.headers.origin;
	if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) && HOST === "127.0.0.1") {
		ws.close(1008, "origin not allowed");
		return;
	}
	clients.add(ws);
	ws.on("close", () => clients.delete(ws));
	ws.on("message", (data) => {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(String(data));
		} catch {
			return;
		}
		handle(ws, msg).catch((err) => sendTo(ws, { type: "error", message: (err as Error).message }));
	});
	void tutor.sendSnapshot((m) => sendTo(ws, m));
});

await tutor.openLesson();
server.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EADDRINUSE") {
		// Most likely Pi Learn is already running (started twice): just show it.
		const url = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
		console.log(`\n  Something is already running at ${url}, probably Pi Learn. Opening it in your browser.\n  To run a second copy, set a different PORT.\n`);
		if (!process.env.PI_LEARN_NO_OPEN) openBrowser(url);
		tutor.dispose();
		setTimeout(() => process.exit(0), 500);
		return;
	}
	throw err;
});
server.listen(PORT, HOST, () => {
	const url = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
	console.log(`\n  Pi Learn is running at ${url}\n  Lessons are saved in ${DATA_DIR}\n  Press Ctrl+C to stop.\n`);
	if (!process.env.PI_LEARN_NO_OPEN) openBrowser(url);
});

function openBrowser(url: string) {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
	} catch {
		// No browser launcher; the URL is printed above.
	}
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		tutor.dispose();
		process.exit(0);
	});
}
