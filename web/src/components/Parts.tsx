// The tutor's part headings ("Pre-test complete", "Your learning plan",
// "Section 2: …", "Final quiz", "Summary") shown as labelled dividers, so the
// lesson's parts stand apart.

import { Markdown } from "./Markdown.tsx";

const PART = /^(pre-?test complete|your learning plan|section\s+\d+\b|final quiz|summary\b)/i;

/** The divider label if this line is one of the tutor's part headings. */
function partLabel(line: string): string | null {
	const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1] ?? /^\s*\*\*([^*]+)\*\*\s*:?\s*$/.exec(line)?.[1];
	if (!heading) return null;
	// Drop bold markers, a leading emoji or number, and a trailing colon.
	const text = heading
		.replace(/\*\*|__/g, "")
		.replace(/^[^\p{L}]+/u, "")
		.replace(/:\s*$/, "")
		.trim();
	if (!PART.test(text)) return null;
	return /^pre-?test complete/i.test(text) ? "Pre-test results" : text;
}

/** Splits a tutor message at its part headings. */
export function splitParts(text: string): { label: string | null; text: string }[] {
	const parts: { label: string | null; text: string }[] = [{ label: null, text: "" }];
	let inCode = false;
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
		const label = inCode ? null : partLabel(line);
		if (label) parts.push({ label, text: "" });
		else parts[parts.length - 1].text += `${line}\n`;
	}
	return parts.filter((p) => p.label || p.text.trim());
}

export function PartDivider({ label }: { label: string }) {
	return (
		<div className="part-divider" role="separator" aria-label={label}>
			<span>{label}</span>
		</div>
	);
}

/** A tutor message, with its part headings drawn as dividers. */
export function TutorText({ text, streaming = false }: { text: string; streaming?: boolean }) {
	const parts = splitParts(text);
	if (parts.length === 1 && !parts[0].label) return <Markdown text={text} streaming={streaming} />;
	return (
		<>
			{parts.map((p, i) => (
				<div key={i}>
					{p.label && <PartDivider label={p.label} />}
					{p.text.trim() && <Markdown text={p.text} streaming={streaming && i === parts.length - 1} />}
				</div>
			))}
		</>
	);
}
