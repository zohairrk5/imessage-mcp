// Tests for draft_imessage: a group draft only goes in once Messages' window shows that group, and a
// group Messages can't open is refused instead of drafted into a New Message window. Plain node:
// `npm test`. Never touches Messages: opening URLs, reading the window title and chat.db are fakes.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const tmp = mkdtempSync(join(os.tmpdir(), "imessage-mcp-test-"));
process.env.HOME = tmp;
process.env.IMESSAGE_MCP_IMPORT = "1";
const S = await import(new URL("../server.js", import.meta.url).href);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.stack.split("\n").slice(0, 3).join("\n     ")}`);
  }
}

const named = { isGroup: true, displayName: "Pakistan Trip", name: "Pakistan Trip", handles: new Set(), chats: [{ id: 68, gid: "D579-68" }] };
const unnamed = { isGroup: true, displayName: null, name: "Saad, Abrahim", handles: new Set(), chats: [{ id: 5, gid: "2B44-5" }] };
const noGid = { isGroup: true, displayName: "Old", name: "Old", handles: new Set(), chats: [{ id: 7, gid: null }] };
const person = { isGroup: false, name: "Ann", handles: new Set(["+15551234567"]), chats: [{ id: 9, ident: "+15551234567" }] };

// titles: what each read of Messages' window returns, in order (the last one repeats).
function deps(conv, { titles = [""], messages = true } = {}) {
  const opened = [];
  let reads = 0;
  return {
    opened,
    resolve: (to, text) => ({ conv, text, label: `${conv.name} [ref: chat:${conv.chats[0].id}]` }),
    hasMessages: () => messages,
    title: async () => titles[Math.min(reads++, titles.length - 1)],
    open: async url => { opened.push(url); },
    sleep: async () => {},
  };
}

await test("named group: opens without text, checks the title, then drafts", async () => {
  const d = deps(named, { titles: ["", "Pakistan Trip"] });
  const out = await S.draftMessage({ recipient: "chat:68", message: "hi there" }, d);
  assert.deepEqual(d.opened, ["sms://open?groupid=D579-68", "sms://open?groupid=D579-68&body=hi%20there"]);
  assert.match(out, /window shows "Pakistan Trip"/);
});

await test("group Messages opens as a New Message window: refused, no text sent to Messages", async () => {
  const d = deps(named, { titles: ["zohair@example.com"] });
  await assert.rejects(S.draftMessage({ recipient: "chat:68", message: "hi" }, d), /opened "zohair@example.com" instead of Pakistan Trip.*nothing was drafted/);
  assert.equal(d.opened.length, 1);
  assert.ok(!d.opened[0].includes("body="));
});

await test("group with no messages left in chat.db: refused before opening anything", async () => {
  const d = deps(named, { messages: false });
  await assert.rejects(S.draftMessage({ recipient: "chat:68", message: "hi" }, d), /no messages are left in it.*Nothing was drafted/);
  assert.equal(d.opened.length, 0);
});

await test("group with no group id: refused before opening anything", async () => {
  const d = deps(noGid);
  await assert.rejects(S.draftMessage({ recipient: "chat:7", message: "hi" }, d), /no group id/);
  assert.equal(d.opened.length, 0);
});

await test("unnamed group: a members title counts, an address or blank window doesn't", async () => {
  const d = deps(unnamed, { titles: ["Saad & Abrahim"] });
  await S.draftMessage({ recipient: "chat:5", message: "yo" }, d);
  assert.equal(d.opened.length, 2);
  await assert.rejects(S.draftMessage({ recipient: "chat:5", message: "yo" }, deps(unnamed, { titles: [""] })), /opened no window instead/);
  await assert.rejects(S.draftMessage({ recipient: "chat:5", message: "yo" }, deps(unnamed, { titles: ["+1 (555) 123-4567"] })), /instead of/);
});

await test("window title unreadable (no permission): drafts but says to check the chat first", async () => {
  const d = deps(named, { titles: [null] });
  const out = await S.draftMessage({ recipient: "chat:68", message: "hi" }, d);
  assert.equal(d.opened.length, 2);
  assert.match(out, /couldn't confirm which chat opened.*Pakistan Trip before pressing Return/);
});

await test("one-to-one: one sms: link with the text, no window check", async () => {
  const d = deps(person, { titles: ["should not be read"] });
  await S.draftMessage({ recipient: "Ann", message: "a&b" }, d);
  assert.deepEqual(d.opened, ["sms:+15551234567&body=a%26b"]);
});

await test("titleShowsGroup", () => {
  assert.ok(S.titleShowsGroup("Hawk fans", { displayName: "Hawk fans " }));
  assert.ok(!S.titleShowsGroup("Hawk", { displayName: "Hawk fans" }));
  assert.ok(S.titleShowsGroup("Ann, Bob & 2 more", { displayName: null }));
  assert.ok(!S.titleShowsGroup("New Message", { displayName: null }));
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
