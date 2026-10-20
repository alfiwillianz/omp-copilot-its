export interface CopilotItsModelDef {
	id: string;
	name: string;
	uiLabel: string;
	submenu: "GPT" | null;
	description: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	aliases: string[];
}

export const COPILOT_ITS_MODELS: CopilotItsModelDef[] = [
	{
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol (Copilot ITS)",
		uiLabel: "GPT-6.1 Sol",
		submenu: "GPT",
		description: "OpenAI GPT-6.1 Sol via Microsoft 365 Copilot",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
		aliases: ["sol 6.1", "sol-6.1", "gpt-6.1", "6.1", "sol"],
	},
	{
		id: "gpt-6",
		name: "GPT-6 (Copilot ITS)",
		uiLabel: "GPT-6",
		submenu: "GPT",
		description: "OpenAI GPT-6 via Microsoft 365 Copilot",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
		aliases: ["gpt6", "6"],
	},
	{
		id: "gpt-5.6-sol-think",
		name: "GPT-5.6 Sol Think deeper (Copilot ITS)",
		uiLabel: "GPT-5.6 Sol Think deeper",
		submenu: "GPT",
		description: "OpenAI GPT-5.6 Sol (Think deeper) via Microsoft 365 Copilot",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
		aliases: ["sol 5.6 think", "5.6 think", "gpt-5.6-think"],
	},
	{
		id: "gpt-5.6-sol-quick",
		name: "GPT-5.6 Sol Quick response (Copilot ITS)",
		uiLabel: "GPT-5.6 Sol Quick response",
		submenu: "GPT",
		description: "OpenAI GPT-5.6 Sol (Quick response) via Microsoft 365 Copilot",
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_384,
		aliases: ["sol 5.6 quick", "5.6 quick", "gpt-5.6-quick", "sol 5.6", "5.6"],
	},
	{
		id: "auto",
		name: "Copilot Auto (Copilot ITS)",
		uiLabel: "Auto",
		submenu: null,
		description: "Decides how long to think automatically",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
		aliases: ["default"],
	},
	{
		id: "think-deeper",
		name: "Copilot Think deeper (Copilot ITS)",
		uiLabel: "Think deeper",
		submenu: null,
		description: "Think longer for better answers",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
		aliases: ["think", "deeper"],
	},
	{
		id: "quick-response",
		name: "Copilot Quick response (Copilot ITS)",
		uiLabel: "Quick response",
		submenu: null,
		description: "Answers right away",
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_384,
		aliases: ["quick", "fast"],
	},
];

export function resolveCopilotModel(query: string): CopilotItsModelDef | undefined {
	const q = query
		.trim()
		.toLowerCase()
		.replace(/^copilot-its\//, "");
	if (!q) return undefined;

	for (const m of COPILOT_ITS_MODELS) {
		if (
			m.id.toLowerCase() === q ||
			m.uiLabel.toLowerCase() === q ||
			m.aliases.some(a => a.toLowerCase() === q)
		) {
			return m;
		}
	}

	for (const m of COPILOT_ITS_MODELS) {
		if (
			m.id.toLowerCase().includes(q) ||
			m.uiLabel.toLowerCase().includes(q) ||
			m.aliases.some(a => a.toLowerCase().includes(q) || q.includes(a.toLowerCase()))
		) {
			return m;
		}
	}

	return undefined;
}
