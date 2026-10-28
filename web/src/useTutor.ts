import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ClientMessage,
	LessonSort,
	LessonSummary,
	LoginEvent,
	LoginPrompt,
	ModelInfo,
	PendingInteraction,
	ProviderInfo,
	ServerMessage,
	TranscriptItem,
	TutorState,
	UpdateStatus,
} from "../../server/protocol.ts";

export interface LoginFlow {
	prompt?: { id: string; prompt: LoginPrompt };
	events: LoginEvent[];
	done?: { ok: boolean; error?: string };
}

export interface TutorStore {
	connected: boolean;
	state: TutorState | null;
	items: TranscriptItem[];
	streaming: string | null;
	/** What the tutor is busy with ("Finding a photo…"), if known. */
	activity: string | null;
	interactions: Record<string, PendingInteraction>;
	lessons: LessonSummary[];
	/** The learner's folders, and how the lesson list is sorted. */
	library: { folders: string[]; sort: LessonSort };
	providers: ProviderInfo[];
	models: ModelInfo[];
	login: LoginFlow | null;
	toast: string | null;
	update: UpdateStatus | null;
	/** The end of the picture log, once asked for. */
	pictureLog: string | null;
	/** True while a file or link is being read. */
	addingResource: boolean;
	send: (msg: ClientMessage) => void;
	resetLogin: () => void;
	clearToast: () => void;
	showToast: (text: string) => void;
}

function download(filename: string, text: string) {
	const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

/** Keeps one WebSocket to the local server open and mirrors what it sends. */
export function useTutor(): TutorStore {
	const wsRef = useRef<WebSocket | null>(null);
	const [connected, setConnected] = useState(false);
	const [state, setState] = useState<TutorState | null>(null);
	const [items, setItems] = useState<TranscriptItem[]>([]);
	const [streaming, setStreaming] = useState<string | null>(null);
	const [activity, setActivity] = useState<string | null>(null);
	const [interactions, setInteractions] = useState<Record<string, PendingInteraction>>({});
	const [lessons, setLessons] = useState<LessonSummary[]>([]);
	const [library, setLibrary] = useState<{ folders: string[]; sort: LessonSort }>({ folders: [], sort: "newest" });
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [login, setLogin] = useState<LoginFlow | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const [update, setUpdate] = useState<UpdateStatus | null>(null);
	const [pictureLog, setPictureLog] = useState<string | null>(null);
	const [addingResource, setAddingResource] = useState(false);
	const versionRef = useRef<string | null>(null);

	useEffect(() => {
		let closed = false;
		let retry: ReturnType<typeof setTimeout>;

		const connect = () => {
			const proto = location.protocol === "https:" ? "wss" : "ws";
			const ws = new WebSocket(`${proto}://${location.host}/ws`);
			wsRef.current = ws;
			ws.onopen = () => {
				setConnected(true);
				ws.send(JSON.stringify({ type: "list_providers" }));
				// The country this computer is set to ("CA" from "en-CA"), so video searches suit where the learner is.
				const region = navigator.languages
					.map((l) => /-([A-Za-z]{2})\b/.exec(l)?.[1])
					.find(Boolean);
				if (region) ws.send(JSON.stringify({ type: "set_region", region: region.toUpperCase() }));
			};
			ws.onclose = () => {
				setConnected(false);
				setInteractions({});
				setAddingResource(false);
				if (!closed) retry = setTimeout(connect, 1500);
			};
			ws.onmessage = (ev) => {
				const msg = JSON.parse(ev.data) as ServerMessage;
				switch (msg.type) {
					case "hello":
						// LILA was updated while this page was open: load the new page.
						if (versionRef.current && versionRef.current !== msg.version) location.reload();
						versionRef.current = msg.version;
						break;
					case "update":
						setUpdate(msg.status);
						break;
					case "picture_log":
						setPictureLog(msg.text);
						break;
					case "resource_done":
						setAddingResource(false);
						if (!msg.ok) setToast(msg.error ?? "That couldn't be added.");
						break;
					case "state":
						setState(msg.state);
						break;
					case "transcript":
						setItems(msg.items);
						break;
					case "streaming":
						setStreaming(msg.text);
						break;
					case "activity":
						setActivity(msg.text);
						break;
					case "interaction":
						setInteractions((cur) => ({ ...cur, [msg.interaction.id]: msg.interaction }));
						break;
					case "interaction_done":
						setInteractions((cur) => {
							const next = { ...cur };
							delete next[msg.id];
							return next;
						});
						break;
					case "lessons":
						setLessons(msg.lessons);
						setLibrary({ folders: msg.folders ?? [], sort: msg.sort ?? "newest" });
						break;
					case "providers":
						setProviders(msg.providers);
						setModels(msg.models);
						break;
					case "login_prompt":
						setLogin((cur) => ({ events: cur?.events ?? [], prompt: { id: msg.id, prompt: msg.prompt } }));
						break;
					case "login_event":
						setLogin((cur) => ({ ...(cur ?? { events: [] }), events: [...(cur?.events ?? []), msg.event] }));
						if (msg.event.type === "auth_url") window.open(msg.event.url, "_blank", "noopener");
						break;
					case "login_done":
						setLogin((cur) => ({ events: cur?.events ?? [], done: { ok: msg.ok, error: msg.error } }));
						break;
					case "export":
						download(msg.filename, msg.markdown);
						break;
					case "error":
						setToast(msg.message);
						break;
				}
			};
		};
		connect();
		return () => {
			closed = true;
			clearTimeout(retry);
			wsRef.current?.close();
		};
	}, []);

	const send = useCallback((msg: ClientMessage) => {
		const ws = wsRef.current;
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
		if (msg.type === "login_start") setLogin({ events: [] });
		if (msg.type === "add_file" || msg.type === "add_link") setAddingResource(true);
		if (msg.type === "login_reply") setLogin((cur) => (cur ? { ...cur, prompt: undefined } : cur));
	}, []);

	return {
		connected,
		state,
		items,
		streaming,
		activity,
		interactions,
		lessons,
		library,
		providers,
		models,
		login,
		toast,
		update,
		pictureLog,
		addingResource,
		send,
		resetLogin: useCallback(() => setLogin(null), []),
		clearToast: useCallback(() => setToast(null), []),
		showToast: useCallback((text: string) => setToast(text), []),
	};
}
