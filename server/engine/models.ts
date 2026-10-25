// The AI providers LILA can use (Anthropic, OpenAI, Google, ...), their
// models, and the learner's sign-ins. The providers themselves come from
// pi-ai; this file decides where sign-ins are kept and which providers are
// ready to use.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AuthInteraction,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createProvider,
	type Model,
	type MutableModels,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import lockfile from "proper-lockfile";

/**
 * Sign-ins are kept where pi keeps them, so they're shared with Pi Learn. A
 * Claude subscription's token changes every time it's refreshed, so two
 * separate copies would sign each other out.
 */
export const AUTH_FILE = path.join(
	process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
	"auth.json",
);

/** auth.json, read and written under a lock that Pi Learn honours too. */
class AuthFile implements CredentialStore {
	constructor(private readonly file: string) {}

	private load(): Record<string, Credential> {
		try {
			return JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^﻿/, ""));
		} catch {
			return {};
		}
	}

	private async locked<T>(fn: (data: Record<string, Credential>) => Promise<{ result: T; next?: Record<string, Credential> }>): Promise<T> {
		fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, "{}", { mode: 0o600 });
		const release = await lockfile.lock(this.file, {
			realpath: false,
			stale: 30_000,
			retries: { retries: 10, factor: 2, minTimeout: 20, maxTimeout: 2000 },
		});
		try {
			const { result, next } = await fn(this.load());
			if (next) fs.writeFileSync(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
			return result;
		} finally {
			await release();
		}
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.load()[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
	}

	modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
		return this.locked(async (data) => {
			const next = await fn(data[providerId]);
			if (next === undefined) return { result: data[providerId] };
			return { result: next, next: { ...data, [providerId]: next } };
		});
	}

	delete(providerId: string): Promise<void> {
		return this.locked(async (data) => {
			delete data[providerId];
			return { result: undefined, next: data };
		});
	}
}

/**
 * Extra providers from a models.json file (LILA_MODELS_PATH), such as a
 * stand-in AI for testing. Each speaks the OpenAI chat API.
 */
function extraProviders(file: string): Provider[] {
	const config = JSON.parse(fs.readFileSync(file, "utf8"));
	return Object.entries<any>(config.providers ?? {}).map(([id, p]) =>
		createProvider({
			id,
			name: p.name ?? id,
			baseUrl: p.baseUrl,
			auth: {
				apiKey: {
					name: `${p.name ?? id} key`,
					resolve: async () => ({ auth: { apiKey: p.apiKey }, source: "models.json" }),
				},
			},
			models: (p.models ?? []).map(
				(m: any): Model<Api> => ({
					id: m.id,
					name: m.name ?? m.id,
					api: p.api ?? "openai-completions",
					provider: id,
					baseUrl: p.baseUrl,
					reasoning: m.reasoning ?? false,
					input: m.input ?? ["text"],
					cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: m.contextWindow ?? 128_000,
					maxTokens: m.maxTokens ?? 16_384,
				}),
			),
			api: openAICompletionsApi(),
		}),
	);
}

/** Every provider and model, which of them are signed in, and the AI calls themselves. */
export class AiModels {
	private readonly models: MutableModels;
	/** Providers with a sign-in or key, kept up to date so it can be checked at once. */
	private configured = new Set<string>();

	private constructor(models: MutableModels) {
		this.models = models;
	}

	static async create(modelsPath?: string): Promise<AiModels> {
		const models = builtinModels({ credentials: new AuthFile(AUTH_FILE) });
		if (modelsPath) for (const provider of extraProviders(modelsPath)) models.setProvider(provider);
		const ai = new AiModels(models);
		await ai.refreshSignIns();
		return ai;
	}

	/** Re-checks which providers are signed in (after a sign-in or sign-out). */
	async refreshSignIns(): Promise<void> {
		const configured = new Set<string>();
		await Promise.all(
			this.models.getProviders().map(async (p) => {
				if (await this.models.checkAuth(p.id).catch(() => undefined)) configured.add(p.id);
			}),
		);
		this.configured = configured;
	}

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.configured.has(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	/** Models of the providers that are signed in. */
	getAvailable(): Promise<readonly Model<Api>[]> {
		return this.models.getAvailable();
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void> {
		await this.models.login(providerId, type, interaction);
		await this.refreshSignIns();
	}

	async logout(providerId: string): Promise<void> {
		await this.models.logout(providerId);
		await this.refreshSignIns();
	}

	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
		return this.models.streamSimple(model, context, options);
	}

	completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
		return this.models.completeSimple(model, context, options);
	}
}
