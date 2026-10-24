import { type ReactNode, useState } from "react";
import type { AskAnswer, PendingInteraction, QuizAnswer } from "../../../server/protocol.ts";
import { Markdown } from "./Markdown.tsx";

type Quiz = Extract<PendingInteraction, { kind: "quiz" }>;
type Ask = Extract<PendingInteraction, { kind: "ask" }>;

function Header({ label, question, details }: { label: string; question: string; details?: string }) {
	return (
		<>
			<div className="card-label">{label}</div>
			<div className="card-question">
				<Markdown text={question} />
			</div>
			{details && (
				<div className="card-details">
					<Markdown text={details} />
				</div>
			)}
		</>
	);
}

// ── Quiz ─────────────────────────────────────────────────────────────────────

export function QuizCard({ quiz, onAnswer }: { quiz: Quiz; onAnswer: (answer: QuizAnswer) => void }) {
	const [selected, setSelected] = useState<number[]>([]);
	const [note, setNote] = useState("");
	const [showNote, setShowNote] = useState(false);
	const [sent, setSent] = useState(false);

	const toggle = (index: number) => {
		if (sent) return;
		setSelected((cur) =>
			quiz.multiSelect ? (cur.includes(index) ? cur.filter((i) => i !== index) : [...cur, index]) : [index],
		);
	};
	const submit = (answer: QuizAnswer) => {
		setSent(true);
		onAnswer({ ...answer, note: note.trim() || undefined });
	};

	return (
		<div className="card quiz-card pending">
			<Header label={quiz.multiSelect ? "Quiz · pick all that apply" : "Quiz"} question={quiz.question} details={quiz.details} />
			<div className="options" role={quiz.multiSelect ? "group" : "radiogroup"}>
				{quiz.options.map((o) => (
					<button
						key={o.index}
						type="button"
						className={`option ${selected.includes(o.index) ? "selected" : ""}`}
						onClick={() => toggle(o.index)}
						aria-pressed={selected.includes(o.index)}
						disabled={sent}
					>
						<span className={`marker ${quiz.multiSelect ? "check" : "radio"}`} />
						<span className="option-text">
							<Markdown text={o.label} inline />
							{o.description && (
								<span className="option-desc">
									<Markdown text={o.description} inline />
								</span>
							)}
						</span>
					</button>
				))}
			</div>
			{showNote ? (
				<textarea
					className="note"
					placeholder="Add a note for your tutor (optional): what you were thinking, what's confusing…"
					value={note}
					onChange={(e) => setNote(e.target.value)}
					rows={2}
					disabled={sent}
				/>
			) : (
				<button type="button" className="link-button" onClick={() => setShowNote(true)}>
					+ Add a note
				</button>
			)}
			<div className="card-actions">
				<button type="button" className="secondary" onClick={() => submit({ dontKnow: true })} disabled={sent}>
					I don't know
				</button>
				<button
					type="button"
					className="primary"
					onClick={() => submit({ selected })}
					disabled={sent || selected.length === 0}
				>
					{sent ? "Checking…" : "Check answer"}
				</button>
			</div>
		</div>
	);
}

export function QuizResult({
	question,
	details,
	result,
	onNext,
	pictures,
}: {
	question: string;
	details?: string;
	result: any;
	/** Set while the lesson waits for the learner to move on. */
	onNext?: () => void;
	/** Pictures the app added for the explanation. */
	pictures?: ReactNode;
}) {
	const [sent, setSent] = useState(false);
	// The learner asked about the section before seeing this question; the
	// tutor will ask it again, so don't reveal it here.
	if (result.status === "paused") {
		return (
			<div className="card quiz-card muted">
				<p className="card-status">You asked a question before the quiz: {result.skippedWith}</p>
			</div>
		);
	}
	if (result.status !== "answered") {
		return (
			<div className="card quiz-card muted">
				<Header label="Quiz" question={question} details={details} />
				<p className="card-status">{result.status === "cancelled" ? "Skipped" : result.message}</p>
				{result.skippedWith && <div className="your-note">You wrote: {result.skippedWith}</div>}
			</div>
		);
	}
	const chosen = new Set<number>((result.answers ?? []).map((a: any) => a.index));
	const correct = new Set<number>(result.correctIndices ?? []);
	const verdict = result.dontKnow ? "dontknow" : result.correct ? "right" : "wrong";
	return (
		<div className={`card quiz-card answered ${verdict}`}>
			<Header label="Quiz" question={question} details={details} />
			<div className="options">
				{(result.options ?? []).map((o: any) => {
					const isKey = correct.has(o.index);
					const isChosen = chosen.has(o.index);
					const cls = isKey ? "key" : isChosen ? "miss" : "";
					return (
						<div key={o.index} className={`option static ${cls} ${isChosen ? "chosen" : ""}`}>
							<span className="mark">{isKey ? "✓" : isChosen ? "✗" : ""}</span>
							<span className="option-text">
								<Markdown text={o.label} inline />
								{isChosen && <span className="you">your answer</span>}
							</span>
						</div>
					);
				})}
			</div>
			<div className={`verdict ${verdict}`}>
				{verdict === "right" ? "Correct!" : verdict === "wrong" ? "Not quite" : "You said you don't know, which is great to know"}
			</div>
			{result.note && <div className="your-note">Your note: {result.note}</div>}
			{result.explanation && (
				<div className="explanation">
					<Markdown text={result.explanation} />
				</div>
			)}
			{pictures}
			{onNext && (
				<div className="invite-questions">
					💬 Do you have any questions about this question or its answer? Type it in the box below, or click Next
					question.
				</div>
			)}
			{onNext && (
				<div className="card-actions">
					<button
						type="button"
						className="primary"
						autoFocus
						disabled={sent}
						onClick={() => {
							setSent(true);
							onNext();
						}}
					>
						Next question →
					</button>
				</div>
			)}
		</div>
	);
}

// ── Question (no right answer) ───────────────────────────────────────────────

export function AskCard({ ask, onAnswer }: { ask: Ask; onAnswer: (answer: AskAnswer) => void }) {
	const [selected, setSelected] = useState<number[]>([]);
	const [other, setOther] = useState("");
	const [otherOn, setOtherOn] = useState(false);
	const [text, setText] = useState("");
	const [sent, setSent] = useState(false);
	const multi = ask.mode === "multi-select";

	const submit = (answer: AskAnswer) => {
		setSent(true);
		onAnswer(answer);
	};

	if (ask.mode === "text") {
		return (
			<div className="card ask-card pending">
				<Header label="Your tutor asks" question={ask.question} details={ask.details} />
				<textarea
					className="note"
					rows={3}
					placeholder="Type your answer…"
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && text.trim()) {
							e.preventDefault();
							submit({ text });
						}
					}}
					disabled={sent}
					autoFocus
				/>
				<div className="card-actions">
					<button type="button" className="primary" disabled={sent || !text.trim()} onClick={() => submit({ text })}>
						Send
					</button>
				</div>
			</div>
		);
	}

	const pick = (index: number) => {
		if (sent) return;
		if (multi) {
			setSelected((cur) => (cur.includes(index) ? cur.filter((i) => i !== index) : [...cur, index]));
		} else {
			// Single choice answers immediately, like tapping a button.
			setSelected([index]);
			submit({ selected: [index] });
		}
	};

	return (
		<div className="card ask-card pending">
			<Header label={multi ? "Your tutor asks · pick any" : "Your tutor asks"} question={ask.question} details={ask.details} />
			<div className="options">
				{ask.options.map((o) => (
					<button
						key={o.index}
						type="button"
						className={`option ${selected.includes(o.index) ? "selected" : ""}`}
						onClick={() => pick(o.index)}
						disabled={sent}
					>
						{multi && <span className="marker check" />}
						<span className="option-text">
							<Markdown text={o.label} inline />
							{o.description && (
								<span className="option-desc">
									<Markdown text={o.description} inline />
								</span>
							)}
						</span>
					</button>
				))}
				{otherOn ? (
					<div className="other-row">
						<input
							className="text-input"
							placeholder="Your own answer…"
							value={other}
							onChange={(e) => setOther(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && other.trim() && !multi) submit({ other });
							}}
							disabled={sent}
							autoFocus
						/>
						{!multi && (
							<button type="button" className="primary" disabled={sent || !other.trim()} onClick={() => submit({ other })}>
								Send
							</button>
						)}
					</div>
				) : (
					<button type="button" className="option other" onClick={() => setOtherOn(true)} disabled={sent}>
						<span className="option-text">Something else…</span>
					</button>
				)}
			</div>
			{multi && (
				<div className="card-actions">
					<button
						type="button"
						className="primary"
						disabled={sent || (selected.length === 0 && !other.trim())}
						onClick={() => submit({ selected, other: other.trim() || undefined })}
					>
						Send
					</button>
				</div>
			)}
		</div>
	);
}

export function AskResult({ question, details, result }: { question: string; details?: string; result: any }) {
	const answers: any[] = result.answers ?? [];
	return (
		<div className="card ask-card answered">
			<Header label="Your tutor asked" question={question} details={details} />
			{result.status === "answered" ? (
				<div className="chosen-answers">
					{answers.length === 0 && <span className="card-status">No answer</span>}
					{answers.map((a, i) => (
						<span key={i} className="chip">
							<Markdown text={a.label || "(empty)"} inline />
						</span>
					))}
				</div>
			) : (
				<p className="card-status">{result.status === "cancelled" ? "Skipped" : result.message}</p>
			)}
		</div>
	);
}

/** The tutor's invitation to ask about what was just taught, with a button to go on. */
export function QuestionsInvite({
	text,
	continueLabel,
	onContinue,
}: {
	text: string;
	continueLabel: string;
	onContinue: () => void;
}) {
	const [sent, setSent] = useState(false);
	return (
		<div className="card invite-card pending">
			<div className="invite-questions">💬 {text}</div>
			<div className="card-actions">
				<button
					type="button"
					className="primary"
					disabled={sent}
					onClick={() => {
						setSent(true);
						onContinue();
					}}
				>
					{continueLabel}
				</button>
			</div>
		</div>
	);
}
