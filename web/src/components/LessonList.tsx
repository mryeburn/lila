// The sidebar's list of past lessons, with folders and a right-click menu:
// review, rename, move into a folder, sort, delete.

import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LessonSort, LessonSummary } from "../../../server/protocol.ts";
import type { TutorStore } from "../useTutor.ts";

function relativeDate(iso: string) {
	const d = new Date(iso);
	const days = Math.floor((Date.now() - d.getTime()) / 86400000);
	if (days < 1) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
	return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

type Target = { kind: "lesson"; lesson: LessonSummary } | { kind: "folder"; name: string } | { kind: "list" };

type Dialog =
	| { kind: "rename-lesson"; lesson: LessonSummary }
	| { kind: "delete-lesson"; lesson: LessonSummary }
	| { kind: "new-folder"; lesson?: LessonSummary }
	| { kind: "rename-folder"; name: string }
	| { kind: "delete-folder"; name: string };

const SORTS: { sort: LessonSort; label: string }[] = [
	{ sort: "newest", label: "Sort by date, newest first" },
	{ sort: "oldest", label: "Sort by date, oldest first" },
	{ sort: "name", label: "Sort by name" },
];

export function LessonList({ store, onOpened }: { store: TutorStore; onOpened: () => void }) {
	const { lessons, library, state, send } = store;
	const [menu, setMenu] = useState<{ x: number; y: number; target: Target } | null>(null);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());

	// The folder holding the open lesson is shown open.
	const currentFolder = lessons.find((l) => l.path === state?.lessonPath)?.folder;
	useEffect(() => {
		if (currentFolder) setOpenFolders((cur) => (cur.has(currentFolder) ? cur : new Set(cur).add(currentFolder)));
	}, [currentFolder]);

	const openMenu = (e: MouseEvent, target: Target) => {
		e.preventDefault();
		e.stopPropagation();
		setMenu({ x: e.clientX, y: e.clientY, target });
	};

	const lessonButton = (l: LessonSummary) => (
		<button
			key={l.path}
			type="button"
			className={`lesson ${l.path === state?.lessonPath ? "current" : ""} ${l.folder ? "in-folder" : ""}`}
			onClick={() => {
				send({ type: "open_lesson", path: l.path });
				onOpened();
			}}
			onContextMenu={(e) => openMenu(e, { kind: "lesson", lesson: l })}
		>
			<span className="lesson-title">{l.title}</span>
			<span className="lesson-date">{relativeDate(l.modified)}</span>
		</button>
	);

	const loose = lessons.filter((l) => !l.folder || !library.folders.includes(l.folder));
	return (
		<div className="lesson-list" onContextMenu={(e) => openMenu(e, { kind: "list" })}>
			{(lessons.length > 0 || library.folders.length > 0) && <div className="list-label">Your lessons</div>}
			{library.folders.map((name) => {
				const inside = lessons.filter((l) => l.folder === name);
				const open = openFolders.has(name);
				return (
					<div key={`folder-${name}`} className="folder">
						<button
							type="button"
							className="folder-row"
							aria-expanded={open}
							onClick={() =>
								setOpenFolders((cur) => {
									const next = new Set(cur);
									if (open) next.delete(name);
									else next.add(name);
									return next;
								})
							}
							onContextMenu={(e) => openMenu(e, { kind: "folder", name })}
						>
							<span className="folder-arrow">{open ? "▾" : "▸"}</span>
							<span className="lesson-title">📁 {name}</span>
							<span className="lesson-date">{inside.length}</span>
						</button>
						{open && (inside.length > 0 ? inside.map(lessonButton) : <div className="folder-empty">Empty folder</div>)}
					</div>
				);
			})}
			{loose.map(lessonButton)}
			{menu && (
				<Menu
					x={menu.x}
					y={menu.y}
					target={menu.target}
					store={store}
					close={() => setMenu(null)}
					ask={(d) => {
						setMenu(null);
						setDialog(d);
					}}
					onOpened={onOpened}
				/>
			)}
			{dialog && <LessonDialog dialog={dialog} store={store} close={() => setDialog(null)} />}
		</div>
	);
}

function Menu({
	x,
	y,
	target,
	store,
	close,
	ask,
	onOpened,
}: {
	x: number;
	y: number;
	target: Target;
	store: TutorStore;
	close: () => void;
	ask: (dialog: Dialog) => void;
	onOpened: () => void;
}) {
	const { library, send } = store;
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ left: x, top: y });

	// Kept on screen, and closed by a click elsewhere or Escape.
	useLayoutEffect(() => {
		const box = ref.current?.getBoundingClientRect();
		if (!box) return;
		setPos({
			left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)),
			top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)),
		});
	}, [x, y]);
	useEffect(() => {
		const onDown = (e: Event) => {
			if (!ref.current?.contains(e.target as Node)) close();
		};
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", close);
		};
	}, [close]);

	const item = (label: string, action: () => void, extra = "") => (
		<button
			key={label}
			type="button"
			role="menuitem"
			className={`menu-item ${extra}`}
			onClick={() => {
				action();
				close();
			}}
		>
			{label}
		</button>
	);
	const sorts = SORTS.map(({ sort, label }) =>
		item(`${library.sort === sort ? "✓ " : ""}${label}`, () => send({ type: "sort_lessons", sort }), library.sort === sort ? "chosen" : ""),
	);

	let items: JSX.Element[];
	if (target.kind === "lesson") {
		const lesson = target.lesson;
		const moves = library.folders.filter((f) => f !== lesson.folder);
		items = [
			item("Review this lesson (new quiz)", () => {
				send({ type: "review_lesson", path: lesson.path });
				onOpened();
			}),
			item("Rename…", () => ask({ kind: "rename-lesson", lesson })),
			<div key="move-label" className="menu-label">
				Move to a folder
			</div>,
			...moves.map((f) => item(`📁 ${f}`, () => send({ type: "move_lesson", path: lesson.path, folder: f }))),
			...(lesson.folder ? [item("Take out of the folder", () => send({ type: "move_lesson", path: lesson.path, folder: null }))] : []),
			item("New folder…", () => ask({ kind: "new-folder", lesson })),
			<hr key="hr1" />,
			...sorts,
			<hr key="hr2" />,
			item("Delete lesson…", () => ask({ kind: "delete-lesson", lesson }), "danger"),
		];
	} else if (target.kind === "folder") {
		const name = target.name;
		items = [
			item("Rename folder…", () => ask({ kind: "rename-folder", name })),
			item("New folder…", () => ask({ kind: "new-folder" })),
			<hr key="hr1" />,
			...sorts,
			<hr key="hr2" />,
			item("Delete folder…", () => ask({ kind: "delete-folder", name }), "danger"),
		];
	} else {
		items = [item("New folder…", () => ask({ kind: "new-folder" })), <hr key="hr1" />, ...sorts];
	}
	return (
		<div ref={ref} className="context-menu" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
			{items}
		</div>
	);
}

function LessonDialog({ dialog, store, close }: { dialog: Dialog; store: TutorStore; close: () => void }) {
	const { send, library } = store;
	const startText =
		dialog.kind === "rename-lesson" ? dialog.lesson.title : dialog.kind === "rename-folder" ? dialog.name : "";
	const [text, setText] = useState(startText);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => inputRef.current?.select(), []);

	let title: string;
	let body: string | null = null;
	let action: string;
	let run: () => void;
	let typed = true;
	let danger = false;
	const name = text.replace(/\s+/g, " ").trim();
	switch (dialog.kind) {
		case "rename-lesson":
			title = "Rename lesson";
			action = "Rename";
			run = () => send({ type: "rename_lesson", path: dialog.lesson.path, title: name });
			break;
		case "new-folder":
			title = "New folder";
			body = dialog.lesson ? `"${dialog.lesson.title}" will go into it.` : null;
			action = "Make folder";
			run = () => send({ type: "new_folder", name, path: dialog.lesson?.path });
			break;
		case "rename-folder":
			title = "Rename folder";
			action = "Rename";
			run = () => send({ type: "rename_folder", from: dialog.name, to: name });
			break;
		case "delete-lesson":
			title = "Delete this lesson?";
			body = `"${dialog.lesson.title}" will be deleted for good. This can't be undone.`;
			action = "Delete";
			typed = false;
			danger = true;
			run = () => send({ type: "delete_lesson", path: dialog.lesson.path });
			break;
		case "delete-folder":
			title = "Delete this folder?";
			body = `The folder "${dialog.name}" will be removed. The lessons in it are kept: they move back to the main list.`;
			action = "Delete folder";
			typed = false;
			danger = true;
			run = () => send({ type: "delete_folder", name: dialog.name });
			break;
	}
	const taken = dialog.kind !== "rename-lesson" && name !== startText && library.folders.includes(name);
	const ready = !typed || (name.length > 0 && !taken);
	const submit = () => {
		if (!ready) return;
		run();
		close();
	};
	return (
		<div className="modal-backdrop" onClick={close}>
			<div className="modal small-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
				<h2>{title}</h2>
				{body && <p className="muted-text">{body}</p>}
				{typed && (
					<input
						ref={inputRef}
						className="text-input"
						value={text}
						placeholder={dialog.kind === "rename-lesson" ? "Lesson name" : "Folder name"}
						maxLength={80}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submit();
							if (e.key === "Escape") close();
						}}
						autoFocus
					/>
				)}
				{taken && <p className="error-text">There's already a folder with that name.</p>}
				<div className="dialog-buttons">
					<button type="button" className="secondary" onClick={close}>
						Cancel
					</button>
					<button type="button" className={danger ? "danger-button" : "primary"} disabled={!ready} onClick={submit}>
						{action}
					</button>
				</div>
			</div>
		</div>
	);
}
