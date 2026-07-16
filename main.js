// main.js — Electron main process
'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client: SSHClient } = require('ssh2');

// ---------------------------------------------------------------------------
// Paths / storage setup
// ---------------------------------------------------------------------------
const USER_DATA = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA, 'config.json');
const CHATS_DIR = path.join(USER_DATA, 'chats');
const CONSOLE_LOG_PATH = path.join(USER_DATA, 'console-log.jsonl');
const MAX_CONSOLE_ENTRIES = 500;

if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true });

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful desktop assistant for a school cybersecurity project. ' +
  'You have two tools available: open_webpage (to fetch a web page\'s raw HTML source, title, and status — ' +
  'use this when asked to inspect, open, or view the source of a specific URL), ' +
  'and run_ssh_command (to run a shell command, as root, on a Linux machine the user has connected to over ' +
  'SSH — the connection always logs in as root, so sudo is never required). ' +
  'There is no command whitelist for run_ssh_command — you may be asked to run, or may propose, any command, ' +
  'but every single command always requires the user\'s explicit on-screen confirmation before it runs, and ' +
  'the tool will fail if no SSH connection is currently open. Because you are always root, be extra careful ' +
  'with destructive or irreversible commands (e.g. deleting files, changing permissions, package removal, ' +
  'modifying system config) — explain what a command or page fetch will do before using it, and keep answers ' +
  'clear and educational. Format code or terminal output using fenced code blocks.';

function defaultConfig() {
  return {
    apiKey: '',
    model: 'openai/gpt-4o-mini',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    // SSH connection details (used to pre-fill the SSH Settings dialog and to reconnect).
    // Login is always root@sshHost — there is no username field.
    sshHost: '',
    sshPort: 22,
    sshAuthMethod: 'password', // 'password' | 'key'
    sshPassword: '',
    sshPrivateKeyPath: '',
    sshPassphrase: '',
    sudoPassword: '',
    // How long to wait for a single SSH command before giving up on it.
    // 45s is fine for quick commands but far too short for things like
    // `nmap -sV -sC` (version detection + default scripts routinely takes
    // 1-5+ minutes per host), so this is user-configurable with a much
    // more realistic default.
    sshCommandTimeoutSec: 240
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return Object.assign(defaultConfig(), JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    }
  } catch (e) { /* fall through to default */ }
  return defaultConfig();
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  sshDisconnect();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('before-quit', () => {
  sshDisconnect();
});

function logConsole(entry) {
  // entry: { type: 'command'|'info'|'error'|'web_fetch', title, detail, time }
  // NOTE: SSH activity is intentionally never logged here — it only ever
  // appears in the SSH Terminal panel. See executeToolCall('run_ssh_command').
  entry.time = entry.time || new Date().toISOString();
  appendConsoleLogToDisk(entry);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('console:log', entry);
  }
}

function loadConsoleLogFromDisk() {
  if (!fs.existsSync(CONSOLE_LOG_PATH)) return [];
  try {
    const lines = fs.readFileSync(CONSOLE_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    return lines.map(l => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function appendConsoleLogToDisk(entry) {
  try {
    fs.appendFileSync(CONSOLE_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
    // Periodically trim the file so it doesn't grow without bound.
    const entries = loadConsoleLogFromDisk();
    if (entries.length > MAX_CONSOLE_ENTRIES) {
      const trimmed = entries.slice(entries.length - MAX_CONSOLE_ENTRIES);
      fs.writeFileSync(CONSOLE_LOG_PATH, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    }
  } catch (e) { /* non-fatal */ }
}

ipcMain.handle('console:history', () => loadConsoleLogFromDisk());
ipcMain.handle('console:clear', () => {
  try { fs.writeFileSync(CONSOLE_LOG_PATH, '', 'utf8'); } catch (e) { /* non-fatal */ }
  return true;
});

// ---------------------------------------------------------------------------
// Config IPC
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (evt, cfg) => {
  const current = loadConfig();
  const merged = Object.assign(current, cfg);
  saveConfig(merged);
  return merged;
});

// ---------------------------------------------------------------------------
// Human-confirmation requests for AI-initiated SSH commands.
// Confirmation is mandatory — there is no setting to disable it, since there
// is no whitelist to fall back on for safety.
// ---------------------------------------------------------------------------
const pendingConfirmations = new Map();

ipcMain.on('command:confirm-response', (evt, { requestId, approved }) => {
  const resolver = pendingConfirmations.get(requestId);
  if (resolver) {
    resolver(approved);
    pendingConfirmations.delete(requestId);
  }
});

function requestUserConfirmation(details) {
  const requestId = crypto.randomBytes(6).toString('hex');
  return new Promise((resolve) => {
    pendingConfirmations.set(requestId, resolve);
    mainWindow.webContents.send('command:confirm-request', { requestId, ...details });
  });
}

// ---------------------------------------------------------------------------
// SSH: connection + persistent interactive shell + AI command execution
// ---------------------------------------------------------------------------
// Root login is the only supported mode — see sshConnect(). There is no
// username field anywhere in the UI; every connection is root@<host>.
const SSH_ROOT_USER = 'root';

let sshConn = null;
let sshStream = null;
let sshConnected = false;
let sshInfo = null; // { host, port, username: 'root' }
let activeSshCapture = null; // { marker, buffer, resolve, reject, timeoutHandle }

// Strip ANSI escape / control sequences so the "view only" terminal panel
// shows clean, readable text instead of raw escape codes.
//
// NOTE: the previous version of this regex used the same nested/overlapping
// quantifier shape as the old vulnerable `ansi-regex` package (CVE-2021-3807)
// — it could hit catastrophic backtracking on certain escape sequences.
// Fancy shell prompts (e.g. Kali's default powerline-style zsh theme) chain
// a lot of SGR/CSI codes per line, and long-running commands like
// `nmap -sV -sC` redraw progress lines through a PTY constantly, so this
// regex was running, and potentially pathologically backtracking, on every
// single chunk of output — synchronously, on Node's one event-loop thread.
// That doesn't just make the app feel slow: it can stall reading off the
// SSH channel entirely, which creates backpressure that makes the *remote*
// shell's writes block too, so the command genuinely takes longer end-to-end
// than the same command typed directly at the console (where none of this
// JS parsing exists in the loop).
// These two patterns split CSI and OSC sequences with bounded, unambiguous
// character classes so there's no ambiguous backtracking possible. CSI_RE
// follows the real ANSI/ECMA-48 structure (parameter bytes 0x30-0x3F,
// intermediate bytes 0x20-0x2F, final byte 0x40-0x7E) rather than assuming
// parameters are only digits/semicolons — the previous version missed DEC
// private-mode sequences like `ESC[?1h` / `ESC[?2004h` (cursor-key mode,
// bracketed-paste mode, sent by the shell whenever it redraws the prompt),
// which is exactly what was showing up as corrupted "?[?1h?=?[?2004h"-style
// junk at an idle prompt.
const CSI_RE = /[\u001B\u009B]\[[0-?]*[ -\/]*[@-~]/g;
const OSC_RE = /[\u001B\u009B]\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
// Standalone (non-bracketed) escapes like ESC= / ESC> (DECKPAM/DECKPNM,
// application vs. numeric keypad mode) — also part of that same junk.
const ESC_SINGLE_RE = /\u001B[=>]/g;
function stripAnsi(str) {
  return String(str).replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC_SINGLE_RE, '');
}

function broadcastSshStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ssh:status', { connected: sshConnected, info: sshInfo });
  }
}

function broadcastSshData(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ssh:data', text);
  }
}

function attachStreamHandlers(stream) {
  let recentTail = '';
  const onChunk = (data) => {
    const raw = data.toString('utf8');
    const clean = stripAnsi(raw);

    // Auto-answer a sudo password prompt if one is configured. (Rarely
    // needed since the session already logs in as root, but harmless.)
    recentTail = (recentTail + clean).slice(-500);
    const cfg = loadConfig();
    if (cfg.sudoPassword && /\[sudo\] password for [^:]+:\s*$/.test(recentTail)) {
      recentTail = '';
      stream.write(cfg.sudoPassword + '\n');
    }

    if (activeSshCapture) {
      // While an AI command is running, hold its raw output back — we
      // render one clean, ruled-off block for it once it completes,
      // instead of interleaving marker/echo noise into the live view.
      const cap = activeSshCapture;
      const prevLen = cap.buffer.length;
      cap.buffer += clean;
      // Only search the region that could possibly contain a *new* match:
      // everything already scanned before is guaranteed marker-free, so
      // there's no need to re-run a regex over the whole (potentially large,
      // for verbose scans) buffer on every single incoming chunk.
      const searchFrom = Math.max(0, prevLen - cap.marker.length - 8);
      const m = cap.buffer.slice(searchFrom).match(cap.markerRe);
      if (m) {
        activeSshCapture = null;
        clearTimeout(cap.timeoutHandle);
        const idx = cap.buffer.indexOf(cap.marker);
        let output = cap.buffer.slice(0, idx);
        // Drop the first line, which is just the echoed input command.
        const firstNl = output.indexOf('\n');
        if (firstNl !== -1) output = output.slice(firstNl + 1);
        output = output.replace(/\r/g, '').trim();
        const exitCode = parseInt(m[1], 10);
        broadcastSshData(`${output ? output + '\n' : ''}■ exit code ${exitCode}\n`);
        cap.resolve({ exitCode, output });
      }
    } else {
      // No AI command in flight — mirror raw shell activity live (banner,
      // MOTD, prompt, etc.) straight through to the terminal panel.
      broadcastSshData(clean);
    }
  };
  stream.on('data', onChunk);
  if (stream.stderr) stream.stderr.on('data', onChunk);

  stream.on('close', () => {
    sshConnected = false;
    sshStream = null;
    sshInfo = null;
    broadcastSshStatus();
  });
}

function sshConnect(details) {
  return new Promise((resolve, reject) => {
    sshDisconnect();

    const conn = new SSHClient();
    const connectOpts = {
      host: details.host,
      port: details.port || 22,
      username: SSH_ROOT_USER,
      readyTimeout: 15000,
      keepaliveInterval: 15000
    };

    if (details.authMethod === 'key') {
      try {
        connectOpts.privateKey = fs.readFileSync(details.privateKeyPath, 'utf8');
      } catch (e) {
        reject(new Error(`Could not read private key file: ${e.message}`));
        return;
      }
      if (details.passphrase) connectOpts.passphrase = details.passphrase;
    } else {
      connectOpts.password = details.password;
    }

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 120, rows: 34 }, (err, stream) => {
        if (err) {
          reject(err);
          try { conn.end(); } catch (e2) { /* ignore */ }
          return;
        }
        sshConn = conn;
        sshStream = stream;
        sshConnected = true;
        sshInfo = { host: details.host, port: details.port || 22, username: SSH_ROOT_USER };
        attachStreamHandlers(stream);
        broadcastSshStatus();
        resolve({ connected: true, info: sshInfo });
      });
    });

    conn.on('error', (err) => {
      sshConnected = false;
      reject(err);
    });

    conn.connect(connectOpts);
  });
}

function sshDisconnect() {
  if (activeSshCapture) {
    clearTimeout(activeSshCapture.timeoutHandle);
    activeSshCapture.reject(new Error('SSH connection was closed.'));
    activeSshCapture = null;
  }
  if (sshStream) {
    try { sshStream.end(); } catch (e) { /* ignore */ }
  }
  if (sshConn) {
    try { sshConn.end(); } catch (e) { /* ignore */ }
  }
  sshConn = null;
  sshStream = null;
  const wasConnected = sshConnected;
  sshConnected = false;
  sshInfo = null;
  if (wasConnected) broadcastSshStatus();
}

function runSshCommand(command) {
  return new Promise((resolve, reject) => {
    if (!sshConnected || !sshStream) {
      reject(new Error('No active SSH connection.'));
      return;
    }
    if (activeSshCapture) {
      reject(new Error('Another SSH command is still running.'));
      return;
    }
    const marker = `__SSH_DONE_${crypto.randomBytes(4).toString('hex')}__`;
    const timeoutSec = (loadConfig().sshCommandTimeoutSec) || 240;
    const timeoutHandle = setTimeout(() => {
      activeSshCapture = null;
      // The command is still running as the shell's foreground process at
      // this point — we've only given up on it client-side. Since this is a
      // single persistent interactive shell/PTY (not one exec per command),
      // if we don't actually stop it, it keeps holding the prompt: every
      // subsequent command (including the marker echo used to detect
      // completion) just queues up unread in the PTY input buffer and
      // *also* times out, cascading indefinitely even for trivial commands
      // like `echo`. Send Ctrl-C to interrupt the hung foreground process
      // so the shell drops back to a prompt and can accept new commands.
      if (sshStream) {
        try { sshStream.write('\x03'); } catch (e) { /* ignore */ }
      }
      broadcastSshData(`■ TIMED OUT after ${timeoutSec}s (sent Ctrl-C to interrupt)\n`);
      reject(new Error(`Command timed out after ${timeoutSec}s (it may be waiting for input, or long-running) — sent Ctrl-C to the remote shell so it stays usable for the next command. If this is a legitimately slow command (e.g. a thorough nmap scan), increase the timeout in SSH Settings or narrow the scan (fewer ports / -T4 / --top-ports).`));
    }, timeoutSec * 1000);
    activeSshCapture = {
      marker,
      markerRe: new RegExp(marker + ':(\\d+)'),
      buffer: '',
      resolve,
      reject,
      timeoutHandle
    };
    broadcastSshData(`▶ $ ${command}\n`);
    sshStream.write(`${command}\n`);
    // A separate, tiny write to emit the completion marker + exit code.
    sshStream.write(`echo "${marker}:$?"\n`);
  });
}

ipcMain.handle('ssh:connect', async (evt, details) => {
  return sshConnect(details);
});
ipcMain.handle('ssh:disconnect', () => {
  sshDisconnect();
  return { connected: false };
});
ipcMain.handle('ssh:status', () => ({ connected: sshConnected, info: sshInfo }));
ipcMain.handle('ssh:browse-key', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select private key file',
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ---------------------------------------------------------------------------
// General web page fetching (view source / inspector) — separate from SSH
// ---------------------------------------------------------------------------
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local / cloud metadata range
  return false;
}

async function fetchPage(rawUrl) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch (e) {
    throw new Error('Invalid URL.');
  }
  if (!/^https?:$/.test(u.protocol)) {
    throw new Error('Only http:// and https:// URLs are allowed.');
  }
  const res = await fetch(u.toString(), {
    headers: { 'User-Agent': 'cve-ai-assistant-school-project' },
    redirect: 'follow'
  });
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    url: res.url,
    status: res.status,
    contentType,
    title: titleMatch ? titleMatch[1].trim().slice(0, 200) : null,
    html: text.slice(0, 50000)
  };
}

ipcMain.handle('web:fetch-source', async (evt, url) => {
  const result = await fetchPage(url);
  logConsole({
    type: 'web_fetch',
    title: `Viewed source: ${result.url}`,
    detail: `Status: ${result.status}\nTitle: ${result.title || '(none)'}\nContent-Type: ${result.contentType}`
  });
  return result;
});

// ---------------------------------------------------------------------------
// OpenRouter tool-calling conversation loop
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_webpage',
      description: 'Fetch a web page and return its raw HTML source, page title, HTTP status, and content type — useful for inspecting a page\'s source code or structure.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'A full http:// or https:// URL to fetch.' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_ssh_command',
      description: 'Run a shell command AS ROOT on the Linux machine currently connected over SSH (set up by the user in SSH Settings — the connection always logs in as root@<host>, so sudo is unnecessary). There is NO whitelist — any command may be requested — but every command always requires the user\'s explicit on-screen confirmation before it runs. Fails if no SSH connection is open. Avoid interactive commands that wait for input (e.g. text editors); prefer non-interactive, single-shot commands.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The full shell command to run on the remote Linux machine, e.g. "df -h" or "sudo systemctl status nginx".' }
        },
        required: ['command']
      }
    }
  }
];

async function callOpenRouter(apiKey, model, messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://localhost',
      'X-Title': 'CVE AI Assistant (school project)'
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      temperature: 0.4
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

async function executeToolCall(toolCall) {
  const name = toolCall.function.name;
  let args = {};
  try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch (e) { /* ignore */ }

  if (name === 'open_webpage') {
    try {
      const result = await fetchPage(args.url);
      logConsole({
        type: 'web_fetch',
        title: `AI opened page: ${result.url}`,
        detail: `Status: ${result.status}\nTitle: ${result.title || '(none)'}\nContent-Type: ${result.contentType}`
      });
      return `URL: ${result.url}\nStatus: ${result.status}\nTitle: ${result.title || '(none)'}\nContent-Type: ${result.contentType}\n\nHTML source (truncated):\n${result.html.slice(0, 40000)}`;
    } catch (e) {
      logConsole({ type: 'error', title: `Web fetch failed: "${args.url}"`, detail: e.message });
      return `Failed to fetch page: ${e.message}`;
    }
  }

  if (name === 'run_ssh_command') {
    // NOTE: intentionally no logConsole(...) anywhere in this branch — SSH
    // activity only ever shows up in the SSH Terminal panel, per design.
    if (!sshConnected || !sshStream) {
      return 'No active SSH connection. Ask the user to connect via SSH Settings first.';
    }
    const approved = await requestUserConfirmation({
      kind: 'ssh_command',
      command: args.command,
      host: sshInfo ? `${sshInfo.username}@${sshInfo.host}:${sshInfo.port}` : 'remote host'
    });
    if (!approved) {
      return `The user denied permission to run "${args.command}" over SSH.`;
    }
    try {
      const result = await runSshCommand(args.command);
      return `Exit code: ${result.exitCode}\nOutput:\n${result.output || '(no output)'}`;
    } catch (e) {
      return `SSH command failed: ${e.message}`;
    }
  }

  return `Unknown tool: ${name}`;
}

ipcMain.handle('chat:send', async (evt, { history, userMessage }) => {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    throw new Error('No OpenRouter API key set. Add one in Settings.');
  }

  const messages = [
    { role: 'system', content: cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage }
  ];

  let finalText = null;
  const newMessages = [{ role: 'user', content: userMessage }];
  let iterations = 0;

  while (iterations < 12 && finalText === null) {
    iterations++;
    const forceFinal = iterations === 6;
    const data = await callOpenRouter(
    cfg.apiKey, cfg.model, messages,
    forceFinal ? { tool_choice: 'none' } : {}   // last call: no more tools, must answer
    );
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error('No response from model.');
    const msg = choice.message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push(msg);
      newMessages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const result = await executeToolCall(tc);
        const toolMsg = { role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result };
        messages.push(toolMsg);
        newMessages.push(toolMsg);
      }
    } else {
      finalText = msg.content || '(empty response)';
      messages.push(msg);
      newMessages.push({ role: 'assistant', content: finalText });
    }
  }

  if (finalText === null) {
    finalText = '(The assistant used tools repeatedly without producing a final answer. Try rephrasing.)';
  }

  return { finalText, newMessages };
});

// ---------------------------------------------------------------------------
// Chat plaintext storage
// ---------------------------------------------------------------------------
function safeFileName(title) {
  return title.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'chat';
}

ipcMain.handle('chats:list', () => {
  const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.txt'));
  return files.map(f => {
    const full = path.join(CHATS_DIR, f);
    const stat = fs.statSync(full);
    return { file: f, mtime: stat.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
});

ipcMain.handle('chats:create', (evt, title) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = `${ts}_${safeFileName(title || 'New Chat')}.txt`;
  const full = path.join(CHATS_DIR, fname);
  const header = `# Chat: ${title || 'New Chat'}\n# Created: ${new Date().toISOString()}\n\n`;
  fs.writeFileSync(full, header, 'utf8');
  return fname;
});

ipcMain.handle('chats:load', (evt, fname) => {
  const full = path.join(CHATS_DIR, fname);
  if (!fs.existsSync(full)) throw new Error('Chat file not found.');
  return fs.readFileSync(full, 'utf8');
});

ipcMain.handle('chats:append', (evt, { fname, entries }) => {
  // entries: array of {role, content, time}
  const full = path.join(CHATS_DIR, fname);
  let block = '';
  for (const e of entries) {
    if (e.role === 'tool') continue; // tool calls are not duplicated verbatim into the transcript
    const roleLabel = e.role.toUpperCase();
    block += `[${roleLabel} - ${new Date().toISOString()}]\n${e.content}\n\n`;
  }
  fs.appendFileSync(full, block, 'utf8');
  return true;
});

ipcMain.handle('chats:delete', (evt, fname) => {
  const full = path.join(CHATS_DIR, fname);
  if (fs.existsSync(full)) fs.unlinkSync(full);
  return true;
});

ipcMain.handle('chats:reveal-folder', () => {
  shell.openPath(CHATS_DIR);
});

ipcMain.handle('app:open-external', (evt, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});
