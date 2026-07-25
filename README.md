# AI Assisted Pen Testing

A cross-platform (Windows + Linux) Electron desktop chatbot that talks to an
AI model through **OpenRouter**, can inspect web pages (fetch raw HTML source
— no general browsing tool beyond that), and can open an **SSH connection to
a Linux machine as root** (`root@<ip_address>` — this is the only supported
login mode, there's no username field) and run **any shell command** on it —
with no whitelist — always with on-screen logging and a **mandatory**
confirmation prompt before the AI runs anything.

## Features

- **OpenRouter integration** — bring your own API key, pick any OpenRouter model id.
- **Editable system prompt** — change the AI's instructions any time in Settings.
- **SSH shell + AI command execution, root only** — click **SSH** to enter
  connection details: a server address (always logged in as `root@<address>`
  — this is the *only* supported login mode, there is no username field),
  port, and password *or* private key + passphrase, plus an optional
  **sudo password**. Once connected, the AI's `run_ssh_command` tool can
  request to run **any** command on that machine, as root — there is no
  whitelist. Every single AI-requested command pops an on-screen confirmation
  dialog showing the exact command before it runs; this cannot be disabled.
- **Sudo permission** — rarely needed since the login is already root, but if
  you set a sudo password in SSH Settings it's automatically (and only)
  typed in whenever the remote shell shows a `[sudo] password for ...:`
  prompt, so confirmed commands that need it can still complete.
- **SSH Terminal panel (view-only, resizable)** — a live, Linux-terminal-styled
  panel docked under the chat shows the actual SSH session: the commands the
  AI runs (after you approve them) and their real output. Each command is
  wrapped in a horizontal `────` rule line before it starts and another
  after it finishes (with its exit code), so it's easy to see where one
  command ends and the next begins. Drag the thin handle at the top of the
  panel up or down to resize it, or use the Collapse/Expand button. It's
  read-only — you can't type into it — and it does **not** appear in the
  System Console; SSH activity is only ever shown here.
- **Knowledge Base (local SQLite FTS5 search / RAG)** — click "Knowledge
  Base" to paste in reference text (with a title and optional source) or
  import a `.txt`/`.md`/`.log`/`.csv`/`.json` file. Documents are chunked
  into overlapping passages and indexed in a local SQLite FTS5 full-text
  index (`knowledge.db`, in the same app-data folder as `config.json`). The
  AI's `search_knowledge_base` tool queries that index and gets back the
  most relevant passages with a highlighted snippet — it's read-only, needs
  no confirmation dialog (nothing it touches leaves the local database), and
  is completely independent of `open_webpage` and `run_ssh_command`: no
  network calls, no SSH connection involved. The modal also has a "test a
  search" box that runs the exact same lookup so you can sanity-check what
  the AI would see.
- **Browser & page inspector** — click "Browser" to open a URL bar with a
  live embedded page view. "View Source" toggles to the page's raw HTML
  (fetched separately, not the rendered DOM). "Inspector / DevTools" opens
  Chrome DevTools attached to the embedded page. The AI also has an
  `open_webpage` tool for the same fetch-and-inspect behavior — separate from
  SSH, and blocked from reaching localhost/private network addresses.
- **System Console panel** — a live, timestamped log of web-page fetches and
  errors (SSH commands are intentionally excluded — see the SSH Terminal
  panel instead).
- **Plaintext chat history** — every chat is saved as a readable `.txt` file
  in its own folder (use "Open chats folder" in the sidebar), one message
  block per turn.
- **Code blocks** — AI responses render fenced code blocks with syntax
  formatting and a one-click "Copy" button.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (for `npm`).
- An [OpenRouter](https://openrouter.ai) account and API key.
- A Linux machine you're allowed to SSH into, if you want to use the SSH feature.

## Setup

```bash
npm install
npm start
```

`npm install` pulls in `ssh2` (SSH feature) and `better-sqlite3` (knowledge
base). `better-sqlite3` is a native module and must be compiled against
Electron's own Node ABI, not your system Node's — a `postinstall` script
(`electron-rebuild -f -w better-sqlite3`) handles this automatically every
time you run `npm install`, so no extra step is needed. If you ever see a
"knowledge base unavailable" message in-app, re-run `npm install` to redo
that rebuild (e.g. after switching Electron versions).

On first launch, click **Settings**, paste your OpenRouter API key, and
(optionally) change the model id (default: `openai/gpt-4o-mini`) and system
prompt. Click **SSH** to enter your SSH connection details and connect.

## Building installers

```bash
npm run build:win     # produces an NSIS installer for Windows
npm run build:linux   # produces an AppImage for Linux
```

## Where things are stored

Electron's per-user app-data folder (`app.getPath('userData')`):

- `config.json` — API key, model, system prompt, and SSH connection details
  (host/port/auth method/**password**/**sudo password** — login is always
  root, so there's no username to store).
- `chats/*.txt` — plaintext chat transcripts.
- `knowledge.db` — the SQLite FTS5 knowledge-base index (documents + chunks)
  used by the "Knowledge Base" panel and the `search_knowledge_base` tool.

On Linux this is typically `~/.config/cve-ai-assistant/`; on Windows it's
typically `%APPDATA%\cve-ai-assistant\`.

## SSH Console limitations

This app's SSH console is intentionally simple, and that simplicity comes
with real restrictions worth knowing about before you rely on it:

- **One shared interactive shell per connection, not one process per
  command.** When you connect, the app opens a single persistent
  shell/PTY channel and every AI-issued command is typed into that same
  shell, one after another — it does **not** open a fresh SSH exec channel
  per command. This keeps shell state (cwd, env vars, a sudo timestamp)
  between commands, but it also means commands are strictly serial: nothing
  else can run on that shell until the current command finishes, and a
  stuck command blocks everything queued behind it.
- **Every command has a timeout, and it isn't optional.** Because the app
  can't otherwise tell a command is "done" other than watching the shell
  for it, each command gets a timeout (configurable in SSH Settings,
  default 240s). If a command is still running when the timeout hits, the
  app sends Ctrl-C to interrupt it and gives up on that command — the
  command's own actual completion is never awaited past that point. Any
  command that legitimately needs longer than the configured timeout
  (a full `nmap -sV -sC`, a large file transfer, a slow compile, etc.)
  will be cut off. Raise the timeout or narrow the command if you expect it
  to run long.
- **No true background execution.** Because there's only one shell, you
  can't kick off a long scan and keep chatting while it runs in the
  background — the shell (and the AI) is blocked until that command
  returns or the timeout fires. Backgrounding a command yourself with `&`
  or `nohup` mostly defeats the app's own completion-detection, since it
  relies on a marker echoed after the command exits in the foreground.
- **Commands that wait for interactive input will hang until timeout.**
  Anything that prompts and waits (`ssh` to another box without `-o
  BatchMode=yes`, an interactive `apt` prompt, `mysql` with no query piped
  in, etc.) will sit there consuming the shell until the timeout fires and
  Ctrl-C is sent — there's no way for the app to detect "waiting for
  input" versus "still working" ahead of time.
- **Output is captured, not rendered as a real terminal.** The SSH panel is
  a view-only text log, not a full terminal emulator — it strips ANSI
  escape codes for readability rather than interpreting them, so anything
  that depends on cursor positioning, live redraws, or colors (progress
  bars, `top`, `htop`, a text editor like `vim`/`nano`, etc.) will not
  display or behave correctly. Stick to commands that produce plain,
  linear output.
- **No command whitelist, and always root.** See below — this isn't a
  restriction on what the AI *can* run, quite the opposite: there's nothing
  stopping it from running anything, with full root privileges. The
  confirmation dialog is the only gate.

## Project structure

```
cve-ai-assistant/
├─ package.json
├─ main.js        # Electron main process: IPC, SSH connection + command exec, OpenRouter calls, chat storage
├─ kb.js           # SQLite FTS5 knowledge base (chunking, indexing, search) — used by main.js
├─ preload.js      # contextBridge — the only API surface exposed to the renderer
└─ src/
   ├─ index.html
   ├─ style.css
   └─ renderer.js  # UI logic
```
