# omp-copilot-its

Microsoft 365 Copilot Chat (`copilot-its`) provider & session manager extension for `omp` (`oh-my-pi`).

Drives Microsoft 365 Copilot Chat (ITS student cloud mail) over a **dedicated headless browser** (`standalone-chromium` by default or [Obscura](https://github.com/h4ckf0r0day/obscura), plus optional `omp browser-relay` cookie sync) so it never hijacks your visible browser, and exposes Copilot's models as a native `omp` provider with full local tool-calling (`omp_tool_calls`), per-session chat isolation, and automatic compaction handoff.
## Features

- **`copilot-its` Provider (`streamSimple`):**
  - `copilot-its/gpt-6.1-sol` (`GPT-6.1 Sol`)
  - `copilot-its/gpt-6` (`GPT-6`)
  - `copilot-its/gpt-5.6-sol-think` (`GPT-5.6 Sol Think deeper`)
  - `copilot-its/gpt-5.6-sol-quick` (`GPT-5.6 Sol Quick response`)
  - `copilot-its/auto` (`Auto`)
  - `copilot-its/think-deeper` (`Think deeper`)
  - `copilot-its/quick-response` (`Quick response`)
- **Live Quota Reporting (`UsageProvider`):**
  - Reads `throttlingInfo.metering` (`GPT61SolQueryDaily`, `GPT61SolQueryWeekly`, etc.) from Copilot's React fiber and surfaces quota usage to `omp`.
- **Slash Commands:**
  - `/its-model [name]` — Switch the Copilot UI model picker (e.g. `/its-model sol 6.1`) and set `omp`'s active model to `copilot-its/<id>`.
  - `/its-setup [server|capture|status]` — Launch the localhost cookie/callback server (`http://127.0.0.1:19224` & `POST /callback`), run Microsoft autologin (`5054251028@student.its.ac.id`), or capture cookies from `omp browser-relay`.
  - `/its-new [prompt]` — Start a fresh Copilot Chat (`New chat`) for the active session.
  - `/its-compact [focus]` — Summarize the active conversation, rotate to a new Copilot Chat, and seed the summary into the new session.
  - `/its-status` — Inspect live connection mode, active UI model, conversation ID, saved cookie count, and quota allowances.
  - `/its-setup [chromium|obscura|relay|capture|server|status]` — Switch headless backend (`standalone-chromium`, `obscura`, or `relay`), capture cookies from `omp browser-relay` into the headless profile, or launch the localhost callback server (`http://127.0.0.1:19224` & `POST /callback`).
