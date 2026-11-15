// Tests for scheduled messages: time parsing, the queue, due selection, the grace window, and the
// never-send-twice guarantees. Plain node, no framework: `npm test`. Never touches Messages: every
// send is a stub, and HOME points at a temp folder so the real queue is never read or written.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const tmp = mkdtempSync(join(os.tmpdir(), "imessage-mcp-test-"));
process.env.HOME = tmp;
process.env.IMESSAGE_MCP_IMPORT = "1";
const SERVER = new URL("../server.js", import.meta.url).href;
const S = await import(SERVER);

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

let n = 0;
const freshFile = () => join(tmp, `q${++n}`, "scheduled.json");
const MIN = 6e4;
const at = (base, mins) => new Date(base.getTime() + mins * MIN);

// ---- time parsing (now = Sunday 2026-11-15 14:00 local)
const NOW = new Date(2026, 10, 15, 14, 0, 0);

await test("relative times, with and without 'in'", () => {
  assert.equal(S.parseSendTime("in 2h", NOW).getTime(), at(NOW, 120).getTime());
  assert.equal(S.parseSendTime("45m", NOW).getTime(), at(NOW, 45).getTime());
  assert.equal(S.parseSendTime("in 90 minutes", NOW).getTime(), at(NOW, 90).getTime());
  assert.equal(S.parseSendTime("1d", NOW).getTime(), at(NOW, 1440).getTime());
});

await test("clock times: today, tonight, tomorrow, am/pm, 24h", () => {
  assert.deepEqual(S.parseSendTime("tomorrow 9am", NOW), new Date(2026, 10, 16, 9, 0));
  assert.deepEqual(S.parseSendTime("today 18:30", NOW), new Date(2026, 10, 15, 18, 30));
  assert.deepEqual(S.parseSendTime("9:15pm", NOW), new Date(2026, 10, 15, 21, 15));
  assert.deepEqual(S.parseSendTime("tonight at 11pm", NOW), new Date(2026, 10, 15, 23, 0));
  assert.deepEqual(S.parseSendTime("tomorrow 12am", NOW), new Date(2026, 10, 16, 0, 0));
  assert.deepEqual(S.parseSendTime("tomorrow 12pm", NOW), new Date(2026, 10, 16, 12, 0));
});

await test("dates with a time: local, ISO T, ISO with offset", () => {
  assert.deepEqual(S.parseSendTime("2026-11-20 08:00", NOW), new Date(2026, 10, 20, 8, 0));
  assert.deepEqual(S.parseSendTime("2026-11-20T08:05", NOW), new Date(2026, 10, 20, 8, 5));
  assert.equal(S.parseSendTime("2026-11-20T08:00:00Z", NOW).toISOString(), "2026-11-20T08:00:00.000Z");
});

await test("past times are rejected and the message shows the resolved time with weekday", () => {
  assert.throws(() => S.parseSendTime("9am", NOW), /Sun 2026-11-15 09:00.*in the past/);
  assert.throws(() => S.parseSendTime("2026-11-01 10:00", NOW), /in the past/);
});

await test("ambiguous or invalid input is rejected", () => {
  assert.throws(() => S.parseSendTime("2026-11-20", NOW), /no time of day/);
  assert.throws(() => S.parseSendTime("tomorrow 9", NOW), /Couldn't parse/);
  assert.throws(() => S.parseSendTime("13pm", NOW), /Couldn't parse/);
  assert.throws(() => S.parseSendTime("25:00", NOW), /Couldn't parse/);
  assert.throws(() => S.parseSendTime("whenever", NOW), /Couldn't parse/);
  assert.throws(() => S.parseSendTime("", NOW), /required/);
});

await test("fmtWhen shows weekday, date, time and zone", () => {
  assert.match(S.fmtWhen(new Date(2026, 10, 16, 9, 0)), /^Mon 2026-11-16 09:00 \S+/);
});

// ---- queue
const entry = (send_at, extra = {}) => ({ to: "Test (+15555550100)", handle: "+15555550100", text: "imessage-mcp test", send_at, ...extra });

await test("add, list and cancel", () => {
  const file = freshFile();
  const a = S.addScheduled(entry(at(NOW, 10)), file);
  const b = S.addScheduled(entry(at(NOW, 20)), file);
  assert.match(a.id, /^[0-9a-f]{6}$/);
  assert.equal(a.status, "scheduled");
  assert.deepEqual(S.readQueue(file).map(m => m.id), [a.id, b.id]);
  const { removed, pending } = S.cancelScheduled(a.id, file);
  assert.equal(removed.id, a.id);
  assert.equal(pending, 1);
  assert.deepEqual(S.readQueue(file).map(m => m.id), [b.id]);
  assert.throws(() => S.cancelScheduled(a.id, file), /No scheduled message/);
  assert.equal(readFileSync(file, "utf8").includes(".tmp"), false);
});

await test("the queue file is private (0600)", () => {
  const file = freshFile();
  S.addScheduled(entry(at(NOW, 10)), file);
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

// ---- due selection and the grace window
await test("only due messages are sent; sent ones leave the queue", async () => {
  const file = freshFile();
  const due = S.addScheduled(entry(at(NOW, -1)), file);
  const later = S.addScheduled(entry(at(NOW, 5)), file);
  const sent = [];
  const r = await S.runDue({ file, now: () => NOW, send: async m => sent.push(m.id) });
  assert.deepEqual(sent, [due.id]);
  assert.deepEqual(r.sent.map(m => m.id), [due.id]);
  assert.deepEqual(S.readQueue(file).map(m => [m.id, m.status]), [[later.id, "scheduled"]]);
});

await test("within the grace window (14 min late) it's sent; beyond it (16 min) it's missed, not sent", async () => {
  const file = freshFile();
  const ok = S.addScheduled(entry(at(NOW, -14)), file);
  const late = S.addScheduled(entry(at(NOW, -16)), file);
  const sent = [];
  const r = await S.runDue({ file, now: () => NOW, send: async m => sent.push(m.id) });
  assert.deepEqual(sent, [ok.id]);
  assert.deepEqual(r.missed.map(m => m.id), [late.id]);
  const q = S.readQueue(file);
  assert.equal(q.length, 1);
  assert.equal(q[0].status, "missed");
  // A later run never sends a missed message.
  await S.runDue({ file, now: () => at(NOW, 1), send: async m => sent.push(m.id) });
  assert.deepEqual(sent, [ok.id]);
});

await test("canSend=false (live server) flags missed messages but sends nothing", async () => {
  const file = freshFile();
  S.addScheduled(entry(at(NOW, -1)), file);
  S.addScheduled(entry(at(NOW, -30)), file);
  const r = await S.runDue({ file, now: () => NOW, canSend: false, send: async () => assert.fail("sent") });
  assert.equal(r.missed.length, 1);
  assert.deepEqual(S.readQueue(file).map(m => m.status).sort(), ["missed", "scheduled"]);
});

await test("a failed send is kept as failed and not retried", async () => {
  const file = freshFile();
  const a = S.addScheduled(entry(at(NOW, -1)), file);
  const r = await S.runDue({ file, now: () => NOW, send: async () => { throw new Error("boom"); } });
  assert.deepEqual(r.failed.map(m => [m.id, m.error]), [[a.id, "boom"]]);
  let calls = 0;
  await S.runDue({ file, now: () => NOW, send: async () => calls++ });
  assert.equal(calls, 0);
  assert.equal(S.readQueue(file)[0].status, "failed");
});

await test("notices are reported once", async () => {
  const file = freshFile();
  S.addScheduled(entry(at(NOW, -60)), file);
  await S.runDue({ file, now: () => NOW, send: async () => {} });
  assert.equal(S.takeNotices(file).length, 1);
  assert.equal(S.takeNotices(file).length, 0);
  assert.equal(S.readQueue(file).length, 1); // still listed until cancelled
});

// ---- never twice: separate processes, as the launchd run and a live server would be
const CHILD = `
  process.env.IMESSAGE_MCP_IMPORT = "1";
  const S = await import(${JSON.stringify(SERVER)});
  const { appendFileSync } = await import("node:fs");
  const [file, log, mode] = process.argv.slice(1);
  await S.runDue({ file, send: async m => {
    appendFileSync(log, m.id + "\\n");
    if (mode === "die") process.kill(process.pid, "SIGKILL");
    await new Promise(r => setTimeout(r, 300));
  } });
`;
const runChild = (...args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ["--input-type=module", "-e", CHILD, ...args], { stdio: ["ignore", "inherit", "inherit"] });
  p.on("exit", (code, signal) => resolve({ code, signal }));
  p.on("error", reject);
});

await test("two concurrent runs send each due message exactly once", async () => {
  for (let round = 0; round < 3; round++) {
    const file = freshFile();
    const log = join(tmp, `sent-${round}.log`);
    writeFileSync(log, "");
    const ids = Array.from({ length: 6 }, () => S.addScheduled(entry(new Date(Date.now() - MIN)), file).id);
    const results = await Promise.all([runChild(file, log), runChild(file, log), runChild(file, log)]);
    assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
    const sent = readFileSync(log, "utf8").trim().split("\n").sort();
    assert.deepEqual(sent, [...ids].sort(), `round ${round}: sent ${sent.length} for ${ids.length}`);
    assert.equal(S.readQueue(file).length, 0);
  }
});

await test("a run killed mid-send leaves the message interrupted, and it is never sent again", async () => {
  const file = freshFile();
  const log = join(tmp, "die.log");
  writeFileSync(log, "");
  const a = S.addScheduled(entry(new Date(Date.now() - MIN)), file);
  const r = await runChild(file, log, "die");
  assert.equal(r.signal, "SIGKILL");
  assert.equal(S.readQueue(file)[0].status, "sending");
  let calls = 0;
  const out = await S.runDue({ file, send: async () => calls++ });
  assert.equal(calls, 0);
  assert.deepEqual(out.interrupted.map(m => m.id), [a.id]);
  assert.equal(S.readQueue(file)[0].status, "interrupted");
  assert.throws(() => S.cancelScheduled("nope", file), /No scheduled message/);
  S.cancelScheduled(a.id, file); // interrupted ones can be cleared
  assert.equal(S.readQueue(file).length, 0);
});

await test("a message being sent by a live run can't be cancelled or re-claimed", async () => {
  const file = freshFile();
  const a = S.addScheduled(entry(new Date(Date.now() - MIN)), file);
  let release;
  const first = S.runDue({ file, send: () => new Promise(r => { release = r; }) });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(S.readQueue(file)[0].status, "sending");
  assert.throws(() => S.cancelScheduled(a.id, file), /being sent/);
  let calls = 0;
  await S.runDue({ file, send: async () => calls++ });
  assert.equal(calls, 0);
  release();
  await first;
  assert.equal(S.readQueue(file).length, 0);
});

await test("a corrupt queue file is reported, not silently replaced", () => {
  const file = freshFile();
  S.addScheduled(entry(at(NOW, 5)), file);
  writeFileSync(file, "{not json");
  assert.throws(() => S.readQueue(file), /unreadable/);
  assert.equal(readFileSync(file, "utf8"), "{not json");
});

assert.equal(existsSync(join(tmp, "Library/LaunchAgents")), false, "tests must not install a LaunchAgent");
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
