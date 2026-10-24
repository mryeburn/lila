import { useEffect, useRef, useState } from "react";
import type { TutorStore } from "../useTutor.ts";

const MAX_FILE_MB = 20;

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

	const pickFile = (file: File | undefined) => {
		if (!file) return;
		if (file.size > MAX_FILE_MB * 1024 * 1024) {
			alert(`That file is too large. Files up to ${MAX_FILE_MB} MB can be added.`);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const data = String(reader.result).replace(/^data:[^,]*,/, "");
			store.send({ type: "add_file", name: file.name, data });
			setOpen(false);
		};
		reader.readAsDataURL(file);
	};

	const addLink = () => {
		const url = link.trim();
		if (!url) return;
		store.send({ type: "add_link", url: /^https?:\/\//i.test(url) ? url : `https://${url}` });
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
						accept=".pdf,.docx,.txt,.md,.markdown,.html,.htm,.csv"
						onChange={(e) => {
							pickFile(e.target.files?.[0]);
							e.target.value = "";
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
				</div>
			)}
		</div>
	);
}
