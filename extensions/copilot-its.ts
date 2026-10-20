import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	COOKIES_PATH,
	loadConfig,
	loadCookieStore,
	saveConfig,
} from "../src/config.js";
import {
	type CopilotThrottlingInfo,
	exportAndSaveCookies,
	getCopilotStatus,
	getLastKnownQuota,
	startNewCopilotChat,
	streamCopilotPrompt,
	switchCopilotModelInUi,
} from "../src/cdp.js";
import { COPILOT_ITS_MODELS, resolveCopilotModel } from "../src/models.js";
import { startSetupServer } from "../src/setup-server.js";

const CUSTOM_ENTRY_SESSION_STATE = "copilot-its.session-state";

interface SessionChatState {
	sessionId: string;
	copilotConversationId?: string;
	modelId: string;
	requireNewChat: boolean;
	seededMessageCount: number;
	seededSummary?: string;
}

interface PersistedSessionState {
	copilotConversationId?: string;
	modelId?: string;
	seededSummary?: string;
	timestamp: number;
}

interface ContextContentBlock {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	arguments?: Record<string, unknown>;
}

interface ContextMessage {
	role: string;
	content: string | ContextContentBlock[];
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

interface StreamContext {
	systemPrompt?: string | string[];
	messages: ContextMessage[];
	tools?: Array<{
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	}>;
}

interface StreamOptions {
	signal?: AbortSignal;
	sessionId?: string;
	maxTokens?: number;
}

function extractMessageText(content: string | ContextContentBlock[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			const argsObj = block.arguments ?? {};
			const paramsXml = Object.entries(argsObj)
				.map(([k, v]) => {
					const serialized = typeof v === "string" ? v : JSON.stringify(v);
					return `<parameter name="${k}">${serialized}</parameter>`;
				})
				.join("");
			parts.push(`<invoke name="${block.name}">${paramsXml}</invoke>`);
		}
	}
	return parts.join("\n");
}

function formatMessagesForCopilot(
	context: StreamContext,
	isFirstTurnInChat: boolean,
	pendingSummary?: string,
): string {
	const chunks: string[] = [];

	if (isFirstTurnInChat) {
		const sysRaw = Array.isArray(context.systemPrompt)
			? context.systemPrompt.join("\n\n")
			: typeof context.systemPrompt === "string"
				? context.systemPrompt
				: "";

		if (sysRaw.trim()) {
			const boundedSys = sysRaw.length > 45_000 ? `${sysRaw.slice(0, 45_000)}\n...[truncated]` : sysRaw;
			chunks.push(`<system_instructions>\n${boundedSys}\n</system_instructions>`);
		}

		if (context.tools && context.tools.length > 0 && !sysRaw.includes("<tools>")) {
			const toolLines = context.tools.map(t =>
				JSON.stringify({
					type: "function",
					function: {
						name: t.name,
						description: t.description ?? "",
						parameters: t.parameters ?? { type: "object", properties: {} },
					},
				}),
			);
			chunks.push(
				[
					"<tools>",
					...toolLines,
					"</tools>",
					"When you need to call a tool, output an XML invoke block with exact tool and parameter names:",
					'<invoke name="TOOL_NAME"><parameter name="PARAM_NAME">VALUE</parameter></invoke>',
					"Wait for <tool_response> in the next message before continuing.",
				].join("\n"),
			);
		}

		if (pendingSummary) {
			chunks.push(`<compaction_handoff_summary>\n${pendingSummary}\n</compaction_handoff_summary>`);
		}

		for (const msg of context.messages) {
			const text = extractMessageText(msg.content);
			if (!text.trim()) continue;
			if (msg.role === "toolResult") {
				chunks.push(`<tool_response>\n${text}\n</tool_response>`);
			} else if (msg.role === "assistant") {
				chunks.push(`[Assistant]\n${text}`);
			} else {
				chunks.push(text);
			}
		}
	} else {
		// Multi-round delta: find messages after the last assistant turn
		let lastAssistantIdx = -1;
		for (let i = context.messages.length - 1; i >= 0; i--) {
			if (context.messages[i].role === "assistant") {
				lastAssistantIdx = i;
				break;
			}
		}
		const deltaMessages =
			lastAssistantIdx >= 0
				? context.messages.slice(lastAssistantIdx + 1)
				: context.messages.slice(-1);

		for (const msg of deltaMessages) {
			const text = extractMessageText(msg.content);
			if (!text.trim()) continue;
			if (msg.role === "toolResult") {
				chunks.push(`<tool_response>\n${text}\n</tool_response>`);
			} else {
				chunks.push(text);
			}
		}
	}

	const combined = chunks.join("\n\n").trim();
	// Copilot Chat editor enforces a 128,000-character limit
	if (combined.length > 124_000) {
		return combined.slice(combined.length - 124_000);
	}
	return combined || "Continue.";
}

function parseXmlToolCalls(text: string): {
	cleanText: string;
	toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
} {
	const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
	const invokeRegex = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
	let match: RegExpExecArray | null;
	let callIdx = 1;

	while ((match = invokeRegex.exec(text)) !== null) {
		const toolName = match[1].trim();
		const body = match[2];
		const args: Record<string, unknown> = {};
		const paramRegex = /<parameter\s+name="([^"]+)"(?:\s+string="([^"]+)")?\s*>([\s\S]*?)<\/parameter>/g;
		let pMatch: RegExpExecArray | null;
		while ((pMatch = paramRegex.exec(body)) !== null) {
			const pName = pMatch[1].trim();
			const forceString = pMatch[2];
			const rawVal = pMatch[3];
			if (forceString === "true") {
				args[pName] = rawVal;
			} else {
				const trimmedVal = rawVal.trim();
				if (
					forceString === "false" ||
					trimmedVal.startsWith("{") ||
					trimmedVal.startsWith("[") ||
					trimmedVal === "true" ||
					trimmedVal === "false" ||
					/^-?\d+(\.\d+)?$/.test(trimmedVal)
				) {
					try {
						args[pName] = JSON.parse(trimmedVal);
					} catch {
						args[pName] = rawVal;
					}
				} else {
					args[pName] = rawVal;
				}
			}
		}
		toolCalls.push({
			id: `copilot_call_${Date.now()}_${callIdx++}`,
			name: toolName,
			arguments: args,
		});
	}

	const cleanText =
		toolCalls.length > 0
			? text
					.replace(/<\/?(?:tool_calls|function_calls)>/g, "")
					.replace(invokeRegex, "")
					.trim()
			: text;

	return { cleanText, toolCalls };
}

function formatQuotaSummary(throttling?: CopilotThrottlingInfo): string {
	const m = throttling?.metering;
	if (!m) return "quota: unknown (send 1 message to refresh)";
	const solDaily = m.GPT61SolQueryDaily?.remainingAllowance;
	const solWeekly = m.GPT61SolQueryWeekly?.remainingAllowance;
	const opusDaily = m.ClaudeOpus55QueryDailyWord?.remainingAllowance ?? m.ClaudeOpusQueryDaily?.remainingAllowance;
	const sonnetDaily = m.ClaudeSonnet55QueryDaily?.remainingAllowance;
	const parts: string[] = [];
	if (typeof solDaily === "number") parts.push(`GPT-6.1 Sol: ${solDaily}/d, ${solWeekly ?? "?"}/w`);
	if (typeof opusDaily === "number") parts.push(`Opus: ${opusDaily}/d`);
	if (typeof sonnetDaily === "number") parts.push(`Sonnet: ${sonnetDaily}/d`);
	if (typeof throttling?.numUserMessagesInConversation === "number") {
		parts.push(
			`Chat turns: ${throttling.numUserMessagesInConversation}/${throttling.maxNumUserMessagesInConversation ?? 600}`,
		);
	}
	return parts.join(" · ") || "quota: active";
}

export default function copilotItsExtension(pi: ExtensionAPI): void {
	pi.setLabel("Copilot ITS Provider");

	let config = loadConfig();
	const sessionStates = new Map<string, SessionChatState>();
	let activeSessionId = "default";

	function getOrCreateSessionState(sessionId: string): SessionChatState {
		let state = sessionStates.get(sessionId);
		if (!state) {
			state = {
				sessionId,
				modelId: config.defaultModel,
				requireNewChat: config.autoNewChatPerSession,
				seededMessageCount: 0,
			};
			sessionStates.set(sessionId, state);
		}
		return state;
	}

	function restoreSessionStateFromContext(ctx: ExtensionContext): SessionChatState {
		const sid = ctx.sessionManager.getSessionId() || "default";
		activeSessionId = sid;
		let latestPersisted: PersistedSessionState | undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_ENTRY_SESSION_STATE && entry.data) {
				latestPersisted = entry.data as PersistedSessionState;
			}
		}

		const state = getOrCreateSessionState(sid);
		if (latestPersisted) {
			state.copilotConversationId = latestPersisted.copilotConversationId;
			if (latestPersisted.modelId) state.modelId = latestPersisted.modelId;
			if (latestPersisted.seededSummary) state.seededSummary = latestPersisted.seededSummary;
			state.requireNewChat = false;
		} else {
			state.requireNewChat = config.autoNewChatPerSession;
		}
		return state;
	}

	// Register the "copilot-its" provider
	pi.registerProvider("copilot-its", {
		baseUrl: "https://outlook.cloud.microsoft/copilot-its",
		apiKey: "copilot-its-session",
		api: "copilot-its-api",
		models: COPILOT_ITS_MODELS.map(m => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: ["text"],
			supportsTools: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
		usage: {
			id: "copilot-its",
			async fetchUsage() {
				const quota = getLastKnownQuota();
				const m = quota.throttlingInfo?.metering;
				if (!m) return null;
				const dailyRem = m.GPT61SolQueryDaily?.remainingAllowance ?? 40;
				const weeklyRem = m.GPT61SolQueryWeekly?.remainingAllowance ?? 75;
				return {
					provider: "copilot-its",
					fetchedAt: Date.now(),
					limits: [
						{
							id: "gpt-6.1-sol-daily",
							label: "GPT-6.1 Sol Daily",
							scope: { provider: "copilot-its" },
							amount: {
								used: Math.max(0, 40 - dailyRem),
								limit: 40,
								unit: "requests",
							},
						},
						{
							id: "gpt-6.1-sol-weekly",
							label: "GPT-6.1 Sol Weekly",
							scope: { provider: "copilot-its" },
							amount: {
								used: Math.max(0, 75 - weeklyRem),
								limit: 75,
								unit: "requests",
							},
						},
					],
				};
			},
		},
		streamSimple(model, rawContext, rawOptions) {
			const stream = new AssistantMessageEventStream();
			const context = rawContext as unknown as StreamContext;
			const options = (rawOptions ?? {}) as StreamOptions;
			const sid = options.sessionId || activeSessionId || "default";
			const state = getOrCreateSessionState(sid);

			const assistantMsg = {
				role: "assistant" as const,
				content: [] as Array<
					| { type: "thinking"; thinking: string }
					| { type: "text"; text: string }
					| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
				>,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as "stop" | "length" | "toolUse" | "error" | "aborted",
				timestamp: Date.now(),
				duration: 0,
				ttft: undefined as number | undefined,
				errorMessage: undefined as string | undefined,
			};

			void (async () => {
				const startedAt = performance.now();
				let thinkingIndex: number | undefined;
				let textIndex: number | undefined;

				const closeThinking = () => {
					if (thinkingIndex !== undefined) {
						const block = assistantMsg.content[thinkingIndex];
						if (block && block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: thinkingIndex,
								content: block.thinking,
								partial: assistantMsg,
							});
						}
						thinkingIndex = undefined;
					}
				};

				const closeText = () => {
					if (textIndex !== undefined) {
						const block = assistantMsg.content[textIndex];
						if (block && block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: textIndex,
								content: block.text,
								partial: assistantMsg,
							});
						}
						textIndex = undefined;
					}
				};

				try {
					config = loadConfig();
					const hasPriorAssistantInContext = context.messages.some(m => m.role === "assistant");
					const isFirstTurnInChat =
						state.requireNewChat || state.seededMessageCount === 0 || !hasPriorAssistantInContext;

					const promptText = formatMessagesForCopilot(
						context,
						isFirstTurnInChat,
						state.seededSummary,
					);

					stream.push({ type: "start", partial: assistantMsg });

					const hasDirectTools = Boolean(context.tools && context.tools.length > 0);

					const result = await streamCopilotPrompt(
						promptText,
						{
							modelId: model.id,
							requireNewChat: isFirstTurnInChat,
							signal: options.signal,
							onThinkingDelta: delta => {
								if (thinkingIndex === undefined) {
									thinkingIndex =
										assistantMsg.content.push({ type: "thinking", thinking: "" }) - 1;
									stream.push({
										type: "thinking_start",
										contentIndex: thinkingIndex,
										partial: assistantMsg,
									});
								}
								const block = assistantMsg.content[thinkingIndex];
								if (block && block.type === "thinking") {
									block.thinking += delta;
								}
								stream.push({
									type: "thinking_delta",
									contentIndex: thinkingIndex,
									delta,
									partial: assistantMsg,
								});
								assistantMsg.ttft ??= performance.now() - startedAt;
							},
							onTextDelta: delta => {
								if (hasDirectTools) {
									// Buffer text until completion if we need to strip/parse direct <invoke> tags
									assistantMsg.ttft ??= performance.now() - startedAt;
									return;
								}
								closeThinking();
								if (textIndex === undefined) {
									textIndex = assistantMsg.content.push({ type: "text", text: "" }) - 1;
									stream.push({
										type: "text_start",
										contentIndex: textIndex,
										partial: assistantMsg,
									});
								}
								const block = assistantMsg.content[textIndex];
								if (block && block.type === "text") {
									block.text += delta;
								}
								stream.push({
									type: "text_delta",
									contentIndex: textIndex,
									delta,
									partial: assistantMsg,
								});
								assistantMsg.ttft ??= performance.now() - startedAt;
							},
						},
						config,
					);

					closeThinking();

					if (hasDirectTools) {
						const { cleanText, toolCalls } = parseXmlToolCalls(result.text);
						if (cleanText) {
							textIndex = assistantMsg.content.push({ type: "text", text: cleanText }) - 1;
							stream.push({
								type: "text_start",
								contentIndex: textIndex,
								partial: assistantMsg,
							});
							stream.push({
								type: "text_delta",
								contentIndex: textIndex,
								delta: cleanText,
								partial: assistantMsg,
							});
							closeText();
						}
						for (const tc of toolCalls) {
							const tcIndex =
								assistantMsg.content.push({
									type: "toolCall",
									id: tc.id,
									name: tc.name,
									arguments: tc.arguments,
								}) - 1;
							const serializedArgs = JSON.stringify(tc.arguments);
							stream.push({
								type: "toolcall_start",
								contentIndex: tcIndex,
								partial: assistantMsg,
							});
							stream.push({
								type: "toolcall_delta",
								contentIndex: tcIndex,
								delta: serializedArgs,
								partial: assistantMsg,
							});
							const block = assistantMsg.content[tcIndex];
							if (block && block.type === "toolCall") {
								stream.push({
									type: "toolcall_end",
									contentIndex: tcIndex,
									toolCall: block,
									partial: assistantMsg,
								});
							}
						}
						if (toolCalls.length > 0) {
							assistantMsg.stopReason = "toolUse";
						}
					} else {
						closeText();
					}

					state.requireNewChat = false;
					state.seededSummary = undefined;
					state.seededMessageCount = context.messages.length + 1;
					state.modelId = model.id;
					if (result.conversationId) {
						state.copilotConversationId = result.conversationId;
					}

					try {
						pi.appendEntry(CUSTOM_ENTRY_SESSION_STATE, {
							copilotConversationId: state.copilotConversationId,
							modelId: state.modelId,
							timestamp: Date.now(),
						} satisfies PersistedSessionState);
					} catch {}

					const estInput = Math.ceil(promptText.length / 4);
					const estOutput = Math.ceil(result.text.length / 4);
					assistantMsg.usage.input = estInput;
					assistantMsg.usage.output = estOutput;
					assistantMsg.usage.totalTokens = estInput + estOutput;
					assistantMsg.duration = performance.now() - startedAt;

					stream.push({
						type: "done",
						reason: assistantMsg.stopReason,
						message: assistantMsg,
					});
					stream.end();
				} catch (err) {
					closeThinking();
					closeText();
					assistantMsg.stopReason = options.signal?.aborted ? "aborted" : "error";
					assistantMsg.errorMessage = err instanceof Error ? err.message : String(err);
					assistantMsg.duration = performance.now() - startedAt;
					stream.push({
						type: "error",
						reason: assistantMsg.stopReason,
						error: assistantMsg,
					});
					stream.end();
				}
			})();

			return stream;
		},
	});

	// Hook: session_start — restore or initialize per-session Copilot chat state
	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		const state = restoreSessionStateFromContext(ctx);
		const cookieStore = loadCookieStore();
		const cookieCount = cookieStore?.cookies.length ?? 0;

		if (ctx.agent?.kind === "sub") return;

		ctx.ui.notify(
			`copilot-its ready (${config.defaultModel}, ${cookieCount} cookies${state.copilotConversationId ? `, chat ${state.copilotConversationId.slice(0, 8)}` : ", new session chat"})`,
			"info",
		);
	});

	// Hook: session_switch — keep per-session chat isolated when switching sessions
	pi.on("session_switch", async (_event, ctx) => {
		config = loadConfig();
		const state = restoreSessionStateFromContext(ctx);
		if (!state.copilotConversationId && config.autoNewChatPerSession) {
			state.requireNewChat = true;
		}
	});

	// Hook: session_compact — start a new Copilot chat and seed it with the compaction summary!
	pi.on("session_compact", async (event, ctx) => {
		config = loadConfig();
		if (!config.autoCompactHandoff) return;

		const summary = event.compactionEntry?.summary?.trim();
		if (!summary) return;

		const sid = ctx.sessionManager.getSessionId() || activeSessionId || "default";
		const state = getOrCreateSessionState(sid);

		try {
			ctx.ui.notify("copilot-its: starting new Copilot chat & seeding compaction summary...", "info");
			const handoffPrompt = [
				"[OMP Session Compaction Summary — Context Handoff]",
				"The previous conversation was compacted. Absorb the following summary of all prior context and work:",
				"",
				"<compaction_summary>",
				summary,
				"</compaction_summary>",
				"",
				"Reply with ONLY the word CONTEXT_RESTORED to confirm you have loaded this summary.",
			].join("\n");

			const handoffRes = await streamCopilotPrompt(
				handoffPrompt,
				{
					modelId: state.modelId || config.defaultModel,
					requireNewChat: true,
				},
				config,
			);

			state.copilotConversationId = handoffRes.conversationId;
			state.requireNewChat = false;
			state.seededSummary = undefined;
			state.seededMessageCount = 1;

			pi.appendEntry(CUSTOM_ENTRY_SESSION_STATE, {
				copilotConversationId: state.copilotConversationId,
				modelId: state.modelId,
				seededSummary: summary.slice(0, 2000),
				timestamp: Date.now(),
			} satisfies PersistedSessionState);

			ctx.ui.notify(
				`copilot-its: compacted context handed off to new Copilot chat (${handoffRes.conversationId.slice(0, 8)})`,
				"info",
			);
		} catch (err) {
			// Fallback: attach summary on next turn
			state.requireNewChat = true;
			state.seededSummary = summary;
			state.seededMessageCount = 0;
			ctx.ui.notify(
				`copilot-its: queued compaction summary for next turn (${err instanceof Error ? err.message : String(err)})`,
				"warning",
			);
		}
	});

	// Command: /its-model [query]
	pi.registerCommand("its-model", {
		description: "Switch Copilot ITS model (e.g. /its-model sol 6.1) and set active omp model",
		handler: async (args, ctx) => {
			config = loadConfig();
			let targetModelDef = args.trim() ? resolveCopilotModel(args.trim()) : undefined;

			if (!targetModelDef) {
				const quota = getLastKnownQuota();
				const quotaLine = formatQuotaSummary(quota.throttlingInfo);
				const items = COPILOT_ITS_MODELS.map(m => {
					const isCurrent = m.id === config.defaultModel || m.uiLabel === quota.activeModel;
					return {
						id: m.id,
						label: `${isCurrent ? "● " : "  "}${m.uiLabel} [copilot-its/${m.id}] — ${m.description}`,
					};
				});

				const choice = await ctx.ui.select(
					`Select Copilot ITS model (${quotaLine}):`,
					items.map(i => i.label),
				);
				if (!choice) return;
				const picked = items.find(i => i.label === choice);
				if (!picked) return;
				targetModelDef = resolveCopilotModel(picked.id);
			}

			if (!targetModelDef) {
				ctx.ui.notify(`Unknown model "${args.trim()}".`, "warning");
				return;
			}

			try {
				ctx.ui.notify(`Switching Copilot UI to ${targetModelDef.uiLabel}...`, "info");
				const switched = await switchCopilotModelInUi(targetModelDef.id, config);
				config = saveConfig({ ...config, defaultModel: switched.modelId });

				const sid = ctx.sessionManager.getSessionId() || activeSessionId || "default";
				const state = getOrCreateSessionState(sid);
				state.modelId = switched.modelId;

				const resolvedOmpModel = ctx.models.resolve(`copilot-its/${switched.modelId}`);
				if (resolvedOmpModel) {
					await pi.setModel(resolvedOmpModel);
				}

				const quota = getLastKnownQuota();
				ctx.ui.notify(
					`Active model: copilot-its/${switched.modelId} (${switched.activeLabel})\n${formatQuotaSummary(quota.throttlingInfo)}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Failed switching model: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// Command: /its-new [prompt]
	pi.registerCommand("its-new", {
		description: "Start a fresh Copilot Chat conversation for this session",
		handler: async (args, ctx) => {
			config = loadConfig();
			const sid = ctx.sessionManager.getSessionId() || activeSessionId || "default";
			const state = getOrCreateSessionState(sid);

			try {
				const res = await startNewCopilotChat(config);
				state.copilotConversationId = res.conversationId;
				state.requireNewChat = false;
				state.seededMessageCount = 0;
				state.seededSummary = undefined;

				pi.appendEntry(CUSTOM_ENTRY_SESSION_STATE, {
					copilotConversationId: res.conversationId,
					modelId: state.modelId,
					timestamp: Date.now(),
				} satisfies PersistedSessionState);

				ctx.ui.notify(
					`Started new Copilot chat (${res.conversationId ? res.conversationId.slice(0, 8) : "ready"}, model: ${res.activeModel})`,
					"info",
				);

				if (args.trim()) {
					pi.sendUserMessage(args.trim());
				}
			} catch (err) {
				state.requireNewChat = true;
				state.seededMessageCount = 0;
				ctx.ui.notify(
					`Marked session for new chat (${err instanceof Error ? err.message : String(err)})`,
					"warning",
				);
			}
		},
	});

	// Command: /its-compact [focus]
	pi.registerCommand("its-compact", {
		description: "Summarize current context, start a new Copilot chat, and seed it with the summary",
		handler: async (args, ctx) => {
			config = loadConfig();
			const focus = args.trim();
			const sid = ctx.sessionManager.getSessionId() || activeSessionId || "default";
			const state = getOrCreateSessionState(sid);

			try {
				ctx.ui.notify("copilot-its: generating handoff summary & rotating to new Copilot chat...", "info");

				// Ask Copilot in the current conversation to distill a handoff summary before resetting
				const summaryPrompt = [
					"Produce a dense, structured handoff summary of our entire conversation so far so it can be pasted into a fresh chat session.",
					focus ? `Focus especially on: ${focus}` : "",
					"Include: key goals, decisions, code/files discussed, exact values/numbers, and next steps.",
				]
					.filter(Boolean)
					.join("\n");

				const summaryRes = await streamCopilotPrompt(
					summaryPrompt,
					{
						modelId: state.modelId || config.defaultModel,
						requireNewChat: false,
					},
					config,
				);

				const summaryText = summaryRes.text.trim();

				// Now start a brand-new Copilot chat and seed the summary into it
				const seedPrompt = [
					"[OMP Session Compaction Summary — Context Handoff]",
					"Here is the summary of our previous chat session. Keep this context in memory for all following turns:",
					"",
					"<compaction_summary>",
					summaryText,
					"</compaction_summary>",
					"",
					"Reply with ONLY: CONTEXT_RESTORED",
				].join("\n");

				const seedRes = await streamCopilotPrompt(
					seedPrompt,
					{
						modelId: state.modelId || config.defaultModel,
						requireNewChat: true,
					},
					config,
				);

				state.copilotConversationId = seedRes.conversationId;
				state.requireNewChat = false;
				state.seededSummary = undefined;
				state.seededMessageCount = 1;

				pi.appendEntry(CUSTOM_ENTRY_SESSION_STATE, {
					copilotConversationId: seedRes.conversationId,
					modelId: state.modelId,
					seededSummary: summaryText.slice(0, 2000),
					timestamp: Date.now(),
				} satisfies PersistedSessionState);

				// Also trigger omp's own compaction if history is large enough, without failing if it's a no-op
				await ctx.compact(focus || undefined).catch(() => {});

				ctx.ui.notify(
					[
						`✅ Rotated to new Copilot chat (${seedRes.conversationId.slice(0, 8)}) with seeded summary!`,
						`Summary (${summaryText.length} chars): ${summaryText.slice(0, 220)}${summaryText.length > 220 ? "..." : ""}`,
					].join("\n"),
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Failed running /its-compact: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// Command: /its-setup [action]
	pi.registerCommand("its-setup", {
		description: "Setup Copilot ITS autologin, capture browser cookies, or start localhost callback server",
		handler: async (args, ctx) => {
			config = loadConfig();
			const sub = args.trim().toLowerCase();

			const runCapture = async () => {
				ctx.ui.notify(`Connecting to browser & capturing cookies for ${config.email}...`, "info");
				const res = await exportAndSaveCookies(config);
				ctx.ui.notify(
					`Saved ${res.count} cookies for ${res.email} to ${COOKIES_PATH}`,
					"info",
				);
			};

			const runServer = async () => {
				const srv = await startSetupServer(config.setupServerPort, msg => {
					ctx.ui.notify(`[its-setup] ${msg}`, "info");
				});
				ctx.ui.notify(
					[
						`🌐 Copilot ITS Setup & Cookie Callback Server running:`,
						`  Dashboard: ${srv.url}`,
						`  Callback:  ${srv.url}/callback`,
						`  Cookies:   ${COOKIES_PATH}`,
					].join("\n"),
					"info",
				);
				return srv;
			};

			if (sub === "server" || sub === "localhost") {
				await runServer();
				return;
			}
			if (sub === "capture" || sub === "cookies" || sub === "login") {
				await runCapture();
				return;
			}
			if (sub === "status") {
				const st = await getCopilotStatus(config);
				const store = loadCookieStore();
				ctx.ui.notify(
					[
						`🔗 Copilot ITS Status`,
						`  Connected:  ${st.connected ? `🟢 yes (${st.mode})` : `🔴 no (${st.error || "disconnected"})`}`,
						`  Account:    ${st.email || config.email}`,
						`  UI Model:   ${st.activeModel || config.defaultModel}`,
						`  Chat ID:    ${st.conversationId || "-"}`,
						`  Cookies:    ${store?.cookies.length ?? 0} saved (${store?.savedAt || "never"})`,
						`  Quota:      ${formatQuotaSummary(st.throttlingInfo)}`,
					].join("\n"),
					st.connected ? "info" : "warning",
				);
				return;
			}

			// Interactive setup wizard
			const srv = await runServer();
			const choice = await ctx.ui.select(
				`Copilot ITS Setup (Callback server live at ${srv.url})`,
				[
					`1. Auto-login & capture cookies from active Browser Relay (${config.email})`,
					`2. Open ${srv.url} setup dashboard in browser`,
					`3. Configure ITS email & session behavior`,
					`4. Check connection & quota status`,
					`5. Done (keep ${srv.url} running)`,
				],
			);

			if (!choice || choice.startsWith("5.")) return;

			if (choice.startsWith("1.")) {
				await runCapture();
			} else if (choice.startsWith("2.")) {
				const status = await getCopilotStatus(config);
				ctx.ui.notify(
					`Setup server is live at ${srv.url} (POST cookies to ${srv.url}/callback). Relay connected=${status.connected}`,
					"info",
				);
			} else if (choice.startsWith("3.")) {
				const newEmail = await ctx.ui.input("ITS Student Email:", config.email);
				if (newEmail !== undefined && newEmail.trim()) {
					config = saveConfig({ ...config, email: newEmail.trim() });
				}
				const modeChoice = await ctx.ui.select("Per-session & compaction behavior:", [
					"Enable both per-session new chat & compaction handoff (Recommended)",
					"Enable per-session new chat only",
					"Enable compaction handoff only",
					"Manual only (/its-new and /its-compact)",
				]);
				if (modeChoice) {
					config = saveConfig({
						...config,
						autoNewChatPerSession:
							modeChoice.includes("Enable both") || modeChoice.includes("per-session new chat only"),
						autoCompactHandoff:
							modeChoice.includes("Enable both") || modeChoice.includes("compaction handoff only"),
					});
				}
				ctx.ui.notify(
					`Updated config: email=${config.email}, autoNewChat=${config.autoNewChatPerSession}, autoCompact=${config.autoCompactHandoff}`,
					"info",
				);
			} else if (choice.startsWith("4.")) {
				const st = await getCopilotStatus(config);
				const store = loadCookieStore();
				ctx.ui.notify(
					[
						`🔗 Copilot ITS Status`,
						`  Connected:  ${st.connected ? `🟢 yes (${st.mode})` : `🔴 no (${st.error || "disconnected"})`}`,
						`  Account:    ${st.email || config.email}`,
						`  UI Model:   ${st.activeModel || config.defaultModel}`,
						`  Chat ID:    ${st.conversationId || "-"}`,
						`  Cookies:    ${store?.cookies.length ?? 0} saved (${store?.savedAt || "never"})`,
						`  Quota:      ${formatQuotaSummary(st.throttlingInfo)}`,
					].join("\n"),
					st.connected ? "info" : "warning",
				);
			}
		},
	});

	// Command: /its-status
	pi.registerCommand("its-status", {
		description: "Show Copilot ITS connection status, active model, chat ID, and remaining quota",
		handler: async (_args, ctx) => {
			config = loadConfig();
			const st = await getCopilotStatus(config);
			const store = loadCookieStore();
			ctx.ui.notify(
				[
					`🔗 Copilot ITS Status`,
					`  Connected:  ${st.connected ? `🟢 yes (${st.mode})` : `🔴 no (${st.error || "disconnected"})`}`,
					`  Account:    ${st.email || config.email}`,
					`  UI Model:   ${st.activeModel || config.defaultModel}`,
					`  Chat ID:    ${st.conversationId || "-"}`,
					`  Cookies:    ${store?.cookies.length ?? 0} saved (${store?.savedAt || "never"})`,
					`  Quota:      ${formatQuotaSummary(st.throttlingInfo)}`,
				].join("\n"),
				st.connected ? "info" : "warning",
			);
		},
	});
}
