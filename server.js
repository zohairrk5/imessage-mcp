#!/usr/bin/env node
// iMessage MCP server: Slack-style context over Messages (chat.db) with real contact names.
// Reads ~/Library/Messages/chat.db and the AddressBook databases directly (read-only).
// Sending goes through Messages.app via AppleScript.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME || os.homedir();
const CHAT_DB = `${HOME}/Library/Messages/chat.db`;
const AB_DIR = `${HOME}/Library/Application Support/AddressBook`;
const APPLE_EPOCH = 978307200;

// Normal messages (0) and sticker replies (1000); 2000-3999 are tapbacks (add/remove).
const MAIN_MSG = "m.associated_message_type IN (0, 1000)";
const REACTION_MSG = "m.associated_message_type BETWEEN 2000 AND 3999";

// ---------------------------------------------------------------- text decoding

// attributedBody is an NSAttributedString in Apple's typedstream format. The plain text sits
// right after the "NSString" class name: <0x01 0x94 0x84 0x01> '+' <length> <utf-8 bytes>.
// Length is one byte, or 0x81 + uint16 LE, or 0x82 + uint32 LE.
function decodeAttributedBody(hex) {
  if (!hex) return null;
  const buf = Buffer.from(hex, "hex");
  const start = buf.indexOf("NSString");
  if (start < 0) return null;
  let p = buf.indexOf(0x2b, start + 8);
  if (p < 0 || p > start + 16) return null;
  p++;
  let len = buf[p++];
  if (len === 0x81) {
    len = buf.readUInt16LE(p);
    p += 2;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(p);
    p += 4;
  }
  return buf.toString("utf8", p, Math.min(p + len, buf.length));
}

function messageText(text, body) {
  const raw = text ? text : decodeAttributedBody(body);
  if (raw == null) return "";
  // U+FFFC marks where an attachment sits inline; attachments are listed separately.
  return raw.replace(/\uFFFC/g, "").replace(/\u000b/g, "\n").trim();
}

// ---------------------------------------------------------------- time helpers

function appleToDate(v) {
  if (!v) return null;
  const seconds = v > 1e11 ? v / 1e9 : v; // nanoseconds since 2001 (seconds on very old rows)
  return new Date((seconds + APPLE_EPOCH) * 1000);
}

function dateToApple(d) {
  return (d.getTime() / 1000 - APPLE_EPOCH) * 1e9;
}

const dateFmt = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const fmtDate = d => (d ? dateFmt.format(d) : "?");

function parseTime(value, field) {
  if (value == null || value === "") return null;
  const s = String(value).trim().toLowerCase();
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*(min|m|hr|h|d|w)[a-z]*$/);
  if (rel) {
    const unit = { min: 6e4, m: 6e4, hr: 36e5, h: 36e5, d: 864e5, w: 6048e5 }[rel[2]];
    return new Date(Date.now() - parseFloat(rel[1]) * unit);
  }
  if (s === "today" || s === "yesterday") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (s === "yesterday") d.setDate(d.getDate() - 1);
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, mo, da] = s.split("-").map(Number);
    return new Date(y, mo - 1, da);
  }
  const d = new Date(value);
  if (isNaN(d)) throw new Error(`Couldn't parse ${field} "${value}". Use e.g. "24h", "7d", "2w", "yesterday", "2026-10-01".`);
  return d;
}

// ---------------------------------------------------------------- databases

// Queries go through /usr/bin/sqlite3 (present on every Mac) rather than node:sqlite, so the
// server runs on any Node, including the one bundled in Claude Desktop, and child processes
// inherit the host app's Full Disk Access. Blobs are selected as hex(); big timestamps as REAL.
function sqlLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`Invalid SQL number: ${v}`);
    return String(v);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

function bindParams(sql, params) {
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error("Missing SQL parameter");
    return sqlLiteral(params[i++]);
  });
  if (i !== params.length) throw new Error("Too many SQL parameters");
  return out;
}

class SqliteCli {
  constructor(path) {
    this.path = path;
  }
  query(sql, params) {
    try {
      const out = execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", this.path, bindParams(sql, params)], {
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return out.trim() ? JSON.parse(out) : [];
    } catch (error) {
      const msg = String(error.stderr || error.message).trim();
      if (/unable to open|authorization denied|not authorized/i.test(msg)) {
        throw new Error(`Can't open ${this.path} (${msg}). Give the app running this server Full Disk Access in System Settings > Privacy & Security.`);
      }
      throw new Error(msg);
    }
  }
  prepare(sql) {
    return { all: (...p) => this.query(sql, p), get: (...p) => this.query(sql, p)[0] };
  }
  close() {}
}

let chatDb;
function db() {
  chatDb ??= new SqliteCli(CHAT_DB);
  return chatDb;
}

// Case-insensitive match of one term against a message's text. attributedBody text sits after
// "NSString" + 5 marker bytes + a length (1 byte, or 0x81 + 2 bytes, or 0x82 + 4 bytes); the
// length is skipped because it can contain a 0x00 that would end the string early. Read as text
// from there, the first NUL after the message ends it, so LIKE sees just the text.
const NS_LEN = "(instr(m.attributedBody, CAST('NSString' AS BLOB)) + 13)";
const BODY_TEXT = `CAST(substr(m.attributedBody, ${NS_LEN} + CASE substr(m.attributedBody, ${NS_LEN}, 1) WHEN X'81' THEN 3 WHEN X'82' THEN 5 ELSE 1 END) AS TEXT)`;
const TEXT_MATCH = `(m.text LIKE ? ESCAPE '\\' OR (instr(m.attributedBody, CAST('NSString' AS BLOB)) > 0 AND ${BODY_TEXT} LIKE ? ESCAPE '\\'))`;
const likePattern = term => `%${term.replace(/[\\%_]/g, c => "\\" + c)}%`;

const placeholders = arr => arr.map(() => "?").join(",");

// ---------------------------------------------------------------- contacts

let contactCache = null;

function phoneKey(v) {
  const digits = String(v || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function handleKey(id) {
  if (!id) return "";
  if (id.includes("@")) return id.trim().toLowerCase();
  return phoneKey(id) || id.trim().toLowerCase();
}

function addressBookPaths() {
  const paths = [`${AB_DIR}/AddressBook-v22.abcddb`];
  try {
    for (const dir of readdirSync(`${AB_DIR}/Sources`)) paths.push(`${AB_DIR}/Sources/${dir}/AddressBook-v22.abcddb`);
  } catch {}
  return paths.filter(p => existsSync(p));
}

function mtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function contacts() {
  const paths = addressBookPaths();
  const signature = paths.map(p => `${p}:${mtime(p)}:${mtime(p + "-wal")}`).join("|");
  if (contactCache?.signature === signature) return contactCache;

  const list = [];
  const byKey = new Map();
  const byName = new Map(); // same person synced from several sources gets merged by name

  for (const path of paths) {
    let ab;
    try {
      ab = new SqliteCli(path);
      const records = ab.prepare("SELECT Z_PK id, ZFIRSTNAME first, ZMIDDLENAME middle, ZLASTNAME last, ZNICKNAME nick, ZORGANIZATION org FROM ZABCDRECORD").all();
      const phones = ab.prepare("SELECT ZOWNER owner, ZFULLNUMBER v FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL").all();
      const emails = ab.prepare("SELECT ZOWNER owner, ZADDRESS v FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL").all();

      const local = new Map();
      for (const r of records) {
        const name = [r.first, r.middle, r.last].filter(Boolean).join(" ").trim() || r.nick || r.org;
        if (name) local.set(r.id, { name, nickname: r.nick || null, organization: r.org || null, phones: [], emails: [] });
      }
      for (const p of phones) local.get(p.owner)?.phones.push(p.v);
      for (const e of emails) local.get(e.owner)?.emails.push(e.v);

      for (const c of local.values()) {
        if (!c.phones.length && !c.emails.length) continue;
        let target = byName.get(c.name);
        if (target) {
          for (const p of c.phones) if (!target.phones.includes(p)) target.phones.push(p);
          for (const e of c.emails) if (!target.emails.includes(e)) target.emails.push(e);
        } else {
          target = c;
          byName.set(c.name, c);
          list.push(c);
        }
        for (const v of [...c.phones, ...c.emails]) {
          const key = handleKey(v);
          if (key && !byKey.has(key)) byKey.set(key, target);
        }
      }
    } catch (error) {
      console.error(`Skipping AddressBook ${path}: ${error.message}`);
    } finally {
      ab?.close();
    }
  }

  contactCache = { signature, list, byKey };
  return contactCache;
}

function contactFor(handleId) {
  return contacts().byKey.get(handleKey(handleId)) || null;
}

function searchContacts(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const digits = q.replace(/\D/g, "");
  const isPhone = digits.length >= 4 && /^[\d\s()+.-]+$/.test(q);
  const needle = digits.length > 10 ? digits.slice(-10) : digits;
  const terms = q.split(/\s+/);
  return contacts().list.filter(c => {
    if (isPhone) return c.phones.some(p => p.replace(/\D/g, "").includes(needle));
    const hay = [c.name, c.nickname, c.organization].filter(Boolean).join(" ").toLowerCase();
    return terms.every(t => hay.includes(t)) || c.emails.some(e => e.toLowerCase().includes(q));
  });
}

// ---------------------------------------------------------------- handles & conversations

function loadHandles() {
  const byRowId = new Map();
  for (const h of db().prepare("SELECT ROWID id, id handle FROM handle").all()) byRowId.set(h.id, h.handle);
  return byRowId;
}

function displayHandle(handleId) {
  return contactFor(handleId)?.name || handleId || "Unknown";
}

// A "conversation" merges every chat row for the same person (iMessage, SMS, RCS, phone + email).
// Group chats stay one conversation per chat row.
function conversationIndex() {
  const handles = loadHandles();
  const chats = db().prepare("SELECT ROWID id, guid, chat_identifier ident, display_name dname, style FROM chat").all();
  const members = new Map();
  for (const r of db().prepare("SELECT chat_id, handle_id FROM chat_handle_join").all()) {
    if (!members.has(r.chat_id)) members.set(r.chat_id, []);
    members.get(r.chat_id).push(r.handle_id);
  }
  const last = new Map();
  for (const r of db().prepare("SELECT chat_id, CAST(MAX(message_date) AS REAL) d FROM chat_message_join GROUP BY chat_id").all()) last.set(r.chat_id, r.d);

  const convs = new Map();
  const byChatId = new Map();
  for (const chat of chats) {
    const memberIds = (members.get(chat.id) || []).map(id => handles.get(id)).filter(Boolean);
    const isGroup = chat.style === 43;
    let key, conv;
    if (isGroup) {
      key = `chat:${chat.id}`;
    } else {
      const other = memberIds[0] || chat.ident;
      const contact = contactFor(other);
      key = contact ? `c:${contact.name}` : `h:${handleKey(other)}`;
    }
    conv = convs.get(key);
    if (!conv) {
      conv = { key, isGroup, chats: [], handles: new Set(), named: Boolean(chat.dname), name: "", last: 0 };
      convs.set(key, conv);
    }
    conv.chats.push({ id: chat.id, guid: chat.guid, last: last.get(chat.id) || 0 });
    for (const m of memberIds) conv.handles.add(m);
    if (!isGroup && !memberIds.length && chat.ident) conv.handles.add(chat.ident);
    conv.last = Math.max(conv.last, last.get(chat.id) || 0);
    if (isGroup) conv.displayName = chat.dname || null;
    byChatId.set(chat.id, conv);
  }

  for (const conv of convs.values()) {
    conv.chats.sort((a, b) => b.last - a.last);
    conv.chatIds = conv.chats.map(c => c.id);
    const memberNames = [...conv.handles].map(displayHandle);
    conv.members = memberNames;
    if (conv.isGroup) {
      conv.name = conv.displayName || (memberNames.length ? summarizeMembers(memberNames, 4) : "Unnamed group");
      conv.ref = `chat:${conv.chats[0].id}`;
    } else {
      const handle = [...conv.handles][0] || "";
      conv.name = contactFor(handle)?.name || handle || "Unknown";
      conv.ref = handle || `chat:${conv.chats[0].id}`;
    }
  }
  return { convs, byChatId, handles };
}

// Named contacts first; raw numbers only fill in when there's room.
function summarizeMembers(members, max = 8) {
  if (!members.length) return "members unknown";
  const sorted = [...members].sort((x, y) => Number(/^[+\d]/.test(x)) - Number(/^[+\d]/.test(y)));
  return sorted.slice(0, max).join(", ") + (sorted.length > max ? ` +${sorted.length - max} more` : "");
}

function describeConv(c) {
  if (c.isGroup) return `${c.name} (group of ${c.members.length + 1}: ${summarizeMembers(c.members)}) [ref: ${c.ref}]`;
  return `${c.name} (${[...c.handles].join(", ")}) [ref: ${c.ref}]`;
}

// Every query word must start a word in the name: "sam" matches "Sam Lee" and "Samantha", not "Osama".
function nameMatches(name, query) {
  const words = String(name || "").toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  return String(query).toLowerCase().split(/\s+/).filter(Boolean).every(t => words.some(w => w.startsWith(t)));
}

const isHandleLike = s => s.includes("@") || /^[\d\s()+.-]{5,}$/.test(s);

function resolveConversation(input, index = conversationIndex()) {
  const s = String(input || "").trim();
  if (!s) throw new Error("conversation is required");
  const { convs, byChatId } = index;

  const chatRef = s.match(/^chat:(\d+)$/i);
  if (chatRef) {
    const c = byChatId.get(Number(chatRef[1]));
    if (!c) throw new Error(`No chat with id ${s}.`);
    return c;
  }

  if (isHandleLike(s)) {
    const contact = contactFor(s);
    const c = convs.get(contact ? `c:${contact.name}` : `h:${handleKey(s)}`);
    if (c) return c;
    throw new Error(`No conversation with ${s}${contact ? ` (${contact.name})` : ""} yet.`);
  }

  // By name: DMs by contact name, groups by their given name (unnamed groups need chat:<id>).
  const q = s.toLowerCase();
  const all = [...convs.values()].filter(c => !c.isGroup || c.displayName);
  const exact = all.filter(c => c.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const matches = exact.length ? exact : all.filter(c => nameMatches(c.name, q));
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    throw new Error(`No conversation matches "${s}". Use list_conversations or search_contacts to find it (unnamed group chats are referenced as chat:<id>).`);
  }
  matches.sort((a, b) => b.last - a.last);
  throw new Error(`"${s}" matches ${matches.length} conversations; pass one ref:\n` +
    matches.slice(0, 15).map(c => `- ${describeConv(c)} last active ${fmtDate(appleToDate(c.last))}`).join("\n"));
}

// ---------------------------------------------------------------- message hydration & rendering

const MESSAGE_COLUMNS = `
  m.ROWID id, m.guid, m.text, hex(m.attributedBody) body, CAST(m.date AS REAL) date, m.is_from_me fromMe, m.handle_id hid,
  m.cache_has_attachments hasAtt, m.thread_originator_guid replyTo, (m.date_edited > 0) edited,
  (m.date_retracted > 0) retracted, m.item_type itype, m.group_action_type gat, m.other_handle otherHandle,
  m.group_title groupTitle, m.subject, m.balloon_bundle_id balloon, m.is_read isRead, cmj.chat_id chatId`;

const REACTIONS = { 2000: "❤️", 2001: "👍", 2002: "👎", 2003: "😂", 2004: "‼️", 2005: "❓", 2007: "sticker" };

function senderName(row, handles) {
  if (row.fromMe) return "Me";
  return displayHandle(handles.get(row.hid));
}

function hydrate(rows, handles) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);

  const attachments = new Map();
  const attRows = db().prepare(`
    SELECT maj.message_id mid, a.filename, a.mime_type mime, a.transfer_name name
    FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id IN (${placeholders(ids)})`).all(...ids);
  for (const a of attRows) {
    if ((a.name || a.filename || "").endsWith(".pluginPayloadAttachment")) continue; // link-preview internals
    if (!attachments.has(a.mid)) attachments.set(a.mid, []);
    attachments.get(a.mid).push({
      type: a.mime || "file",
      name: a.name || (a.filename || "").split("/").pop(),
      path: a.filename ? a.filename.replace(/^~/, HOME) : null,
    });
  }

  // Tapbacks on these messages, folded so removed reactions disappear.
  const guids = rows.map(r => r.guid);
  const chatIds = [...new Set(rows.map(r => r.chatId))];
  const minDate = Math.min(...rows.map(r => r.date));
  const reactions = new Map();
  const reactRows = db().prepare(`
    SELECT m.associated_message_guid target, m.associated_message_type type, m.associated_message_emoji emoji,
           m.is_from_me fromMe, m.handle_id hid
    FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
    WHERE cmj.chat_id IN (${placeholders(chatIds)}) AND ${REACTION_MSG} AND cmj.message_date >= ?
    ORDER BY m.date`).all(...chatIds, minDate);
  const guidSet = new Set(guids);
  for (const r of reactRows) {
    const target = String(r.target || "").replace(/^(p:\d+\/|bp:)/, "");
    if (!guidSet.has(target)) continue;
    const base = r.type >= 3000 ? r.type - 1000 : r.type;
    const who = senderName(r, handles);
    const symbol = base === 2006 ? r.emoji || "emoji" : REACTIONS[base] || "reaction";
    if (!reactions.has(target)) reactions.set(target, new Map());
    const perTarget = reactions.get(target);
    const k = `${who}|${base}|${base === 2006 ? r.emoji : ""}`;
    if (r.type >= 3000) perTarget.delete(k);
    else perTarget.set(k, `${symbol} ${who}`);
  }

  // Inline-reply context.
  const replyGuids = [...new Set(rows.map(r => r.replyTo).filter(Boolean))];
  const replies = new Map();
  if (replyGuids.length) {
    for (const o of db().prepare(`SELECT guid, text, hex(attributedBody) body, is_from_me fromMe, handle_id hid FROM message WHERE guid IN (${placeholders(replyGuids)})`).all(...replyGuids)) {
      replies.set(o.guid, { who: senderName(o, handles), text: messageText(o.text, o.body) });
    }
  }

  return rows.map(r => ({
    ...r,
    content: messageText(r.text, r.body),
    sender: senderName(r, handles),
    when: appleToDate(r.date),
    attachments: attachments.get(r.id) || [],
    reactions: [...(reactions.get(r.guid)?.values() || [])],
    reply: r.replyTo ? replies.get(r.replyTo) || { who: "?", text: "(original not found)" } : null,
  }));
}

function systemEvent(m, handles) {
  const other = m.otherHandle ? displayHandle(handles.get(m.otherHandle)) : "someone";
  if (m.itype === 1) return m.gat === 1 ? `${m.sender} removed ${other}` : `${m.sender} added ${other}`;
  if (m.itype === 2) return `${m.sender} renamed the group to "${m.groupTitle || ""}"`;
  if (m.itype === 3) return m.gat === 0 ? `${m.sender} left the group` : `${m.sender} changed the group photo`;
  return null;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function renderMessage(m, handles, { conversationName, maxLen } = {}) {
  const where = conversationName ? ` [${conversationName}]` : "";
  const head = `#${m.id} ${fmtDate(m.when)}${where}`;
  if (m.itype !== 0) {
    const ev = systemEvent(m, handles);
    return ev ? `${head} — ${ev}` : null;
  }
  let body;
  if (m.retracted) body = "[unsent a message]";
  else {
    body = m.content;
    if (m.subject) body = `Subject: ${m.subject}${body ? "\n" + body : ""}`;
    if (!body && m.balloon && !m.attachments.length) body = `[app message: ${m.balloon.split(".").pop()}]`;
    if (maxLen) body = clip(body, maxLen);
  }
  if (!body && !m.attachments.length) return null;
  const lines = [`${head} ${m.sender}: ${(body || "").replace(/\n/g, "\n    ")}${m.edited ? " (edited)" : ""}`.trimEnd()];
  if (m.reply) lines.push(`    ↳ replying to ${m.reply.who}: "${clip(m.reply.text.replace(/\s+/g, " "), 100)}"`);
  for (const a of m.attachments) lines.push(`    [${a.type}] ${a.name}${a.path ? ` — ${a.path}` : ""}`);
  if (m.reactions.length) lines.push(`    reactions: ${m.reactions.join(", ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- tools

function listConversations({ limit = 25, since, query, groups_only, unread_only } = {}) {
  const index = conversationIndex();
  const sinceDate = parseTime(since, "since");
  const unread = new Map();
  for (const r of db().prepare(`
      SELECT cmj.chat_id chatId, COUNT(*) n FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE m.is_read = 0 AND m.is_from_me = 0 AND m.item_type = 0 AND ${MAIN_MSG} AND m.date > ?
      GROUP BY cmj.chat_id`).all(dateToApple(parseTime("90d")))) {
    const c = index.byChatId.get(r.chatId);
    if (c) unread.set(c, (unread.get(c) || 0) + r.n);
  }

  const q = query ? String(query).toLowerCase() : null;
  let list = [...index.convs.values()].filter(c => c.last > 0);
  if (sinceDate) list = list.filter(c => c.last >= dateToApple(sinceDate));
  if (groups_only) list = list.filter(c => c.isGroup);
  if (unread_only) list = list.filter(c => unread.get(c));
  if (q) list = list.filter(c => c.name.toLowerCase().includes(q) || c.members.some(n => n.toLowerCase().includes(q)));
  list.sort((a, b) => b.last - a.last);
  const total = list.length;
  list = list.slice(0, Math.min(Number(limit) || 25, 200));

  const previewStmtCache = new Map();
  const out = list.map((c, i) => {
    const n = c.chatIds.length;
    if (!previewStmtCache.has(n)) {
      previewStmtCache.set(n, db().prepare(`
        SELECT ${MESSAGE_COLUMNS} FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
        WHERE cmj.chat_id IN (${placeholders(c.chatIds)}) AND ${MAIN_MSG} AND m.item_type = 0
        ORDER BY cmj.message_date DESC LIMIT 1`));
    }
    const row = previewStmtCache.get(n).get(...c.chatIds);
    const last = row ? hydrate([row], index.handles)[0] : null;
    const preview = last
      ? `${last.sender}: ${clip((last.retracted ? "[unsent]" : last.content || (last.attachments[0] ? `[${last.attachments[0].type}]` : "")).replace(/\s+/g, " "), 140)}`
      : "";
    const u = unread.get(c);
    return `${i + 1}. ${describeConv(c)}\n   last ${fmtDate(appleToDate(c.last))}${u ? ` · ${u} unread` : ""}\n   ${preview}`;
  });
  return `${total} conversation(s)${total > list.length ? `, showing ${list.length} most recent` : ""}:\n\n${out.join("\n")}`;
}

function readConversation({ conversation, limit = 40, since, before, around }) {
  const index = conversationIndex();
  const conv = resolveConversation(conversation, index);
  const max = Math.min(Number(limit) || 40, 500);
  const ids = conv.chatIds;
  const base = `SELECT ${MESSAGE_COLUMNS} FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
                WHERE cmj.chat_id IN (${placeholders(ids)}) AND ${MAIN_MSG}`;
  let rows;
  if (around) {
    const anchor = db().prepare("SELECT CAST(date AS REAL) date FROM message WHERE ROWID = ?").get(Number(String(around).replace("#", "")));
    if (!anchor) throw new Error(`No message #${around}.`);
    const half = Math.max(5, Math.floor(max / 2));
    const older = db().prepare(`${base} AND m.date <= ? ORDER BY m.date DESC LIMIT ?`).all(...ids, anchor.date, half + 1);
    const newer = db().prepare(`${base} AND m.date > ? ORDER BY m.date ASC LIMIT ?`).all(...ids, anchor.date, half);
    rows = [...older.reverse(), ...newer];
  } else {
    const params = [...ids];
    let where = "";
    const s = parseTime(since, "since");
    const b = parseTime(before, "before");
    if (s) { where += " AND m.date >= ?"; params.push(dateToApple(s)); }
    if (b) { where += " AND m.date < ?"; params.push(dateToApple(b)); }
    rows = db().prepare(`${base}${where} ORDER BY m.date DESC LIMIT ?`).all(...params, max).reverse();
  }
  const msgs = hydrate(rows, index.handles).map(m => renderMessage(m, index.handles)).filter(Boolean);
  const header = `Conversation: ${describeConv(conv)}\n${msgs.length} message(s), oldest first. Message ids (#…) work with read_conversation(around=…).`;
  return `${header}\n\n${msgs.join("\n") || "(no messages in this range)"}`;
}

function searchMessages({ query, conversation, from, since, before, limit = 30 }) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error("query is required");
  const index = conversationIndex();
  const params = terms.flatMap(t => [likePattern(t), likePattern(t)]);
  let where = "";
  if (conversation) {
    const conv = resolveConversation(conversation, index);
    where += ` AND cmj.chat_id IN (${placeholders(conv.chatIds)})`;
    params.push(...conv.chatIds);
  }
  if (from) {
    if (/^(me|myself|i)$/i.test(String(from).trim())) {
      where += " AND m.is_from_me = 1";
    } else {
      const people = isHandleLike(String(from)) ? [contactFor(from)?.name || from] : contacts().list.filter(c => nameMatches(c.name, from)).map(c => c.name);
      const wanted = new Set(isHandleLike(String(from)) ? [handleKey(from)] : []);
      for (const name of people) for (const c of contacts().list.filter(x => x.name === name)) for (const v of [...c.phones, ...c.emails]) wanted.add(handleKey(v));
      const hids = [...index.handles].filter(([, h]) => wanted.has(handleKey(h))).map(([id]) => id);
      if (!hids.length) throw new Error(`No messages from anyone matching "${from}".`);
      where += ` AND m.is_from_me = 0 AND m.handle_id IN (${placeholders(hids)})`;
      params.push(...hids);
    }
  }
  const s = parseTime(since, "since");
  const b = parseTime(before, "before");
  if (s) { where += " AND m.date >= ?"; params.push(dateToApple(s)); }
  if (b) { where += " AND m.date < ?"; params.push(dateToApple(b)); }
  const max = Math.min(Number(limit) || 30, 200);
  const rows = db().prepare(`
    SELECT ${MESSAGE_COLUMNS} FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    WHERE ${MAIN_MSG} AND m.item_type = 0 AND ${terms.map(() => TEXT_MATCH).join(" AND ")}${where}
    ORDER BY m.date DESC LIMIT ?`).all(...params, max);
  const lines = hydrate(rows, index.handles)
    .map(m => renderMessage(m, index.handles, { conversationName: index.byChatId.get(m.chatId)?.name, maxLen: 400 }))
    .filter(Boolean);
  return `${lines.length} match(es) for "${terms.join(" ")}", newest first. For surrounding context call read_conversation(conversation, around=<#id>).\n\n${lines.join("\n") || "(no matches)"}`;
}

function getUnread({ limit = 50, since = "30d" }) {
  const index = conversationIndex();
  const s = parseTime(since, "since");
  const rows = db().prepare(`
    SELECT ${MESSAGE_COLUMNS} FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    WHERE m.is_read = 0 AND m.is_from_me = 0 AND m.item_type = 0 AND ${MAIN_MSG} ${s ? "AND m.date >= ?" : ""}
    ORDER BY m.date DESC LIMIT ?`).all(...(s ? [dateToApple(s)] : []), Math.min(Number(limit) || 50, 500));
  const groups = new Map();
  for (const m of hydrate(rows, index.handles)) {
    const conv = index.byChatId.get(m.chatId);
    if (!groups.has(conv)) groups.set(conv, []);
    groups.get(conv).push(m);
  }
  const out = [];
  for (const [conv, msgs] of groups) {
    out.push(`## ${conv ? describeConv(conv) : "Unknown chat"} — ${msgs.length} unread`);
    for (const m of msgs.reverse()) {
      const line = renderMessage(m, index.handles);
      if (line) out.push(line);
    }
    out.push("");
  }
  return `${rows.length} unread message(s)${s ? ` since ${fmtDate(s)}` : ""} across ${groups.size} conversation(s):\n\n${out.join("\n") || "(nothing unread)"}`;
}

async function sendMessage({ recipient, message }) {
  const to = String(recipient || "").trim();
  const text = String(message ?? "");
  if (!to || !text) throw new Error("recipient and message are required");

  let conv = null;
  let newHandle = null;
  try {
    conv = resolveConversation(to);
  } catch (error) {
    if (isHandleLike(to)) {
      newHandle = to.includes("@") ? to.trim() : normalizePhone(to);
    } else {
      // A saved contact you've never messaged: only if the name means exactly one person with one number/email.
      const people = contacts().list.filter(c => c.name.toLowerCase() === to.toLowerCase() || nameMatches(c.name, to));
      const handles = people.length === 1 ? [...people[0].phones, ...people[0].emails] : [];
      if (!String(error.message).startsWith("No conversation matches") || handles.length !== 1) {
        if (people.length === 1 && handles.length > 1) {
          throw new Error(`${people[0].name} has no conversation yet and several numbers/emails; send to one of: ${handles.join(", ")}`);
        }
        throw error; // ambiguous or unknown: never guess who to send to
      }
      newHandle = handles[0].includes("@") ? handles[0] : normalizePhone(handles[0]);
    }
  }

  if (conv) {
    const guid = conv.chats[0].guid; // most recently active chat for this person/group
    await execFileAsync("/usr/bin/osascript", [
      "-e", "on run argv",
      "-e", 'tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)',
      "-e", "end run",
      text, guid,
    ]);
    return `Sent to ${describeConv(conv)}.`;
  }

  // New conversation with a phone number or email.
  const handle = newHandle;
  await execFileAsync("/usr/bin/osascript", [
    "-e", "on run argv",
    "-e", 'tell application "Messages"',
    "-e", "set svc to 1st account whose service type = iMessage",
    "-e", "send (item 1 of argv) to participant (item 2 of argv) of svc",
    "-e", "end tell",
    "-e", "end run",
    text, handle,
  ]);
  return `Sent to ${contactFor(handle)?.name || handle} (${handle}), new conversation via iMessage.`;
}

function normalizePhone(phone) {
  const cleaned = phone.replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (/^1\d{10}$/.test(cleaned)) return `+${cleaned}`;
  if (/^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
  return cleaned;
}

function searchContactsTool({ query }) {
  const index = conversationIndex();
  const results = searchContacts(query).slice(0, 50).map(c => {
    const keys = new Set([...c.phones, ...c.emails].map(handleKey));
    const conv = [...index.convs.values()].find(v => !v.isGroup && [...v.handles].some(h => keys.has(handleKey(h))));
    return {
      name: c.name,
      ...(c.organization && c.organization !== c.name ? { organization: c.organization } : {}),
      phones: c.phones,
      emails: c.emails,
      conversation: conv ? { ref: conv.ref, last_active: fmtDate(appleToDate(conv.last)) } : null,
    };
  });
  return JSON.stringify(results, null, 2);
}

// ---------------------------------------------------------------- MCP wiring

const TIME_HINT = 'Relative ("24h", "7d", "2w", "today", "yesterday") or a date ("2026-10-01").';
const CONV_HINT = 'A contact name ("Alex"), a named group chat, a phone number or email, or a ref like "chat:123" from list_conversations.';

const TOOLS = [
  {
    name: "list_conversations",
    description: "List iMessage/SMS conversations (DMs and group chats) by most recent activity, like a Slack channel list. Shows contact names, group members, unread counts, a last-message preview and a ref to pass to the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max conversations (default 25, max 200)" },
        since: { type: "string", description: `Only conversations active since. ${TIME_HINT}` },
        query: { type: "string", description: "Filter by conversation name or member name" },
        groups_only: { type: "boolean", description: "Only group chats" },
        unread_only: { type: "boolean", description: "Only conversations with unread messages" },
      },
    },
    annotations: { title: "List Conversations", readOnlyHint: true, openWorldHint: false },
    run: listConversations,
  },
  {
    name: "read_conversation",
    description: "Read a DM or group chat as a transcript with sender names, timestamps, inline replies, reactions and attachments. Merges a person's iMessage, SMS and email threads.",
    inputSchema: {
      type: "object",
      properties: {
        conversation: { type: "string", description: CONV_HINT },
        limit: { type: "number", description: "Max messages (default 40, max 500); the most recent in range are returned" },
        since: { type: "string", description: `Only messages at or after. ${TIME_HINT}` },
        before: { type: "string", description: `Only messages before. ${TIME_HINT}` },
        around: { type: "string", description: "Message id (e.g. \"#408211\" from search results) to center the window on" },
      },
      required: ["conversation"],
    },
    annotations: { title: "Read Conversation", readOnlyHint: true, openWorldHint: false },
    run: readConversation,
  },
  {
    name: "search_messages",
    description: "Full-text search across all messages (every word must appear, case-insensitive). Optionally limit to a conversation, a sender, or a time range. Returns message ids for read_conversation(around=…).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find" },
        conversation: { type: "string", description: `Limit to one conversation. ${CONV_HINT}` },
        from: { type: "string", description: 'Only messages sent by this person (name, phone, email) or "me"' },
        since: { type: "string", description: TIME_HINT },
        before: { type: "string", description: TIME_HINT },
        limit: { type: "number", description: "Max results (default 30, max 200)" },
      },
      required: ["query"],
    },
    annotations: { title: "Search Messages", readOnlyHint: true, openWorldHint: false },
    run: searchMessages,
  },
  {
    name: "get_unread_imessages",
    description: "Unread messages grouped by conversation, with sender names.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max messages (default 50, max 500)" },
        since: { type: "string", description: `Default "30d" (older unread items are usually stale). ${TIME_HINT}` },
      },
    },
    annotations: { title: "Get Unread iMessages", readOnlyHint: true, openWorldHint: false },
    run: getUnread,
  },
  {
    name: "search_contacts",
    description: "Search contacts by name, phone number (any format) or email. Includes the ref of any existing conversation.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Name, phone, or email fragment" } },
      required: ["query"],
    },
    annotations: { title: "Search Contacts", readOnlyHint: true, openWorldHint: false },
    run: searchContactsTool,
  },
  {
    name: "send_imessage",
    description: "Send a message to a person or group chat via Messages.app. The recipient must resolve to exactly one conversation (otherwise the candidates are returned and nothing is sent). A raw phone number or email with no history starts a new iMessage conversation.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: CONV_HINT },
        message: { type: "string", description: "Message text" },
      },
      required: ["recipient", "message"],
    },
    annotations: { title: "Send iMessage", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    run: sendMessage,
  },
];

const server = new Server(
  { name: "imessage-mcp", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "The user's iMessage and SMS history from their Mac. Start with list_conversations or search_messages, " +
      "then read_conversation for full context. All senders are shown by contact name; 'Me' is the user. Confirm wording and recipient with the user before send_imessage.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ run, ...t }) => t),
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = TOOLS.find(t => t.name === request.params.name);
  if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
  try {
    const text = await tool.run(request.params.arguments || {});
    return { content: [{ type: "text", text }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

if (process.argv[2] === "--cli") {
  // Local testing: node server.js --cli <tool> '<json args>'
  const tool = TOOLS.find(t => t.name === process.argv[3]);
  if (!tool) {
    console.error(`Tools: ${TOOLS.map(t => t.name).join(", ")}`);
    process.exit(1);
  }
  console.log(await tool.run(JSON.parse(process.argv[4] || "{}")));
} else {
  await server.connect(new StdioServerTransport());
}
