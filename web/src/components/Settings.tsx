import { useMemo, useState } from "react";
import type { ProviderInfo } from "../../../server/protocol.ts";
import type { TutorStore } from "../useTutor.ts";

const FEATURED_HELP: Record<string, string> = {
	anthropic: "Claude. Sign in with a Claude Pro or Max plan, or paste an API key from console.anthropic.com.",
	openai: "ChatGPT models. Sign in with a ChatGPT plan, or paste an API key from platform.openai.com.",
	google: "Gemini. Get a free API key at aistudio.google.com.",
	openrouter: "One key for many providers' models, from openrouter.ai.",
};

function LoginPanel({ store, provider, onClose }: { store: TutorStore; provider: ProviderInfo; onClose: () => void }) {
	const { login, send } = store;
	const [value, setValue] = useState("");
	if (!login) return null;
	const prompt = login.prompt?.prompt;
	const reply = (v: string) => {
		send({ type: "login_reply", id: login.prompt!.id, value: v });
		setValue("");
	};

	return (
		<div className="login-panel">
			<h3>Signing in to {provider.name}</h3>
			{login.events.map((e, i) => {
				if (e.type === "auth_url")
					return (
						<p key={i}>
							A sign-in page should have opened in a new tab.{" "}
							<a href={e.url} target="_blank" rel="noreferrer noopener">
								Open it again
							</a>
							{e.instructions ? `. ${e.instructions}` : ""}
						</p>
					);
				if (e.type === "device_code")
					return (
						<p key={i}>
							Go to{" "}
							<a href={e.verificationUri} target="_blank" rel="noreferrer noopener">
								{e.verificationUri}
							</a>{" "}
							and enter the code <strong className="device-code">{e.userCode}</strong>
						</p>
					);
				return (
					<p key={i} className="muted-text">
						{e.message}
						{e.type === "info" &&
							e.links?.map((l) => (
								<a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener">
									{" "}
									{l.label ?? l.url}
								</a>
							))}
					</p>
				);
			})}

			{prompt && prompt.type === "select" && (
				<div className="options">
					<p>{prompt.message}</p>
					{prompt.options.map((o) => (
						<button key={o.id} type="button" className="option" onClick={() => reply(o.id)}>
							<span className="option-text">
								{o.label}
								{o.description && <span className="option-desc">{o.description}</span>}
							</span>
						</button>
					))}
				</div>
			)}
			{prompt && prompt.type !== "select" && (
				<form
					className="login-form"
					onSubmit={(e) => {
						e.preventDefault();
						if (value.trim()) reply(value.trim());
					}}
				>
					<label>{prompt.message}</label>
					<input
						className="text-input"
						type={prompt.type === "secret" ? "password" : "text"}
						placeholder={prompt.placeholder}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						autoFocus
						autoComplete="off"
					/>
					<button type="submit" className="primary" disabled={!value.trim()}>
						Continue
					</button>
				</form>
			)}

			{login.done?.ok && <p className="success-text">You're signed in. Pick a model below and start learning.</p>}
			{login.done && !login.done.ok && <p className="error-text">Sign-in didn't work: {login.done.error}</p>}
			{!login.done && !prompt && <p className="muted-text">Waiting…</p>}

			<div className="card-actions">
				{!login.done && (
					<button type="button" className="secondary" onClick={() => send({ type: "login_cancel" })}>
						Cancel
					</button>
				)}
				{login.done && (
					<button type="button" className="secondary" onClick={onClose}>
						Done
					</button>
				)}
			</div>
		</div>
	);
}

export function Settings({ store, onClose }: { store: TutorStore; onClose: () => void }) {
	const { providers, models, state, send, login } = store;
	const [active, setActive] = useState<string | null>(null);
	const [showAll, setShowAll] = useState(false);
	const featured = providers.filter((p) => p.id in FEATURED_HELP);
	const rest = providers.filter((p) => !(p.id in FEATURED_HELP));
	const shown = showAll ? [...featured, ...rest] : featured;
	const activeProvider = providers.find((p) => p.id === active);

	const grouped = useMemo(() => {
		const byProvider = new Map<string, typeof models>();
		for (const m of models) {
			if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
			byProvider.get(m.provider)!.push(m);
		}
		return [...byProvider.entries()];
	}, [models]);
	const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
	const currentKey = state?.model ? `${state.model.provider}/${state.model.id}` : "";

	const start = (p: ProviderInfo, method: "api_key" | "oauth") => {
		setActive(p.id);
		send({ type: "login_start", provider: p.id, method });
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
				<div className="modal-head">
					<h2>Settings</h2>
					<button type="button" className="icon-button" onClick={onClose} aria-label="Close">
						×
					</button>
				</div>

				<section>
					<h3>1. Connect an AI provider</h3>
					<p className="muted-text">
						Pi Learn uses an AI model to teach you. Connect at least one provider. Your sign-in is stored only on this
						computer.
					</p>
					{login && activeProvider ? (
						<LoginPanel
							store={store}
							provider={activeProvider}
							onClose={() => {
								store.resetLogin();
								setActive(null);
							}}
						/>
					) : (
						<div className="provider-list">
							{shown.map((p) => (
								<div key={p.id} className="provider">
									<div className="provider-info">
										<div className="provider-name">
											{p.name}
											{p.configured && <span className="badge">Connected</span>}
										</div>
										{FEATURED_HELP[p.id] && <div className="option-desc">{FEATURED_HELP[p.id]}</div>}
									</div>
									<div className="provider-actions">
										{p.oauthName && (
											<button type="button" className="primary small" onClick={() => start(p, "oauth")}>
												Sign in
											</button>
										)}
										{p.apiKeyName && (
											<button type="button" className="secondary small" onClick={() => start(p, "api_key")}>
												API key
											</button>
										)}
										{p.configured && (
											<button
												type="button"
												className="link-button"
												onClick={() => send({ type: "logout", provider: p.id })}
											>
												Disconnect
											</button>
										)}
									</div>
								</div>
							))}
							<button type="button" className="link-button" onClick={() => setShowAll((v) => !v)}>
								{showAll ? "Show fewer providers" : `Show ${rest.length} more providers`}
							</button>
						</div>
					)}
				</section>

				<section>
					<h3>2. Choose a model</h3>
					{models.length === 0 ? (
						<p className="muted-text">Connect a provider first, then its models appear here.</p>
					) : (
						<select
							className="select"
							value={currentKey}
							onChange={(e) => {
								const [provider, ...rest] = e.target.value.split("/");
								send({ type: "set_model", provider, modelId: rest.join("/") });
							}}
						>
							{!currentKey && <option value="">Choose a model…</option>}
							{grouped.map(([provider, list]) => (
								<optgroup key={provider} label={providerName(provider)}>
									{list.map((m) => (
										<option key={m.id} value={`${m.provider}/${m.id}`}>
											{m.name}
										</option>
									))}
								</optgroup>
							))}
						</select>
					)}
				</section>

				{state && state.thinkingLevels.length > 0 && (
					<section>
						<h3>3. Thinking effort</h3>
						<p className="muted-text">Higher effort plans lessons more carefully but responds more slowly.</p>
						<div className="segmented">
							{state.thinkingLevels.map((level) => (
								<button
									key={level}
									type="button"
									className={level === state.thinkingLevel ? "on" : ""}
									onClick={() => send({ type: "set_thinking", level })}
								>
									{level}
								</button>
							))}
						</div>
					</section>
				)}
			</div>
		</div>
	);
}
