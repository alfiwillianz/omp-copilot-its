# omp-copilot-its

Microsoft 365 Copilot Chat (`copilot-its`) provider & session manager extension for `omp` (`oh-my-pi`).

Drives Microsoft 365 Copilot Chat (ITS student cloud mail) over a **dedicated headless browser** (`standalone-chromium` by default or [Obscura](https://github.com/h4ckf0r0day/obscura), plus optional `omp browser-relay` cookie sync) so it never hijacks your visible browser, and exposes Copilot's models as a native `omp` provider with full local tool-calling (`omp_tool_calls`), per-session chat isolation, and automatic compaction handoff.

## Quickstart

### 1. Install the Extension

**Option A — Install as an `omp` plugin (recommended):**
```bash
omp plugin install git+https://github.com/alfiwillianz/omp-copilot-its.git
```
This clones the package into `~/.omp/plugins/node_modules/omp-copilot-its` and registers it in `omp-plugins.lock.json`. Restart `omp` (or `/reload-plugins`) to pick it up. No local checkout or personal path required.

Verify it loaded:
```bash
omp plugin list          # should list omp-copilot-its
omp --model copilot-its/gpt-6.1-sol -p "Reply with ONLY: OK"
```

**Option B — Link a local clone (for development):**
```bash
git clone https://github.com/alfiwillianz/omp-copilot-its.git
cd omp-copilot-its
omp plugin link .
```
`omp plugin link` symlinks the working tree into `~/.omp/plugins/node_modules`, so edits apply on the next session.

**Option C — Load a single module via config:**
```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/.omp/plugins/node_modules/omp-copilot-its/extensions/copilot-its.ts
```

---

### 2. Authenticate & Save Cookies (One-Time Setup)

`omp-copilot-its` stores your Microsoft 365 / Outlook session cookies in `~/.omp/agent/copilot-its-cookies.json` and runs a persistent headless browser profile in `~/.omp/agent/copilot-its-profile`.

Inside `omp`, run:
```text
/its-setup
```
Or choose one of the direct setup flows:

- **Capture from active `omp browser-relay` (fastest if already logged in on Chrome):**
  1. Start the relay in a terminal: `omp browser-relay`
  2. In `omp`, run:
     ```text
     /its-setup capture
     ```
     This logs into your ITS Microsoft account (if needed), navigates to Copilot Chat, exports all Microsoft/Outlook cookies to `~/.omp/agent/copilot-its-cookies.json`, and syncs them into the headless browser profile.

- **Use the Localhost Setup & Cookie Callback Server (`http://127.0.0.1:19224`):**
  ```text
  /its-setup server
  ```
  Open `http://127.0.0.1:19224` in your browser to:
  - Click **Spawn Headed Browser & Login** or **Auto-Login**, or
  - Paste a raw `Cookie:` header / JSON cookie array, or POST directly to `http://127.0.0.1:19224/callback`:
    ```bash
    curl -X POST http://127.0.0.1:19224/callback \
      -H "Content-Type: application/json" \
      -d '{"email":"5054251028@student.its.ac.id","cookies":"Cookie: ..."}'
    ```

---

### 3. Switch Models & Run

**Interactive TUI:**
```text
/its-model sol 6.1
```
(Or run `/its-model` with no arguments to open the interactive model picker with live daily/weekly quota info, or use `omp`'s built-in `/model copilot-its/gpt-6.1-sol`.)

**CLI one-shot / non-interactive:**
```bash
omp --model copilot-its/gpt-6.1-sol -p "Explain how this repo works"
```

**Set as default or role model in `~/.omp/agent/config.yml`:**
```yaml
modelRoles:
  default: copilot-its/gpt-6.1-sol
  slow: copilot-its/gpt-6.1-sol
  smol: copilot-its/gpt-5.6-sol-quick
```

---

## Available Models (`copilot-its/*`)

| Model ID | Copilot UI Option | Aliases for `/its-model` | Reasoning |
|---|---|---|---|
| `copilot-its/gpt-6.1-sol` | `GPT` → `GPT-6.1 Sol` | `sol 6.1`, `6.1`, `sol` | Yes |
| `copilot-its/gpt-6` | `GPT` → `GPT-6` | `gpt6`, `6` | Yes |
| `copilot-its/gpt-5.6-sol-think` | `GPT` → `GPT-5.6 Sol Think deeper` | `5.6 think`, `sol 5.6 think` | Yes |
| `copilot-its/gpt-5.6-sol-quick` | `GPT` → `GPT-5.6 Sol Quick response` | `5.6 quick`, `sol 5.6` | No |
| `copilot-its/auto` | `Auto` | `auto`, `default` | Yes |
| `copilot-its/think-deeper` | `Think deeper` | `think`, `deeper` | Yes |
| `copilot-its/quick-response` | `Quick response` | `quick`, `fast` | No |

---

## Slash Commands

| Command | Description |
|---|---|
| `/its-model [query]` | Switch the Copilot UI model picker (e.g. `/its-model sol 6.1`) and set `omp`'s active model to `copilot-its/<id>`. |
| `/its-setup [action]` | Interactive setup wizard, or pass `capture`, `server`, `chromium`, `obscura`, `relay`, or `status`. |
| `/its-new [prompt]` | Click `New chat` in Copilot to start a fresh conversation for the current session (and optionally send `[prompt]`). |
| `/its-compact [focus]` | Ask Copilot to summarize the current conversation, start a brand-new Copilot Chat, and seed the summary into the new chat. |
| `/its-status` | Display active backend (`standalone-chromium` / `obscura` / `relay`), account, UI model, `conversationId`, cookie count, and remaining daily/weekly quota. |

---

## Headless Browser Backends

Switch backends anytime via `/its-setup`:

- **`/its-setup chromium`** *(Default)* — Runs a dedicated headless Chromium (`--headless=new`) on `127.0.0.1:19225` with persistent profile `~/.omp/agent/copilot-its-profile` and automatic cookie injection from `~/.omp/agent/copilot-its-cookies.json`. Never touches your visible browser.
- **`/its-setup obscura`** — Automatically downloads [Obscura](https://github.com/h4ckf0r0day/obscura) (`obscura-x86_64-linux.tar.gz`) to `~/.omp/agent/bin/obscura` and runs `obscura serve --port 19226 --stealth`.
- **`/its-setup relay`** — Drives your active Chrome session via `omp browser-relay` (`ws://127.0.0.1:9224/cdp`).

---

## Per-Session Isolation & Compaction Handoff

- **Per-Session Chat (`session_start` / `session_switch`):** Each new `omp` session automatically starts a fresh Copilot Chat (`New chat`) and persists its `conversationId` in the session journal.
- **Compaction Handoff (`session_compact` & `/its-compact`):** When `omp` compacts context (via `/compact` or auto-compaction), `omp-copilot-its` automatically opens a new Copilot Chat and seeds the compaction summary so long coding sessions never hit Copilot turn/context limits.

---

## Configuration & Files

- `~/.omp/agent/copilot-its-config.json` — Saved settings (`email`, `defaultModel`, `browserBackend`, ports, flags).
- `~/.omp/agent/copilot-its-cookies.json` — Exported Microsoft/Outlook cookies (`0600` permissions).
- `~/.omp/agent/copilot-its-profile/` — Persistent Chromium profile directory for the headless backend.
- `~/.omp/agent/bin/obscura` — Installed Obscura binary (when using `/its-setup obscura`).

**Environment variable overrides:**
- `COPILOT_ITS_EMAIL` — Default Microsoft/ITS email (`5054251028@student.its.ac.id`)
- `COPILOT_ITS_MODEL` — Default model ID (`gpt-6.1-sol`)
- `COPILOT_ITS_BACKEND` — `standalone-chromium` | `obscura` | `relay`
- `COPILOT_ITS_SETUP_PORT` — Localhost callback server port (default `19224`)
- `COPILOT_ITS_STANDALONE_PORT` — Standalone headless CDP port (default `19225`)
