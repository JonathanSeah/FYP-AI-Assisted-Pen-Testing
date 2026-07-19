// kb.js — Local SQLite FTS5 knowledge base ("RAG" store) the AI can search.
//
// This is a self-contained subsystem, intentionally kept separate from the
// SSH / open_webpage tools in main.js:
//   - its own database file (knowledge.db, next to config.json / chats/)
//   - its own IPC channel namespace (kb:*)
//   - its own AI tool (search_knowledge_base), wired up in main.js
// Nothing in this file touches the SSH connection, the browser/webview, or
// the OpenRouter chat loop directly — main.js just calls the functions
// exported here and returns their results as a tool response.
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

let db = null;

// ---------------------------------------------------------------------------
// Chunking — split a document into overlapping passages so search results
// point at a focused paragraph or two instead of an entire (possibly huge)
// document. Paragraph-aware where possible; hard-splits only when a single
// paragraph itself exceeds maxChars.
// ---------------------------------------------------------------------------
function chunkText(text, { maxChars = 1200, overlapChars = 150 } = {}) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const paras = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const para of paras) {
    if (para.length > maxChars) {
      if (current) { chunks.push(current); current = ''; }
      let start = 0;
      while (start < para.length) {
        chunks.push(para.slice(start, start + maxChars));
        start += Math.max(1, maxChars - overlapChars);
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxChars) {
      if (current) chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  // Prepend a small tail of the previous chunk to each chunk (after the
  // first) so a passage that got cut mid-thought still has some lead-in
  // context when it's returned on its own by a search.
  return chunks.map((c, i) => {
    if (i === 0) return c;
    const prevTail = chunks[i - 1].slice(-overlapChars);
    return `…${prevTail}\n\n${c}`;
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function init(userDataDir) {
  const dbPath = path.join(userDataDir, 'knowledge.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT,
      added_at TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL
    );
  `);

  // FTS5 holds the searchable chunks directly (not an "external content"
  // table) — simplest to reason about, and this knowledge base is sized for
  // personal/reference documents, not a huge corpus.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks USING fts5(
      title,
      source,
      content,
      doc_id UNINDEXED,
      chunk_index UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);

  return dbPath;
}

function assertReady() {
  if (!db) throw new Error('Knowledge base is not initialized.');
}

// ---------------------------------------------------------------------------
// Document CRUD
// ---------------------------------------------------------------------------
function addDocument({ title, source, content }) {
  assertReady();
  const cleanTitle = String(title || 'Untitled').trim().slice(0, 200) || 'Untitled';
  const cleanSource = String(source || '').trim().slice(0, 500);
  const cleanContent = String(content || '').trim();
  if (!cleanContent) throw new Error('Document content is empty.');

  const chunks = chunkText(cleanContent);
  if (chunks.length === 0) throw new Error('Document content is empty.');

  const insertDoc = db.prepare(
    `INSERT INTO kb_documents (title, source, added_at, char_count, chunk_count) VALUES (?, ?, ?, ?, ?)`
  );
  const insertChunk = db.prepare(
    `INSERT INTO kb_chunks (title, source, content, doc_id, chunk_index) VALUES (?, ?, ?, ?, ?)`
  );

  const insertAll = db.transaction(() => {
    const info = insertDoc.run(cleanTitle, cleanSource, new Date().toISOString(), cleanContent.length, chunks.length);
    const docId = info.lastInsertRowid;
    chunks.forEach((chunk, i) => insertChunk.run(cleanTitle, cleanSource, chunk, docId, i));
    return docId;
  });

  const docId = insertAll();
  return { id: docId, title: cleanTitle, source: cleanSource, chunkCount: chunks.length };
}

function listDocuments() {
  assertReady();
  return db.prepare(
    `SELECT id, title, source, added_at, char_count, chunk_count FROM kb_documents ORDER BY added_at DESC`
  ).all();
}

function deleteDocument(id) {
  assertReady();
  const del = db.transaction(() => {
    db.prepare(`DELETE FROM kb_chunks WHERE doc_id = ?`).run(id);
    db.prepare(`DELETE FROM kb_documents WHERE id = ?`).run(id);
  });
  del();
  return true;
}

function clearAll() {
  assertReady();
  const clear = db.transaction(() => {
    db.exec(`DELETE FROM kb_chunks`);
    db.exec(`DELETE FROM kb_documents`);
  });
  clear();
  return true;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
// Turn free-text (from either the AI or the manual test box) into a safe
// FTS5 MATCH expression: each whitespace-separated token becomes a quoted
// prefix match, OR'd together. Quoting neutralizes FTS5's special query
// syntax (:, -, *, (), etc.) in the input so arbitrary text can't produce a
// syntax error or an unintended query-operator interpretation.
function buildMatchQuery(query) {
  const tokens = String(query || '')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 24);
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

function search(query, limit = 5) {
  assertReady();
  const matchQuery = buildMatchQuery(query);
  if (!matchQuery) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 20));

  return db.prepare(`
    SELECT
      doc_id AS docId,
      chunk_index AS chunkIndex,
      title,
      source,
      content,
      snippet(kb_chunks, 2, '[[', ']]', '…', 12) AS snippet,
      bm25(kb_chunks) AS rank
    FROM kb_chunks
    WHERE kb_chunks MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(matchQuery, safeLimit);
}

module.exports = { init, chunkText, addDocument, listDocuments, deleteDocument, clearAll, search };
