import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TranscriptItem } from "../../server/protocol.ts";
import { AddResource } from "./components/AddResource.tsx";
import { AskCard, AskResult, QuizCard, QuizResult } from "./components/Cards.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { Settings } from "./components/Settings.tsx";
import { type TutorStore, useTutor } from "./useTutor.ts";

const STARTERS = [
	"Teach me how the internet actually works",
	"I want to really understand derivatives",
	"Explain how large language models work",
	"Teach me the basics of music theory",
];

function Item({ item, store }: { item: TranscriptItem; store: TutorStore }) {
	switch (item.kind) {
		case "user":
			return (
				<div className="msg user">
					<div className="bubble">{item.text}</div>
				</div>
			);
		case "assistant":
			return (
				<div className="msg tutor">
					<Markdown text={item.text} />
				</div>
			);
		case "error":
			return <div className="msg error-msg">Something went wrong: {item.text}</div>;
		case "resource":
			return (
				<div className="msg user">
					<div className="resource-chip" title={item.truncated ? "Very long, so only the first part was used" : undefined}>
						<span className="resource-icon">{item.source === "link" ? "🔗" : "📄"}</span>
						<span className="resource-name">{item.name}</span>
						<span className="resource-size">
							{Math.max(1, Math.round(item.chars / 6 / 100) * 100).toLocaleString()} words{item.truncated ? ", shortened" : ""}
						</span>
					</div>
				</div>
			);
		case "quiz":
		case "ask": {
			const pending = store.interactions[item.id];
			const answer = (answer: unknown) => store.send({ type: "answer", id: item.id, answer });
			if (pending?.kind === "quiz") return <QuizCard quiz={pending} onAnswer={answer} />;
			if (pending?.kind === "ask") return <AskCard ask={pending} onAnswer={answer} />;
			if (pending?.kind === "graded")
				return (
					<QuizResult question={item.question} details={item.details} result={pending.result} onNext={() => answer({})} />
				);
			if (item.result) {
				return item.kind === "quiz" ? (
					<QuizResult question={item.question} details={item.details} result={item.result} />
				) : (
					<AskResult question={item.question} details={item.details} result={item.result} />
				);
			}
			// Queued behind the card the learner is on now: show it when its turn comes.
			if (Object.keys(store.interactions).length > 0) return null;
			return <div className="card muted">Preparing a {item.kind === "quiz" ? "quiz" : "question"}…</div>;
		}
	}
}

function relativeDate(iso: string) {
	const d = new Date(iso);
	const days = Math.floor((Date.now() - d.getTime()) / 86400000);
	if (days < 1) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
	return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function App() {
	const store = useTutor();
	const { state, items, streaming, lessons, send, connected } = store;
	const [draft, setDraft] = useState("");
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const busy = state?.busy ?? false;
	const needsSetup = state !== null && !state.model;
	const waitingOnCard = Object.values(store.interactions).some((i) => i.kind !== "graded");

	// First visit with no AI connected: open settings straight away.
	useEffect(() => {
		if (needsSetup) setSettingsOpen(true);
	}, [needsSetup]);

	// Follow new content unless the learner has scrolled up to reread.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [items, streaming, store.interactions]);

	useEffect(() => {
		if (!store.toast) return;
		const t = setTimeout(store.clearToast, 6000);
		return () => clearTimeout(t);
	}, [store.toast, store.clearToast]);

	const submit = (text = draft) => {
		if (!text.trim()) return;
		if (!state?.model) {
			setSettingsOpen(true);
			return;
		}
		send({ type: "prompt", text });
		setDraft("");
		stick.current = true;
	};

	const last = items.at(-1);
	const lastIsStreamingDuplicate = streaming !== null && last?.kind === "assistant" && last.text === streaming;

	return (
		<div className={`app ${sidebarOpen ? "sidebar-open" : ""}`}>
			<aside className="sidebar">
				<div className="brand">
					<span className="logo">π</span> Pi Learn
				</div>
				<button
					type="button"
					className="primary wide"
					onClick={() => {
						send({ type: "new_lesson" });
						setSidebarOpen(false);
						inputRef.current?.focus();
					}}
				>
					+ New lesson
				</button>
				<div className="lesson-list">
					{lessons.length > 0 && <div className="list-label">Your lessons</div>}
					{lessons.map((l) => (
						<button
							key={l.path}
							type="button"
							className={`lesson ${l.path === state?.lessonPath ? "current" : ""}`}
							onClick={() => {
								send({ type: "open_lesson", path: l.path });
								setSidebarOpen(false);
							}}
						>
							<span className="lesson-title">{l.title}</span>
							<span className="lesson-date">{relativeDate(l.modified)}</span>
						</button>
					))}
				</div>
				<button type="button" className="secondary wide" onClick={() => setSettingsOpen(true)}>
					⚙ Settings
				</button>
			</aside>
			<div className="scrim" onClick={() => setSidebarOpen(false)} />

			<main className="main">
				<header className="topbar">
					<button type="button" className="icon-button menu" onClick={() => setSidebarOpen(true)} aria-label="Lessons">
						☰
					</button>
					<div className="title">{state?.lessonTitle ?? "New lesson"}</div>
					<button type="button" className="model-pill" onClick={() => setSettingsOpen(true)}>
						{state?.model ? state.model.name : "Connect AI"}
					</button>
					{items.length > 0 && (
						<button
							type="button"
							className="icon-button"
							title="Download this lesson as Markdown"
							onClick={() => send({ type: "export_lesson" })}
						>
							⤓
						</button>
					)}
				</header>

				{!connected && <div className="banner">Reconnecting to Pi Learn… Is the app still running in your terminal?</div>}
				{state?.error && <div className="banner error">{state.error}</div>}

				<div
					className="scroll"
					ref={scrollRef}
					onScroll={(e) => {
						const el = e.currentTarget;
						stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
					}}
				>
					<div className="transcript">
						{items.length === 0 && streaming === null && (
							<div className="welcome">
								<div className="logo big">π</div>
								<h1>What do you want to understand?</h1>
								<p>
									Your tutor first checks what you already know with a few quick questions, then shows you a plan, then
									builds the idea up step by step from things that are obviously true.
								</p>
								<div className="starters">
									{STARTERS.map((s) => (
										<button key={s} type="button" className="starter" onClick={() => submit(s)}>
											{s}
										</button>
									))}
								</div>
							</div>
						)}
						{items.map((item, i) => (
							<Item key={item.kind === "quiz" || item.kind === "ask" ? item.id : `${item.kind}-${i}`} item={item} store={store} />
						))}
						{streaming !== null && streaming.trim() !== "" && !lastIsStreamingDuplicate && (
							<div className="msg tutor">
								<Markdown text={streaming} streaming />
							</div>
						)}
						{busy && Object.keys(store.interactions).length === 0 && (streaming === null || streaming.trim() === "") && (
							<div className="thinking">
								<span />
								<span />
								<span />
							</div>
						)}
					</div>
				</div>

				<form
					className="composer"
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<AddResource store={store} />
					<textarea
						ref={inputRef}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								submit();
							}
						}}
						rows={1}
						placeholder={
							waitingOnCard
								? "Answer the card above, or type here to say something else…"
								: items.length === 0
									? "Type a topic you want to learn…"
									: "Reply to your tutor…"
						}
					/>
					{busy ? (
						<button type="button" className="secondary" onClick={() => send({ type: "abort" })}>
							Stop
						</button>
					) : (
						<button type="submit" className="primary" disabled={!draft.trim()}>
							Send
						</button>
					)}
				</form>
			</main>

			{settingsOpen && <Settings store={store} onClose={() => setSettingsOpen(false)} />}
			{store.toast && (
				<div className="toast" onClick={store.clearToast}>
					{store.toast}
				</div>
			)}
		</div>
	);
}
