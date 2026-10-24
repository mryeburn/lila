import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { memo, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
	mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
		const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
		mermaid.initialize({
			startOnLoad: false,
			// "base" takes the app's colors: soft indigo boxes, clear lines, readable text.
			theme: "base",
			securityLevel: "strict",
			flowchart: { curve: "basis", padding: 14 },
			themeVariables: dark
				? {
						darkMode: true,
						fontSize: "16px",
						background: "#1f2937",
						primaryColor: "#312e81",
						primaryTextColor: "#eef2ff",
						primaryBorderColor: "#818cf8",
						secondaryColor: "#064e3b",
						tertiaryColor: "#78350f",
						lineColor: "#a5b4fc",
						textColor: "#e5e7eb",
						xyChart: { plotColorPalette: "#818cf8, #4ade80, #f87171, #fbbf24, #22d3ee" },
					}
				: {
						fontSize: "16px",
						primaryColor: "#eef2ff",
						primaryTextColor: "#1e1b4b",
						primaryBorderColor: "#6366f1",
						secondaryColor: "#ecfdf5",
						tertiaryColor: "#fff7ed",
						lineColor: "#4f46e5",
						textColor: "#1f2937",
						// Line and bar charts otherwise come out pale grey.
						xyChart: { plotColorPalette: "#6366f1, #16a34a, #dc2626, #d97706, #0891b2" },
					},
		});
		return mermaid;
	});
	return mermaidPromise;
}

// Mermaid sizes a diagram to the page width, so a wide one ends up with tiny
// text that zooming the page can't fix. Show it at its own size instead; the
// box scrolls sideways when it's wider than the page.
function atNaturalSize(svg: string, scale = 1): string {
	const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
	const root = doc.documentElement;
	const [, , w, h] = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
	if (root.nodeName !== "svg" || !(w > 0 && h > 0)) return svg;
	root.setAttribute("width", String(Math.ceil(w * scale)));
	root.setAttribute("height", String(Math.ceil(h * scale)));
	root.style.maxWidth = "none";
	root.style.maxHeight = "none";
	return new XMLSerializer().serializeToString(root);
}

/** The diagram for the full-screen view: filling the screen, and never smaller than 1.5× its own size. */
function enlarged(svg: string): string {
	const viewBox = /viewBox="([^"]*)"/.exec(svg)?.[1] ?? "";
	const [, , w, h] = viewBox.split(/[\s,]+/).map(Number);
	if (!(w > 0 && h > 0)) return svg;
	const fit = Math.min((window.innerWidth - 64) / w, (window.innerHeight - 64) / h);
	return atNaturalSize(svg, Math.max(fit, 1.5));
}

/** A diagram in its box; clicking it opens it full screen. */
function DiagramBox({ html, className }: { html: string; className: string }) {
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	// A wide diagram usually starts from a box at the top middle, so show the middle first.
	useEffect(() => {
		const el = box.current;
		if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
	}, [html]);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);
	return (
		<>
			<div
				ref={box}
				className={`diagram zoomable ${className}`}
				role="button"
				tabIndex={0}
				title="Click to enlarge"
				onClick={() => setOpen(true)}
				onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(true)}
				dangerouslySetInnerHTML={{ __html: html }}
			/>
			{open &&
				createPortal(
					<div className="diagram-zoom" role="dialog" aria-label="Enlarged diagram" onClick={() => setOpen(false)}>
						<button type="button" className="diagram-zoom-close" aria-label="Close" onClick={() => setOpen(false)}>
							✕
						</button>
						<div
							className="diagram-zoom-body"
							ref={(el) => {
								if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
							}}
							onClick={(e) => e.stopPropagation()}
							dangerouslySetInnerHTML={{ __html: enlarged(html) }} />
					</div>,
					document.body,
				)}
		</>
	);
}

function MermaidDiagram({ code, onBroken }: { code: string; onBroken?: () => void }) {
	const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	const [svg, setSvg] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let cancelled = false;
		loadMermaid()
			// parse() first: a failed render() leaves an error graphic on the page.
			.then(async (mermaid) => {
				await mermaid.parse(code);
				return mermaid.render(id, code);
			})
			.then(({ svg }) => !cancelled && setSvg(svg))
			.catch(() => {
				if (cancelled) return;
				setFailed(true);
				onBroken?.();
			});
		return () => {
			cancelled = true;
		};
	}, [code, id, onBroken]);
	// The app replaces its own broken pictures, so there's nothing to show.
	if (failed && onBroken) return null;
	if (failed) {
		return (
			<details className="diagram-error">
				<summary>This diagram couldn't be drawn. Show its source</summary>
				<pre>{code}</pre>
			</details>
		);
	}
	if (!svg) return <div className="diagram diagram-loading">Drawing diagram…</div>;
	return <DiagramBox className="mermaid" html={atNaturalSize(svg)} />;
}

function SvgPicture({ code }: { code: string }) {
	const clean = DOMPurify.sanitize(code, { USE_PROFILES: { svg: true, svgFilters: true } });
	if (!clean.includes("<svg")) return <pre>{code}</pre>;
	return <DiagramBox className="picture" html={clean} />;
}

// Photos may only come from the trusted libraries the tutor's find_image tool
// searches (server/images.ts), so an invented link can never show up.
const IMAGE_HOSTS = ["upload.wikimedia.org", "openi.nlm.nih.gov"];

function Photo({ src, alt, title, onBroken }: { src?: string; alt?: string; title?: string; onBroken?: () => void }) {
	let ok = false;
	try {
		const u = new URL(src ?? "");
		ok = u.protocol === "https:" && IMAGE_HOSTS.includes(u.hostname);
	} catch {
		// Not a URL.
	}
	const [failed, setFailed] = useState(false);
	if (!ok || failed) return null;
	// Spans, not <figure>: Markdown puts images inside paragraphs.
	return (
		<span className="photo">
			<a href={src} target="_blank" rel="noreferrer noopener" title="Open full size">
				<img
					src={src}
					alt={alt ?? ""}
					loading="lazy"
					referrerPolicy="no-referrer"
					onError={() => {
						setFailed(true);
						onBroken?.();
					}}
				/>
			</a>
			{alt && <span className="photo-caption">{alt}</span>}
			{title && <span className="photo-credit">{title}</span>}
		</span>
	);
}

function makeComponents(streaming: boolean, inline: boolean, onBroken?: () => void): Components {
	return {
		...(inline ? { p: ({ children }) => <span>{children}</span> } : {}),
		a: ({ href, children }) => (
			<a href={href} target="_blank" rel="noreferrer noopener">
				{children}
			</a>
		),
		img: ({ src, alt, title }) => (
			<Photo src={typeof src === "string" ? src : undefined} alt={alt} title={title} onBroken={onBroken} />
		),
		pre: ({ children }) => <>{children}</>,
		code: ({ className, children }) => {
			const lang = /language-(\w+)/.exec(className ?? "")?.[1];
			const code = String(children ?? "").replace(/\n$/, "");
			if (lang === "mermaid" || lang === "svg") {
				// Half-written diagrams can't be drawn; wait for the message to finish.
				if (streaming) return <div className="diagram diagram-loading">Drawing diagram…</div>;
				return lang === "mermaid" ? <MermaidDiagram code={code} onBroken={onBroken} /> : <SvgPicture code={code} />;
			}
			if (!lang && !code.includes("\n")) return <code className="inline-code">{children}</code>;
			return (
				<pre className="code-block">
					<code>{code}</code>
				</pre>
			);
		},
	};
}

// Models often write \( \) and \[ \] for math; the renderer only knows $ and $$.
// Code spans and blocks are left alone.
function normalizeMath(text: string): string {
	return text
		.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
		.map((part, i) =>
			i % 2 === 1
				? part
				: part
						.replace(/\\\[([\s\S]+?)\\\]/g, (_m, m) => `\n$$\n${m.trim()}\n$$\n`)
						.replace(/\\\(([\s\S]+?)\\\)/g, (_m, m) => `$${m.trim()}$`),
		)
		.join("");
}

export const Markdown = memo(function Markdown({
	text,
	streaming = false,
	inline = false,
	onBroken,
}: {
	text: string;
	streaming?: boolean;
	inline?: boolean;
	/** Called when a diagram or photo can't be shown; it is then hidden. */
	onBroken?: () => void;
}) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
			rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
			components={makeComponents(streaming, inline, onBroken)}
		>
			{normalizeMath(text)}
		</ReactMarkdown>
	);
});
