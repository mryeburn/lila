import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
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
			// Plain SVG text, not HTML boxes: mermaid sizes each box from the text as
			// drawn, so a label can't be cut off when the browser's fonts differ.
			htmlLabels: false,
			flowchart: { curve: "basis", padding: 14, htmlLabels: false },
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
	const broken = useRef(onBroken);
	broken.current = onBroken;
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
				broken.current?.();
			});
		return () => {
			cancelled = true;
		};
	}, [code, id]);
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
// searches (server/images.ts), or be a web photo LILA keeps a copy of, so an
// invented link can never show up.
const IMAGE_HOSTS = ["upload.wikimedia.org", "openi.nlm.nih.gov"];
const WEB_PHOTO = /^\/photos\/[a-f0-9]{24}$/;

function allowedPhoto(src: string): boolean {
	if (WEB_PHOTO.test(src)) return true;
	try {
		const u = new URL(src);
		return u.protocol === "https:" && IMAGE_HOSTS.includes(u.hostname);
	} catch {
		return false;
	}
}

/**
 * Other addresses for the same Wikimedia picture, tried in turn when one
 * won't load: without the tracking part, then a standard-size thumbnail.
 */
function photoFallbacks(src: string): string[] {
	const out = [src];
	try {
		const u = new URL(src);
		if (u.hostname !== "upload.wikimedia.org") return out;
		const plain = `${u.origin}${u.pathname}`;
		out.push(plain);
		const m = /^\/wikipedia\/commons\/(\w)\/(\w\w)\/([^/]+)$/.exec(u.pathname);
		if (m) out.push(`${u.origin}/wikipedia/commons/thumb/${m[1]}/${m[2]}/${m[3]}/400px-${m[3]}${/\.svg$/i.test(m[3]) ? ".png" : ""}`);
	} catch {
		// Not a URL: nothing else to try.
	}
	return [...new Set(out)];
}

function Photo({ src, alt, title, onBroken }: { src?: string; alt?: string; title?: string; onBroken?: () => void }) {
	const ok = allowedPhoto(src ?? "");
	const [attempt, setAttempt] = useState(0);
	if (!ok) return null;
	const tries = photoFallbacks(src ?? "");
	// None of them loaded: leave an empty marker, so the styles can also hide
	// the tutor's description line under the picture.
	if (attempt >= tries.length) return <span className="photo-failed" />;
	// Spans, not <figure>: Markdown puts images inside paragraphs.
	return (
		<span className="photo">
			<a href={src} target="_blank" rel="noreferrer noopener" title="Open full size">
				<img
					src={tries[attempt]}
					alt={alt ?? ""}
					loading="lazy"
					referrerPolicy="no-referrer"
					onError={() => {
						if (attempt + 1 >= tries.length) onBroken?.();
						setAttempt(attempt + 1);
					}}
				/>
			</a>
			{alt && <span className="photo-caption">{alt}</span>}
			{title && <span className="photo-credit">{title}</span>}
		</span>
	);
}

/** The stretch of a YouTube video the tutor picked with find_video. */
export function parseClip(code: string): { id: string; start: number; end: number; title: string; channel: string } | undefined {
	try {
		const c = JSON.parse(code);
		const start = Math.max(0, Math.floor(Number(c.start)));
		const end = Math.floor(Number(c.end));
		if (!/^[A-Za-z0-9_-]{11}$/.test(String(c.id)) || !(end > start) || end - start > 120) return undefined;
		return { id: String(c.id), start, end, title: String(c.title ?? ""), channel: String(c.channel ?? "") };
	} catch {
		return undefined;
	}
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function VideoClip({ code }: { code: string }) {
	const clip = parseClip(code);
	if (!clip) return null;
	// youtube-nocookie plays only from start to end and sets no tracking cookies until played.
	const src = `https://www.youtube-nocookie.com/embed/${clip.id}?start=${clip.start}&end=${clip.end}&rel=0&modestbranding=1`;
	return (
		<span className="video-clip">
			<iframe
				src={src}
				title={clip.title || "Video clip"}
				allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
				allowFullScreen
				referrerPolicy="strict-origin-when-cross-origin"
			/>
			<span className="photo-credit">
				Clip {clock(clip.start)}–{clock(clip.end)} from "{clip.title}"{clip.channel ? `, ${clip.channel}` : ""}, YouTube
			</span>
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
			if (lang === "youtube") {
				if (streaming) return <div className="diagram diagram-loading">Loading video…</div>;
				return <VideoClip code={code} />;
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
	// The same components every time: new ones would make React rebuild every
	// diagram on each page update, and a diagram being redrawn is briefly short,
	// which jumps the page up.
	const broken = useRef(onBroken);
	broken.current = onBroken;
	const hasBroken = onBroken !== undefined;
	const components = useMemo(
		() => makeComponents(streaming, inline, hasBroken ? () => broken.current?.() : undefined),
		[streaming, inline, hasBroken],
	);
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
			rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
			components={components}
		>
			{normalizeMath(text)}
		</ReactMarkdown>
	);
});
