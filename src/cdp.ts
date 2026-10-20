import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type CopilotCookie,
	type CopilotItsConfig,
	OBSCURA_BIN_DIR,
	PROFILE_DIR,
	loadConfig,
	loadCookieStore,
	saveConfig,
	saveCookieStore,
} from "./config.js";
import { COPILOT_ITS_MODELS, resolveCopilotModel } from "./models.js";

export interface CopilotQuotaMeter {
	remainingAllowance: number;
}

export interface CopilotThrottlingInfo {
	maxNumUserMessagesInConversation?: number;
	numUserMessagesInConversation?: number;
	metering?: Record<string, CopilotQuotaMeter>;
}

export interface CopilotBridgeStatus {
	connected: boolean;
	mode: "relay" | "standalone" | "obscura" | "disconnected";
	cdpUrl: string;
	pageUrl?: string;
	pageTitle?: string;
	email?: string;
	activeModel?: string;
	conversationId?: string;
	turnCount?: number;
	throttlingInfo?: CopilotThrottlingInfo;
	authenticatorNumber?: string;
	error?: string;
}

export interface StreamPromptOptions {
	modelId?: string;
	requireNewChat?: boolean;
	targetConversationId?: string;
	signal?: AbortSignal;
	onThinkingDelta?: (delta: string) => void;
	onTextDelta?: (delta: string) => void;
}

export interface StreamPromptResult {
	text: string;
	thinking: string;
	conversationId: string;
	turnCount: number;
	throttlingInfo?: CopilotThrottlingInfo;
}

interface CdpTargetInfo {
	targetId: string;
	type: string;
	title: string;
	url: string;
	attached?: boolean;
}

interface CdpAttachedEvent {
	sessionId: string;
	targetInfo: CdpTargetInfo;
	waitingForDebugger?: boolean;
}

interface CdpPendingCall {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

interface PollSnapshot {
	count: number;
	requestId: string | null;
	requestResultType: string | null;
	hasCopyBtn: boolean;
	isStreamingMessage: boolean;
	streamingText: string | null;
	replyMessage: string | null;
	conversationId: string | null;
	currentUserUpn: string | null;
	throttlingInfo: CopilotThrottlingInfo | null;
}

let lastKnownThrottlingInfo: CopilotThrottlingInfo | undefined;
let lastKnownConversationId: string | undefined;
let lastKnownActiveModel: string | undefined;
let standaloneProc: Bun.Subprocess | null = null;
let obscuraProc: Bun.Subprocess | null = null;
let requestQueue: Promise<unknown> = Promise.resolve();

export function getLastKnownQuota(): {
	throttlingInfo?: CopilotThrottlingInfo;
	conversationId?: string;
	activeModel?: string;
} {
	return {
		throttlingInfo: lastKnownThrottlingInfo,
		conversationId: lastKnownConversationId,
		activeModel: lastKnownActiveModel,
	};
}

function findChromiumBinary(): string | null {
	const candidates = [
		join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"),
		Bun.which("chromium"),
		Bun.which("google-chrome"),
		Bun.which("google-chrome-stable"),
		Bun.which("brave"),
		Bun.which("microsoft-edge"),
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return null;
}

export async function ensureStandaloneChromium(config: CopilotItsConfig, headed = false): Promise<string> {
	const port = config.standaloneCdpPort || 19225;
	const versionUrl = `http://127.0.0.1:${port}/json/version`;

	try {
		const res = await fetch(versionUrl, { signal: AbortSignal.timeout(1500) });
		if (res.ok) {
			const data = (await res.json()) as { webSocketDebuggerUrl?: string };
			if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
		}
	} catch {}

	const bin = findChromiumBinary();
	if (!bin) {
		throw new Error("No Chromium binary found and OMP browser-relay is not reachable.");
	}

	const args = [
		bin,
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${PROFILE_DIR}`,
		"--no-first-run",
		"--no-default-browser-check",
		...(headed ? [] : ["--headless=new"]),
		config.copilotUrl || "https://outlook.cloud.microsoft/mail/",
	];

	standaloneProc = Bun.spawn(args, {
		stdout: "ignore",
		stderr: "ignore",
	});
	standaloneProc.unref();

	for (let i = 0; i < 25; i++) {
		await Bun.sleep(400);
		try {
			const res = await fetch(versionUrl, { signal: AbortSignal.timeout(1000) });
			if (res.ok) {
				const data = (await res.json()) as { webSocketDebuggerUrl?: string };
				if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
			}
		} catch {}
	}

	throw new Error(`Timed out waiting for standalone Chromium on port ${port}`);
}

export async function installObscuraBinary(onProgress?: (msg: string) => void): Promise<string> {
	const binPath = join(OBSCURA_BIN_DIR, "obscura");
	if (existsSync(binPath)) return binPath;
	const systemObscura = Bun.which("obscura");
	if (systemObscura && existsSync(systemObscura)) return systemObscura;

	mkdirSync(OBSCURA_BIN_DIR, { recursive: true });
	const tarUrl =
		"https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-x86_64-linux.tar.gz";
	const tarPath = join(OBSCURA_BIN_DIR, "obscura-x86_64-linux.tar.gz");
	onProgress?.(`Downloading Obscura from ${tarUrl}...`);
	const dl = Bun.spawnSync(["curl", "-fsSL", "-o", tarPath, tarUrl]);
	if (dl.exitCode !== 0) {
		throw new Error(`Failed downloading Obscura: ${dl.stderr.toString()}`);
	}
	const untar = Bun.spawnSync(["tar", "xzf", tarPath, "-C", OBSCURA_BIN_DIR]);
	if (untar.exitCode !== 0 || !existsSync(binPath)) {
		throw new Error(`Failed extracting Obscura archive: ${untar.stderr.toString()}`);
	}
	return binPath;
}

export async function ensureObscuraServer(
	config: CopilotItsConfig,
	onProgress?: (msg: string) => void,
): Promise<string> {
	const port = (config.standaloneCdpPort || 19225) + 1;
	const wsUrl = `ws://127.0.0.1:${port}/devtools/browser`;

	try {
		const ws = new WebSocket(wsUrl);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			try {
				ws.close();
			} catch {}
			reject(new Error("timeout"));
		}, 1200);
		ws.onopen = () => {
			clearTimeout(timer);
			ws.close();
			resolve();
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error("ws error"));
		};
		await promise;
		return wsUrl;
	} catch {}

	const bin = await installObscuraBinary(onProgress);
	obscuraProc = Bun.spawn([bin, "serve", "--port", String(port), "--stealth"], {
		stdout: "ignore",
		stderr: "ignore",
		env: {
			...process.env,
			OBSCURA_SCRIPT_DEADLINE_MS: "60000",
			OBSCURA_MODULE_BUDGET_MS: "15000",
		},
	});
	obscuraProc.unref();

	for (let i = 0; i < 20; i++) {
		await Bun.sleep(300);
		try {
			const ws = new WebSocket(wsUrl);
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const timer = setTimeout(() => {
				try {
					ws.close();
				} catch {}
				reject(new Error("timeout"));
			}, 1000);
			ws.onopen = () => {
				clearTimeout(timer);
				ws.close();
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("ws error"));
			};
			await promise;
			return wsUrl;
		} catch {}
	}

	throw new Error(`Timed out starting Obscura CDP server on port ${port}`);
}

export async function resolveActiveCdpEndpoint(
	config: CopilotItsConfig,
	options?: { forceRelay?: boolean; onProgress?: (msg: string) => void },
): Promise<{ wsUrl: string; mode: "relay" | "standalone" | "obscura" }> {
	const wantRelay = options?.forceRelay === true || config.browserBackend === "relay";

	if (!wantRelay) {
		if (config.browserBackend === "obscura") {
			try {
				const wsUrl = await ensureObscuraServer(config, options?.onProgress);
				return { wsUrl, mode: "obscura" };
			} catch {
				// Fallback to standalone headless Chromium if Obscura fails
			}
		}
		try {
			const wsUrl = await ensureStandaloneChromium(config, false);
			return { wsUrl, mode: "standalone" };
		} catch {}
	}

	// Try relay HTTP /json/version
	try {
		const res = await fetch(`${config.relayHttpUrl}/json/version`, {
			signal: AbortSignal.timeout(1500),
		});
		if (res.ok) {
			const data = (await res.json()) as { webSocketDebuggerUrl?: string };
			if (data.webSocketDebuggerUrl) {
				return { wsUrl: data.webSocketDebuggerUrl, mode: "relay" };
			}
		}
	} catch {}

	// Fallback to standalone Chromium
	const wsUrl = await ensureStandaloneChromium(config, false);
	return { wsUrl, mode: "standalone" };
}

export class CdpSession {
	private ws: WebSocket;
	private nextId = 1;
	private pending = new Map<number, CdpPendingCall>();
	public attachedTargets: CdpAttachedEvent[] = [];

	private constructor(ws: WebSocket) {
		this.ws = ws;
		this.ws.onmessage = ev => {
			try {
				const msg = JSON.parse(String(ev.data)) as {
					id?: number;
					method?: string;
					params?: Record<string, unknown>;
					result?: Record<string, unknown>;
					error?: { message?: string };
				};
				if (msg.method === "Target.attachedToTarget" && msg.params) {
					const paramObj = msg.params as unknown as CdpAttachedEvent;
					this.attachedTargets.push(paramObj);
				}
				if (typeof msg.id === "number") {
					const handler = this.pending.get(msg.id);
					if (handler) {
						this.pending.delete(msg.id);
						if (msg.error) {
							handler.reject(new Error(msg.error.message || "CDP error"));
						} else {
							handler.resolve(msg.result ?? {});
						}
					}
				}
			} catch {}
		};
		this.ws.onclose = () => {
			for (const [, handler] of this.pending) {
				handler.reject(new Error("CDP WebSocket closed"));
			}
			this.pending.clear();
		};
	}

	static async connect(wsUrl: string, timeoutMs = 5000): Promise<CdpSession> {
		const ws = new WebSocket(wsUrl);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			try {
				ws.close();
			} catch {}
			reject(new Error(`Timeout connecting to CDP at ${wsUrl}`));
		}, timeoutMs);
		ws.onopen = () => {
			clearTimeout(timer);
			resolve();
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error(`Failed connecting to CDP at ${wsUrl}`));
		};
		await promise;
		return new CdpSession(ws);
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
		timeoutMs = 15_000,
	): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new Error(`CDP timeout calling ${method}`));
		}, timeoutMs);
		this.pending.set(id, {
			resolve: res => {
				clearTimeout(timer);
				resolve(res);
			},
			reject: err => {
				clearTimeout(timer);
				reject(err);
			},
		});
		this.ws.send(
			JSON.stringify({
				id,
				method,
				params,
				...(sessionId ? { sessionId } : {}),
			}),
		);
		return promise;
	}

	async evalInSession<T>(sessionId: string, expression: string, awaitPromise = true): Promise<T> {
		const res = await this.send(
			"Runtime.evaluate",
			{
				expression,
				returnByValue: true,
				awaitPromise,
			},
			sessionId,
		);
		const exceptionDetails = res.exceptionDetails as { text?: string } | undefined;
		if (exceptionDetails) {
			throw new Error(`Page eval error: ${exceptionDetails.text || "unknown"}`);
		}
		const resultObj = res.result as { value?: T } | undefined;
		return resultObj?.value as T;
	}

	close(): void {
		try {
			this.ws.close();
		} catch {}
	}
}

export async function connectToCopilotIframe(
	config: CopilotItsConfig,
	options?: {
		autoLogin?: boolean;
		forceRelay?: boolean;
		onProgress?: (msg: string) => void;
	},
): Promise<{
	cdp: CdpSession;
	mode: "relay" | "standalone" | "obscura";
	wsUrl: string;
	pageTarget: CdpTargetInfo;
	pageSessionId: string;
	iframeSessionId: string;
}> {
	const { wsUrl, mode } = await resolveActiveCdpEndpoint(config, {
		forceRelay: options?.forceRelay,
		onProgress: options?.onProgress,
	});
	const cdp = await CdpSession.connect(wsUrl);

	try {
		let targetsRes = await cdp.send("Target.getTargets");
		let targetInfos = (targetsRes.targetInfos as CdpTargetInfo[] | undefined) ?? [];

		// Fast path for standalone Chromium when semanticoverview iframe is already live at top level
		const directIframe = targetInfos.find(
			t => t.type === "iframe" && t.url.includes("semanticoverview"),
		);
		const existingCopilotPage = targetInfos.find(
			t => t.type === "page" && t.url.includes("outlook.cloud.microsoft/host/"),
		);
		if (directIframe && existingCopilotPage && options?.forceRelay !== true) {
			const pageAttach = await cdp.send("Target.attachToTarget", {
				targetId: existingCopilotPage.targetId,
				flatten: true,
			});
			const iframeAttach = await cdp.send("Target.attachToTarget", {
				targetId: directIframe.targetId,
				flatten: true,
			});
			return {
				cdp,
				mode,
				wsUrl,
				pageTarget: existingCopilotPage,
				pageSessionId: String(pageAttach.sessionId || ""),
				iframeSessionId: String(iframeAttach.sessionId || ""),
			};
		}

		let pageTarget =
			existingCopilotPage ??
			targetInfos.find(
				t => t.type === "page" && t.url.includes("outlook.cloud.microsoft"),
			) ??
			targetInfos.find(
				t =>
					t.type === "page" &&
					(t.url.includes("login.microsoftonline.com") || t.url.includes("outlook.office")),
			) ??
			(mode !== "relay" ? targetInfos.find(t => t.type === "page") : undefined);

		if (!pageTarget) {
			options?.onProgress?.("Opening Outlook / Copilot Chat tab...");
			const created = await cdp.send("Target.createTarget", {
				url: config.copilotUrl || "https://outlook.cloud.microsoft/mail/",
				background: true,
			});
			const newTargetId = String(created.targetId || "");
			await Bun.sleep(2000);
			const refreshed = await cdp.send("Target.getTargets");
			const refreshedList = (refreshed.targetInfos as CdpTargetInfo[] | undefined) ?? [];
			pageTarget =
				refreshedList.find(t => t.targetId === newTargetId) ??
				refreshedList.find(t => t.type === "page");
			if (!pageTarget) {
				throw new Error("Could not find or create Microsoft/Outlook tab.");
			}
		}

		const attachRes = await cdp.send("Target.attachToTarget", {
			targetId: pageTarget.targetId,
			flatten: true,
		});
		const pageSessionId = String(attachRes.sessionId || "");

		// If standalone/obscura mode, inject saved cookies and navigate to Copilot if needed
		if (mode !== "relay") {
			const cookieStore = loadCookieStore();
			if (cookieStore && cookieStore.cookies.length > 0) {
				await cdp.send("Network.enable", {}, pageSessionId).catch(() => {});
				await cdp
					.send("Network.setCookies", { cookies: cookieStore.cookies }, pageSessionId)
					.catch(() => {});
			}
			const initialUrl = await cdp.evalInSession<string>(pageSessionId, "location.href", false).catch(() => "");
			const targetUrl =
				cookieStore?.copilotUrl || config.copilotUrl || "https://outlook.cloud.microsoft/mail/";
			if (!initialUrl.includes("outlook.cloud.microsoft/host/")) {
				await cdp.send("Page.navigate", { url: targetUrl }, pageSessionId).catch(() => {});
				await Bun.sleep(2500);
			}
		}

		// Check if we are on login.microsoftonline.com and need autologin
		const currentUrl = await cdp.evalInSession<string>(pageSessionId, "location.href", false).catch(() => "");
		if (currentUrl.includes("login.microsoftonline.com") && options?.autoLogin !== false) {
			options?.onProgress?.(`Running Microsoft autologin for ${config.email}...`);
			await performMicrosoftAutoLogin(cdp, pageSessionId, config.email, options?.onProgress);
		}

		// Check if we are on Outlook Mail instead of Copilot Chat host
		const postLoginUrl = await cdp.evalInSession<string>(pageSessionId, "location.href", false).catch(() => "");
		if (postLoginUrl.includes("outlook.cloud.microsoft/mail")) {
			options?.onProgress?.("Switching Outlook tab to Copilot Chat...");
			await cdp.evalInSession(
				pageSessionId,
				`(() => {
					const btn = [...document.querySelectorAll('button')].find(b =>
						(b.getAttribute('aria-label') || b.innerText || '').includes('Copilot Chat')
					);
					if (btn) btn.click();
				})()`,
				false,
			);
			await Bun.sleep(3000);
		}

		// First check top-level targets for the semanticoverview iframe
		targetsRes = await cdp.send("Target.getTargets");
		targetInfos = (targetsRes.targetInfos as CdpTargetInfo[] | undefined) ?? [];
		const topIframe = targetInfos.find(
			t => t.type === "iframe" && t.url.includes("semanticoverview"),
		);
		let iframeSessionId = "";

		if (topIframe) {
			const attachedIframe = await cdp.send("Target.attachToTarget", {
				targetId: topIframe.targetId,
				flatten: true,
			});
			iframeSessionId = String(attachedIframe.sessionId || "");
		} else {
			await cdp.send(
				"Target.setAutoAttach",
				{ autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
				pageSessionId,
			);
			for (let attempt = 0; attempt < 20; attempt++) {
				await Bun.sleep(300);
				for (const child of cdp.attachedTargets) {
					if (child.waitingForDebugger) {
						await cdp.send("Runtime.runIfWaitingForDebugger", {}, child.sessionId).catch(() => {});
					}
				}
				const found = cdp.attachedTargets.find(t => t.targetInfo.type === "iframe");
				if (found) {
					iframeSessionId = found.sessionId;
					break;
				}
				const polled = await cdp.send("Target.getTargets");
				const polledList = (polled.targetInfos as CdpTargetInfo[] | undefined) ?? [];
				const polledIframe = polledList.find(
					t => t.type === "iframe" && t.url.includes("semanticoverview"),
				);
				if (polledIframe) {
					const attachedPolled = await cdp.send("Target.attachToTarget", {
						targetId: polledIframe.targetId,
						flatten: true,
					});
					iframeSessionId = String(attachedPolled.sessionId || "");
					break;
				}
			}
		}

		if (!iframeSessionId) {
			throw new Error(
				"Copilot Chat iframe not found. Run /its-setup to authenticate or refresh cookies.",
			);
		}

		for (let i = 0; i < 15; i++) {
			const hasEditor = await cdp
				.evalInSession<boolean>(
					iframeSessionId,
					"Boolean(document.querySelector('#m365-chat-editor-target-element'))",
					false,
				)
				.catch(() => false);
			if (hasEditor) break;
			await Bun.sleep(400);
		}

		return {
			cdp,
			mode,
			wsUrl,
			pageTarget,
			pageSessionId,
			iframeSessionId,
		};
	} catch (err) {
		cdp.close();
		throw err;
	}
}

async function performMicrosoftAutoLogin(
	cdp: CdpSession,
	pageSessionId: string,
	email: string,
	onProgress?: (msg: string) => void,
): Promise<void> {
	for (let step = 0; step < 30; step++) {
		const state = await cdp.evalInSession<{
			url: string;
			hasEmailInput: boolean;
			hasPassInput: boolean;
			passFilled: boolean;
			authNumber: string | null;
			hasStaySignedIn: boolean;
		}>(
			pageSessionId,
			`(() => {
				const emailInput = document.querySelector('input[type="email"], input[name="loginfmt"]');
				const passInput = document.querySelector('input[type="password"], input[name="passwd"]');
				const submitBtn = document.querySelector('input[type="submit"], button[type="submit"]');
				const authNumEl = document.querySelector('#idRichContext_DisplaySign');
				const heading = document.querySelector('#kmsiTitle, [ role="heading" ]')?.textContent || '';

				if (emailInput && !emailInput.closest('.moveOffScreen')) {
					emailInput.focus();
					emailInput.value = ${JSON.stringify(email)};
					emailInput.dispatchEvent(new Event('input', { bubbles: true }));
					emailInput.dispatchEvent(new Event('change', { bubbles: true }));
					if (submitBtn) submitBtn.click();
					return { url: location.href, hasEmailInput: true, hasPassInput: false, passFilled: false, authNumber: null, hasStaySignedIn: false };
				}

				if (passInput && !passInput.closest('.moveOffScreen')) {
					const hasVal = passInput.value && passInput.value.length > 0;
					if (hasVal && submitBtn) {
						submitBtn.click();
					}
					return { url: location.href, hasEmailInput: false, hasPassInput: true, passFilled: Boolean(hasVal), authNumber: null, hasStaySignedIn: false };
				}

				if (/stay signed in/i.test(heading) && submitBtn) {
					submitBtn.click();
					return { url: location.href, hasEmailInput: false, hasPassInput: false, passFilled: false, authNumber: null, hasStaySignedIn: true };
				}

				return {
					url: location.href,
					hasEmailInput: false,
					hasPassInput: false,
					passFilled: false,
					authNumber: authNumEl ? authNumEl.textContent?.trim() || null : null,
					hasStaySignedIn: false,
				};
			})()`,
			false,
		);

		if (state.url.includes("outlook.cloud.microsoft") || state.url.includes("outlook.office.com")) {
			onProgress?.("Microsoft login succeeded!");
			return;
		}

		if (state.authNumber) {
			onProgress?.(`Approve Microsoft Authenticator sign-in number: ${state.authNumber}`);
		}

		await Bun.sleep(2000);
	}
}

export async function exportAndSaveCookies(
	config: CopilotItsConfig,
	forceRelay = true,
): Promise<{ count: number; email: string; copilotUrl: string }> {
	const { cdp, pageSessionId, pageTarget } = await connectToCopilotIframe(config, {
		autoLogin: true,
		forceRelay,
	});
	try {
		const res = await cdp
			.send("Network.getAllCookies", {}, pageSessionId)
			.catch(() =>
				cdp.send(
					"Network.getCookies",
					{
						urls: [
							"https://outlook.cloud.microsoft",
							"https://outlook.office.com",
							"https://login.microsoftonline.com",
							"https://substrate.office.com",
						],
					},
					pageSessionId,
				),
			);

		const allCookies = (res.cookies as CopilotCookie[] | undefined) ?? [];
		const msCookies = allCookies.filter(c =>
			/microsoft|office|live|outlook|skype/i.test(c.domain),
		);

		const count = saveCookieStore({
			savedAt: new Date().toISOString(),
			email: config.email,
			copilotUrl: pageTarget.url,
			cookies: msCookies,
		});

		if (pageTarget.url.includes("outlook.cloud.microsoft/host/")) {
			saveConfig({ ...config, copilotUrl: pageTarget.url });
		}

		return { count, email: config.email, copilotUrl: pageTarget.url };
	} finally {
		cdp.close();
	}
}

export async function getCopilotStatus(config = loadConfig()): Promise<CopilotBridgeStatus> {
	try {
		const { cdp, mode, wsUrl, pageTarget, iframeSessionId } = await connectToCopilotIframe(config, {
			autoLogin: false,
		});
		try {
			const info = await cdp.evalInSession<{
				activeModel: string | null;
				conversationId: string | null;
				turnCount: number;
				email: string | null;
				throttlingInfo: CopilotThrottlingInfo | null;
			}>(
				iframeSessionId,
				`(() => {
					const modelLabels = ${JSON.stringify(COPILOT_ITS_MODELS.map(m => m.uiLabel))};
					const modelBtn = [...document.querySelectorAll('button')].find(b =>
						modelLabels.includes(b.innerText?.trim())
					);
					const tb = document.querySelector('#m365-chat-editor-target-element');
					let conversationId = null;
					let turnCount = 0;
					let throttlingInfo = null;
					let email = null;

					if (tb) {
						const fKey = Object.keys(tb).find(k => k.startsWith('__reactFiber$'));
						let curr = fKey ? tb[fKey] : null;
						for (let d = 0; d < 60 && curr; d++) {
							const p = curr.memoizedProps;
							if (p) {
								if (!conversationId && typeof p.currentConversationId === 'string') {
									conversationId = p.currentConversationId;
								}
								if (Array.isArray(p.chatHistory)) {
									turnCount = p.chatHistory.length;
									const lastTurn = p.chatHistory[p.chatHistory.length - 1];
									const lastResp = lastTurn?.responses?.[0];
									if (lastResp?.throttlingInfo) {
										throttlingInfo = lastResp.throttlingInfo;
									}
									if (!conversationId && lastResp?.conversationId) {
										conversationId = lastResp.conversationId;
									}
								}
							}
							curr = curr.return;
						}
					}

					const lastMsg = [...document.querySelectorAll('.fai-CopilotMessage')].pop();
					if (lastMsg) {
						const replyEl = lastMsg.querySelector('[data-testid="markdown-reply"]') || lastMsg;
						const rKey = Object.keys(replyEl).find(k => k.startsWith('__reactFiber$'));
						let rCurr = rKey ? replyEl[rKey] : null;
						for (let d = 0; d < 10 && rCurr; d++) {
							const p = rCurr.memoizedProps;
							if (p?.currentUserUpn && !email) email = p.currentUserUpn;
							if (p?.responses?.[0]?.throttlingInfo && !throttlingInfo) {
								throttlingInfo = p.responses[0].throttlingInfo;
							}
							rCurr = rCurr.return;
						}
					}

					return {
						activeModel: modelBtn ? modelBtn.innerText.trim() : null,
						conversationId,
						turnCount,
						email,
						throttlingInfo,
					};
				})()`,
				false,
			);

			if (info.throttlingInfo) lastKnownThrottlingInfo = info.throttlingInfo;
			if (info.conversationId) lastKnownConversationId = info.conversationId;
			if (info.activeModel) lastKnownActiveModel = info.activeModel;

			return {
				connected: true,
				mode,
				cdpUrl: wsUrl,
				pageUrl: pageTarget.url,
				pageTitle: pageTarget.title,
				email: info.email || config.email,
				activeModel: info.activeModel || undefined,
				conversationId: info.conversationId || undefined,
				turnCount: info.turnCount,
				throttlingInfo: info.throttlingInfo || lastKnownThrottlingInfo,
			};
		} finally {
			cdp.close();
		}
	} catch (err) {
		return {
			connected: false,
			mode: "disconnected",
			cdpUrl: config.cdpUrl,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function switchCopilotModelInUi(
	modelQueryOrId: string,
	config = loadConfig(),
): Promise<{ modelId: string; uiLabel: string; activeLabel: string }> {
	const modelDef = resolveCopilotModel(modelQueryOrId);
	if (!modelDef) {
		throw new Error(
			`Unknown Copilot ITS model "${modelQueryOrId}". Available: ${COPILOT_ITS_MODELS.map(m => m.id).join(", ")}`,
		);
	}

	const { cdp, iframeSessionId } = await connectToCopilotIframe(config);
	try {
		const activeLabel = await selectModelInsideIframe(cdp, iframeSessionId, modelDef.uiLabel, modelDef.submenu);
		lastKnownActiveModel = activeLabel;
		return {
			modelId: modelDef.id,
			uiLabel: modelDef.uiLabel,
			activeLabel,
		};
	} finally {
		cdp.close();
	}
}

async function selectModelInsideIframe(
	cdp: CdpSession,
	iframeSessionId: string,
	uiLabel: string,
	submenu: "GPT" | null,
): Promise<string> {
	const allLabels = COPILOT_ITS_MODELS.map(m => m.uiLabel);
	const result = await cdp.evalInSession<{ ok: boolean; active: string; error?: string }>(
		iframeSessionId,
		`(async () => {
			const allLabels = ${JSON.stringify(allLabels)};
			const targetLabel = ${JSON.stringify(uiLabel)};
			const submenu = ${JSON.stringify(submenu)};

			const findPickerBtn = () =>
				[...document.querySelectorAll('button')].find(b =>
					allLabels.includes(b.innerText?.trim())
				);

			const pickerBtn = findPickerBtn();
			if (!pickerBtn) return { ok: true, active: targetLabel };
			if (pickerBtn.innerText.trim() === targetLabel) {
				return { ok: true, active: targetLabel };
			}

			pickerBtn.click();
			await new Promise(r => setTimeout(r, 350));

			if (submenu === 'GPT') {
				const gptOption = [...document.querySelectorAll('[role="option"][aria-haspopup="menu"], [role="option"]')].find(
					el => el.innerText.trim().startsWith('GPT')
				);
				if (gptOption) {
					gptOption.focus();
					gptOption.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
					gptOption.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
					gptOption.click();
					await new Promise(r => setTimeout(r, 250));
					if (gptOption.getAttribute('aria-expanded') !== 'true') {
						gptOption.dispatchEvent(
							new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true })
						);
						await new Promise(r => setTimeout(r, 250));
					}
				}
			}

			const options = [...document.querySelectorAll('[role="option"], [role^="menuitem"]')];
			const match = options.find(el => {
				const lines = el.innerText.trim().split('\\n').map(s => s.trim());
				return lines[0] === targetLabel || el.innerText.trim() === targetLabel;
			});

			if (!match) {
				document.body.click();
				return {
					ok: false,
					active: pickerBtn.innerText.trim(),
					error: 'Option not found in menu: ' + targetLabel,
				};
			}

			match.click();
			await new Promise(r => setTimeout(r, 300));
			const updatedBtn = findPickerBtn();
			return {
				ok: true,
				active: updatedBtn ? updatedBtn.innerText.trim() : targetLabel,
			};
		})()`,
		true,
	);

	if (!result.ok) {
		throw new Error(result.error || `Failed switching model to ${uiLabel}`);
	}
	return result.active;
}

export async function startNewCopilotChat(
	config = loadConfig(),
): Promise<{ conversationId: string; activeModel: string }> {
	const { cdp, iframeSessionId } = await connectToCopilotIframe(config);
	try {
		const res = await resetChatInsideIframe(cdp, iframeSessionId);
		lastKnownConversationId = res.conversationId;
		return res;
	} finally {
		cdp.close();
	}
}

async function resetChatInsideIframe(
	cdp: CdpSession,
	iframeSessionId: string,
): Promise<{ conversationId: string; activeModel: string }> {
	return await cdp.evalInSession<{ conversationId: string; activeModel: string }>(
		iframeSessionId,
		`(async () => {
			const newChatBtn = document.querySelector('button[aria-label="New chat"]');
			if (newChatBtn) {
				newChatBtn.click();
			} else {
				const tb = document.querySelector('#m365-chat-editor-target-element');
				const fKey = tb ? Object.keys(tb).find(k => k.startsWith('__reactFiber$')) : null;
				let curr = fKey && tb ? tb[fKey] : null;
				while (curr && !curr.memoizedProps?.onNewConversationClicked) curr = curr.return;
				curr?.memoizedProps?.onNewConversationClicked?.();
			}

			for (let i = 0; i < 20; i++) {
				await new Promise(r => setTimeout(r, 150));
				const msgCount = document.querySelectorAll('.fai-CopilotMessage').length;
				if (msgCount === 0) break;
			}

			const tb = document.querySelector('#m365-chat-editor-target-element');
			let conversationId = '';
			if (tb) {
				const fKey = Object.keys(tb).find(k => k.startsWith('__reactFiber$'));
				let curr = fKey ? tb[fKey] : null;
				for (let d = 0; d < 40 && curr; d++) {
					if (typeof curr.memoizedProps?.currentConversationId === 'string') {
						conversationId = curr.memoizedProps.currentConversationId;
						break;
					}
					curr = curr.return;
				}
			}

			const allLabels = ${JSON.stringify(COPILOT_ITS_MODELS.map(m => m.uiLabel))};
			const pickerBtn = [...document.querySelectorAll('button')].find(b =>
				allLabels.includes(b.innerText?.trim())
			);

			return {
				conversationId,
				activeModel: pickerBtn ? pickerBtn.innerText.trim() : 'Auto',
			};
		})()`,
		true,
	);
}

export function streamCopilotPrompt(
	promptText: string,
	options: StreamPromptOptions = {},
	config = loadConfig(),
): Promise<StreamPromptResult> {
	const run = async (): Promise<StreamPromptResult> => {
		const { cdp, iframeSessionId } = await connectToCopilotIframe(config);
		try {
			if (options.requireNewChat) {
				await resetChatInsideIframe(cdp, iframeSessionId);
			}

			if (options.modelId && options.requireNewChat) {
				const modelDef = resolveCopilotModel(options.modelId);
				if (modelDef) {
					await selectModelInsideIframe(cdp, iframeSessionId, modelDef.uiLabel, modelDef.submenu);
				}
			}

			const beforeState = await cdp.evalInSession<{
				beforeCount: number;
				prevRequestId: string;
				conversationId: string;
			}>(
				iframeSessionId,
				`(() => {
					const msgs = [...document.querySelectorAll('.fai-CopilotMessage')];
					const beforeCount = ${options.requireNewChat ? "0" : "msgs.length"};
					let prevRequestId = '';
					if (!${Boolean(options.requireNewChat)} && msgs.length > 0) {
						const last = msgs[msgs.length - 1];
						const replyEl = last.querySelector('[data-testid="markdown-reply"]') || last;
						const rKey = Object.keys(replyEl).find(k => k.startsWith('__reactFiber$'));
						let rCurr = rKey ? replyEl[rKey] : null;
						for (let d = 0; d < 10 && rCurr; d++) {
							if (typeof rCurr.memoizedProps?.requestId === 'string') {
								prevRequestId = rCurr.memoizedProps.requestId;
								break;
							}
							rCurr = rCurr.return;
						}
					}
					let conversationId = '';
					const tb = document.querySelector('#m365-chat-editor-target-element');
					if (tb) {
						const fKey = Object.keys(tb).find(k => k.startsWith('__reactFiber$'));
						let curr = fKey ? tb[fKey] : null;
						for (let d = 0; d < 40 && curr; d++) {
							if (typeof curr.memoizedProps?.currentConversationId === 'string') {
								conversationId = curr.memoizedProps.currentConversationId;
								break;
							}
							curr = curr.return;
						}
					}
					window.postMessage({
						func: 'askCopilot',
						args: [${JSON.stringify(promptText)}],
					}, '*');
					return { beforeCount, prevRequestId, conversationId };
				})()`,
				false,
			);

			let emittedThinking = "";
			let emittedText = "";
			let finalReply = "";
			let finalConversationId = beforeState.conversationId;
			let finalTurnCount = beforeState.beforeCount + 1;
			let finalThrottling: CopilotThrottlingInfo | undefined;

			const maxPolls = 1500; // ~3 minutes at 120ms
			for (let pollIdx = 0; pollIdx < maxPolls; pollIdx++) {
				if (options.signal?.aborted) {
					await cdp
						.evalInSession(
							iframeSessionId,
							`(() => {
								const stopBtn = [...document.querySelectorAll('button')].find(b =>
									/stop/i.test(b.getAttribute('aria-label') || b.innerText || '')
								);
								if (stopBtn) stopBtn.click();
							})()`,
							false,
						)
						.catch(() => {});
					throw new Error("Request was aborted");
				}

				await Bun.sleep(120);

				const snap = await cdp.evalInSession<PollSnapshot>(
					iframeSessionId,
					`(() => {
						const msgs = [...document.querySelectorAll('.fai-CopilotMessage')];
						const count = msgs.length;
						const last = msgs[count - 1];
						if (!last) {
							return {
								count: 0,
								requestId: null,
								requestResultType: null,
								hasCopyBtn: false,
								isStreamingMessage: false,
								streamingText: null,
								replyMessage: null,
								conversationId: null,
								currentUserUpn: null,
								throttlingInfo: null,
							};
						}

						const replyEl = last.querySelector('[data-testid="markdown-reply"]') || last;
						const fKey = Object.keys(replyEl).find(k => k.startsWith('__reactFiber$'));
						let curr = fKey ? replyEl[fKey] : null;
						let requestId = null;
						let requestResultType = null;
						let isStreamingMessage = false;
						let streamingText = null;
						let replyMessage = null;
						let conversationId = null;
						let currentUserUpn = null;
						let throttlingInfo = null;

						for (let d = 0; d < 12 && curr; d++) {
							const p = curr.memoizedProps;
							if (p) {
								if (typeof p.requestId === 'string' && !requestId) {
									requestId = p.requestId;
								}
								if (typeof p.isStreamingMessage === 'boolean') {
									isStreamingMessage = p.isStreamingMessage;
								}
								if (typeof p.streamingText === 'string' && streamingText === null) {
									streamingText = p.streamingText;
								}
								if (typeof p.replyMessage === 'string' && replyMessage === null) {
									replyMessage = p.replyMessage;
								}
								if (typeof p.legacyReplyMessage === 'string' && replyMessage === null) {
									replyMessage = p.legacyReplyMessage;
								}
								if (typeof p.currentUserUpn === 'string' && !currentUserUpn) {
									currentUserUpn = p.currentUserUpn;
								}
								const firstResp = Array.isArray(p.responses) ? p.responses[0] : null;
								if (firstResp) {
									if (typeof firstResp.requestResultType === 'string' && !requestResultType) {
										requestResultType = firstResp.requestResultType;
									}
									if (typeof firstResp.text === 'string' && !replyMessage) {
										replyMessage = firstResp.text;
									}
									if (typeof firstResp.conversationId === 'string' && !conversationId) {
										conversationId = firstResp.conversationId;
									}
									if (firstResp.throttlingInfo && !throttlingInfo) {
										throttlingInfo = firstResp.throttlingInfo;
									}
								}
							}
							curr = curr.return;
						}

						const hasCopyBtn = Boolean(last.querySelector('[data-testid="CopyButtonTestId"]'));
						return {
							count,
							requestId,
							requestResultType,
							hasCopyBtn,
							isStreamingMessage,
							streamingText,
							replyMessage,
							conversationId,
							currentUserUpn,
							throttlingInfo,
						};
					})()`,
					false,
				);

				const isNewTurn =
					snap.count > beforeState.beforeCount ||
					Boolean(snap.requestId && snap.requestId !== beforeState.prevRequestId);
				if (!isNewTurn) {
					continue;
				}

				if (snap.conversationId) finalConversationId = snap.conversationId;
				if (snap.throttlingInfo) {
					finalThrottling = snap.throttlingInfo;
					lastKnownThrottlingInfo = snap.throttlingInfo;
				}
				finalTurnCount = snap.count;

				if (snap.streamingText && snap.streamingText !== "[](typingBalls)") {
					const rawStream = snap.streamingText.replace(/^\[\]\(typingBalls\)\s*/, "");
					let cotPart = "";
					let bodyPart = rawStream;

					const splitMatch = rawStream.match(/^([^\n]{1,120}(?:…|\.\.\.))\n\n([\s\S]*)$/);
					if (splitMatch) {
						cotPart = splitMatch[1];
						bodyPart = splitMatch[2];
					} else if (/^[^\n]{1,120}(?:…|\.\.\.)$/.test(rawStream.trim())) {
						cotPart = rawStream.trim();
						bodyPart = "";
					}

					if (cotPart && cotPart.length > emittedThinking.length && cotPart.startsWith(emittedThinking)) {
						const delta = cotPart.slice(emittedThinking.length);
						emittedThinking = cotPart;
						options.onThinkingDelta?.(delta);
					}

					if (bodyPart && bodyPart.length > emittedText.length && bodyPart.startsWith(emittedText)) {
						const delta = bodyPart.slice(emittedText.length);
						emittedText = bodyPart;
						options.onTextDelta?.(delta);
					}
				}

				const isTurnComplete =
					!snap.isStreamingMessage &&
					(snap.hasCopyBtn || snap.requestResultType === "Success");
				if (isTurnComplete) {
					finalReply = snap.replyMessage ?? emittedText;
					if (finalReply.length > emittedText.length && finalReply.startsWith(emittedText)) {
						options.onTextDelta?.(finalReply.slice(emittedText.length));
						emittedText = finalReply;
					} else if (!emittedText && finalReply) {
						options.onTextDelta?.(finalReply);
						emittedText = finalReply;
					}
					break;
				}
			}

			lastKnownConversationId = finalConversationId;
			return {
				text: finalReply || emittedText,
				thinking: emittedThinking,
				conversationId: finalConversationId,
				turnCount: finalTurnCount,
				throttlingInfo: finalThrottling,
			};
		} finally {
			cdp.close();
		}
	};

	const queued = requestQueue.then(run, run);
	requestQueue = queued.catch(() => {});
	return queued;
}
