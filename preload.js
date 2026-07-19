// preload.js — exposes a narrow, safe API to the renderer
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // Web page fetch (view source / inspector)
  fetchPageSource: (url) => ipcRenderer.invoke('web:fetch-source', url),

  // System console persistence
  getConsoleHistory: () => ipcRenderer.invoke('console:history'),
  clearConsoleHistory: () => ipcRenderer.invoke('console:clear'),

  // SSH
  sshConnect: (details) => ipcRenderer.invoke('ssh:connect', details),
  sshDisconnect: () => ipcRenderer.invoke('ssh:disconnect'),
  sshStatus: () => ipcRenderer.invoke('ssh:status'),
  sshBrowseKey: () => ipcRenderer.invoke('ssh:browse-key'),

  // Chat / AI
  sendMessage: (history, userMessage) => ipcRenderer.invoke('chat:send', { history, userMessage }),

  // Chat storage
  listChats: () => ipcRenderer.invoke('chats:list'),
  createChat: (title) => ipcRenderer.invoke('chats:create', title),
  loadChat: (fname) => ipcRenderer.invoke('chats:load', fname),
  appendChat: (fname, entries) => ipcRenderer.invoke('chats:append', { fname, entries }),
  deleteChat: (fname) => ipcRenderer.invoke('chats:delete', fname),
  revealChatsFolder: () => ipcRenderer.invoke('chats:reveal-folder'),

  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  // Knowledge base (local SQLite FTS5 RAG store) — separate from chat/SSH/web APIs above.
  // The AI reaches this same store only through its own search_knowledge_base tool call.
  listKbDocuments: () => ipcRenderer.invoke('kb:list'),
  addKbDocument: (doc) => ipcRenderer.invoke('kb:add-document', doc),
  importKbFile: () => ipcRenderer.invoke('kb:add-file'),
  deleteKbDocument: (id) => ipcRenderer.invoke('kb:delete-document', id),
  clearKbDocuments: () => ipcRenderer.invoke('kb:clear'),
  searchKb: (query, limit) => ipcRenderer.invoke('kb:search', { query, limit }),

  // Events from main
  onConsoleLog: (cb) => ipcRenderer.on('console:log', (evt, entry) => cb(entry)),
  onConfirmRequest: (cb) => ipcRenderer.on('command:confirm-request', (evt, req) => cb(req)),
  sendConfirmResponse: (requestId, approved) => ipcRenderer.send('command:confirm-response', { requestId, approved }),
  onSshData: (cb) => ipcRenderer.on('ssh:data', (evt, text) => cb(text)),
  onSshStatus: (cb) => ipcRenderer.on('ssh:status', (evt, status) => cb(status))
});
