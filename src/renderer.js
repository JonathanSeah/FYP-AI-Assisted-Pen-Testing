// renderer.js — UI logic (runs in the renderer, only talks to main via window.api)
'use strict';

let currentChatFile = null;
let currentHistory = []; // array of {role, content, tool_calls?}

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Minimal markdown-ish renderer: fenced code blocks + inline code + bold/italic
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderMarkdownish(text) {
  const parts = [];
  const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = codeBlockRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'code', lang: match[1] || '', content: match[2] });
    lastIndex = codeBlockRe.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return parts.map(p => {
    if (p.type === 'code') {
      const id = 'code_' + Math.random().toString(36).slice(2);
      return `<pre><span class="code-lang">${escapeHtml(p.lang || 'text')}</span><button class="code-copy-btn" data-target="${id}">Copy</button><code id="${id}">${escapeHtml(p.content)}</code></pre>`;
    }
    let t = escapeHtml(p.content);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return t.split('\n').map(line => line).join('\n');
  }).join('');
}

function appendMessageBubble(role, content) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = renderMarkdownish(content);
  el('messages').appendChild(div);
  div.querySelectorAll('.code-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = document.getElementById(btn.dataset.target).innerText;
      navigator.clipboard.writeText(code);
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
  });
  el('messages').scrollTop = el('messages').scrollHeight;
  return div;
}

function appendSystemNote(text) {
  const div = document.createElement('div');
  div.className = 'msg system-note';
  div.textContent = text;
  el('messages').appendChild(div);
  el('messages').scrollTop = el('messages').scrollHeight;
}

// ---------------------------------------------------------------------------
// Chat list / loading / creating
// ---------------------------------------------------------------------------
async function refreshChatList() {
  const chats = await window.api.listChats();
  const listEl = el('chatList');
  listEl.innerHTML = '';
  chats.forEach(c => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.file === currentChatFile ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = humanizeChatFile(c.file);
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.whiteSpace = 'nowrap';
    item.appendChild(label);

    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Delete chat';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Delete this chat permanently?')) {
        await window.api.deleteChat(c.file);
        if (currentChatFile === c.file) {
          currentChatFile = null;
          currentHistory = [];
          el('messages').innerHTML = '';
          el('currentChatTitle').textContent = 'No chat selected';
        }
        refreshChatList();
      }
    });
    item.appendChild(del);

    item.addEventListener('click', () => loadChat(c.file));
    listEl.appendChild(item);
  });
}

function humanizeChatFile(fname) {
  return fname.replace(/^[0-9T:\-Z.]+_/, '').replace(/\.txt$/, '').replace(/_/g, ' ');
}

async function loadChat(fname) {
  currentChatFile = fname;
  currentHistory = [];
  const text = await window.api.loadChat(fname);
  el('messages').innerHTML = '';
  el('currentChatTitle').textContent = humanizeChatFile(fname);

  const blockRe = /\[(USER|ASSISTANT) - ([^\]]+)\]\n([\s\S]*?)(?=\n\[(?:USER|ASSISTANT)|\s*$)/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const role = m[1].toLowerCase();
    const content = m[3].trim();
    if (!content) continue;
    appendMessageBubble(role, content);
    currentHistory.push({ role, content });
  }
  refreshChatList();
}

async function createChatSilently(title) {
  const fname = await window.api.createChat(title || 'New Chat');
  currentChatFile = fname;
  currentHistory = [];
  el('messages').innerHTML = '';
  el('currentChatTitle').textContent = title || 'New Chat';
  await refreshChatList();
  return fname;
}

function openNewChatModal() {
  el('newChatNameInput').value = 'New Chat';
  el('newChatModal').classList.remove('hidden');
  el('newChatNameInput').focus();
  el('newChatNameInput').select();
}

async function actuallyCreateChat() {
  const title = el('newChatNameInput').value.trim() || 'New Chat';
  el('newChatModal').classList.add('hidden');
  await createChatSilently(title);
}

el('cancelNewChatBtn').addEventListener('click', () => el('newChatModal').classList.add('hidden'));
el('confirmNewChatBtn').addEventListener('click', actuallyCreateChat);
el('newChatNameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); actuallyCreateChat(); }
});

function createNewChat() {
  openNewChatModal();
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------
async function sendMessage() {
  const input = el('userInput');
  const text = input.value.trim();
  if (!text) return;
  if (!currentChatFile) await createChatSilently('New Chat');

  input.value = '';
  appendMessageBubble('user', text);

  const thinkingDiv = appendMessageBubble('assistant', 'Thinking...');

  try {
    const { finalText, newMessages } = await window.api.sendMessage(currentHistory, text);
    thinkingDiv.remove();
    appendMessageBubble('assistant', finalText);

    currentHistory.push({ role: 'user', content: text });
    currentHistory.push({ role: 'assistant', content: finalText });

    await window.api.appendChat(currentChatFile, [
      { role: 'user', content: text },
      { role: 'assistant', content: finalText }
    ]);
    refreshChatList();
  } catch (err) {
    thinkingDiv.remove();
    appendMessageBubble('assistant', `⚠ Error: ${err.message || err}`);
  }
}

el('sendBtn').addEventListener('click', sendMessage);
el('userInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
el('newChatBtn').addEventListener('click', createNewChat);
el('revealFolderBtn').addEventListener('click', () => window.api.revealChatsFolder());

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
async function openSettings() {
  const cfg = await window.api.getConfig();
  el('apiKeyInput').value = cfg.apiKey || '';
  el('modelInput').value = cfg.model || '';
  el('systemPromptInput').value = cfg.systemPrompt || '';
  el('settingsModal').classList.remove('hidden');
}
el('settingsBtn').addEventListener('click', openSettings);
el('closeSettingsBtn').addEventListener('click', () => el('settingsModal').classList.add('hidden'));
el('saveSettingsBtn').addEventListener('click', async () => {
  await window.api.saveConfig({
    apiKey: el('apiKeyInput').value.trim(),
    model: el('modelInput').value.trim() || 'openai/gpt-4o-mini',
    systemPrompt: el('systemPromptInput').value
  });
  el('settingsModal').classList.add('hidden');
});

// ---------------------------------------------------------------------------
// SSH settings modal + connection state
// ---------------------------------------------------------------------------
function updateSshAuthGroups() {
  const method = el('sshAuthMethodInput').value;
  el('sshPasswordGroup').classList.toggle('hidden', method !== 'password');
  el('sshKeyGroup').classList.toggle('hidden', method !== 'key');
}
el('sshAuthMethodInput').addEventListener('change', updateSshAuthGroups);

function collectSshFormFields() {
  return {
    host: el('sshHostInput').value.trim(),
    port: parseInt(el('sshPortInput').value.trim(), 10) || 22,
    authMethod: el('sshAuthMethodInput').value,
    password: el('sshPasswordInput').value,
    privateKeyPath: el('sshKeyPathInput').value.trim(),
    passphrase: el('sshPassphraseInput').value,
    sudoPassword: el('sshSudoPasswordInput').value,
    commandTimeoutSec: parseInt(el('sshCommandTimeoutInput').value.trim(), 10) || 240
  };
}

async function saveSshConfig() {
  const f = collectSshFormFields();
  await window.api.saveConfig({
    sshHost: f.host,
    sshPort: f.port,
    sshAuthMethod: f.authMethod,
    sshPassword: f.password,
    sshPrivateKeyPath: f.privateKeyPath,
    sshPassphrase: f.passphrase,
    sudoPassword: f.sudoPassword,
    sshCommandTimeoutSec: f.commandTimeoutSec
  });
  return f;
}

function describeSshStatus(status) {
  if (status && status.connected && status.info) {
    return `Connected as ${status.info.username}@${status.info.host}:${status.info.port}`;
  }
  return 'Disconnected';
}

function setSshModalStatus(status) {
  el('sshModalStatusText').textContent = describeSshStatus(status);
}

function setSshTopStatus(status) {
  const connected = !!(status && status.connected);
  el('sshStatusDot').className = 'ssh-status-dot ' + (connected ? 'connected' : 'disconnected');
  el('sshStatusText').textContent = connected
    ? `Connected: ${status.info.username}@${status.info.host}`
    : 'Disconnected';
}

async function openSshModal() {
  const cfg = await window.api.getConfig();
  el('sshHostInput').value = cfg.sshHost || '';
  el('sshPortInput').value = cfg.sshPort || 22;
  el('sshAuthMethodInput').value = cfg.sshAuthMethod || 'password';
  el('sshPasswordInput').value = cfg.sshPassword || '';
  el('sshKeyPathInput').value = cfg.sshPrivateKeyPath || '';
  el('sshPassphraseInput').value = cfg.sshPassphrase || '';
  el('sshSudoPasswordInput').value = cfg.sudoPassword || '';
  el('sshCommandTimeoutInput').value = cfg.sshCommandTimeoutSec || 240;
  updateSshAuthGroups();
  const status = await window.api.sshStatus();
  setSshModalStatus(status);
  el('sshModal').classList.remove('hidden');
}
el('sshSettingsBtn').addEventListener('click', openSshModal);
el('sshSettingsBtn2').addEventListener('click', openSshModal);
el('closeSshBtn').addEventListener('click', () => el('sshModal').classList.add('hidden'));

el('sshSaveBtn').addEventListener('click', async () => {
  await saveSshConfig();
  el('sshModal').classList.add('hidden');
});

el('sshConnectBtn').addEventListener('click', async () => {
  const f = await saveSshConfig();
  if (!f.host) {
    alert('A server address is required.');
    return;
  }
  if (f.authMethod === 'key' && !f.privateKeyPath) {
    alert('Please choose a private key file, or switch to Password authentication.');
    return;
  }
  const btn = el('sshConnectBtn');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const status = await window.api.sshConnect(f);
    setSshModalStatus({ connected: true, info: status.info });
    setSshTopStatus({ connected: true, info: status.info });
  } catch (e) {
    alert('SSH connection failed: ' + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Connect';
  }
});

el('sshDisconnectBtn').addEventListener('click', async () => {
  await window.api.sshDisconnect();
  setSshModalStatus({ connected: false });
  setSshTopStatus({ connected: false });
});

el('sshBrowseKeyBtn').addEventListener('click', async () => {
  const filePath = await window.api.sshBrowseKey();
  if (filePath) el('sshKeyPathInput').value = filePath;
});

window.api.onSshStatus((status) => {
  setSshTopStatus(status);
  if (!el('sshModal').classList.contains('hidden')) setSshModalStatus(status);
});

// ---------------------------------------------------------------------------
// SSH terminal panel (view-only — the AI's commands stream in here live)
// ---------------------------------------------------------------------------
const SSH_TERMINAL_MAX_CHARS = 200000;
let sshTerminalPrimed = false;

window.api.onSshData((text) => {
  const out = el('sshTerminalOutput');
  if (!sshTerminalPrimed) {
    out.textContent = '';
    sshTerminalPrimed = true;
  }
  out.textContent += text;
  if (out.textContent.length > SSH_TERMINAL_MAX_CHARS) {
    out.textContent = out.textContent.slice(-SSH_TERMINAL_MAX_CHARS + 20000);
  }
  out.scrollTop = out.scrollHeight;
});

// ---------------------------------------------------------------------------
// SSH terminal panel: drag-to-resize + collapse/expand button
// ---------------------------------------------------------------------------
const SSH_PANEL_MIN_HEIGHT = 38; // header-only, "collapsed"
const SSH_PANEL_DEFAULT_HEIGHT = 230;
let sshPanelExpandedHeight = SSH_PANEL_DEFAULT_HEIGHT;

function setSshPanelHeight(px) {
  const panel = el('sshTerminalPanel');
  panel.style.height = `${px}px`;
  panel.classList.toggle('collapsed', px <= SSH_PANEL_MIN_HEIGHT + 4);
  el('sshTerminalToggleBtn').textContent = px <= SSH_PANEL_MIN_HEIGHT + 4 ? 'Expand' : 'Collapse';
}

el('sshTerminalToggleBtn').addEventListener('click', () => {
  const panel = el('sshTerminalPanel');
  if (panel.classList.contains('collapsed')) {
    setSshPanelHeight(sshPanelExpandedHeight || SSH_PANEL_DEFAULT_HEIGHT);
  } else {
    sshPanelExpandedHeight = panel.getBoundingClientRect().height;
    setSshPanelHeight(SSH_PANEL_MIN_HEIGHT);
  }
});

(function initSshTerminalDrag() {
  const handle = el('sshTerminalResizeHandle');
  const panel = el('sshTerminalPanel');
  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  function onPointerMove(e) {
    if (!dragging) return;
    const maxHeight = Math.round(window.innerHeight * 0.75);
    const delta = startY - e.clientY; // dragging up increases height
    const newHeight = Math.max(SSH_PANEL_MIN_HEIGHT, Math.min(maxHeight, startHeight + delta));
    setSshPanelHeight(newHeight);
  }

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('ssh-resizing');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const finalHeight = panel.getBoundingClientRect().height;
    if (finalHeight > SSH_PANEL_MIN_HEIGHT + 4) sshPanelExpandedHeight = finalHeight;
  }

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startHeight = panel.getBoundingClientRect().height;
    document.body.classList.add('ssh-resizing');
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    e.preventDefault();
  });
})();

// ---------------------------------------------------------------------------
// System console panel
// ---------------------------------------------------------------------------
el('consoleToggleBtn').addEventListener('click', () => {
  el('consolePanel').classList.toggle('collapsed');
});
el('clearConsoleBtn').addEventListener('click', async () => {
  el('consoleLog').innerHTML = '';
  await window.api.clearConsoleHistory();
});

function renderConsoleEntry(entry, { prepend = true } = {}) {
  const div = document.createElement('div');
  div.className = `console-entry ${entry.type}`;
  div.innerHTML = `
    <div class="ce-time">${new Date(entry.time).toLocaleTimeString()}</div>
    <div class="ce-title">${escapeHtml(entry.title)}</div>
    <div class="ce-detail">${escapeHtml(entry.detail || '')}</div>
  `;
  if (prepend) {
    el('consoleLog').prepend(div);
  } else {
    el('consoleLog').appendChild(div);
  }
}

window.api.onConsoleLog((entry) => renderConsoleEntry(entry));

// ---------------------------------------------------------------------------
// AI SSH-command confirmation modal
// ---------------------------------------------------------------------------
window.api.onConfirmRequest((req) => {
  el('confirmHost').textContent = req.host || '(unknown host)';
  el('confirmCommand').textContent = req.command || '';
  el('confirmModal').classList.remove('hidden');

  const onApprove = () => {
    window.api.sendConfirmResponse(req.requestId, true);
    cleanup();
  };
  const onDeny = () => {
    window.api.sendConfirmResponse(req.requestId, false);
    cleanup();
  };
  function cleanup() {
    el('confirmModal').classList.add('hidden');
    el('approveBtn').removeEventListener('click', onApprove);
    el('denyBtn').removeEventListener('click', onDeny);
  }
  el('approveBtn').addEventListener('click', onApprove);
  el('denyBtn').addEventListener('click', onDeny);
});

// ---------------------------------------------------------------------------
// Browser modal — live page view, view source, and inspector/devtools
// ---------------------------------------------------------------------------
function normalizeUrl(value) {
  const v = value.trim();
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

function showWebview() {
  el('browserWebview').classList.remove('hidden');
  el('browserSourceView').classList.add('hidden');
  el('browserViewSourceBtn').textContent = 'View Source';
}

function navigateBrowser(value) {
  const url = normalizeUrl(value);
  if (!url) return;
  el('browserUrlInput').value = url;
  showWebview();
  el('browserWebview').src = url;
}

el('browserBtn').addEventListener('click', () => {
  el('browserModal').classList.remove('hidden');
  if (!el('browserUrlInput').value) {
    el('browserUrlInput').value = 'https://';
    el('browserUrlInput').focus();
  }
});
el('closeBrowserBtn').addEventListener('click', () => el('browserModal').classList.add('hidden'));

el('browserGoBtn').addEventListener('click', () => navigateBrowser(el('browserUrlInput').value));
el('browserUrlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); navigateBrowser(el('browserUrlInput').value); }
});
el('browserReloadBtn').addEventListener('click', () => {
  try { el('browserWebview').reload(); } catch (e) { /* webview may not be ready yet */ }
});
el('browserDevtoolsBtn').addEventListener('click', () => {
  try { el('browserWebview').openDevTools(); } catch (e) { /* webview may not be ready yet */ }
});

el('browserViewSourceBtn').addEventListener('click', async () => {
  const sourceView = el('browserSourceView');
  const isShowingSource = !sourceView.classList.contains('hidden');
  if (isShowingSource) {
    showWebview();
    return;
  }
  const url = el('browserUrlInput').value.trim();
  if (!url) return;
  el('browserSourceCode').textContent = 'Loading source...';
  sourceView.classList.remove('hidden');
  el('browserWebview').classList.add('hidden');
  el('browserViewSourceBtn').textContent = 'Live View';
  try {
    const result = await window.api.fetchPageSource(url);
    el('browserSourceCode').textContent = result.html;
  } catch (e) {
    el('browserSourceCode').textContent = `Error fetching source: ${e.message || e}`;
  }
});

const browserWebviewEl = el('browserWebview');
browserWebviewEl.addEventListener('did-navigate', (e) => {
  if (e.url && e.url !== 'about:blank') el('browserUrlInput').value = e.url;
});
browserWebviewEl.addEventListener('did-navigate-in-page', (e) => {
  if (e.url && e.url !== 'about:blank') el('browserUrlInput').value = e.url;
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
(async function init() {
  await refreshChatList();
  const cfg = await window.api.getConfig();
  if (!cfg.apiKey) {
    appendSystemNote('No OpenRouter API key set yet — open Settings (⚙) to add one.');
  }
  const history = await window.api.getConsoleHistory();
  history.forEach(entry => renderConsoleEntry(entry, { prepend: true }));

  const sshStatus = await window.api.sshStatus();
  setSshTopStatus(sshStatus);
  if (!sshStatus.connected) {
    appendSystemNote('No SSH connection yet — open 🔐 SSH to connect to a Linux machine.');
  }
})();
