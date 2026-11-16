// Tests for rename_group_chat: resolving exactly one iMessage group, refusing one-to-one chats, SMS/RCS
// groups and groups Messages no longer lists, the selected-chat checks before opening the sheet and
// before confirming, every abort path (Cancel pressed, the previous app back in front), the after-check
// against chat.db and the permission wording. Plain node: `npm test`. Never touches Messages: the
// Accessibility steps, opening URLs, chat.db and the conversation index are fakes.
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

// A conversation index shaped like conversationIndex()'s.
function fakeIndex() {
  const convs = new Map();
  const byChatId = new Map();
  const add = (key, conv) => {
    conv = { key, chatIds: conv.chats.map(c => c.id), last: 1, handles: new Set(), members: ["Ann", "Bob"], ...conv };
    convs.set(key, conv);
    for (const c of conv.chats) byChatId.set(c.id, conv);
  };
  const group = (id, name, service = "iMessage", gid = `G${id}`) => add(`chat:${id}`, {
    isGroup: true, displayName: name || null, name: name || "Ann, Bob", ref: `chat:${id}`, chats: [{ id, guid: `any;+;chat${id}`, gid, service }],
  });
  group(1, "Acme Leads");
  group(2, "Soccer Parents", "SMS");
  group(3, "Book Club", "RCS");
  group(4, "Acme Prospects East");
  group(5, "Acme Prospects West");
  group(6, "");
  group(7, "No Group Id", "iMessage", null);
  group(8, "Gone");
  add("h:+12145550100", { isGroup: false, name: "+12145550100", ref: "+12145550100", chats: [{ id: 9, gid: null, service: "iMessage" }] });
  return { convs, byChatId, handles: new Map() };
}

const MESSAGES = "com.apple.MobileSMS";

// Messages as the Accessibility steps see it. `steps` overrides what an op returns ({ op: result or
// fn(q) }); by default the group shows, the sheet opens, takes the name and closes on Done, and Done
// writes the name to the fake chat.db (unless `applies` is false).
function fakeDeps({ steps = {}, applies = true, front = "com.google.Chrome", unnamed = false, now } = {}) {
  const names = new Map([[1, "Acme Leads"], [4, "Acme Prospects East"], [6, ""], [8, "Gone"]]);
  const ops = [];
  const opened = [];
  let sheet = false;
  const chatId = () => (unnamed ? 6 : 1);
  const title = unnamed ? "Ann & Bob" : "Acme Leads";
  const base = () => ({ front: MESSAGES, title, heading: unnamed ? "2 People" : names.get(1), sheet });
  const defaults = {
    state: q => ({ ...base(), wrong: q.expect ? "" : undefined }),
    openSheet: () => { sheet = true; return { ...base(), sheet: false, ok: true }; },
    fill: q => ({ ...base(), ok: true, value: q.name, done: true }),
    confirm: q => { sheet = false; if (applies) names.set(chatId(), q.name); return { ...base(), ok: true }; },
    cancel: () => { const was = sheet; sheet = false; return { ...base(), cancelled: was, sheet: false }; },
    activate: () => ({ ok: true }),
  };
  let first = true;
  return {
    ops, opened, names,
    index: fakeIndex,
    hasMessages: id => id !== 8,
    state: id => ({ name: names.get(id) ?? "" }),
    host: () => "Cursor",
    now: now || (() => 0),
    sleep: async () => {},
    open: async url => { opened.push(url); },
    ax: async q => {
      ops.push(q);
      if (q.op === "state" && first && !q.expect) { first = false; return { ...base(), front }; }
      const r = steps[q.op] ?? defaults[q.op];
      return typeof r === "function" ? r(q, defaults) : r;
    },
  };
}
const opNames = d => d.ops.map(q => q.op);

await test("renames a named group: checks it before the sheet and before Done, puts the old app back", async () => {
  const d = fakeDeps();
  const out = await S.renameGroupChat({ conversation: "chat:1", name: "  Dallas   Expo 2026 " }, d);
  assert.deepEqual(d.opened, ["sms://open?groupid=G1"]);
  assert.deepEqual(opNames(d), ["state", "state", "state", "openSheet", "state", "fill", "confirm", "state", "activate"]);
  const [open, fill, confirm] = ["openSheet", "fill", "confirm"].map(op => d.ops.find(q => q.op === op));
  assert.deepEqual(open.expect, { name: "Acme Leads" });
  assert.deepEqual(fill.expect, { name: "Acme Leads", window: "Acme Leads" });
  assert.equal(fill.current, "Acme Leads");
  assert.equal(fill.name, "Dallas Expo 2026");
  assert.deepEqual(confirm.expect, fill.expect);
  assert.equal(d.ops.at(-1).app, "com.google.Chrome");
  assert.match(out, /Renamed group chat:1\.\nBefore: "Acme Leads"\nAfter: "Dallas Expo 2026"\nEveryone in the group sees/);
});

await test("unnamed group: identified by its window title and the 'N People' heading", async () => {
  const d = fakeDeps({ unnamed: true });
  const out = await S.renameGroupChat({ conversation: "chat:6", name: "Q3 Leads" }, d);
  const open = d.ops.find(q => q.op === "openSheet");
  assert.deepEqual(open.expect, { title: "Ann & Bob" });
  assert.equal(d.ops.find(q => q.op === "fill").current, "");
  assert.match(out, /Before: no name \(shown as Ann, Bob\)\nAfter: "Q3 Leads"/);
});

await test("unnamed group whose window shows something else: stops before opening the sheet", async () => {
  const d = fakeDeps({ unnamed: true, steps: { state: q => ({ front: MESSAGES, title: "zohair@example.com", heading: "", sheet: false, wrong: q.expect ? "" : undefined }) } });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:6", name: "Q3" }, d),
    /Stopped before changing anything: Messages didn't show the unnamed group Ann, Bob \(it shows "zohair@example.com"\)\. Nothing was changed/);
  assert.ok(!opNames(d).includes("openSheet"));
  assert.ok(opNames(d).includes("cancel"));
  assert.equal(d.ops.at(-1).op, "activate");
});

await test("Messages never shows the group: stops before opening the sheet", async () => {
  const d = fakeDeps({ steps: { state: q => ({ front: MESSAGES, title: "Other", heading: "Other", sheet: false, wrong: q.expect ? 'Messages shows "Other"' : undefined }) } });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d),
    /Messages didn't show "Acme Leads" \(Messages shows "Other"\)\. Nothing was changed: chat\.db still shows "Acme Leads"\./);
  assert.ok(!opNames(d).includes("openSheet"));
});

await test("check before the sheet fails (chat switched, Messages not in front): Cancel, nothing changed", async () => {
  const d = fakeDeps({ steps: { openSheet: { front: "com.google.Chrome", abort: "Messages isn't the frontmost app" } } });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d),
    /^Error: Stopped before changing anything: Messages isn't the frontmost app\. Nothing was changed: chat\.db still shows "Acme Leads"\.$/);
  assert.deepEqual(opNames(d).slice(-3), ["openSheet", "cancel", "activate"]);
  assert.equal(d.names.get(1), "Acme Leads");
});

await test("check before Done fails: Cancel (and Discard), never confirmed", async () => {
  let confirmed = false;
  const d = fakeDeps({ steps: { confirm: () => { confirmed = true; return { abort: "Messages' window changed to \"Other\"" }; } } });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d),
    /Stopped before changing anything: Messages' window changed to "Other"\. Nothing was changed/);
  assert.ok(confirmed);
  assert.deepEqual(opNames(d).slice(-2), ["cancel", "activate"]);
  assert.equal(d.names.get(1), "Acme Leads");
});

await test("the name field doesn't take the name exactly (autocapitalised): never confirmed", async () => {
  const d = fakeDeps({ steps: { fill: q => ({ ok: true, value: q.name[0].toUpperCase() + q.name.slice(1), done: true }) } });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "acme" }, d), /name field didn't take the new name\. Nothing was changed/);
  assert.ok(!opNames(d).includes("confirm"));
});

await test("Done stays disabled: never confirmed", async () => {
  const d = fakeDeps({ steps: { fill: q => ({ ok: true, value: q.name, done: false }) } });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d), /didn't take the new name/);
  assert.ok(!opNames(d).includes("confirm"));
});

await test("the sheet never opens: stops, Cancel, nothing changed", async () => {
  const d = fakeDeps({ steps: { openSheet: { ok: true, title: "Acme Leads" } } });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d), /the Edit Name & Photo sheet didn't open\. Nothing was changed/);
  assert.ok(!opNames(d).includes("fill"));
});

await test("a step that fails or times out in osascript: short reason, not the script", async () => {
  const err = Object.assign(new Error("Command failed: /usr/bin/osascript -l JavaScript -e <script>"), { cmd: "/usr/bin/osascript ..." });
  const d = fakeDeps({ steps: { fill: () => { throw err; } } });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d),
    /^Error: Stopped: a step in Messages failed or took more than 5 seconds\. Nothing was changed: chat\.db still shows "Acme Leads"\.$/);
  assert.deepEqual(opNames(d).slice(-2), ["cancel", "activate"]);
});

await test("overall timeout: stops between steps", async () => {
  let t = 0;
  const d = fakeDeps({ now: () => (t += 9000) });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d), /Stopped: Messages took more than 20 seconds\. Nothing was changed/);
  assert.ok(!opNames(d).includes("confirm"));
});

await test("Cancel can't close the sheet: says so", async () => {
  const d = fakeDeps({ steps: { fill: { abort: "the sheet's name field didn't take the keyboard focus" }, cancel: { sheet: true } } });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d), /keyboard focus\. Nothing was changed.*may still show the Edit Name & Photo sheet/);
});

await test("Done pressed but chat.db never shows the name: reported as NOT renamed", async () => {
  const d = fakeDeps({ applies: false });
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d), /after 5 seconds chat\.db still names chat:1 "Acme Leads", so treat it as NOT renamed/);
});

await test("a stop after chat.db already changed says so instead of 'nothing changed'", async () => {
  const d = fakeDeps();
  const ax = d.ax;
  d.ax = async q => {
    if (q.op === "state" && opNames(d).includes("confirm")) throw new Error("late failure.");
    return ax(q);
  };
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d), /late failure\. But chat\.db now names chat:1 "New" \(it was "Acme Leads"\)/);
});

await test("Messages already in front: nothing to put back", async () => {
  const d = fakeDeps({ front: MESSAGES });
  await S.renameGroupChat({ conversation: "chat:1", name: "New" }, d);
  assert.ok(!opNames(d).includes("activate"));
});

await test("no Accessibility permission: names the app and where to turn it on, opens nothing", async () => {
  const d = fakeDeps({ steps: {} });
  d.ax = async q => { d.ops.push(q); return { front: "com.todesktop.cursor", denied: true }; };
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "New" }, d),
    /isn't letting this server control Messages' window, so nothing was changed\..*System Settings > Privacy & Security > Accessibility, turn on Cursor.*Don't try to change the setting yourself/);
  assert.equal(d.opened.length, 0);
});

const refusals = [
  ["one-to-one chat", "chat:9", /is a one-to-one conversation, not a group chat.*Nothing was changed/],
  ["SMS group", "chat:2", /Soccer Parents is an SMS group \(green bubbles\).*Nothing was changed/],
  ["RCS group", "chat:3", /Book Club is an RCS group/],
  ["group without a group id", "chat:7", /has no group id\)\. Nothing was changed/],
  ["group Messages no longer lists", "chat:8", /Messages no longer lists Gone.*Nothing was changed/],
  ["ambiguous name", "Acme Prospects", /matches 2 conversations; pass one ref/],
  ["unknown chat", "chat:999", /No chat with id chat:999/],
];
for (const [what, conversation, re] of refusals) {
  await test(`refuses: ${what}, before touching Messages`, async () => {
    const d = fakeDeps();
    await assert.rejects(S.renameGroupChat({ conversation, name: "New" }, d), re);
    assert.equal(d.ops.length + d.opened.length, 0);
  });
}

await test("refuses an empty name and the name it already has, before touching Messages", async () => {
  const d = fakeDeps();
  await assert.rejects(S.renameGroupChat({ conversation: "chat:1", name: "  " }, d), /name is required/);
  await assert.rejects(S.renameGroupChat({ conversation: "Acme Leads", name: "Acme Leads" }, d), /Nothing to change: chat:1 is already named "Acme Leads"/);
  assert.equal(d.ops.length + d.opened.length, 0);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
