import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { QUIZ_LABEL, type QuizPhase, quizPhases } from "../../server/phases.ts";
import type { TranscriptItem } from "../../server/protocol.ts";
import { AddResource, DropBox, isDroppable, sendDropped } from "./components/AddResource.tsx";
import { AskCard, AskResult, QuestionsInvite, QuizCard, QuizResult } from "./components/Cards.tsx";
import { KeyPopup } from "./components/KeyPopup.tsx";
import { LessonList } from "./components/LessonList.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { PartDivider, TutorText } from "./components/Parts.tsx";
import { Settings } from "./components/Settings.tsx";
import { type TutorStore, useTutor } from "./useTutor.ts";

const STARTERS = [
	"Teach me how the internet actually works",
	"I want to really understand derivatives",
	"Explain how large language models work",
	"Teach me the basics of music theory",
];

// A tutor message at least this long is a teaching section: invite questions after it.
const MIN_SECTION_TEXT = 400;

/** Pictures the app added under a tutor message or quiz. */
function Pictures({
	id,
	pictures,
	drawing,
	store,
}: {
	id: string;
	pictures?: string[];
	drawing?: boolean;
	store: TutorStore;
}) {
	if (!pictures?.length && !drawing) return null;
	return (
		<div className="app-pictures">
			{pictures?.map((picture) => (
				<div className="app-picture" key={picture}>
					<Markdown text={picture} onBroken={() => store.send({ type: "picture_broken", id, picture })} />
				</div>
			))}
			{drawing && <div className="picture-button drawing">🖼 Making a picture…</div>}
		</div>
	);
}

const START_QUIZ: Record<QuizPhase, { text: string; label: string }> = {
	"pre-test": {
		text: "Any questions? Type your question here or start the pre-test.",
		label: "Start the pre-test →",
	},
	lesson: {
		text: "Any questions about this section? Type your question here or start the quiz.",
		label: "Start the quiz →",
	},
	final: {
		text: "Any questions about the lesson? Type your question here or start the final quiz.",
		label: "Start the final quiz →",
	},
	review: {
		text: "Any questions about the lesson? Type your question here or start the review quiz.",
		label: "Start the review quiz →",
	},
};

/** Cards the learner never saw (the app sent them back to the tutor). */
const NOT_SHOWN = ["unanswered", "held", "unavailable"];

/**
 * The tutor's text since the learner last did something, skipping cards that
 * were never shown, so a section followed by a refused card still counts.
 */
function turnText(items: TranscriptItem[]): string {
	let text = "";
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === "assistant") text = `${item.text}\n${text}`;
		else if ((item.kind === "quiz" || item.kind === "ask") && NOT_SHOWN.includes(item.result?.status ?? "")) continue;
		else break;
	}
	return text;
}

/** The learner said yes to "Do you have any files or web links…?" */
function saidYesToFiles(item: TranscriptItem): boolean {
	return (
		item.kind === "ask" &&
		/files or web links/i.test(item.question) &&
		item.result?.status === "answered" &&
		(item.result.answers ?? []).some((a: any) => /^yes\b/i.test(String(a.label ?? "").trim()))
	);
}

function Item({
	item,
	store,
	latestCard,
	phase = "lesson",
}: {
	item: TranscriptItem;
	store: TutorStore;
	latestCard?: boolean;
	phase?: QuizPhase;
}) {
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
					<TutorText text={item.text} />
					<Pictures id={item.id} pictures={item.pictures} drawing={item.drawing} store={store} />
				</div>
			);
		case "error":
			return (
				<div className="msg error-msg">
					<p>{item.text}</p>
					{item.retry && (
						<button type="button" className="primary small" onClick={() => store.send({ type: "retry" })}>
							Try again
						</button>
					)}
				</div>
			);
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
			if (pending?.kind === "quiz") return <QuizCard quiz={pending} label={QUIZ_LABEL[phase]} onAnswer={answer} />;
			if (pending?.kind === "ask") return <AskCard ask={pending} onAnswer={answer} />;
			if (pending?.kind === "pause")
				return (
					<QuestionsInvite
						text={START_QUIZ[phase].text}
						continueLabel={START_QUIZ[phase].label}
						onContinue={() => answer({})}
						onAsk={(text) => answer({ text })}
					/>
				);
			const pictures =
				item.kind === "quiz" ? (
					<Pictures id={item.id} pictures={item.pictures} drawing={item.drawing} store={store} />
				) : null;
			if (pending?.kind === "graded")
				return (
					<QuizResult
						label={QUIZ_LABEL[phase]}
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
					<QuizResult
						label={QUIZ_LABEL[phase]}
						question={item.question}
						details={item.details}
						result={item.result}
						pictures={pictures}
					/>
				) : (
					<>
						<AskResult question={item.question} details={item.details} result={item.result} />
						{latestCard && saidYesToFiles(item) && <DropBox store={store} />}
					</>
				);
			}
			// Queued behind the card the learner is on now: show it when its turn comes.
			if (Object.keys(store.interactions).length > 0) return null;
			return <div className="card muted">Preparing a {item.kind === "quiz" ? "quiz" : "question"}…</div>;
		}
	}
}

/** The lesson has reached its end ("What to learn next", or a review's "How you did"). */
function lessonFinished(items: TranscriptItem[]): boolean {
	return items.some(
		(item) => item.kind === "assistant" && /^\s*(#{1,6}\s*|\*\*)\s*(what to learn next|how you did)/im.test(item.text),
	);
}

export function App() {
	const store = useTutor();
	const { state, items, streaming, send, connected } = store;
	const [draft, setDraft] = useState("");
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
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

	// First visit with no AI connected: open settings straight away. Only once
	// per visit, so starting a new lesson never brings it up again.
	const offeredSetup = useRef(false);
	useEffect(() => {
		if (state === null || offeredSetup.current) return;
		offeredSetup.current = true;
		if (needsSetup) setSettingsOpen(true);
	}, [state, needsSetup]);

	// Where the learner is on the page. The page never moves up by itself.
	// After the learner does something (answers, asks, clicks on), it follows
	// what the tutor adds, but only until the start of that new part reaches
	// the top of the screen. Scrolling up to reread stops the following until
	// they next do something. "More below" takes them down a screen at a time.
	const [moreBelow, setMoreBelow] = useState(false);
	/** Files or a link are being dragged over the page. */
	const [dragging, setDragging] = useState(false);
	const checkMoreBelow = (el: HTMLElement) => setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 80);
	/** The scroll position the learner should be at; restored if the page briefly gets shorter. */
	const place = useRef(0);
	/** True from the learner's last action until they scroll up. */
	const following = useRef(true);
	/** Set once the learner has done something; until then (a lesson just opened) follow to the very end. */
	const acted = useRef(false);
	const markInput = () => {
		following.current = true;
		acted.current = true;
		// Tag what's on the page now, so what the tutor adds next can be told apart.
		for (const child of scrollRef.current?.firstElementChild?.children ?? []) child.setAttribute("data-seen", "");
	};
	const scrollTo = (el: HTMLElement, top: number) => {
		place.current = top;
		if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
	};
	// A different lesson: start at its end.
	useLayoutEffect(() => {
		place.current = 0;
		following.current = true;
		acted.current = false;
	}, [state?.lessonPath]);
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		// When a card shrinks (say, its question box closes) keep the page tall
		// enough that the browser doesn't move the learner up.
		const content = el.firstElementChild as HTMLElement | null;
		if (content) content.style.minHeight = place.current > 0 ? `${place.current + el.clientHeight}px` : "";
		const max = el.scrollHeight - el.clientHeight;
		let target = place.current;
		if (following.current) {
			let limit = max;
			const added = acted.current ? content?.querySelector<HTMLElement>(":scope > :not([data-seen])") : null;
			if (added) limit = added.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16;
			target = Math.max(target, Math.min(max, limit));
		}
		// The home page starts at its top, so the name and logo show.
		if (items.length === 0 && streaming === null) target = 0;
		scrollTo(el, Math.max(0, Math.min(max, target)));
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
		markInput();
	};

	const last = items.at(-1);
	const phases = quizPhases(items);
	const latestCard = [...items].reverse().find((item) => item.kind === "quiz" || item.kind === "ask");
	// The tutor finished a teaching section and is waiting: invite questions.
	const inviteQuestions =
		connected &&
		!busy &&
		Object.keys(store.interactions).length === 0 &&
		last?.kind === "assistant" &&
		// Only after teaching: not after Final quiz feedback or the lesson's end.
		phases[items.length - 1] !== "final" &&
		phases[items.length - 1] !== "review" &&
		// A section, or the learning plan (Section 1 follows when they continue).
		(turnText(items).trim().length >= MIN_SECTION_TEXT || /^\s*(#{1,6}\s*|\*\*)\s*your learning plan/im.test(turnText(items)));
	const pretestStart = items.findIndex((item, i) => item.kind === "quiz" && phases[i] === "pre-test");
	// A card with its own typing box is on screen: hide the bottom box, so there's one place to type.
	const cardWaiting =
		inviteQuestions || items.some((item) => (item.kind === "quiz" || item.kind === "ask") && store.interactions[item.id]);
	const lastIsStreamingDuplicate = streaming !== null && last?.kind === "assistant" && last.text === streaming;

	return (
		<div className={`app ${sidebarOpen ? "sidebar-open" : ""}`}>
			<aside className="sidebar">
				<div className="brand">
					{/* The L in the box is the name's first letter, as on the home page. */}
					<span className="logo">L</span>
					<span className="brand-text">
						<span className="brand-name" aria-label="LILA">
							ILA
						</span>
						<span className="brand-full">
							<b>L</b>ila <b>I</b>nteractive <b>L</b>earning <b>A</b>ssistant
						</span>
					</span>
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
				<LessonList store={store} onOpened={() => setSidebarOpen(false)} />
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

			<main
				className="main"
				onDragEnter={(e) => isDroppable(e.dataTransfer) && setDragging(true)}
				onDragOver={(e) => {
					if (!isDroppable(e.dataTransfer)) return;
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={(e) => {
					// Only when leaving the page area, not when moving between its parts.
					if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
				}}
				onDrop={(e) => {
					setDragging(false);
					if (e.defaultPrevented || !isDroppable(e.dataTransfer)) return;
					e.preventDefault();
					sendDropped(store, e.dataTransfer);
				}}
			>
				{/* The box below a "Yes" already says where to drop, so no second one. */}
				{dragging && !scrollRef.current?.querySelector(".drop-area") && (
					<div className="drop-overlay">
						<div className="drop-box over">
							<span className="drop-icon">⬇</span>
							<strong>Drop files or links here to add them to the lesson</strong>
						</div>
					</div>
				)}
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
					onClickCapture={(e) => {
						if ((e.target as HTMLElement).closest("button")) markInput();
					}}
					onKeyDownCapture={(e) => {
						if (e.key === "Enter") markInput();
					}}
					onScroll={(e) => {
						const el = e.currentTarget;
						const max = el.scrollHeight - el.clientHeight;
						// The page got shorter for a moment and the browser moved it up:
						// not the learner's doing, so keep their place.
						const squeezed = el.scrollTop >= max - 1 && el.scrollTop < place.current;
						if (!squeezed && Math.abs(el.scrollTop - place.current) > 1) {
							if (el.scrollTop < place.current) following.current = false;
							place.current = el.scrollTop;
						}
						checkMoreBelow(el);
					}}
				>
					<div className="transcript">
						{items.length === 0 && streaming === null && (
							<div className="welcome">
								<div className="hero-brand">
									{/* The L in the box is the name's first letter. */}
									<div className="hero-name" role="img" aria-label="LILA">
										<span className="logo big">L</span>
										<span className="hero-lila">ILA</span>
									</div>
									<div className="hero-full">Lila Interactive Learning Assistant</div>
								</div>
								<h1>What do you want to understand?</h1>
								<p>I'm your own private tutor. Tell me anything you want to learn, and I'll teach it to you.</p>
								<div className="starters">
									{STARTERS.map((s) => (
										<button key={s} type="button" className="starter" onClick={() => submit(s)}>
											{s}
										</button>
									))}
								</div>
							</div>
						)}
						{items.map((item, i) => {
							const key = item.kind === "quiz" || item.kind === "ask" ? item.id : `${item.kind}-${i}`;
							const card = (
								<Item key={key} item={item} store={store} latestCard={item === latestCard} phase={phases[i]} />
							);
							// Pre-test and final quiz questions get their own tint; teaching stays white.
							if (item.kind !== "quiz" || phases[i] === "lesson") return card;
							return (
								<div key={key} className="phase-quiz">
									{i === pretestStart && <PartDivider label="Pre-test" />}
									{card}
								</div>
							);
						})}
						{streaming !== null && streaming.trim() !== "" && !lastIsStreamingDuplicate && (
							<div className="msg tutor">
								<TutorText text={streaming} streaming />
							</div>
						)}
						{inviteQuestions && (
							<QuestionsInvite
								key={last.id}
								text="Any questions about this section? Type your question here or continue the lesson."
								continueLabel="Continue the lesson →"
								onContinue={() => submit("No questions, please continue.")}
								onAsk={(text) => submit(text, true)}
							/>
						)}
						{!busy && state?.lessonPath && Object.keys(store.interactions).length === 0 && lessonFinished(items) && (
							<div className="review-offer">
								<button type="button" className="secondary" onClick={() => send({ type: "review_lesson", path: state.lessonPath! })}>
									↻ Review this lesson with a new quiz
								</button>
							</div>
						)}
						{busy && state?.retrying && <div className="msg retry-msg">{state.retrying}</div>}
						{/* While the tutor works, even mid-reply, so a pause never looks like a freeze. */}
						{busy && Object.keys(store.interactions).length === 0 && (
							<div className="working" role="status">
								<span className="spinner" aria-hidden="true" />
								{store.activity ?? "Working…"}
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
				{!cardWaiting && (
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
							placeholder={items.length === 0 ? "Type a topic you want to learn…" : "Reply to your tutor…"}
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
				)}
			</main>

			{settingsOpen && <Settings store={store} onClose={() => setSettingsOpen(false)} />}
			<KeyPopup store={store} hidden={settingsOpen} />
			{store.toast && (
				<div className="toast" onClick={store.clearToast}>
					{store.toast}
				</div>
			)}
		</div>
	);
}
