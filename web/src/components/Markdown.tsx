import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { memo, useEffect, useId, useState } from "react";
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
			theme: dark ? "dark" : "neutral",
			securityLevel: "strict",
			// The neutral theme draws chart lines in pale grey; use the app's colors.
			themeVariables: { xyChart: { plotColorPalette: "#6366f1, #16a34a, #dc2626, #d97706, #0891b2" } },
		});
		return mermaid;
	});
	return mermaidPromise;
}

function MermaidDiagram({ code }: { code: string }) {
	const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	const [svg, setSvg] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let cancelled = false;
		loadMermaid()
			.then((mermaid) => mermaid.render(id, code))
			.then(({ svg }) => !cancelled && setSvg(svg))
			.catch(() => !cancelled && setFailed(true));
		return () => {
			cancelled = true;
		};
	}, [code, id]);
	if (failed) {
		return (
			<details className="diagram-error">
				<summary>This diagram couldn't be drawn. Show its source</summary>
				<pre>{code}</pre>
			</details>
		);
	}
	if (!svg) return <div className="diagram diagram-loading">Drawing diagram…</div>;
	return <div className="diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function SvgPicture({ code }: { code: string }) {
	const clean = DOMPurify.sanitize(code, { USE_PROFILES: { svg: true, svgFilters: true } });
	if (!clean.includes("<svg")) return <pre>{code}</pre>;
	return <div className="diagram picture" dangerouslySetInnerHTML={{ __html: clean }} />;
}

// Photos may only come from the trusted libraries the tutor's find_image tool
// searches (server/images.ts), so an invented link can never show up.
const IMAGE_HOSTS = ["upload.wikimedia.org", "openi.nlm.nih.gov"];

function Photo({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
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
				<img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
			</a>
			{alt && <span className="photo-caption">{alt}</span>}
			{title && <span className="photo-credit">{title}</span>}
		</span>
	);
}

function makeComponents(streaming: boolean, inline: boolean): Components {
	return {
		...(inline ? { p: ({ children }) => <span>{children}</span> } : {}),
		a: ({ href, children }) => (
			<a href={href} target="_blank" rel="noreferrer noopener">
				{children}
			</a>
		),
		img: ({ src, alt, title }) => <Photo src={typeof src === "string" ? src : undefined} alt={alt} title={title} />,
		pre: ({ children }) => <>{children}</>,
		code: ({ className, children }) => {
			const lang = /language-(\w+)/.exec(className ?? "")?.[1];
			const code = String(children ?? "").replace(/\n$/, "");
			if (lang === "mermaid" || lang === "svg") {
				// Half-written diagrams can't be drawn; wait for the message to finish.
				if (streaming) return <div className="diagram diagram-loading">Drawing diagram…</div>;
				return lang === "mermaid" ? <MermaidDiagram code={code} /> : <SvgPicture code={code} />;
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
}: {
	text: string;
	streaming?: boolean;
	inline?: boolean;
}) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
			rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
			components={makeComponents(streaming, inline)}
		>
			{normalizeMath(text)}
		</ReactMarkdown>
	);
});
