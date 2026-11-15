#!/usr/bin/env node
// iMessage MCP server: Slack-style context over Messages (chat.db) with real contact names.
// Reads ~/Library/Messages/chat.db and the AddressBook databases directly (read-only).
// Sending goes through Messages.app via AppleScript.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import {
  constants as fsConstants, appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// "90m", "2 hours", "3d", "1w" as milliseconds, or null.
function relativeMs(s) {
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*(min|m|hr|h|d|w)[a-z]*$/);
  return rel ? parseFloat(rel[1]) * { min: 6e4, m: 6e4, hr: 36e5, h: 36e5, d: 864e5, w: 6048e5 }[rel[2]] : null;
}

function parseTime(value, field) {
  if (value == null || value === "") return null;
  const s = String(value).trim().toLowerCase();
  const ms = relativeMs(s);
  if (ms != null) return new Date(Date.now() - ms);
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

const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const zoneFmt = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" });
// "Sun 2026-11-15 18:30 CST": the weekday and zone make a wrong parse easy to spot.
const fmtWhen = d => `${weekdayFmt.format(d)} ${fmtDate(d)} ${zoneFmt.formatToParts(d).find(p => p.type === "timeZoneName")?.value || ""}`.trim();

function fmtSpan(ms) {
  const m = Math.round(ms / 6e4);
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.round(m / 1440)} days`;
}

// When to send a scheduled message: "in 2h", "45m", "tomorrow 9am", "today 18:30", "9:15pm", or a
// date with a time ("2026-11-20 08:00", or ISO with an offset). Local time; must be in the future.
function parseSendTime(value, now = new Date()) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("send_at is required");
  const s = raw.toLowerCase().replace(/^in\s+/, "");
  const hint = 'Use e.g. "in 2h", "45m", "tomorrow 9am", "today 18:30" or "2026-11-20 08:00".';
  const ms = relativeMs(s);
  const clock = s.match(/^(?:(today|tonight|tomorrow)\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  let d;
  if (ms != null) {
    d = new Date(now.getTime() + ms);
  } else if (clock && (clock[3] || clock[4])) {
    let hour = Number(clock[2]);
    const minute = Number(clock[3] || 0);
    if (clock[4]) hour = hour >= 1 && hour <= 12 ? (hour % 12) + (clock[4] === "pm" ? 12 : 0) : 99;
    if (hour > 23 || minute > 59) throw new Error(`Couldn't parse send_at "${raw}". ${hint}`);
    d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    if (clock[1] === "tomorrow") d.setDate(d.getDate() + 1);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`send_at "${raw}" has no time of day; add one, e.g. "${raw} 09:00".`);
  } else if (/^\d{4}-\d{2}-\d{2}[t ]\d/.test(s)) {
    // Only ISO-style dates reach Date(): its lenient parsing reads "tomorrow 9" as a day in 2001.
    d = new Date(raw.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2")); // "2026-11-20 08:00" as local time
  }
  if (!d || isNaN(d)) throw new Error(`Couldn't parse send_at "${raw}". ${hint}`);
  if (d <= now) throw new Error(`send_at "${raw}" is ${fmtWhen(d)}, which is in the past. Nothing was scheduled.`);
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

// list: people with a phone or email, merged by name across accounts (for naming senders).
// cards: every contact card as stored, one per account, with its id (the Contacts framework's
// identifier, e.g. "1A2B…:ABPerson") and labels, for create_contact and update_contact.
function contacts() {
  const paths = addressBookPaths();
  const signature = paths.map(p => `${p}:${mtime(p)}:${mtime(p + "-wal")}`).join("|");
  if (contactCache?.signature === signature) return contactCache;

  const list = [];
  const cards = [];
  const byKey = new Map();
  const byName = new Map(); // same person synced from several sources gets merged by name

  for (const path of paths) {
    let ab;
    try {
      ab = new SqliteCli(path);
      const records = ab.prepare("SELECT Z_PK id, ZUNIQUEID uid, ZFIRSTNAME first, ZMIDDLENAME middle, ZLASTNAME last, ZNICKNAME nick, ZORGANIZATION org FROM ZABCDRECORD").all();
      const phones = ab.prepare("SELECT ZOWNER owner, ZFULLNUMBER v, ZLABEL label FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL ORDER BY ZOWNER, ZORDERINGINDEX").all();
      const emails = ab.prepare("SELECT ZOWNER owner, ZADDRESS v, ZLABEL label FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL ORDER BY ZOWNER, ZORDERINGINDEX").all();

      const local = new Map();
      for (const r of records) {
        const name = [r.first, r.middle, r.last].filter(Boolean).join(" ").trim() || r.nick || r.org;
        if (name) {
          local.set(r.id, {
            id: r.uid, name, first: r.first || "", middle: r.middle || "", last: r.last || "", nickname: r.nick || null,
            organization: r.org || "", phones: [], emails: [],
          });
        }
      }
      for (const p of phones) local.get(p.owner)?.phones.push({ label: p.label || "", value: p.v });
      for (const e of emails) local.get(e.owner)?.emails.push({ label: e.label || "", value: e.v });

      for (const card of local.values()) {
        const isPerson = /:ABPerson$/.test(card.id || "");
        if (isPerson) cards.push(card);
        const ph = card.phones.map(p => p.value);
        const em = card.emails.map(e => e.value);
        if (!ph.length && !em.length) continue;
        let target = byName.get(card.name);
        if (target) {
          for (const p of ph) if (!target.phones.includes(p)) target.phones.push(p);
          for (const e of em) if (!target.emails.includes(e)) target.emails.push(e);
        } else {
          target = { name: card.name, nickname: card.nickname, organization: card.organization || null, phones: ph, emails: em, ids: [] };
          byName.set(card.name, target);
          list.push(target);
        }
        if (isPerson) target.ids.push(card.id);
        for (const v of [...ph, ...em]) {
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

  contactCache = { signature, list, cards, byKey };
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
  // Cards with no phone or email aren't in the merged list but can still be found (and edited).
  const { list, cards } = contacts();
  const bare = cards.filter(c => !c.phones.length && !c.emails.length)
    .map(c => ({ name: c.name, nickname: c.nickname, organization: c.organization || null, phones: [], emails: [], ids: [c.id] }));
  return [...list, ...bare].filter(c => {
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
  const chats = db().prepare("SELECT ROWID id, guid, chat_identifier ident, group_id gid, display_name dname, style FROM chat").all();
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
    conv.chats.push({ id: chat.id, guid: chat.guid, ident: chat.ident, gid: chat.gid, last: last.get(chat.id) || 0 });
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

// Link previews (.pluginPayloadAttachment) and stickers are Messages internals, not files people sent.
const ATTACHMENT_COLUMNS = "a.filename, a.mime_type mime, a.transfer_name name, a.total_bytes size";
const REAL_ATTACHMENT = "ifnull(a.transfer_name, ifnull(a.filename, '')) NOT LIKE '%.pluginPayloadAttachment' AND ifnull(a.is_sticker, 0) = 0";

const TEXT_EXTS = new Set("txt md markdown csv tsv json log yaml yml toml ini xml vcf ics tex sql sh py js ts jsx tsx css swift java kt c cc cpp h go rs rb php".split(" "));
const TEXTUTIL_EXTS = new Set("doc docx rtf rtfd html htm odt wordml webarchive".split(" ")); // formats macOS textutil reads

function attachmentFromRow(a) {
  const name = a.name || basename(a.filename || "") || "attachment";
  const att = { type: a.mime || "file", name, path: a.filename ? a.filename.replace(/^~/, HOME) : null, size: Number(a.size) || 0 };
  att.kind = attachmentKind(att);
  return att;
}

function attachmentKind({ type, name }) {
  const ext = extname(name).slice(1).toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/") || ext === "caf") return "audio";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (TEXTUTIL_EXTS.has(ext)) return "document";
  if (type.startsWith("text/") || TEXT_EXTS.has(ext)) return "text";
  return "other";
}

const OPENABLE = new Set(["image", "pdf", "document", "text"]);
const isLocal = a => Boolean(a.path && existsSync(a.path));
const fmtSize = n => (!n ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function senderName(row, handles) {
  if (row.fromMe) return "Me";
  return displayHandle(handles.get(row.hid));
}

function hydrate(rows, handles) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);

  const attachments = new Map();
  const attRows = db().prepare(`
    SELECT maj.message_id mid, ${ATTACHMENT_COLUMNS}
    FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id IN (${placeholders(ids)}) AND ${REAL_ATTACHMENT}`).all(...ids);
  for (const a of attRows) {
    if (!attachments.has(a.mid)) attachments.set(a.mid, []);
    attachments.get(a.mid).push(attachmentFromRow(a));
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
  if (m.attachments.some(a => OPENABLE.has(a.kind))) lines.push(`    (open with view_attachments(message_id="#${m.id}"))`);
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

// Who a message goes to: an existing conversation, or (for a phone/email or a saved contact never
// messaged) a new handle. Shared by send, draft and schedule so they all pick the same recipient.
function resolveRecipient(recipient, message) {
  const to = String(recipient || "").trim();
  const text = String(message ?? "");
  if (!to || !text) throw new Error("recipient and message are required");
  try {
    const conv = resolveConversation(to);
    return { conv, text, label: describeConv(conv) };
  } catch (error) {
    let handle;
    if (isHandleLike(to)) {
      handle = to.includes("@") ? to.trim() : normalizePhone(to);
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
      handle = handles[0].includes("@") ? handles[0] : normalizePhone(handles[0]);
    }
    return { handle, text, label: `${contactFor(handle)?.name || handle} (${handle})` };
  }
}

// Sends through Messages.app: to an existing chat by its guid, or to a handle as a new iMessage.
// Needs nothing from chat.db, so the scheduler can call it with what was resolved at schedule time.
async function deliver({ chat_guid, handle, text }) {
  const script = chat_guid
    ? ['tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)']
    : ['tell application "Messages"', "set svc to 1st account whose service type = iMessage", "send (item 1 of argv) to participant (item 2 of argv) of svc", "end tell"];
  await execFileAsync("/usr/bin/osascript", [
    "-e", "on run argv", ...script.flatMap(line => ["-e", line]), "-e", "end run", text, chat_guid || handle,
  ], { timeout: 60000 });
}

async function sendMessage({ recipient, message }) {
  const r = resolveRecipient(recipient, message);
  // An existing conversation goes to its most recently active chat (iMessage, SMS, …).
  await deliver({ chat_guid: r.conv?.chats[0].guid, handle: r.handle, text: r.text });
  return r.conv ? `Sent to ${r.label}.` : `Sent to ${r.label}, new conversation via iMessage.`;
}

// Puts the text in the compose box of the right chat in Messages without sending it, through the
// sms: URL scheme Messages registers. Opening a URL needs no Automation or Accessibility permission,
// and nothing here can press Return: the person reads the draft in Messages and sends it themselves.
// Messages replaces whatever was already in that chat's compose box; an empty body doesn't clear it.
async function draftMessage({ recipient, message }) {
  const r = resolveRecipient(recipient, message);
  const chat = r.conv?.chats[0];
  let url;
  if (r.conv?.isGroup) {
    if (!chat.gid) throw new Error(`Can't open ${r.label} from outside Messages (it has no group id). Nothing was drafted.`);
    url = `sms://open?groupid=${encodeURIComponent(chat.gid)}&body=${encodeURIComponent(r.text)}`;
  } else {
    const handle = r.conv ? chat.ident || [...r.conv.handles][0] : r.handle;
    if (!handle) throw new Error(`Can't open ${r.label} from outside Messages (no phone number or email on it). Nothing was drafted.`);
    url = `sms:${handle}&body=${encodeURIComponent(r.text)}`;
  }
  await execFileAsync("/usr/bin/open", [url]);
  return `Draft placed in the compose box of ${r.label} in Messages, which is now open on that chat. Nothing was sent. ` +
    "Tell the person to check or edit it there and press Return to send it. " +
    "If that chat's compose box already held unsent text, the draft replaced it.";
}

// Claude reads JPEG/PNG/GIF/WebP, not HEIC or TIFF, so every image is converted to a JPEG with
// macOS's built-in sips, capped at 1568px on the long side (the size Claude processes anyway).
const MAX_IMAGE_EDGE = 1568;

function imageAsJpeg(path, tmp, i) {
  const out = join(tmp, `${i}.jpg`);
  execFileSync("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", String(MAX_IMAGE_EDGE), path, "--out", out], {
    stdio: "ignore",
  });
  return readFileSync(out).toString("base64");
}

// Text comes out of PDFs through PDFKit (via JavaScript for Automation) and out of Word/RTF/HTML
// through textutil, both built into macOS, so nothing extra needs installing.
const MAX_READ_BYTES = 50 * 1048576;

function extractText(a) {
  if (a.kind === "text") {
    const text = readFileSync(a.path, "utf8");
    if (text.includes("\u0000")) throw new Error("binary file");
    return text;
  }
  if (a.kind === "document") {
    return execFileSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", a.path], { encoding: "utf8", maxBuffer: 64 * 1048576, timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
  }
  return execFileSync("/usr/bin/osascript", [
    "-l", "JavaScript", "-e",
    'ObjC.import("PDFKit"); function run(argv) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])); ' +
      'if (!d || d.isNil()) throw new Error("not a readable PDF"); const s = d.string; return s && !s.isNil() ? ObjC.unwrap(s) : ""; }',
    a.path,
  ], { encoding: "utf8", maxBuffer: 64 * 1048576, timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
}

function messageWithAttachments(message_id) {
  const id = Number(String(message_id ?? "").replace("#", ""));
  if (!id) throw new Error('message_id is required, e.g. "#1234567" from read_conversation, search_messages or list_attachments');
  const index = conversationIndex();
  const row = db().prepare(`SELECT ${MESSAGE_COLUMNS} FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID WHERE m.ROWID = ?`).get(id);
  if (!row) throw new Error(`No message #${id}.`);
  const [m] = hydrate([row], index.handles);
  const where = index.byChatId.get(m.chatId)?.name || "unknown chat";
  return { m, header: `#${m.id} ${fmtDate(m.when)} [${where}] ${m.sender}: ${m.content || ""}`.trimEnd() };
}

const NOT_DOWNLOADED = "not downloaded on this Mac (it's in iCloud). Open the conversation in Messages to download it, then try again.";

function viewAttachments({ message_id, max_images = 4, max_chars = 20000 }) {
  const { m, header } = messageWithAttachments(message_id);
  if (!m.attachments.length) return `${header}\n(no attachments)`;
  const imageCap = Math.min(Number(max_images) || 4, 10);
  const charCap = Math.min(Number(max_chars) || 20000, 100000);

  const lines = [header];
  const images = [];
  const texts = [];
  const tmp = mkdtempSync(join(os.tmpdir(), "imessage-mcp-"));
  const addImage = (a, i, label) => {
    if (images.length >= imageCap) return lines.push(`- ${a.name}: skipped (max_images reached)`);
    images.push({ type: "image", data: imageAsJpeg(a.path, tmp, i), mimeType: "image/jpeg" });
    lines.push(`- ${a.name}: ${label}`);
  };
  try {
    m.attachments.forEach((a, i) => {
      const label = `${a.name} [${a.type}${a.size ? `, ${fmtSize(a.size)}` : ""}]`;
      if (!isLocal(a)) return lines.push(`- ${label}: ${NOT_DOWNLOADED}`);
      if (!OPENABLE.has(a.kind)) return lines.push(`- ${label}: ${a.kind} files can't be opened here; file at ${a.path} (save_attachment copies it out)`);
      try {
        if (a.kind === "image") return addImage(a, i, "shown below");
        if (statSync(a.path).size > MAX_READ_BYTES) return lines.push(`- ${label}: too large to read; file at ${a.path}`);
        const text = extractText(a).replace(/\r\n?/g, "\n").trim();
        // A PDF with no text layer is a scan or a picture: show its first page instead.
        if (!text && a.kind === "pdf") return addImage(a, i, "no text layer (scanned?), first page shown below");
        const cut = text.length > charCap;
        lines.push(`- ${label}: ${text ? `text below${cut ? ` (first ${charCap} of ${text.length} characters; raise max_chars for more)` : ""}` : "empty"}`);
        if (text) texts.push(`===== ${a.name} =====\n${cut ? text.slice(0, charCap) + "\n[…truncated]" : text}`);
      } catch {
        lines.push(`- ${label}: couldn't read this file; it's at ${a.path}`);
      }
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { content: [{ type: "text", text: [lines.join("\n"), ...texts].join("\n\n") }, ...images] };
}

// Copies keep the original file name; an existing file is never overwritten ("name (1).pdf" instead).
function saveAttachment({ message_id, destination = "~/Downloads", attachment }) {
  const { m, header } = messageWithAttachments(message_id);
  if (!m.attachments.length) return `${header}\n(no attachments)`;
  const dir = resolve(HOME, String(destination || "~/Downloads").trim().replace(/^~(?=\/|$)/, HOME));
  let picked = m.attachments;
  if (attachment != null && attachment !== "") {
    const n = Number(attachment);
    picked = Number.isInteger(n) && n >= 1 ? [m.attachments[n - 1]].filter(Boolean)
      : m.attachments.filter(a => a.name.toLowerCase().includes(String(attachment).toLowerCase()));
    if (!picked.length) throw new Error(`No attachment "${attachment}" on #${m.id}. It has: ${m.attachments.map((a, i) => `${i + 1}. ${a.name}`).join(", ")}`);
  }
  mkdirSync(dir, { recursive: true });
  const lines = [header];
  for (const a of picked) {
    if (!isLocal(a)) { lines.push(`- ${a.name}: ${NOT_DOWNLOADED}`); continue; }
    const ext = extname(a.name);
    const stem = basename(a.name, ext).replace(/[/:]/g, "-") || "attachment";
    for (let k = 0; ; k++) {
      const target = join(dir, k ? `${stem} (${k})${ext}` : `${stem}${ext}`);
      try {
        copyFileSync(a.path, target, fsConstants.COPYFILE_EXCL);
        lines.push(`- ${a.name} → ${target}`);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") { lines.push(`- ${a.name}: couldn't copy (${error.code || error.message})`); break; }
      }
    }
  }
  return lines.join("\n");
}

const KINDS = ["image", "video", "audio", "pdf", "document", "text", "other"];

function listAttachments({ conversation, type, query, from, since, before, limit = 50 } = {}) {
  const index = conversationIndex();
  const want = type ? String(type).toLowerCase().replace(/s$/, "") : null;
  if (want && want !== "file" && !KINDS.includes(want)) throw new Error(`type must be one of: files, ${KINDS.join(", ")}`);
  const params = [];
  let where = "";
  let scope = "all conversations";
  if (conversation) {
    const conv = resolveConversation(conversation, index);
    where += ` AND cmj.chat_id IN (${placeholders(conv.chatIds)})`;
    params.push(...conv.chatIds);
    scope = describeConv(conv);
  }
  if (from) {
    if (/^(me|myself|i)$/i.test(String(from).trim())) where += " AND m.is_from_me = 1";
    else if (/^(them|others)$/i.test(String(from).trim())) where += " AND m.is_from_me = 0";
    else throw new Error('from takes "me" or "them"; to see one person\'s attachments pass their name as conversation.');
  }
  if (query) { where += " AND ifnull(a.transfer_name, a.filename) LIKE ? ESCAPE '\\'"; params.push(likePattern(String(query).toLowerCase())); }
  const s = parseTime(since, "since");
  const b = parseTime(before, "before");
  if (s) { where += " AND m.date >= ?"; params.push(dateToApple(s)); }
  if (b) { where += " AND m.date < ?"; params.push(dateToApple(b)); }
  const max = Math.min(Number(limit) || 50, 500);
  // Kinds are decided from mime type and extension, so filter after fetching a wider window.
  const rows = db().prepare(`
    SELECT m.ROWID id, CAST(m.date AS REAL) date, m.is_from_me fromMe, m.handle_id hid, cmj.chat_id chatId, ${ATTACHMENT_COLUMNS}
    FROM attachment a JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
    JOIN message m ON m.ROWID = maj.message_id JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    WHERE m.item_type = 0 AND ${REAL_ATTACHMENT}${where}
    ORDER BY m.date DESC LIMIT ?`).all(...params, want ? Math.max(max * 20, 5000) : max);
  const matches = rows
    .map(r => ({ r, a: attachmentFromRow(r) }))
    .filter(({ a }) => !want || (want === "file" ? !["image", "video", "audio"].includes(a.kind) : a.kind === want))
    .slice(0, max);
  const lines = matches.map(({ r, a }) => {
    const sender = r.fromMe ? "Me" : displayHandle(index.handles.get(r.hid));
    const conv = conversation ? "" : ` [${index.byChatId.get(r.chatId)?.name || "unknown chat"}]`;
    const meta = [a.kind, fmtSize(a.size), isLocal(a) ? null : "in iCloud only"].filter(Boolean).join(", ");
    return `#${r.id} ${fmtDate(appleToDate(r.date))}${conv} ${sender}: ${a.name} (${meta})`;
  });
  return `${lines.length} attachment(s)${want ? ` of type ${type}` : ""} in ${scope}, newest first. ` +
    `Open one with view_attachments(message_id) or copy it out with save_attachment(message_id).\n\n${lines.join("\n") || "(none)"}`;
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
      // For update_contact. Several ids: the same name is saved as several cards (other accounts, or duplicates).
      ...(c.ids.length > 1 ? { ids: c.ids } : c.ids.length ? { id: c.ids[0] } : {}),
      ...(c.organization && c.organization !== c.name ? { organization: c.organization } : {}),
      phones: c.phones,
      emails: c.emails,
      conversation: conv ? { ref: conv.ref, last_active: fmtDate(appleToDate(conv.last)) } : null,
    };
  });
  return JSON.stringify(results, null, 2);
}

// ---------------------------------------------------------------- editing contacts
//
// Writes go through Apple's Contacts framework (CNContactStore), driven by JavaScript for Automation
// in /usr/bin/osascript. The AddressBook databases are never written: the framework saves, and syncs
// to iCloud/Google like an edit made in the Contacts app. It needs the Contacts privacy permission,
// which macOS asks for once on behalf of the app running this server (Claude, or the terminal or
// editor running the MCP client). Scripting the Contacts app instead would need the Automation
// permission, launch Contacts, can't pick an account and is slow on big address books.
// The framework hides contact notes from scripts (they need an Apple entitlement), so notes aren't editable.

const CONTACTS_FIX = "System Settings > Privacy & Security > Contacts";
const CONTACTS_DENIED = "macOS is blocking this server from Contacts, so nothing was changed. Tell the person to turn on the app running it " +
  `(Claude, or the terminal or editor running their assistant) in ${CONTACTS_FIX}, then try again.`;
const contactsTimeout = write => "Contacts didn't answer within a minute. macOS may be showing a dialog asking whether the app running this server " +
  "may access Contacts: tell the person to click OK (Allow), then try again. " +
  (write ? "The change may or may not have been saved: check with search_contacts before retrying." : "Nothing was changed.");

// Runs one request through the Contacts framework. Ops: status, accounts, get {id}, create {container,
// contact}, update {id, contact}. A contact is {first, last, organization, phones, emails}; phones and
// emails are [{id?, label, value}], where an entry with an id keeps that existing number or address.
const CONTACTS_JXA = String.raw`
ObjC.import("Contacts");
const S = $.CNContactStore.alloc.init;
const KEYS = [$.CNContactIdentifierKey, $.CNContactGivenNameKey, $.CNContactMiddleNameKey, $.CNContactFamilyNameKey,
  $.CNContactOrganizationNameKey, $.CNContactPhoneNumbersKey, $.CNContactEmailAddressesKey];
const str = v => (v == null || v.isNil()) ? "" : ObjC.unwrap(v);
function fail(err, what) {
  const e = new Error(what + ": " + (err.isNil() ? "unknown error" : str(err.localizedDescription)));
  e.code = err.isNil() ? 0 : Number(err.code);
  throw e;
}
function checkAccess() {
  const s = Number($.CNContactStore.authorizationStatusForEntityType(0)); // 0 not asked: the next call shows the prompt
  if (s === 1 || s === 2) { const e = new Error("Contacts access denied"); e.code = 100; throw e; }
}
function containers(pred) {
  const err = $();
  const r = S.containersMatchingPredicateError(pred || $(), err);
  if (r.isNil()) fail(err, "Couldn't list Contacts accounts");
  const out = [];
  for (let i = 0; i < Number(r.count); i++) out.push({ id: str(r.objectAtIndex(i).identifier), name: str(r.objectAtIndex(i).name) });
  return out;
}
function fetch(id) {
  const fr = $.CNContactFetchRequest.alloc.initWithKeysToFetch($(KEYS));
  fr.setPredicate($.CNContact.predicateForContactsWithIdentifiers($([id])));
  fr.setUnifyResults(false);
  let found = null;
  const err = $();
  if (!S.enumerateContactsWithFetchRequestErrorUsingBlock(fr, err, (c, stop) => { found = c; })) fail(err, "Couldn't read the contact");
  return found;
}
function values(arr, phone) {
  const out = [];
  for (let i = 0; i < Number(arr.count); i++) {
    const lv = arr.objectAtIndex(i);
    out.push({ id: str(lv.identifier), label: str(lv.label), value: phone ? str(lv.value.stringValue) : str(lv.value) });
  }
  return out;
}
function toJson(c) {
  const id = str(c.identifier);
  const acct = containers($.CNContainer.predicateForContainerOfContactWithIdentifier(id))[0];
  return { id, first: str(c.givenName), middle: str(c.middleName), last: str(c.familyName), organization: str(c.organizationName),
    phones: values(c.phoneNumbers, true), emails: values(c.emailAddresses, false), account: acct ? acct.name : "" };
}
function build(existing, list, wrap, what) {
  const byId = {};
  for (let i = 0; i < Number(existing.count); i++) byId[str(existing.objectAtIndex(i).identifier)] = existing.objectAtIndex(i);
  return $(list.map(x => {
    if (!x.id) return $.CNLabeledValue.labeledValueWithLabelValue(x.label, wrap(x.value));
    const old = byId[x.id];
    if (!old) throw new Error("A " + what + " on this contact changed while it was being edited; nothing was changed. Try again.");
    const cur = values($([old]), what === "phone")[0];
    if (cur.label === x.label && cur.value === x.value) return old;
    return x.label ? old.labeledValueBySettingLabelValue(x.label, wrap(x.value)) : old.labeledValueBySettingValue(wrap(x.value));
  }));
}
function apply(mc, want) {
  if (want.first != null) mc.setGivenName(want.first);
  if (want.last != null) mc.setFamilyName(want.last);
  if (want.organization != null) mc.setOrganizationName(want.organization);
  if (want.phones) mc.setPhoneNumbers(build(mc.phoneNumbers, want.phones, v => $.CNPhoneNumber.phoneNumberWithStringValue(v), "phone"));
  if (want.emails) mc.setEmailAddresses(build(mc.emailAddresses, want.emails, v => $(v), "email"));
}
function save(req) {
  const err = $();
  if (!S.executeSaveRequestError(req, err)) fail(err, "Contacts didn't save the change");
}
function handle(q) {
  if (q.op === "status") return { status: Number($.CNContactStore.authorizationStatusForEntityType(0)) };
  checkAccess();
  if (q.op === "accounts") return { default: str(S.defaultContainerIdentifier), accounts: containers() };
  if (q.op === "get") { const c = fetch(q.id); return { contact: c ? toJson(c) : null }; }
  if (q.op === "create") {
    const mc = $.CNMutableContact.alloc.init;
    apply(mc, q.contact);
    const req = $.CNSaveRequest.alloc.init;
    req.addContactToContainerWithIdentifier(mc, q.container);
    save(req);
    return { contact: toJson(fetch(str(mc.identifier))) };
  }
  if (q.op === "update") {
    const c = fetch(q.id);
    if (!c) throw new Error("That contact no longer exists; nothing was changed.");
    const mc = c.mutableCopy;
    apply(mc, q.contact);
    const req = $.CNSaveRequest.alloc.init;
    req.updateContact(mc);
    save(req);
    return { contact: toJson(fetch(q.id)) };
  }
  throw new Error("unknown op " + q.op);
}
function run(argv) {
  try { return JSON.stringify(handle(JSON.parse(argv[0]))); }
  catch (e) { return JSON.stringify({ error: String(e && e.message || e), code: e && e.code || 0 }); }
}`;

async function runContactsScript(request) {
  const write = request.op === "create" || request.op === "update";
  let stdout;
  try {
    ({ stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", CONTACTS_JXA, JSON.stringify(request)], { timeout: 60000 }));
  } catch (error) {
    if (error.killed) throw new Error(contactsTimeout(write));
    throw new Error(String(error.stderr || error.message).trim());
  }
  return contactsReply(stdout);
}

function contactsReply(stdout) {
  const r = JSON.parse(stdout);
  if (r.error) throw new Error(r.code === 100 ? CONTACTS_DENIED : r.error); // 100: CNErrorCodeAuthorizationDenied
  return r;
}

// For setup.js --check: never prompts. The answer is for the app that ran the check.
function contactsAccess() {
  try {
    const out = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", CONTACTS_JXA, JSON.stringify({ op: "status" })], { encoding: "utf8", timeout: 10000 });
    return { 0: "not asked yet", 1: "restricted", 2: "denied", 3: "allowed", 4: "limited" }[JSON.parse(out).status] || "unknown";
  } catch {
    return "unknown";
  }
}

const LABELS = {
  mobile: "_$!<Mobile>!$_", cell: "_$!<Mobile>!$_", iphone: "iPhone", home: "_$!<Home>!$_", work: "_$!<Work>!$_", main: "_$!<Main>!$_",
  other: "_$!<Other>!$_", school: "_$!<School>!$_", "home fax": "_$!<HomeFAX>!$_", "work fax": "_$!<WorkFAX>!$_", pager: "_$!<Pager>!$_",
};
const toLabel = l => LABELS[String(l).trim().toLowerCase()] || String(l).trim();
const showLabel = l => (l || "").replace(/^_\$!<(.*)>!\$_$/, "$1").replace(/FAX$/, " fax").toLowerCase() || "no label";

const asList = v => (v == null || v === "" ? [] : Array.isArray(v) ? v : [v]);
const trimmed = v => (v == null ? undefined : String(v).trim());
const sameValue = (kind, a, b) => (kind === "phone" ? phoneKey(a) === phoneKey(b) : a.trim().toLowerCase() === b.trim().toLowerCase());

function checkValue(kind, v) {
  const s = String(v ?? "").trim();
  if (kind === "phone" && !(/^[\d\s()+.\-]+$/.test(s) && s.replace(/\D/g, "").length >= 3)) throw new Error(`"${s}" isn't a phone number. Nothing was changed.`);
  if (kind === "email" && !/^[^\s@]+@[^\s@]+$/.test(s)) throw new Error(`"${s}" isn't an email address. Nothing was changed.`);
  return s;
}

// Phones or emails from tool input: "214 555 0100" or {value, label}. Default label: mobile / home.
function entries(input, kind) {
  return asList(input).map(e => {
    const value = checkValue(kind, typeof e === "object" ? e.value : e);
    const label = typeof e === "object" && e.label ? e.label : kind === "phone" ? "mobile" : "home";
    return { label: toLabel(label), value };
  });
}

const fullName = c => [c.first, c.middle, c.last].filter(Boolean).join(" ") || c.organization || "(no name)";
const showValues = list => list.map(x => `${showLabel(x.label)} ${x.value}`).join(", ") || "none";

function cardText(c) {
  const org = c.organization && c.organization !== fullName(c) ? ` (${c.organization})` : "";
  return `  ${fullName(c)}${org}\n  phones: ${showValues(c.phones)}\n  emails: ${showValues(c.emails)}\n` +
    `  id: ${c.id}${c.account ? `, account: ${c.account}` : ""}`;
}

const describeCard = c => `- ${fullName(c)}${c.organization && c.organization !== fullName(c) ? ` (${c.organization})` : ""}: ` +
  `phones ${showValues(c.phones)}; emails ${showValues(c.emails)} [id: ${c.id}]`;

const CONTACT_ID = /^[0-9a-f-]{36}:ABPerson$/i;

// Exactly one card, by id, phone, email or name; otherwise nothing is changed and the candidates are listed.
function resolveCard(input, cards) {
  const s = String(input || "").trim();
  if (!s) throw new Error("contact is required");
  let matches;
  if (CONTACT_ID.test(s)) {
    matches = cards.filter(c => c.id.toLowerCase() === s.toLowerCase());
  } else if (isHandleLike(s)) {
    const key = handleKey(s);
    matches = cards.filter(c => [...c.phones, ...c.emails].some(x => handleKey(x.value) === key));
  } else {
    const exact = cards.filter(c => c.name.toLowerCase() === s.toLowerCase());
    matches = exact.length ? exact : cards.filter(c => nameMatches(c.name, s));
  }
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`No contact matches "${s}". Nothing was changed. Find it with search_contacts.`);
  throw new Error(`"${s}" matches ${matches.length} contacts, so nothing was changed. Ask the person which one they mean, then pass its id as contact:\n` +
    matches.slice(0, 15).map(describeCard).join("\n") + (matches.length > 15 ? `\n…and ${matches.length - 15} more; be more specific.` : ""));
}

// Cards that already have one of these phone numbers (compared on the last 10 digits) or emails.
function findDuplicates(cards, { phones = [], emails = [] }) {
  return cards.filter(c => phones.some(p => c.phones.some(x => sameValue("phone", x.value, p.value))) ||
    emails.some(e => c.emails.some(x => sameValue("email", x.value, e.value))));
}

// The card as it should be after an update_contact call. Pure: throws (nothing changed) on any problem.
function planUpdate(before, args) {
  const after = { ...before, phones: before.phones.map(x => ({ ...x })), emails: before.emails.map(x => ({ ...x })) };
  for (const [arg, field] of [["first_name", "first"], ["last_name", "last"], ["organization", "organization"]]) {
    if (args[arg] != null) after[field] = String(args[arg]).trim();
  }
  for (const kind of ["phone", "email"]) {
    const key = `${kind}s`;
    const find = value => {
      const v = checkValue(kind, value);
      const hits = after[key].filter(x => sameValue(kind, x.value, v));
      if (!hits.length) throw new Error(`${fullName(before)} has no ${kind} ${v}. Nothing was changed. Their ${key}: ${showValues(before[key])}.`);
      return hits;
    };
    for (const v of asList(args[`remove_${key}`])) {
      const hits = find(typeof v === "object" ? v.value : v);
      after[key] = after[key].filter(x => !hits.includes(x)); // every copy of that number or address
    }
    for (const ch of asList(args[`change_${key}`])) {
      if (!ch || typeof ch !== "object" || ch.from == null) throw new Error(`change_${key} entries need "from" (the current ${kind}) and "to" and/or "label".`);
      if (ch.to == null && ch.label == null) throw new Error(`change_${key}: say what "${ch.from}" becomes with "to" and/or "label".`);
      const hits = find(ch.from);
      if (hits.length > 1) throw new Error(`${ch.from} is on ${fullName(before)} ${hits.length} times; remove the copies first. Nothing was changed.`);
      if (ch.to != null) hits[0].value = checkValue(kind, ch.to);
      if (ch.label != null) hits[0].label = toLabel(ch.label);
    }
    for (const e of entries(args[`add_${key}`], kind)) {
      if (after[key].some(x => sameValue(kind, x.value, e.value))) throw new Error(`${fullName(before)} already has ${kind} ${e.value}. Nothing was changed.`);
      after[key].push(e);
    }
  }
  if (!after.first && !after.last && !after.organization) throw new Error("A contact needs a first name, last name or company. Nothing was changed.");
  return after;
}

// What differs between two versions of a card, one line each. Phones and emails are matched by their
// id, so an entry without one (about to be added) counts as added.
function describeChange(before, after) {
  const lines = [];
  const q = s => (s ? `"${s}"` : "(empty)");
  if (fullName(before) !== fullName(after)) lines.push(`name: ${q(fullName(before))} → ${q(fullName(after))}`);
  if ((before.organization || "") !== (after.organization || "")) lines.push(`company: ${q(before.organization)} → ${q(after.organization)}`);
  for (const kind of ["phone", "email"]) {
    const old = before[`${kind}s`];
    const now = after[`${kind}s`];
    for (const x of now) {
      const was = x.id && old.find(o => o.id === x.id);
      if (!was) lines.push(`${kind} added: ${showLabel(x.label)} ${x.value}`);
      else if (was.value !== x.value || was.label !== x.label) lines.push(`${kind} changed: ${showLabel(was.label)} ${was.value} → ${showLabel(x.label)} ${x.value}`);
    }
    for (const o of old) if (!now.some(x => x.id === o.id)) lines.push(`${kind} removed: ${showLabel(o.label)} ${o.value}`);
  }
  return lines;
}

// After a save, Contacts writes the AddressBook database a moment later. Wait for it (up to 5 s) so
// the next search_contacts, and the names on messages, already show the change.
const cardKey = c => JSON.stringify([c.first || "", c.last || "", c.organization || "",
  c.phones.map(p => phoneKey(p.value)).sort(), c.emails.map(e => e.value.toLowerCase()).sort()]);

async function settleAddressBook(after, timeout = 5000) {
  const want = cardKey(after);
  for (const end = Date.now() + timeout; ;) {
    const card = contacts().cards.find(c => c.id === after.id);
    if (card && cardKey(card) === want) return true;
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, 150));
  }
}
const NOT_SETTLED = "\n\nContacts saved it, but its database hadn't caught up after 5 seconds, so search_contacts may show the old details for a moment.";

const CONTACT_DEPS = { run: runContactsScript, cards: () => contacts().cards, settle: settleAddressBook };

async function createContact(args, deps = CONTACT_DEPS) {
  const want = {
    first: trimmed(args.first_name) || "", last: trimmed(args.last_name) || "", organization: trimmed(args.organization) || "",
    phones: entries(args.phones, "phone"), emails: entries(args.emails, "email"),
  };
  if (!want.first && !want.last && !want.organization) throw new Error("first_name, last_name or organization is required");
  for (const kind of ["phone", "email"]) {
    const list = want[`${kind}s`];
    const dup = list.find((x, i) => list.findIndex(y => sameValue(kind, x.value, y.value)) !== i);
    if (dup) throw new Error(`${kind} ${dup.value} is listed twice. Nothing was created.`);
  }
  const existing = findDuplicates(deps.cards(), want);
  if (existing.length) {
    throw new Error(`Not created: ${existing.length === 1 ? "a contact" : `${existing.length} contacts`} already ${existing.length === 1 ? "has" : "have"} ` +
      `that phone number or email. Use update_contact with the id instead:\n${existing.map(describeCard).join("\n")}`);
  }
  const { default: def, accounts } = await deps.run({ op: "accounts" });
  let container = def;
  if (args.account) {
    const hit = accounts.find(a => a.name.toLowerCase() === String(args.account).trim().toLowerCase());
    if (!hit) throw new Error(`No Contacts account named "${args.account}". Accounts: ${accounts.map(a => a.name).join(", ")}. Nothing was created.`);
    container = hit.id;
  }
  const { contact } = await deps.run({ op: "create", container, contact: want });
  const settled = await deps.settle(contact);
  const where = container === def ? `${contact.account || "your"} (the default account)` : contact.account;
  return `Created a new contact in ${where}:\n${cardText(contact)}${settled ? "" : NOT_SETTLED}`;
}

async function updateContact(args, deps = CONTACT_DEPS) {
  const card = resolveCard(args.contact, deps.cards());
  const { contact: before } = await deps.run({ op: "get", id: card.id });
  if (!before) throw new Error(`Contact ${card.id} no longer exists in Contacts. Nothing was changed.`);
  const planned = planUpdate(before, args);
  if (!describeChange(before, planned).length) throw new Error(`Nothing to change: ${fullName(before)} already looks like that.`);
  const { contact: after } = await deps.run({ op: "update", id: card.id, contact: planned });
  const settled = await deps.settle(after);
  return `Updated ${fullName(after)}${after.account ? ` in ${after.account}` : ""}:\n` +
    describeChange(before, after).map(l => `- ${l}`).join("\n") +
    `\n\nBefore:\n${cardText(before)}\nAfter:\n${cardText(after)}${settled ? "" : NOT_SETTLED}`;
}

// ---------------------------------------------------------------- scheduled messages
//
// The queue is one JSON file. A per-user launchd agent runs `server.js --run-due` every minute while
// something is scheduled, so messages go out with every MCP client closed (the Mac must be on and
// awake). It's installed with the first scheduled message and removes itself once nothing is left.
// The agent starts /usr/bin/osascript, which starts node: macOS asks for the Automation permission
// ("control Messages") on behalf of that first process, and Apple's osascript keeps one identity
// across Node upgrades, where a grant to Homebrew's node would be lost on every `brew upgrade`.
//
// Every read-modify-write holds an exclusive kernel lock (released by macOS if the process dies) and
// replaces the file with an atomic rename. A due message is marked "sending" under the lock before it
// goes to Messages and removed once sent, so two runs can never both send it. If a run dies mid-send
// the message is marked "interrupted" for the person to check, and is never sent a second time.

const STATE_DIR = `${HOME}/Library/Application Support/imessage-mcp`;
const QUEUE_FILE = `${STATE_DIR}/scheduled.json`;
const AUTOMATION_FILE = `${STATE_DIR}/automation.json`;
const LOG_FILE = `${STATE_DIR}/scheduler.log`;
const AGENT_LABEL = "com.github.zohairrk5.imessage-mcp.scheduler";
const AGENT_PLIST = `${HOME}/Library/LaunchAgents/${AGENT_LABEL}.plist`;
const SERVER_PATH = fileURLToPath(import.meta.url);
const GRACE_MS = 15 * 6e4; // more than 15 minutes late (Mac asleep or off): don't send, report it
const STUCK_MS = 10 * 6e4; // a send times out after a minute, so a claim this old belongs to a dead run
const PENDING = new Set(["scheduled", "sending"]);
const O_EXLOCK = 0x20; // macOS open(2) flag: flock the file as it opens

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Runs fn(queue) under the lock; writes the queue back if fn returns { changed: true, ... }.
function withQueue(fn, file = QUEUE_FILE) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NONBLOCK | O_EXLOCK;
  let fd;
  for (const deadline = Date.now() + 10000; fd === undefined;) {
    try {
      fd = openSync(`${file}.lock`, flags, 0o600);
    } catch (error) {
      if (error.code !== "EAGAIN" || Date.now() > deadline) throw new Error(`Couldn't lock the scheduled-message queue (${error.code || error.message}); try again.`);
      sleepSync(25);
    }
  }
  try {
    let queue = { messages: [] };
    if (existsSync(file)) {
      try {
        queue = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(`The scheduled-message queue at ${file} is unreadable (${error.message}); fix or delete it.`);
      }
    }
    const result = fn(queue) || {};
    if (result.changed) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(queue, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, file);
    }
    return result;
  } finally {
    closeSync(fd);
  }
}

function addScheduled({ to, chat_guid, handle, text, send_at }, file) {
  const entry = {
    id: randomBytes(3).toString("hex"), to, ...(chat_guid ? { chat_guid } : { handle }), text,
    send_at: send_at.toISOString(), created_at: new Date().toISOString(), status: "scheduled",
  };
  return withQueue(q => {
    q.messages.push(entry);
    return { changed: true, entry, pending: q.messages.filter(m => PENDING.has(m.status)).length };
  }, file).entry;
}

function cancelScheduled(id, file) {
  const want = String(id || "").replace(/^#/, "").trim().toLowerCase();
  if (!want) throw new Error("id is required (from list_scheduled_imessages)");
  return withQueue(q => {
    const m = q.messages.find(x => x.id === want);
    if (!m) throw new Error(`No scheduled message ${want}. list_scheduled_imessages shows what's queued.`);
    if (m.status === "sending") throw new Error(`${want} is being sent right now and can't be cancelled.`);
    q.messages = q.messages.filter(x => x !== m);
    return { changed: true, removed: m, pending: q.messages.filter(x => PENDING.has(x.status)).length };
  }, file);
}

const readQueue = file => withQueue(q => ({ messages: q.messages }), file).messages;

// One pass over the queue: claim what's due, send it, and settle the rest.
//   send: async (entry) => void, throws on failure. canSend=false only flags overdue messages as missed
//   (the live server does that so the assistant hears about it even if the agent never ran).
async function runDue({ send, now = () => new Date(), file = QUEUE_FILE, canSend = true } = {}) {
  const out = { sent: [], missed: [], failed: [], interrupted: [] };
  const claimed = withQueue(q => {
    const t = now().getTime();
    const mine = [];
    let changed = false;
    for (const m of q.messages) {
      if (m.status === "sending" && (!isAlive(m.claimed_by) || t - Date.parse(m.claimed_at) > STUCK_MS)) {
        Object.assign(m, { status: "interrupted", error: "the sender stopped while handing this to Messages, so it may or may not have gone out" });
        out.interrupted.push(m);
        changed = true;
      } else if (m.status === "scheduled" && Date.parse(m.send_at) <= t) {
        if (t - Date.parse(m.send_at) > GRACE_MS) {
          Object.assign(m, { status: "missed", error: `the Mac was asleep, off or busy at ${fmtWhen(new Date(m.send_at))}, and it's more than ${GRACE_MS / 6e4} minutes late` });
          out.missed.push(m);
          changed = true;
        } else if (canSend) {
          Object.assign(m, { status: "sending", claimed_by: process.pid, claimed_at: new Date(t).toISOString() });
          mine.push(m.id);
          changed = true;
        }
      }
    }
    return { changed, mine };
  }, file).mine;

  for (const id of claimed) {
    const entry = readQueue(file).find(m => m.id === id);
    let error = null;
    try {
      await send(entry);
    } catch (e) {
      error = String(e.stderr || e.message || e).trim().split("\n").pop();
    }
    withQueue(q => {
      const m = q.messages.find(x => x.id === id);
      if (!error) q.messages = q.messages.filter(x => x !== m);
      else Object.assign(m, { status: "failed", error });
      return { changed: true };
    }, file);
    (error ? out.failed : out.sent).push({ ...entry, ...(error ? { status: "failed", error } : {}) });
  }
  return out;
}

// Missed, failed and interrupted messages the assistant hasn't been told about yet, marked as told.
function takeNotices(file = QUEUE_FILE) {
  if (!existsSync(file)) return [];
  return withQueue(q => {
    const fresh = q.messages.filter(m => !PENDING.has(m.status) && !m.reported);
    for (const m of fresh) m.reported = true;
    return { changed: fresh.length > 0, fresh };
  }, file).fresh;
}

function describeScheduled(m, now = new Date()) {
  const when = new Date(m.send_at);
  const due = m.status === "scheduled" ? (when > now ? ` (in ${fmtSpan(when - now)})` : " (due now)") : "";
  const state = m.status === "scheduled" ? "" : ` [${m.status.toUpperCase()}${m.error ? `: ${m.error}` : ""}]`;
  return `${m.id}  ${fmtWhen(when)}${due} → ${m.to}${state}\n    "${clip(m.text.replace(/\s+/g, " "), 200)}"`;
}

// ---- the launchd agent

const uid = () => process.getuid();
const launchctl = (...args) => spawnSync("/bin/launchctl", args, { encoding: "utf8" });
const agentLoaded = () => launchctl("print", `gui/${uid()}/${AGENT_LABEL}`).status === 0;
const xml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Homebrew's process.execPath is a versioned Cellar path that disappears on upgrade; use its stable link.
function stableNodePath() {
  const m = process.execPath.match(/^(.*)\/Cellar\/node[^/]*\/[^/]+\/bin\/node$/);
  return m && existsSync(`${m[1]}/bin/node`) ? `${m[1]}/bin/node` : process.execPath;
}

function agentPlist() {
  const args = [
    "/usr/bin/osascript", "-e", "on run argv",
    "-e", 'do shell script quoted form of item 1 of argv & " " & quoted form of item 2 of argv & " --run-due"',
    "-e", "return", "-e", "end run", stableNodePath(), SERVER_PATH, // "return": no empty result line in the log
  ];
  // Claude Desktop may run extensions on its own Electron binary, which acts as node only with this set.
  const env = { HOME, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG_FILE)}</string>
</dict>
</plist>
`;
}

// Writes and loads the agent; loading runs it once straight away (RunAtLoad).
function installAgent() {
  const plist = agentPlist();
  const current = existsSync(AGENT_PLIST) ? readFileSync(AGENT_PLIST, "utf8") : null;
  const loaded = agentLoaded();
  if (current === plist && loaded) return;
  mkdirSync(dirname(AGENT_PLIST), { recursive: true });
  writeFileSync(AGENT_PLIST, plist);
  if (loaded) launchctl("bootout", `gui/${uid()}/${AGENT_LABEL}`);
  const r = launchctl("bootstrap", `gui/${uid()}`, AGENT_PLIST);
  if (r.status !== 0 && !agentLoaded()) throw new Error(`Couldn't start the background sender (launchctl: ${(r.stderr || r.stdout).trim()}).`);
}

// Stops the agent. Called by the agent itself when the queue empties, so bootout (which ends this
// process) comes last, after the plist is gone.
function removeAgent() {
  rmSync(AGENT_PLIST, { force: true });
  if (agentLoaded()) launchctl("bootout", `gui/${uid()}/${AGENT_LABEL}`);
}

function readAutomation() {
  try {
    return JSON.parse(readFileSync(AUTOMATION_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Sends one harmless Apple Event to Messages, so macOS asks for the Automation permission while the
// person is scheduling rather than at send time. Records the outcome for schedule_imessage to report.
function probeAutomation() {
  writeFileSync(AUTOMATION_FILE, JSON.stringify({ status: "asking", at: new Date().toISOString() }));
  const r = spawnSync("/usr/bin/osascript", ["-e", 'tell application "Messages" to count of accounts'], { encoding: "utf8", timeout: 5 * 6e4 });
  const detail = (r.stderr || "").trim();
  const status = r.status === 0 ? "ok" : /-1743|not authori[sz]ed/i.test(detail) ? "denied" : "error";
  writeFileSync(AUTOMATION_FILE, JSON.stringify({ status, at: new Date().toISOString(), ...(status === "ok" ? {} : { detail }) }));
}

function log(line) {
  try {
    if (mtime(LOG_FILE) && statSync(LOG_FILE).size > 256 * 1024) rmSync(LOG_FILE);
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

// `server.js --run-due`: what the launchd agent runs. Logs ids and outcomes, never message text.
async function runDueFromAgent() {
  const send = entry => deliver(entry).catch(error => {
    throw /-1743/.test(String(error.stderr || error.message)) ? new Error(`macOS blocked the background sender from controlling Messages (${PERMISSION_FIX})`) : error;
  });
  const r = await runDue({ send });
  for (const m of r.sent) log(`sent ${m.id}`);
  for (const k of ["missed", "failed", "interrupted"]) for (const m of r[k]) log(`${k} ${m.id}: ${m.error}`);
  const { pending } = withQueue(q => {
    const pending = q.messages.filter(m => PENDING.has(m.status)).length;
    if (!pending) removeAgent(); // under the lock, so a message scheduled right now can't be stranded
    return { pending };
  });
  if (pending && readAutomation().status !== "ok") probeAutomation();
}

const PERMISSION_FIX = "System Settings > Privacy & Security > Automation > osascript > turn on Messages";
const SLEEP_NOTE = `It's sent by a background job within a minute of that time, even with Claude closed, as long as the Mac is on and awake. ` +
  `If the Mac is asleep or off then, it goes out on wake only if that's within ${GRACE_MS / 6e4} minutes; otherwise it isn't sent and is reported as missed.`;

// Waits briefly for the agent's permission check so the result can say whether sending will work.
function automationReport() {
  let a = readAutomation();
  if (a.status !== "ok") {
    launchctl("kickstart", `gui/${uid()}/${AGENT_LABEL}`);
    for (let i = 0; i < 40 && readAutomation().status !== "ok" && readAutomation().status !== "denied"; i++) sleepSync(250);
    a = readAutomation();
  }
  if (a.status === "ok") return "";
  if (a.status === "denied") {
    return `\n\nWARNING: macOS is blocking the background sender from controlling Messages, so this won't send. Tell the person to turn it on: ${PERMISSION_FIX}.`;
  }
  if (a.status === "error") {
    return `\n\nWARNING: the background sender couldn't reach Messages to check its permission (${a.detail || "unknown error"}). It will try again within a minute.`;
  }
  return "\n\nACTION NEEDED: macOS should now be showing a dialog asking whether “osascript” may control “Messages”. " +
    `Tell the person to click OK (Allow); until they do, scheduled messages can't be sent. If no dialog appears: ${PERMISSION_FIX}.`;
}

async function scheduleMessage({ recipient, message, send_at }) {
  const when = parseSendTime(send_at);
  const r = resolveRecipient(recipient, message);
  const entry = addScheduled({ to: r.label, chat_guid: r.conv?.chats[0].guid, handle: r.handle, text: r.text, send_at: when });
  try {
    withQueue(() => installAgent());
  } catch (error) {
    cancelScheduled(entry.id);
    throw new Error(`${error.message} Nothing was scheduled.`);
  }
  return `Scheduled ${entry.id}: to ${r.label} at ${fmtWhen(when)} (in ${fmtSpan(when - Date.now())}).\n` +
    `Text: "${r.text}"\n${SLEEP_NOTE} Cancel with cancel_scheduled_imessage("${entry.id}").${automationReport()}`;
}

function listScheduled() {
  const messages = existsSync(QUEUE_FILE) ? readQueue() : [];
  messages.sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
  const pending = messages.filter(m => PENDING.has(m.status)).length;
  const agent = pending ? (agentLoaded() ? "Background sender: running." : "Background sender: NOT running; schedule or cancel a message to restart it.") : "";
  if (!messages.length) return "Nothing scheduled.";
  return `${messages.length} scheduled message(s), soonest first. ${agent}\n\n${messages.map(m => describeScheduled(m)).join("\n")}` +
    (pending < messages.length ? "\n\nMissed, failed or interrupted messages stay listed until cancelled; cancel_scheduled_imessage removes them." : "");
}

function cancelScheduledTool({ id }) {
  const { removed, pending } = cancelScheduled(id);
  if (!pending) {
    withQueue(q => {
      if (!q.messages.some(m => PENDING.has(m.status))) removeAgent();
    });
  }
  return `Cancelled ${removed.id} (${removed.status}): to ${removed.to} at ${fmtWhen(new Date(removed.send_at))}. Nothing will be sent.`;
}

// For setup.js --check.
function schedulerStatus() {
  const messages = existsSync(QUEUE_FILE) ? readQueue() : [];
  return {
    pending: messages.filter(m => PENDING.has(m.status)).length,
    needs_attention: messages.filter(m => !PENDING.has(m.status)).length,
    agent_installed: existsSync(AGENT_PLIST),
    agent_loaded: agentLoaded(),
    automation: readAutomation().status || "not checked",
  };
}

// Appended to every tool result: overdue messages flagged as missed, plus any missed/failed/interrupted
// message the assistant hasn't mentioned yet. Never breaks the tool it's attached to.
async function scheduleNotices() {
  try {
    if (!existsSync(QUEUE_FILE)) return "";
    await runDue({ canSend: false });
    const fresh = takeNotices();
    if (!fresh.length) return "";
    return "\n\n---\nTell the person: these scheduled messages were NOT sent as planned:\n" +
      fresh.map(m => describeScheduled(m)).join("\n") +
      "\nThey stay in list_scheduled_imessages until cancelled. Ask before resending any (send_imessage); check the chat first for an interrupted one.";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- MCP wiring

const TIME_HINT = 'Relative ("24h", "7d", "2w", "today", "yesterday") or a date ("2026-10-01").';
const CONV_HINT = 'A contact name ("Alex"), a named group chat, a phone number or email, or a ref like "chat:123" from list_conversations.';
const LABEL_HINT = "Labels: mobile, iphone, home, work, main, other, school, home fax, work fax, pager, or any custom text.";
const LABELED = { type: "object", properties: { value: { type: "string" }, label: { type: "string" } }, required: ["value"] };
const CHANGE = { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } }, required: ["from"] };

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
    description: "Search contacts by name, phone number (any format) or email. Includes the ref of any existing conversation, and the contact's id for update_contact (ids, plural, when the same person is saved as several cards, in different accounts or as duplicates).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Name, phone, or email fragment" } },
      required: ["query"],
    },
    annotations: { title: "Search Contacts", readOnlyHint: true, openWorldHint: false },
    run: searchContactsTool,
  },
  {
    name: "create_contact",
    description: "Add a new contact to the Contacts app (syncs like any contact: iCloud, Google…). Goes into the default account unless account is given. " +
      "If a contact already has one of the phone numbers or emails, nothing is created and that contact is returned: use update_contact instead. " +
      "Confirm the exact name, numbers, emails and labels with the person before calling. The result shows the saved contact: read it back to them.",
    inputSchema: {
      type: "object",
      properties: {
        first_name: { type: "string", description: "First name" },
        last_name: { type: "string", description: "Last name" },
        organization: { type: "string", description: "Company" },
        phones: { type: "array", items: { anyOf: [{ type: "string" }, LABELED] }, description: `Phone numbers, e.g. ["214 555 0100"] or [{"value": "214 555 0100", "label": "work"}]. Label defaults to mobile. ${LABEL_HINT}` },
        emails: { type: "array", items: { anyOf: [{ type: "string" }, LABELED] }, description: `Emails, as strings or {value, label}. Label defaults to home. ${LABEL_HINT}` },
        account: { type: "string", description: 'Contacts account to save into, e.g. "iCloud", "Google", "On My Mac". Default: the default account set in Contacts' },
      },
    },
    annotations: { title: "Create Contact", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: args => createContact(args),
  },
  {
    name: "update_contact",
    description: "Change an existing contact in the Contacts app: name, company, and add, change or remove phone numbers and emails. " +
      "The contact must resolve to exactly one card; otherwise the candidates are returned with their ids and nothing changes, so ask the person which one and pass its id. " +
      "Confirm the exact change (which contact, old and new values) with the person before calling. The result lists every change with before and after: read it back to them. " +
      "Notes can't be edited (macOS doesn't let scripts read or write contact notes), and whole contacts can't be deleted.",
    inputSchema: {
      type: "object",
      properties: {
        contact: { type: "string", description: "The contact's id from search_contacts (exact), or a name, phone number or email that matches exactly one contact" },
        first_name: { type: "string", description: "New first name (\"\" clears it)" },
        last_name: { type: "string", description: "New last name (\"\" clears it)" },
        organization: { type: "string", description: "New company (\"\" clears it)" },
        add_phones: { type: "array", items: { anyOf: [{ type: "string" }, LABELED] }, description: `Phone numbers to add, as strings or {value, label}. Label defaults to mobile. ${LABEL_HINT}` },
        change_phones: { type: "array", items: CHANGE, description: 'Phone numbers to change: [{"from": "<current number, any format>", "to": "<new number>", "label": "work"}]; give to, label or both' },
        remove_phones: { type: "array", items: { type: "string" }, description: "Phone numbers to remove from this contact (any format; every copy of that number goes)" },
        add_emails: { type: "array", items: { anyOf: [{ type: "string" }, LABELED] }, description: `Emails to add, as strings or {value, label}. Label defaults to home. ${LABEL_HINT}` },
        change_emails: { type: "array", items: CHANGE, description: 'Emails to change: [{"from": "<current email>", "to": "<new email>", "label": "work"}]; give to, label or both' },
        remove_emails: { type: "array", items: { type: "string" }, description: "Emails to remove from this contact" },
      },
      required: ["contact"],
    },
    annotations: { title: "Update Contact", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: args => updateContact(args),
  },
  {
    name: "list_attachments",
    description: "Browse the files, photos and videos sent in a conversation (or across all of them), newest first, filtered by type, file name, sender or time range. Returns message ids for view_attachments and save_attachment.",
    inputSchema: {
      type: "object",
      properties: {
        conversation: { type: "string", description: `Limit to one conversation. ${CONV_HINT}` },
        type: { type: "string", enum: ["files", "image", "video", "audio", "pdf", "document", "text", "other"], description: '"files" means everything except photos, videos and audio; "document" is Word/RTF/HTML; "text" is Markdown, txt, CSV, JSON, code' },
        query: { type: "string", description: "Only attachments whose file name contains this" },
        from: { type: "string", description: '"me" (sent by me) or "them" (received)' },
        since: { type: "string", description: TIME_HINT },
        before: { type: "string", description: TIME_HINT },
        limit: { type: "number", description: "Max results (default 50, max 500)" },
      },
    },
    annotations: { title: "List Attachments", readOnlyHint: true, openWorldHint: false },
    run: listAttachments,
  },
  {
    name: "view_attachments",
    description: "Open the attachments on a message. Images (photos, screenshots, HEIC, GIF first frame) are shown so you can see them; PDFs, Word/RTF/HTML documents, Markdown, text, CSV, JSON and code are returned as text. Video, audio and other files are listed with their paths. Takes a message id from read_conversation, search_messages or list_attachments.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: 'Message id, e.g. "#1234567"' },
        max_images: { type: "number", description: "Max images to return (default 4, max 10)" },
        max_chars: { type: "number", description: "Max characters of text per file (default 20000, max 100000)" },
      },
      required: ["message_id"],
    },
    annotations: { title: "View Attachments", readOnlyHint: true, openWorldHint: false },
    run: viewAttachments,
  },
  {
    name: "save_attachment",
    description: "Copy a message's attachments (any file type) to a folder on this Mac, ~/Downloads by default. Keeps original file names and never overwrites an existing file.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: 'Message id, e.g. "#1234567"' },
        destination: { type: "string", description: 'Folder to copy into (default "~/Downloads"); created if missing' },
        attachment: { type: "string", description: "Only this attachment: its number on the message (1, 2, …) or part of its file name. Default: all" },
      },
      required: ["message_id"],
    },
    annotations: { title: "Save Attachment", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: saveAttachment,
  },
  {
    name: "send_imessage",
    description: "Send a message to a person or group chat via Messages.app, right now. The recipient must resolve to exactly one conversation (otherwise the candidates are returned and nothing is sent). A raw phone number or email with no history starts a new iMessage conversation. If the person wants to read and approve the message in the chat themselves, use draft_imessage instead; to send later, schedule_imessage.",
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
  {
    name: "draft_imessage",
    description: "Write a message into the compose box of a person's or group chat's conversation in Messages.app WITHOUT sending it. Messages opens on that chat; the person reads it, edits it if they like, and presses Return to send. Use this when the person wants to approve messages in the chat themselves. Resolves recipients exactly like send_imessage. Replaces any unsent text already in that chat's compose box.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: CONV_HINT },
        message: { type: "string", description: "Draft text" },
      },
      required: ["recipient", "message"],
    },
    annotations: { title: "Draft iMessage", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: draftMessage,
  },
  {
    name: "schedule_imessage",
    description: "Schedule a message to a person or group chat to be sent automatically at a later time, even if Claude is closed (the Mac must be on and awake; if it was asleep or off, the message is sent on wake only within 15 minutes, otherwise reported as missed). Confirm the exact wording, the recipient and the time with the person before scheduling. Resolves recipients exactly like send_imessage. The result echoes the time with its weekday: read it back to the person.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: CONV_HINT },
        message: { type: "string", description: "Message text" },
        send_at: { type: "string", description: 'When, in local time on this Mac: "in 2h", "45m", "tomorrow 9am", "today 18:30", "9:15pm", "2026-11-20 08:00", or ISO 8601 with an offset. Must be in the future.' },
      },
      required: ["recipient", "message", "send_at"],
    },
    annotations: { title: "Schedule iMessage", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    run: scheduleMessage,
  },
  {
    name: "list_scheduled_imessages",
    description: "List scheduled messages, soonest first, with their ids, recipients, send times and text, plus any that were missed, failed or interrupted.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List Scheduled iMessages", readOnlyHint: true, openWorldHint: false },
    run: listScheduled,
  },
  {
    name: "cancel_scheduled_imessage",
    description: "Cancel a scheduled message by id so it is never sent, or clear a missed/failed one from the list. To change a scheduled message, cancel it and schedule a new one.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Id from list_scheduled_imessages or schedule_imessage" } },
      required: ["id"],
    },
    annotations: { title: "Cancel Scheduled iMessage", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: cancelScheduledTool,
  },
];

const server = new Server(
  { name: "imessage-mcp", version: "1.4.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "The user's iMessage and SMS history from their Mac. Start with list_conversations or search_messages, " +
      "then read_conversation for full context. All senders are shown by contact name; 'Me' is the user. " +
      "Confirm wording and recipient with the user before send_imessage, and wording, recipient and time before schedule_imessage. " +
      "When the user wants to review or approve a message in the chat before it goes, use draft_imessage: it puts the text in Messages' compose box " +
      "and never sends. If a tool result reports scheduled messages that weren't sent, tell the user. " +
      "create_contact and update_contact change the user's real Contacts (synced to their phone): confirm the exact change with the user first, " +
      "never guess which contact (pass the id from search_contacts), and read the before/after in the result back to them.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ run, ...t }) => t),
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = TOOLS.find(t => t.name === request.params.name);
  if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
  let result;
  try {
    result = await tool.run(request.params.arguments || {});
    result = typeof result === "string" ? { content: [{ type: "text", text: result }] } : result;
  } catch (error) {
    result = { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
  const notice = await scheduleNotices();
  if (notice) result.content.push({ type: "text", text: notice.trim() });
  return result;
});

// Exposed for test/ and bin/setup.js, which import this file with IMESSAGE_MCP_IMPORT=1.
export { parseSendTime, fmtWhen, withQueue, addScheduled, cancelScheduled, readQueue, runDue, takeNotices, schedulerStatus, GRACE_MS };
export { createContact, updateContact, resolveCard, findDuplicates, planUpdate, describeChange, contactsReply, contactsTimeout, contactsAccess, phoneKey };

if (process.env.IMESSAGE_MCP_IMPORT === "1") {
  // imported as a module: don't start anything
} else if (process.argv[2] === "--run-due") {
  await runDueFromAgent();
} else if (process.argv[2] === "--cli") {
  // Local testing: node server.js --cli <tool> '<json args>'
  const tool = TOOLS.find(t => t.name === process.argv[3]);
  if (!tool) {
    console.error(`Tools: ${TOOLS.map(t => t.name).join(", ")}`);
    process.exit(1);
  }
  const result = await tool.run(JSON.parse(process.argv[4] || "{}"));
  if (typeof result === "string") console.log(result);
  else for (const c of result.content) console.log(c.type === "text" ? c.text : `[${c.mimeType} image, ${Math.round(c.data.length * 0.75 / 1024)} KB]`);
  const notice = await scheduleNotices();
  if (notice) console.log(notice.trim());
} else {
  await server.connect(new StdioServerTransport());
}
