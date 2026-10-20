import {
	COOKIES_PATH,
	loadConfig,
	loadCookieStore,
	parseSubmittedCookies,
	saveConfig,
	saveCookieStore,
} from "./config.js";
import {
	ensureStandaloneChromium,
	exportAndSaveCookies,
	getCopilotStatus,
	startNewCopilotChat,
	switchCopilotModelInUi,
} from "./cdp.js";
import { COPILOT_ITS_MODELS } from "./models.js";

export interface RunningSetupServer {
	url: string;
	port: number;
	stop: () => void;
}

let activeServer: RunningSetupServer | null = null;

export async function startSetupServer(
	portOverride?: number,
	onEvent?: (msg: string) => void,
): Promise<RunningSetupServer> {
	if (activeServer) {
		return activeServer;
	}

	const cfg = loadConfig();
	const desiredPort = portOverride ?? cfg.setupServerPort ?? 19224;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: desiredPort,
		async fetch(req) {
			const url = new URL(req.url);
			const corsHeaders: Record<string, string> = {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type, Authorization",
			};

			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders });
			}

			if (url.pathname === "/status" && req.method === "GET") {
				const currentConfig = loadConfig();
				const status = await getCopilotStatus(currentConfig);
				const store = loadCookieStore();
				return Response.json(
					{
						status,
						config: currentConfig,
						cookieStore: {
							path: COOKIES_PATH,
							savedAt: store?.savedAt ?? null,
							count: store?.cookies.length ?? 0,
						},
						models: COPILOT_ITS_MODELS,
					},
					{ headers: corsHeaders },
				);
			}

			if (url.pathname === "/callback") {
				try {
					let rawCookiesInput = url.searchParams.get("cookies") || "";
					let emailInput = url.searchParams.get("email") || "";
					if (req.method === "POST") {
						const bodyText = await req.text();
						try {
							const parsed: unknown = JSON.parse(bodyText);
							if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
								if ("email" in parsed && typeof parsed.email === "string") {
									emailInput = parsed.email;
								}
								if ("cookies" in parsed && typeof parsed.cookies === "string") {
									rawCookiesInput = parsed.cookies;
								} else {
									rawCookiesInput = bodyText;
								}
							} else {
								rawCookiesInput = bodyText;
							}
						} catch {
							rawCookiesInput = bodyText;
						}
					}

					const currentConfig = loadConfig();
					const parsedCookies = parseSubmittedCookies(rawCookiesInput);
					if (parsedCookies.length === 0) {
						return Response.json(
							{
								ok: false,
								error: "No valid cookies found in payload. Provide a Cookie header or JSON array.",
							},
							{ status: 400, headers: corsHeaders },
						);
					}

					const email = emailInput.trim() || currentConfig.email;
					if (email !== currentConfig.email) {
						saveConfig({ ...currentConfig, email });
					}

					const savedCount = saveCookieStore({
						savedAt: new Date().toISOString(),
						email,
						copilotUrl: currentConfig.copilotUrl,
						cookies: parsedCookies,
					});

					onEvent?.(`Saved ${savedCount} cookies for ${email} via localhost callback.`);
					return Response.json(
						{
							ok: true,
							savedCookies: savedCount,
							email,
							path: COOKIES_PATH,
						},
						{ headers: corsHeaders },
					);
				} catch (err) {
					return Response.json(
						{
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						},
						{ status: 500, headers: corsHeaders },
					);
				}
			}

			if (url.pathname === "/capture" && req.method === "POST") {
				try {
					const currentConfig = loadConfig();
					const res = await exportAndSaveCookies(currentConfig);
					onEvent?.(`Captured ${res.count} cookies from active browser session (${res.email}).`);
					return Response.json({ ok: true, ...res, path: COOKIES_PATH }, { headers: corsHeaders });
				} catch (err) {
					return Response.json(
						{
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						},
						{ status: 500, headers: corsHeaders },
					);
				}
			}

			if (url.pathname === "/autologin" && req.method === "POST") {
				try {
					const bodyText = await req.text();
					let emailOverride = "";
					let spawnHeaded = false;
					if (bodyText) {
						try {
							const parsed: unknown = JSON.parse(bodyText);
							if (parsed && typeof parsed === "object") {
								if ("email" in parsed && typeof parsed.email === "string") {
									emailOverride = parsed.email.trim();
								}
								if ("headed" in parsed && typeof parsed.headed === "boolean") {
									spawnHeaded = parsed.headed;
								}
							}
						} catch {}
					}

					let currentConfig = loadConfig();
					if (emailOverride && emailOverride !== currentConfig.email) {
						currentConfig = saveConfig({ ...currentConfig, email: emailOverride });
					}
					if (spawnHeaded) {
						await ensureStandaloneChromium(currentConfig, true);
					}
					const res = await exportAndSaveCookies(currentConfig);
					onEvent?.(`Autologin & cookie capture finished for ${res.email} (${res.count} cookies).`);
					return Response.json({ ok: true, ...res }, { headers: corsHeaders });
				} catch (err) {
					return Response.json(
						{
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						},
						{ status: 500, headers: corsHeaders },
					);
				}
			}

			if (url.pathname === "/model" && req.method === "POST") {
				try {
					const bodyText = await req.text();
					const parsed = JSON.parse(bodyText) as { model?: string };
					const targetModel = parsed.model || "gpt-6.1-sol";
					const switched = await switchCopilotModelInUi(targetModel);
					const currentConfig = loadConfig();
					saveConfig({ ...currentConfig, defaultModel: switched.modelId });
					onEvent?.(`Switched Copilot ITS model to ${switched.uiLabel} (${switched.modelId}).`);
					return Response.json({ ok: true, ...switched }, { headers: corsHeaders });
				} catch (err) {
					return Response.json(
						{
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						},
						{ status: 500, headers: corsHeaders },
					);
				}
			}

			if (url.pathname === "/new-chat" && req.method === "POST") {
				try {
					const res = await startNewCopilotChat();
					onEvent?.(`Started new Copilot chat (${res.conversationId || "ready"}).`);
					return Response.json({ ok: true, ...res }, { headers: corsHeaders });
				} catch (err) {
					return Response.json(
						{
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						},
						{ status: 500, headers: corsHeaders },
					);
				}
			}

			// Default: Serve interactive HTML dashboard
			const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OMP Copilot-ITS Setup & Cookie Callback Server</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --success: #3fb950;
    --danger: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    max-width: 860px;
    margin-inline: auto;
  }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p.sub { color: var(--muted); margin: 0 0 24px; font-size: 14px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
    margin-bottom: 18px;
  }
  .card h2 { font-size: 15px; margin: 0 0 12px; color: var(--accent); }
  .grid { display: grid; grid-template-columns: 160px 1fr; gap: 8px 14px; font-size: 13px; }
  .label { color: var(--muted); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
  button, select, input, textarea {
    background: #0d1117;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    font-family: inherit;
    font-size: 13px;
  }
  button {
    cursor: pointer;
    background: #21262d;
    font-weight: 600;
  }
  button.primary { background: #1f6feb; border-color: #388bfd; }
  button:hover { filter: brightness(1.15); }
  textarea { width: 100%; min-height: 110px; resize: vertical; }
  pre#log {
    background: #090c10;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    font-size: 12px;
    overflow-x: auto;
    white-space: pre-wrap;
  }
</style>
</head>
<body>
  <h1>⚡ OMP Copilot-ITS Setup & Cookie Server</h1>
  <p class="sub">Callback endpoint: <code>http://127.0.0.1:${desiredPort}/callback</code></p>

  <div class="card">
    <h2>Live Status & Quota</h2>
    <div id="status-grid" class="grid">Loading...</div>
    <div class="row">
      <button class="primary" onclick="captureFromRelay()">Capture Cookies from Active Browser/Relay</button>
      <button onclick="runAutoLogin(false)">Auto-Login (${cfg.email})</button>
      <button onclick="runAutoLogin(true)">Spawn Headed Browser & Login</button>
      <button onclick="newChat()">Start New Copilot Chat</button>
      <button onclick="refreshStatus()">Refresh Status</button>
    </div>
  </div>

  <div class="card">
    <h2>Switch Model</h2>
    <div class="row">
      <select id="model-select"></select>
      <button class="primary" onclick="changeModel()">Switch Active Model</button>
    </div>
  </div>

  <div class="card">
    <h2>Paste / POST Cookies (<code>POST /callback</code>)</h2>
    <div class="row" style="margin-bottom: 10px;">
      <input id="email-input" style="flex:1" placeholder="5054251028@student.its.ac.id" value="${cfg.email}" />
    </div>
    <textarea id="cookie-input" placeholder='Paste raw Cookie: header or JSON cookie array [{"name":"...","value":"...","domain":".cloud.microsoft"}]'></textarea>
    <div class="row">
      <button class="primary" onclick="submitCookies()">Save Cookies to ~/.omp/agent/copilot-its-cookies.json</button>
    </div>
  </div>

  <div class="card">
    <h2>Output Log</h2>
    <pre id="log">Ready.</pre>
  </div>

<script>
async function refreshStatus() {
  const res = await fetch('/status');
  const data = await res.json();
  const s = data.status || {};
  const c = data.cookieStore || {};
  const m = s.throttlingInfo?.metering || {};
  const solDaily = m.GPT61SolQueryDaily?.remainingAllowance ?? '?';
  const solWeekly = m.GPT61SolQueryWeekly?.remainingAllowance ?? '?';
  const turnsUsed = s.throttlingInfo?.numUserMessagesInConversation ?? s.turnCount ?? 0;
  const turnsMax = s.throttlingInfo?.maxNumUserMessagesInConversation ?? 600;

  document.getElementById('status-grid').innerHTML = [
    ['Connection', s.connected ? '🟢 Connected (' + s.mode + ')' : '🔴 Disconnected (' + (s.error || '') + ')'],
    ['Account', s.email || data.config?.email || '-'],
    ['Active UI Model', s.activeModel || data.config?.defaultModel || '-'],
    ['Conversation ID', s.conversationId || '-'],
    ['Turn Count', turnsUsed + ' / ' + turnsMax],
    ['GPT-6.1 Sol Quota', solDaily + ' daily / ' + solWeekly + ' weekly remaining'],
    ['Saved Cookies', c.count + ' cookies (' + (c.savedAt || 'never') + ')'],
  ].map(([k, v]) => '<div class="label">' + k + '</div><div>' + v + '</div>').join('');

  const sel = document.getElementById('model-select');
  if (sel.options.length === 0 && Array.isArray(data.models)) {
    for (const mod of data.models) {
      const opt = document.createElement('option');
      opt.value = mod.id;
      opt.textContent = mod.uiLabel + ' (' + mod.id + ') — ' + mod.description;
      if (s.activeModel === mod.uiLabel || data.config?.defaultModel === mod.id) opt.selected = true;
      sel.appendChild(opt);
    }
  }
}

function setLog(obj) {
  document.getElementById('log').textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

async function captureFromRelay() {
  setLog('Capturing cookies from active browser session...');
  const res = await fetch('/capture', { method: 'POST' });
  setLog(await res.json());
  await refreshStatus();
}

async function runAutoLogin(headed) {
  const email = document.getElementById('email-input').value;
  setLog('Running autologin for ' + email + '...');
  const res = await fetch('/autologin', {
    method: 'POST',
    body: JSON.stringify({ email, headed })
  });
  setLog(await res.json());
  await refreshStatus();
}

async function changeModel() {
  const model = document.getElementById('model-select').value;
  setLog('Switching model to ' + model + '...');
  const res = await fetch('/model', {
    method: 'POST',
    body: JSON.stringify({ model })
  });
  setLog(await res.json());
  await refreshStatus();
}

async function newChat() {
  setLog('Starting new Copilot chat...');
  const res = await fetch('/new-chat', { method: 'POST' });
  setLog(await res.json());
  await refreshStatus();
}

async function submitCookies() {
  const email = document.getElementById('email-input').value;
  const cookies = document.getElementById('cookie-input').value;
  const res = await fetch('/callback', {
    method: 'POST',
    body: JSON.stringify({ email, cookies })
  });
  setLog(await res.json());
  await refreshStatus();
}

refreshStatus();
</script>
</body>
</html>`;

			return new Response(html, {
				headers: {
					...corsHeaders,
					"Content-Type": "text/html; charset=utf-8",
				},
			});
		},
	});

	const actualPort = server.port ?? desiredPort;
	activeServer = {
		url: `http://127.0.0.1:${actualPort}`,
		port: actualPort,
		stop: () => {
			server.stop(true);
			activeServer = null;
		},
	};
	return activeServer;
}
