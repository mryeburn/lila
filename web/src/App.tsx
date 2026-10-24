import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TranscriptItem } from "../../server/protocol.ts";
import { AddResource } from "./components/AddResource.tsx";
import { AskCard, AskResult, QuestionsInvite, QuizCard, QuizResult } from "./components/Cards.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { Settings } from "./components/Settings.tsx";
import { type TutorStore, useTutor } from "./useTutor.ts";

const STARTERS = [
	"Teach me how the internet actually works",
	"I want to really understand derivatives",
	"Explain how large language models work",
	"Teach me the basics of music theory",
];

// Short tutor messages ("Great, let's start") don't get a picture button.
const MIN_PICTURE_TEXT = 120;
// A tutor message at least this long is a teaching section: invite questions after it.
const MIN_SECTION_TEXT = 400;

/** Pictures the app added under a tutor message or quiz, and the button to ask for one. */
function Pictures({
	id,
	pictures,
	drawing,
	canAsk,
	store,
}: {
	id: string;
	pictures?: string[];
	drawing?: boolean;
	canAsk: boolean;
	store: TutorStore;
}) {
	if (!pictures?.length && !drawing && !canAsk) return null;
	return (
		<div className="app-pictures">
			{pictures?.map((picture) => (
				<div className="app-picture" key={picture}>
					<Markdown text={picture} onBroken={() => store.send({ type: "picture_broken", id, picture })} />
				</div>
			))}
			{drawing ? (
				<div className="picture-button drawing">🖼 Making a picture…</div>
			) : (
				canAsk && (
					<button type="button" className="picture-button" onClick={() => store.send({ type: "illustrate", id })}>
						🖼 {pictures?.length ? "Show me another picture" : "Show me a picture"}
					</button>
				)
			)}
		</div>
	);
}

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
					<Pictures
						id={item.id}
						pictures={item.pictures}
						drawing={item.drawing}
						canAsk={item.text.trim().length >= MIN_PICTURE_TEXT}
						store={store}
					/>
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
			if (pending?.kind === "pause")
				return (
					<QuestionsInvite
						text="If you have a question about this section, type it in here. Otherwise, start the quiz."
						continueLabel="Start the quiz →"
						onContinue={() => answer({})}
						onAsk={(text) => answer({ text })}
					/>
				);
			const pictures =
				item.kind === "quiz" ? (
					<Pictures id={item.id} pictures={item.pictures} drawing={item.drawing} canAsk store={store} />
				) : null;
			if (pending?.kind === "graded")
				return (
					<QuizResult
						question={item.question}
						details={item.details}
						result={pending.result}
						onNext={() => answer({})}
						onAsk={(text) => store.send({ type: "prompt", text, question: true })}
						pictures={pictures}
					/>
				);
			if (item.result) {
				return item.kind === "quiz" ? (
					<QuizResult question={item.question} details={item.details} result={item.result} pictures={pictures} />
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
	/** Set when the learner pressed "Check for updates", so the answer is shown even when there's nothing new. */
	const checkedByHand = useRef(false);
	/** Shown on the update button for a few seconds after a check found nothing new. */
	const [upToDate, setUpToDate] = useState(false);

	useEffect(() => {
		const update = store.update;
		if (!checkedByHand.current || !update || update.state === "checking") return;
		checkedByHand.current = false;
		if (update.state === "current") {
			setUpToDate(true);
			setTimeout(() => setUpToDate(false), 5000);
		}
		if (update.state === "error") store.showToast(update.error ?? "Couldn't check for updates.");
	}, [store.update, store.showToast]);

	const busy = state?.busy ?? false;
	const needsSetup = state !== null && !state.model;
	const waitingOnCard = Object.values(store.interactions).some((i) => i.kind !== "graded");

	// First visit with no AI connected: open settings straight away. Only once
	// per visit, so starting a new lesson never brings it up again.
	const offeredSetup = useRef(false);
	useEffect(() => {
		if (state === null || offeredSetup.current) return;
		offeredSetup.current = true;
		if (needsSetup) setSettingsOpen(true);
	}, [state, needsSetup]);

	// Follow new content unless the learner has scrolled up to reread, but
	// stop once a new tutor reply reaches the top of the screen, so a long
	// reply is read from its beginning. "More below" then takes them down.
	const [moreBelow, setMoreBelow] = useState(false);
	const checkMoreBelow = (el: HTMLElement) => setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 80);
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (stick.current) {
			let target = el.scrollHeight - el.clientHeight;
			const replies = el.querySelectorAll<HTMLElement>(".msg.tutor");
			const reply = replies[replies.length - 1];
			if (reply) {
				const top = reply.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16;
				if (top >= el.scrollTop - 4) target = Math.min(target, top);
			}
			if (target > el.scrollTop) el.scrollTop = target;
		}
		checkMoreBelow(el);
	}, [items, streaming, store.interactions]);

	useEffect(() => {
		if (!store.toast) return;
		const t = setTimeout(store.clearToast, 6000);
		return () => clearTimeout(t);
	}, [store.toast, store.clearToast]);

	const submit = (text = draft, question = false) => {
		if (!text.trim()) return;
		if (!state?.model) {
			setSettingsOpen(true);
			return;
		}
		send({ type: "prompt", text, question });
		setDraft("");
		stick.current = true;
	};

	const last = items.at(-1);
	// The tutor finished a teaching section and is waiting: invite questions.
	const inviteQuestions =
		connected &&
		!busy &&
		Object.keys(store.interactions).length === 0 &&
		last?.kind === "assistant" &&
		last.text.trim().length >= MIN_SECTION_TEXT;
	const lastIsStreamingDuplicate = streaming !== null && last?.kind === "assistant" && last.text === streaming;

	return (
		<div className={`app ${sidebarOpen ? "sidebar-open" : ""}`}>
			<aside className="sidebar">
				<div className="brand">
					<span className="logo">L</span> LILA
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
				{/* Checking for, offering and running updates all happen on this one button. */}
				{store.update?.supported &&
					(store.update.state === "available" ? (
						<button type="button" className="update-ready wide" onClick={() => send({ type: "start_update" })}>
							⬇ Update now
						</button>
					) : (
						<button
							type="button"
							className={`secondary wide ${store.update.state === "updating" ? "update-running" : ""} ${upToDate ? "update-current" : ""}`}
							disabled={store.update.state === "checking" || store.update.state === "updating" || upToDate}
							onClick={() => {
								checkedByHand.current = true;
								send({ type: "check_update" });
							}}
						>
							{store.update.state === "checking"
								? "Checking for updates…"
								: store.update.state === "updating"
									? "Updating… the page will reload by itself"
									: upToDate
										? "✓ LILA is up to date"
										: "⟳ Check for updates"}
						</button>
					))}
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

				{!connected && <div className="banner">Reconnecting to LILA… Is the app still running in your terminal?</div>}
				{state?.error && <div className="banner error">{state.error}</div>}

				<div
					className="scroll"
					ref={scrollRef}
					onScroll={(e) => {
						const el = e.currentTarget;
						stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
						checkMoreBelow(el);
					}}
				>
					<div className="transcript">
						{items.length === 0 && streaming === null && (
							<div className="welcome">
								<div className="logo big">L</div>
								<h1>What do you want to understand?</h1>
								<p>
									Your tutor first checks what you already know with a few quick questions, then shows you a plan, then
									teaches it one small step at a time, with pictures and quick checks along the way.
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
						{inviteQuestions && (
							<QuestionsInvite
								key={last.id}
								text="If you have a question about this section, type it in here. Otherwise, continue the lesson."
								continueLabel="Continue the lesson →"
								onContinue={() => submit("No questions, please continue.")}
								onAsk={(text) => submit(text, true)}
							/>
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

				{moreBelow && (
					<div className="more-below-anchor">
						<button
							type="button"
							className="more-below"
							onClick={() => scrollRef.current?.scrollBy({ top: scrollRef.current.clientHeight * 0.8, behavior: "smooth" })}
						>
							↓ More below
						</button>
					</div>
				)}
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
