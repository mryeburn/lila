import { useEffect, useRef, useState } from "react";
import type { TutorStore } from "../useTutor.ts";

const MAX_FILE_MB = 20;
const ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.html,.htm,.csv";

/** Sends files to the lesson, one message each. */
export function sendFiles(store: TutorStore, files: Iterable<File>) {
	for (const file of files) {
		if (file.size > MAX_FILE_MB * 1024 * 1024) {
			alert(`"${file.name}" is too large. Files up to ${MAX_FILE_MB} MB can be added.`);
			continue;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const data = String(reader.result).replace(/^data:[^,]*,/, "");
			store.send({ type: "add_file", name: file.name, data });
		};
		reader.readAsDataURL(file);
	}
}

/** Sends a web link to the lesson. Returns false when there's nothing to send. */
export function sendLink(store: TutorStore, text: string): boolean {
	const url = text.trim();
	if (!url) return false;
	store.send({ type: "add_link", url: /^https?:\/\//i.test(url) ? url : `https://${url}` });
	return true;
}

/** True when what's being dragged is files or a link (not text being moved around the page). */
export function isDroppable(dt: DataTransfer | null): boolean {
	const types = [...(dt?.types ?? [])];
	return types.includes("Files") || types.includes("text/uri-list");
}

/** Adds whatever was dropped: files, or else a dragged link. */
export function sendDropped(store: TutorStore, dt: DataTransfer) {
	if (dt.files.length > 0) {
		sendFiles(store, dt.files);
		return;
	}
	const uri = dt
		.getData("text/uri-list")
		.split(/\r?\n/)
		.find((line) => line.trim() && !line.startsWith("#"));
	const url = uri ?? dt.getData("text/plain");
	if (/^https?:\/\/\S+$/i.test(url.trim())) sendLink(store, url);
}

/** The box shown after the learner says they have files or links: drop them in, or click to choose. */
export function DropBox({ store }: { store: TutorStore }) {
	const [over, setOver] = useState(false);
	const [link, setLink] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);
	const addLink = () => sendLink(store, link) && setLink("");
	return (
		<div className="drop-area">
			<div
				className={`drop-box ${over ? "over" : ""}`}
				role="button"
				tabIndex={0}
				onClick={() => fileRef.current?.click()}
				onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileRef.current?.click()}
				onDragOver={(e) => {
					if (!isDroppable(e.dataTransfer)) return;
					e.preventDefault();
					e.stopPropagation();
					setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={(e) => {
					// The page's own drop handler sees defaultPrevented and only tidies up.
					e.preventDefault();
					setOver(false);
					sendDropped(store, e.dataTransfer);
				}}
			>
				<span className="drop-icon">⬇</span>
				<strong>Drag and drop your files or links here, or click to choose a file</strong>
				<span className="muted-text small">PDF, Word (.docx), text files and web pages work.</span>
				<input
					ref={fileRef}
					type="file"
					hidden
					multiple
					accept={ACCEPT}
					onChange={(e) => {
						if (e.target.files) sendFiles(store, e.target.files);
						e.target.value = "";
					}}
				/>
			</div>
			<div className="link-row">
				<input
					type="url"
					placeholder="Or paste a web link: https://…"
					value={link}
					onChange={(e) => setLink(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							addLink();
						}
					}}
				/>
				<button type="button" className="secondary" onClick={addLink} disabled={!link.trim()}>
					Add
				</button>
			</div>
		</div>
	);
}

/** The 📎 button: adds the learner's own files and web links to the lesson. */
export function AddResource({ store }: { store: TutorStore }) {
	const [open, setOpen] = useState(false);
	const [link, setLink] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const busy = store.addingResource;

	// Close when clicking anywhere else.
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const addLink = () => {
		if (!sendLink(store, link)) return;
		setLink("");
		setOpen(false);
	};

	return (
		<div className="add-resource" ref={boxRef}>
			<button
				type="button"
				className="icon-button attach"
				title="Add your own learning materials"
				aria-label="Add your own learning materials"
				disabled={busy}
				onClick={() => setOpen((v) => !v)}
			>
				{busy ? <span className="spinner" /> : "📎"}
			</button>
			{busy && <span className="attach-status">Reading…</span>}
			{open && (
				<div className="resource-popover">
					<h4>Add your own learning materials</h4>
					<button type="button" className="primary" onClick={() => fileRef.current?.click()}>
						Upload a file
					</button>
					<input
						ref={fileRef}
						type="file"
						hidden
						multiple
						accept={ACCEPT}
						onChange={(e) => {
							if (e.target.files) sendFiles(store, e.target.files);
							e.target.value = "";
							setOpen(false);
						}}
					/>
					<div className="or">or add a web link</div>
					<div className="link-row">
						<input
							type="url"
							placeholder="https://…"
							value={link}
							onChange={(e) => setLink(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									addLink();
								}
							}}
						/>
						<button type="button" className="secondary" onClick={addLink} disabled={!link.trim()}>
							Add
						</button>
					</div>
					<p className="muted-text small">
						PDF, Word (.docx), text files and web pages work. Scanned PDFs (pictures of pages) can't be read yet.
					</p>
					<p className="muted-text small">You can also drag and drop files or links onto the page.</p>
				</div>
			)}
		</div>
	);
}
