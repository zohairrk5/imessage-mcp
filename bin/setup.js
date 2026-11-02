#!/usr/bin/env node
// Sets up imessage-mcp on this Mac: checks access to Messages, registers the server with
// Claude Code, Cursor and Codex, installs the Claude Desktop extension, and runs a self-test.
//
//   node bin/setup.js            full setup
//   node bin/setup.js --check    only check access and run the self-test
//   flags: --skip-claude-code --skip-desktop --skip-cursor --skip-codex --no-open

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server.js");
const NAME = "imessage-mcp";
const REPO = "zohairrk5/imessage-mcp";
const NODE = process.execPath;
const HOME = os.homedir();
const flags = new Set(process.argv.slice(2));

const green = s => `\x1b[32m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const bold = s => `\x1b[1m${s}\x1b[0m`;
const ok = msg => console.log(`${green("✓")} ${msg}`);
const warn = msg => console.log(`${yellow("!")} ${msg}`);
const fail = msg => console.log(`${red("✗")} ${msg}`);

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const has = cmd => run("/usr/bin/which", [cmd]).status === 0;
const FDA_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

function hostAppName() {
  const map = { Apple_Terminal: "Terminal", "iTerm.app": "iTerm", vscode: "VS Code (or Cursor)", WarpTerminal: "Warp", ghostty: "Ghostty" };
  return map[process.env.TERM_PROGRAM] || process.env.TERM_PROGRAM || "your terminal app";
}

function checkPlatform() {
  if (process.platform !== "darwin") {
    fail("imessage-mcp only runs on macOS (it reads the Messages database on your Mac).");
    process.exit(1);
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    fail(`Node ${process.versions.node} is too old; install Node 18 or newer (https://nodejs.org or \`brew install node\`).`);
    process.exit(1);
  }
  ok(`macOS, Node ${process.versions.node}`);
}

function ensureDependencies() {
  if (existsSync(join(ROOT, "node_modules/@modelcontextprotocol/sdk"))) return ok("Dependencies installed");
  console.log("Installing dependencies…");
  const r = run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    fail("npm install failed");
    process.exit(1);
  }
  ok("Dependencies installed");
}

// Runs the server's own CLI mode, so this checks exactly what the MCP clients will run.
function selfTest() {
  const r = run(NODE, [SERVER, "--cli", "list_conversations", '{"limit":1}']);
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const m = out.match(/^(\d+) conversation\(s\)/m);
  if (r.status === 0 && m) {
    ok(`Can read Messages from here: ${m[1]} conversations found`);
    return true;
  }
  if (/Full Disk Access|unable to open|authorization denied/i.test(out)) {
    fail(`${hostAppName()} doesn't have Full Disk Access, so it can't read ~/Library/Messages/chat.db.`);
    console.log(`  Open System Settings > Privacy & Security > Full Disk Access, turn on ${bold(hostAppName())}` +
      ` (add it with + if it's missing), then fully quit and reopen it and run:\n  ${bold(`node ${join(ROOT, "bin/setup.js")} --check`)}`);
    if (!flags.has("--no-open")) run("/usr/bin/open", [FDA_PANE]);
    return false;
  }
  fail(`Self-test failed:\n${out.trim().split("\n").slice(0, 8).join("\n")}`);
  return false;
}

function setupClaudeCode() {
  if (!has("claude")) return warn("Claude Code not found; skipping (install it, then rerun setup).");
  run("claude", ["mcp", "remove", NAME, "-s", "user"]);
  const r = run("claude", ["mcp", "add", "-s", "user", NAME, "--", NODE, SERVER]);
  if (r.status !== 0) return fail(`Couldn't register with Claude Code: ${(r.stderr || r.stdout).trim()}`);
  ok("Registered with Claude Code (all projects). Start a new `claude` session to load it.");
}

function setupCursor() {
  const dir = join(HOME, ".cursor");
  if (!existsSync(dir)) return;
  const file = join(dir, "mcp.json");
  let config = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return warn(`${file} isn't valid JSON; add imessage-mcp to it by hand (see README).`);
    }
  }
  config.mcpServers = { ...(config.mcpServers || {}), [NAME]: { command: NODE, args: [SERVER] } };
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  ok("Registered with Cursor (~/.cursor/mcp.json). Cursor also needs Full Disk Access.");
}

function setupCodex() {
  const dir = join(HOME, ".codex");
  if (!existsSync(dir)) return;
  const file = join(dir, "config.toml");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existing.includes(`[mcp_servers.${NAME}]`)) return ok("Already registered with Codex (~/.codex/config.toml)");
  appendFileSync(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}\n[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(SERVER)}]\n`);
  ok("Registered with Codex (~/.codex/config.toml)");
}

// Claude Desktop must run this as an extension (.mcpb): extensions run inside Claude's own Node and
// inherit Claude's Full Disk Access, while servers added to claude_desktop_config.json do not.
function setupClaudeDesktop() {
  const app = ["/Applications/Claude.app", join(HOME, "Applications/Claude.app")].find(existsSync);
  if (!app) return;
  const tmp = mkdtempSync(join(os.tmpdir(), "imessage-mcp-"));
  const bundle = join(tmp, "imessage-mcp.mcpb");
  const dl = run("/usr/bin/curl", ["-fsSL", "-o", bundle, `https://github.com/${REPO}/releases/latest/download/imessage-mcp.mcpb`]);
  if (dl.status !== 0) {
    console.log("Building the Claude Desktop extension locally…");
    const pack = run("npx", ["-y", "@anthropic-ai/mcpb", "pack", ROOT, bundle], { cwd: ROOT });
    if (pack.status !== 0) return fail("Couldn't download or build the Claude Desktop extension (see README to install it by hand).");
  }
  if (flags.has("--no-open")) return ok(`Claude Desktop extension ready: ${bundle}`);
  run("/usr/bin/open", [bundle]);
  ok(`Opened the Claude Desktop installer. ${bold("Click Install")} in Claude, then start a new chat.`);
  console.log("  Claude itself needs Full Disk Access too (System Settings > Privacy & Security > Full Disk Access > Claude).");
}

console.log(bold("\nimessage-mcp setup\n"));
checkPlatform();
ensureDependencies();
const canRead = selfTest();

if (!flags.has("--check")) {
  if (!flags.has("--skip-claude-code")) setupClaudeCode();
  if (!flags.has("--skip-cursor")) setupCursor();
  if (!flags.has("--skip-codex")) setupCodex();
  if (!flags.has("--skip-desktop")) setupClaudeDesktop();
  console.log(`\nOther MCP clients: add this server config:\n  ${JSON.stringify({ [NAME]: { command: NODE, args: [SERVER] } })}`);
}

console.log(canRead
  ? `\n${green(bold("Ready."))} Try asking: "What's unread in my texts?" or "Catch me up on my group chat with Alex and Sam."\n`
  : `\n${yellow(bold("Almost there:"))} grant Full Disk Access (above), then rerun with --check.\n`);
process.exit(canRead ? 0 : 2);
