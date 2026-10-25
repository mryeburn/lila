import { useEffect, useMemo, useState } from "react";
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
						LILA uses an AI model to teach you. Connect at least one provider. Your sign-in is stored only on this
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

				<UpdateSection store={store} />

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

				<WebPhotosSection store={store} />
				<PictureLogSection store={store} />
				<section className="about">
					<h3>About LILA</h3>
					<p>LILA Interactive Learning Assistant.</p>
					<p className="dedication">
						Dedicated to the best teachers in my life: my grade 4 teacher, Mr. Roberts, my grade 7 teacher, Mrs.
						Woodside, my Mandarin teacher, Mrs. Bi, and my pharmacology professor Dr. Rudolf Vrba
					</p>
				</section>
			</div>
		</div>
	);
}

/** Turns on photos from Google Images with a free SerpApi key. */
function WebPhotosSection({ store }: { store: TutorStore }) {
	const { state, send } = store;
	const [key, setKey] = useState("");
	if (!state) return null;
	return (
		<section>
			<h3>Photos from Google Images</h3>
			{state.webPhotos ? (
				<div className="update-row">
					<span className="success-text">Photos from Google Images are on.</span>
					<button type="button" className="link-button" onClick={() => send({ type: "set_photo_key", key: "" })}>
						Turn off
					</button>
				</div>
			) : (
				<>
					<p className="muted-text">
						LILA can also show you photos from Google Images. This uses a free SerpApi account: 250 photo searches a
						month, no credit card, and it never charges you.
					</p>
					<ol className="steps">
						<li>
							Make a free account at{" "}
							<a href="https://serpapi.com/users/sign_up" target="_blank" rel="noreferrer noopener">
								serpapi.com
							</a>
							.
						</li>
						<li>
							Copy your key from{" "}
							<a href="https://serpapi.com/manage-api-key" target="_blank" rel="noreferrer noopener">
								your SerpApi key page
							</a>
							.
						</li>
						<li>Paste it here and click Save.</li>
					</ol>
					<form
						className="login-form"
						onSubmit={(e) => {
							e.preventDefault();
							if (key.trim()) send({ type: "set_photo_key", key: key.trim() });
							setKey("");
						}}
					>
						<input
							className="text-input"
							type="password"
							placeholder="Paste your SerpApi key"
							value={key}
							onChange={(e) => setKey(e.target.value)}
							autoComplete="off"
						/>
						<button type="submit" className="primary" disabled={!key.trim()}>
							Save
						</button>
					</form>
				</>
			)}
		</section>
	);
}

/** Lets the learner copy the picture log to share when pictures go wrong. */
function PictureLogSection({ store }: { store: TutorStore }) {
	const { pictureLog, send } = store;
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	return (
		<section>
			<h3>Picture log</h3>
			<p className="muted-text">
				A record of how LILA chose each picture. If pictures seem wrong or missing, copy it and send it to whoever
				looks after your LILA.
			</p>
			{!open ? (
				<button
					type="button"
					className="secondary small"
					onClick={() => {
						setOpen(true);
						send({ type: "get_picture_log" });
					}}
				>
					Show picture log
				</button>
			) : (
				<>
					<textarea className="picture-log" readOnly value={pictureLog === null ? "Loading…" : pictureLog || "Nothing logged yet."} rows={8} />
					<button
						type="button"
						className="secondary small"
						disabled={!pictureLog}
						onClick={() =>
							navigator.clipboard.writeText(pictureLog ?? "").then(
								() => setCopied(true),
								() => setCopied(false),
							)
						}
					>
						{copied ? "Copied" : "Copy"}
					</button>
				</>
			)}
		</section>
	);
}

function UpdateSection({ store }: { store: TutorStore }) {
	const { update, send } = store;
	const supported = update?.supported === true;
	// Check once each time Settings opens.
	useEffect(() => {
		if (supported) send({ type: "check_update" });
	}, [supported, send]);
	if (!update?.supported) return null;
	const { state } = update;
	return (
		<section>
			<h3>Updates</h3>
			{state === "updating" ? (
				<p className="muted-text">
					Updating LILA. This takes a minute or two. The page will reload by itself when the new version is ready.
				</p>
			) : (
				<div className="update-row">
					{state === "available" ? (
						<>
							<span>A new version of LILA is available.</span>
							<button type="button" className="primary small" onClick={() => send({ type: "start_update" })}>
								Update now
							</button>
						</>
					) : (
						<>
							<span className="muted-text">
								{state === "current"
									? "You have the latest version."
									: state === "error"
										? update.error
										: state === "checking"
											? "Checking…"
											: "Get the newest improvements to LILA."}
							</span>
							<button
								type="button"
								className="secondary small"
								disabled={state === "checking"}
								onClick={() => send({ type: "check_update" })}
							>
								Check for updates
							</button>
						</>
					)}
				</div>
			)}
		</section>
	);
}
