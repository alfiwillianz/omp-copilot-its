import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface CopilotCookie {
	name: string;
	value: string;
	domain: string;
	path?: string;
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
}

export interface CopilotCookieStore {
	savedAt: string;
	email: string;
	copilotUrl?: string;
	cookies: CopilotCookie[];
}

export interface CopilotItsConfig {
	email: string;
	defaultModel: string;
	cdpUrl: string;
	relayHttpUrl: string;
	setupServerPort: number;
	standaloneCdpPort: number;
	copilotUrl: string;
	autoNewChatPerSession: boolean;
	autoCompactHandoff: boolean;
}

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "copilot-its-config.json");
export const COOKIES_PATH = join(AGENT_DIR, "copilot-its-cookies.json");
export const PROFILE_DIR = join(AGENT_DIR, "copilot-its-profile");

export const DEFAULT_CONFIG: CopilotItsConfig = {
	email: process.env.COPILOT_ITS_EMAIL || "5054251028@student.its.ac.id",
	defaultModel: process.env.COPILOT_ITS_MODEL || "gpt-6.1-sol",
	cdpUrl: process.env.COPILOT_ITS_CDP_URL || "ws://127.0.0.1:9224/cdp",
	relayHttpUrl: process.env.COPILOT_ITS_RELAY_HTTP || "http://127.0.0.1:9224",
	setupServerPort: Number(process.env.COPILOT_ITS_SETUP_PORT || 19224),
	standaloneCdpPort: Number(process.env.COPILOT_ITS_STANDALONE_PORT || 19225),
	copilotUrl: "https://outlook.cloud.microsoft/mail/",
	autoNewChatPerSession: true,
	autoCompactHandoff: true,
};

function writeFileAtomic(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, contents, { mode: 0o600 });
		renameSync(tmp, path);
	} finally {
		if (existsSync(tmp)) {
			try {
				unlinkSync(tmp);
			} catch {}
		}
	}
}

export function loadConfig(): CopilotItsConfig {
	try {
		if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<CopilotItsConfig>;
		return {
			email: typeof raw.email === "string" && raw.email.trim() ? raw.email.trim() : DEFAULT_CONFIG.email,
			defaultModel:
				typeof raw.defaultModel === "string" && raw.defaultModel.trim()
					? raw.defaultModel.trim()
					: DEFAULT_CONFIG.defaultModel,
			cdpUrl: typeof raw.cdpUrl === "string" && raw.cdpUrl.trim() ? raw.cdpUrl.trim() : DEFAULT_CONFIG.cdpUrl,
			relayHttpUrl:
				typeof raw.relayHttpUrl === "string" && raw.relayHttpUrl.trim()
					? raw.relayHttpUrl.trim()
					: DEFAULT_CONFIG.relayHttpUrl,
			setupServerPort:
				typeof raw.setupServerPort === "number" && raw.setupServerPort > 0
					? raw.setupServerPort
					: DEFAULT_CONFIG.setupServerPort,
			standaloneCdpPort:
				typeof raw.standaloneCdpPort === "number" && raw.standaloneCdpPort > 0
					? raw.standaloneCdpPort
					: DEFAULT_CONFIG.standaloneCdpPort,
			copilotUrl:
				typeof raw.copilotUrl === "string" && raw.copilotUrl.trim()
					? raw.copilotUrl.trim()
					: DEFAULT_CONFIG.copilotUrl,
			autoNewChatPerSession:
				typeof raw.autoNewChatPerSession === "boolean"
					? raw.autoNewChatPerSession
					: DEFAULT_CONFIG.autoNewChatPerSession,
			autoCompactHandoff:
				typeof raw.autoCompactHandoff === "boolean"
					? raw.autoCompactHandoff
					: DEFAULT_CONFIG.autoCompactHandoff,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: CopilotItsConfig): CopilotItsConfig {
	const normalized: CopilotItsConfig = {
		...config,
		email: config.email.trim() || DEFAULT_CONFIG.email,
		defaultModel: config.defaultModel.trim() || DEFAULT_CONFIG.defaultModel,
		cdpUrl: config.cdpUrl.trim() || DEFAULT_CONFIG.cdpUrl,
		relayHttpUrl: config.relayHttpUrl.trim().replace(/\/+$/, "") || DEFAULT_CONFIG.relayHttpUrl,
	};
	writeFileAtomic(CONFIG_PATH, JSON.stringify(normalized, null, 2));
	return normalized;
}

export function loadCookieStore(): CopilotCookieStore | null {
	try {
		if (!existsSync(COOKIES_PATH)) return null;
		const parsed = JSON.parse(readFileSync(COOKIES_PATH, "utf8")) as CopilotCookieStore;
		if (!Array.isArray(parsed.cookies)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function saveCookieStore(store: CopilotCookieStore): number {
	const validCookies = store.cookies.filter(c => Boolean(c.name && c.value));
	writeFileAtomic(
		COOKIES_PATH,
		JSON.stringify(
			{
				...store,
				savedAt: store.savedAt || new Date().toISOString(),
				cookies: validCookies,
			},
			null,
			2,
		),
	);
	return validCookies.length;
}

function isCookieRecord(val: unknown): val is Record<string, unknown> & { name: string; value: string } {
	return (
		Boolean(val) &&
		typeof val === "object" &&
		"name" in val &&
		typeof val.name === "string" &&
		"value" in val &&
		typeof val.value === "string"
	);
}

export function parseSubmittedCookies(input: string, defaultDomain = ".cloud.microsoft"): CopilotCookie[] {
	const trimmed = input.trim();
	if (!trimmed) return [];

	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const rawList: unknown[] = Array.isArray(parsed)
				? parsed
				: parsed && typeof parsed === "object" && "cookies" in parsed && Array.isArray(parsed.cookies)
					? parsed.cookies
					: [];
			return rawList.filter(isCookieRecord).map(c => ({
				name: c.name,
				value: c.value,
				domain: typeof c.domain === "string" && c.domain ? c.domain : defaultDomain,
				path: typeof c.path === "string" && c.path ? c.path : "/",
				secure: typeof c.secure === "boolean" ? c.secure : true,
				httpOnly: typeof c.httpOnly === "boolean" ? c.httpOnly : false,
				...(typeof c.expires === "number" ? { expires: c.expires } : {}),
			}));
		} catch {}
	}

	// 2. Raw Cookie: header or semicolon-separated key=value pairs
	const rawHeader = trimmed.replace(/^cookie:\s*/i, "");
	const cookies: CopilotCookie[] = [];
	for (const part of rawHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		const name = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (!name) continue;
		cookies.push({
			name,
			value,
			domain: defaultDomain,
			path: "/",
			secure: true,
		});
	}
	return cookies;
}
