// Tests for create_contact and update_contact: resolving exactly one contact, duplicate detection,
// phone matching, the planned change, the before/after text and the permission wording. Plain node:
// `npm test`. Never touches Contacts: every Contacts call goes to an in-memory fake, and HOME points
// at a temp folder so the real address book is never read.
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

const MOBILE = "_$!<Mobile>!$_";
const HOME_L = "_$!<Home>!$_";
const WORK = "_$!<Work>!$_";
const uuid = n => `${String(n).padStart(8, "0")}-1111-2222-3333-444444444444:ABPerson`;
const card = (n, first, last, phones = [], emails = [], organization = "") => ({
  id: uuid(n), first, middle: "", last, organization, account: "iCloud",
  phones: phones.map((v, i) => ({ id: `p${n}.${i}`, label: MOBILE, value: v })),
  emails: emails.map((v, i) => ({ id: `e${n}.${i}`, label: HOME_L, value: v })),
});

// An in-memory Contacts: records every request and assigns ids the way the framework does.
function fakeContacts(initial) {
  const store = new Map(initial.map(c => [c.id, structuredClone(c)]));
  const calls = [];
  let n = 1000;
  const withIds = list => list.map(x => ({ ...x, id: x.id || `new${++n}` }));
  const run = async q => {
    calls.push(structuredClone(q));
    if (q.op === "accounts") return { default: "ICLOUD:ABAccount", accounts: [{ id: "ICLOUD:ABAccount", name: "iCloud" }, { id: "GOOGLE:ABAccount", name: "Google" }] };
    if (q.op === "get") return { contact: store.has(q.id) ? structuredClone(store.get(q.id)) : null };
    if (q.op === "create") {
      const c = { id: uuid(++n), middle: "", ...q.contact, phones: withIds(q.contact.phones), emails: withIds(q.contact.emails), account: q.container === "GOOGLE:ABAccount" ? "Google" : "iCloud" };
      store.set(c.id, c);
      return { contact: structuredClone(c) };
    }
    if (q.op === "update") {
      const c = { ...store.get(q.id), ...q.contact, phones: withIds(q.contact.phones), emails: withIds(q.contact.emails) };
      store.set(q.id, c);
      return { contact: structuredClone(c) };
    }
    throw new Error(`unexpected op ${q.op}`);
  };
  const cards = () => [...store.values()].map(c => ({ ...c, name: [c.first, c.middle, c.last].filter(Boolean).join(" ") || c.organization }));
  return { store, calls, deps: { run, cards, settle: async () => true } };
}

const BOOK = () => [
  card(1, "Alex", "Rivera", ["(214) 555-0101"], ["alex@example.com"]),
  card(2, "Sam", "Lee", ["+1 214 555 0102"], []),
  card(3, "Sam", "Lee", ["214.555.0103"], ["sam@example.com"]),
  card(4, "Samantha", "Ortiz", [], []),
  card(5, "", "", ["214 555 0105"], [], "Example Co"),
];

// ---- phone matching
await test("phones match on the last 10 digits whatever the format", () => {
  for (const v of ["(214) 555-0101", "+1 214 555 0101", "214.555.0101", "12145550101"]) assert.equal(S.phoneKey(v), "2145550101");
  assert.notEqual(S.phoneKey("214 555 0101"), S.phoneKey("214 555 0110"));
});

// ---- resolution
await test("resolves by id, phone in any format, email in any case, or a unique name", () => {
  const cards = fakeContacts(BOOK()).deps.cards();
  assert.equal(S.resolveCard(uuid(3), cards).id, uuid(3));
  assert.equal(S.resolveCard(uuid(3).toLowerCase(), cards).id, uuid(3));
  assert.equal(S.resolveCard("+12145550101", cards).id, uuid(1));
  assert.equal(S.resolveCard("ALEX@example.com", cards).id, uuid(1));
  assert.equal(S.resolveCard("alex", cards).id, uuid(1));
  assert.equal(S.resolveCard("Example Co", cards).id, uuid(5));
});

await test("several matches: nothing is resolved, and every candidate is listed with its id and numbers", () => {
  const cards = fakeContacts(BOOK()).deps.cards();
  assert.throws(() => S.resolveCard("Sam Lee", cards), e => {
    assert.match(e.message, /"Sam Lee" matches 2 contacts, so nothing was changed/);
    assert.ok(e.message.includes(`[id: ${uuid(2)}]`) && e.message.includes(`[id: ${uuid(3)}]`));
    assert.ok(e.message.includes("+1 214 555 0102") && e.message.includes("sam@example.com"));
    return true;
  });
  // "sam" is a prefix of Sam and Samantha: three cards, still no guess.
  assert.throws(() => S.resolveCard("sam", cards), /matches 3 contacts/);
});

await test("no match, and an unknown id, change nothing", () => {
  const cards = fakeContacts(BOOK()).deps.cards();
  assert.throws(() => S.resolveCard("Jordan", cards), /No contact matches "Jordan". Nothing was changed/);
  assert.throws(() => S.resolveCard(uuid(99), cards), /No contact matches/);
  assert.throws(() => S.resolveCard("", cards), /contact is required/);
});

await test("an ambiguous update never reaches Contacts", async () => {
  const f = fakeContacts(BOOK());
  await assert.rejects(S.updateContact({ contact: "Sam Lee", last_name: "X" }, f.deps), /matches 2 contacts/);
  assert.equal(f.calls.length, 0);
});

// ---- create and duplicates
await test("create refuses a phone or email that's already saved, in any format, and returns that contact", async () => {
  const f = fakeContacts(BOOK());
  await assert.rejects(S.createContact({ first_name: "New", phones: ["214-555-0103"] }, f.deps), e => {
    assert.match(e.message, /^Not created: a contact already has that phone number or email. Use update_contact/);
    assert.ok(e.message.includes(uuid(3)));
    return true;
  });
  await assert.rejects(S.createContact({ first_name: "New", emails: ["SAM@Example.com"] }, f.deps), /Not created/);
  await assert.rejects(S.createContact({ first_name: "New", phones: ["214 555 0199", "(214) 555-0199"] }, f.deps), /listed twice/);
  assert.equal(f.calls.length, 0);
});

await test("create goes to the default account, with labels and defaults, and shows the saved card", async () => {
  const f = fakeContacts(BOOK());
  const out = await S.createContact({
    first_name: " Jordan ", last_name: "Park", organization: "Example Co",
    phones: ["214 555 0110", { value: "214 555 0111", label: "Work" }], emails: ["jordan@example.com"],
  }, f.deps);
  const req = f.calls.find(c => c.op === "create");
  assert.equal(req.container, "ICLOUD:ABAccount");
  assert.deepEqual(req.contact, {
    first: "Jordan", last: "Park", organization: "Example Co",
    phones: [{ label: MOBILE, value: "214 555 0110" }, { label: WORK, value: "214 555 0111" }],
    emails: [{ label: HOME_L, value: "jordan@example.com" }],
  });
  assert.match(out, /^Created a new contact in iCloud \(the default account\):/);
  assert.match(out, /phones: mobile 214 555 0110, work 214 555 0111/);
  assert.match(out, /emails: home jordan@example.com/);
});

await test("create into a named account; unknown accounts and nameless contacts are refused", async () => {
  const f = fakeContacts(BOOK());
  const out = await S.createContact({ first_name: "Jordan", account: "google" }, f.deps);
  assert.equal(f.calls.find(c => c.op === "create").container, "GOOGLE:ABAccount");
  assert.match(out, /^Created a new contact in Google:/);
  await assert.rejects(S.createContact({ first_name: "X", account: "Exchange" }, f.deps), /No Contacts account named "Exchange". Accounts: iCloud, Google/);
  await assert.rejects(S.createContact({ phones: ["214 555 0120"] }, f.deps), /first_name, last_name or organization is required/);
  await assert.rejects(S.createContact({ first_name: "X", phones: ["call me"] }, f.deps), /isn't a phone number/);
  await assert.rejects(S.createContact({ first_name: "X", emails: ["nope"] }, f.deps), /isn't an email address/);
});

await test("if the address book hasn't caught up, the result says so", async () => {
  const f = fakeContacts(BOOK());
  const out = await S.createContact({ first_name: "Jordan" }, { ...f.deps, settle: async () => false });
  assert.match(out, /hadn't caught up after 5 seconds/);
});

// ---- planning an update
await test("plan: name, company, add, change (value and label) and remove", () => {
  const before = card(1, "Alex", "Rivera", ["(214) 555-0101", "214 555 0109"], ["alex@example.com"]);
  const after = S.planUpdate(before, {
    last_name: "Rivera-Diaz", organization: "Example Co",
    add_phones: [{ value: "214 555 0130", label: "home" }],
    change_phones: [{ from: "2145550101", to: "214 555 0131" }, { from: "+1 214 555 0109", label: "work fax" }],
    change_emails: [{ from: "ALEX@EXAMPLE.COM", to: "alex@work.example.com", label: "work" }],
  });
  assert.deepEqual(after.phones, [
    { id: "p1.0", label: MOBILE, value: "214 555 0131" },
    { id: "p1.1", label: "_$!<WorkFAX>!$_", value: "214 555 0109" },
    { label: HOME_L, value: "214 555 0130" },
  ]);
  assert.deepEqual(after.emails, [{ id: "e1.0", label: WORK, value: "alex@work.example.com" }]);
  assert.deepEqual(before.phones.map(p => p.value), ["(214) 555-0101", "214 555 0109"], "before is not mutated");
});

await test("plan: removing a number removes every copy; problems change nothing", () => {
  const before = card(1, "Alex", "Rivera", ["214 555 0101", "+1 (214) 555-0101", "214 555 0102"], ["alex@example.com"]);
  assert.deepEqual(S.planUpdate(before, { remove_phones: ["2145550101"] }).phones.map(p => p.value), ["214 555 0102"]);
  assert.throws(() => S.planUpdate(before, { remove_phones: ["214 555 0199"] }), /Alex Rivera has no phone 214 555 0199. Nothing was changed. Their phones: mobile 214 555 0101/);
  assert.throws(() => S.planUpdate(before, { change_phones: [{ from: "214 555 0101", to: "214 555 0140" }] }), /on Alex Rivera 2 times/);
  assert.throws(() => S.planUpdate(before, { change_phones: [{ from: "214 555 0102" }] }), /with "to" and\/or "label"/);
  assert.throws(() => S.planUpdate(before, { add_emails: ["Alex@Example.com"] }), /already has email/);
  assert.throws(() => S.planUpdate(before, { first_name: "", last_name: "" }), /needs a first name, last name or company/);
});

// ---- the before/after text
await test("describeChange lists each change with old and new values", () => {
  const before = card(1, "Alex", "Rivera", ["214 555 0101", "214 555 0102"], ["alex@example.com"]);
  const after = S.planUpdate(before, {
    first_name: "Alexander", organization: "Example Co", add_emails: [{ value: "a@work.example.com", label: "work" }],
    change_phones: [{ from: "214 555 0101", label: "iphone" }], remove_phones: ["214 555 0102"],
  });
  assert.deepEqual(S.describeChange(before, after), [
    'name: "Alex Rivera" → "Alexander Rivera"',
    'company: (empty) → "Example Co"',
    "phone changed: mobile 214 555 0101 → iphone 214 555 0101",
    "phone removed: mobile 214 555 0102",
    "email added: work a@work.example.com",
  ]);
  assert.deepEqual(S.describeChange(before, before), []);
});

await test("update: sends the plan with existing ids kept, and reports before and after", async () => {
  const f = fakeContacts(BOOK());
  const out = await S.updateContact({ contact: uuid(3), add_phones: ["214 555 0150"], remove_emails: ["sam@example.com"] }, f.deps);
  const req = f.calls.find(c => c.op === "update");
  assert.equal(req.id, uuid(3));
  assert.deepEqual(req.contact.phones, [{ id: "p3.0", label: MOBILE, value: "214.555.0103" }, { label: MOBILE, value: "214 555 0150" }]);
  assert.deepEqual(req.contact.emails, []);
  assert.match(out, /^Updated Sam Lee in iCloud:\n- phone added: mobile 214 555 0150\n- email removed: home sam@example.com\n\nBefore:\n/);
  assert.match(out, /Before:\n  Sam Lee\n  phones: mobile 214\.555\.0103\n  emails: home sam@example.com/);
  assert.match(out, /After:\n  Sam Lee\n  phones: mobile 214\.555\.0103, mobile 214 555 0150\n  emails: none/);
  assert.equal(f.store.get(uuid(2)).phones.length, 1, "the other Sam Lee is untouched");
});

await test("update with nothing to change doesn't write", async () => {
  const f = fakeContacts(BOOK());
  await assert.rejects(S.updateContact({ contact: uuid(1), last_name: "Rivera" }, f.deps), /Nothing to change/);
  assert.deepEqual(f.calls.map(c => c.op), ["get"]);
});

// ---- permission and timeout wording
await test("permission denied names the setting and says nothing changed", () => {
  assert.throws(() => S.contactsReply(JSON.stringify({ error: "Contacts access denied", code: 100 })), e => {
    assert.match(e.message, /macOS is blocking this server from Contacts, so nothing was changed/);
    assert.match(e.message, /System Settings > Privacy & Security > Contacts/);
    return true;
  });
  assert.throws(() => S.contactsReply(JSON.stringify({ error: "Contacts didn't save the change: boom", code: 3 })), /^Error: Contacts didn't save the change: boom$/);
  assert.deepEqual(S.contactsReply('{"status":3}'), { status: 3 });
  assert.match(S.contactsTimeout(false), /click OK \(Allow\).*Nothing was changed\.$/);
  assert.match(S.contactsTimeout(true), /may or may not have been saved/);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
