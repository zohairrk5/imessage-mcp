# Instructions for coding agents

This repo is an MCP server that gives AI assistants Slack-style access to the user's iMessage/SMS history on macOS.
It provides conversations, group chats, full-text search, unread messages and contact names.
Everything runs locally and reads the Messages database read-only.

## When the user asks you to "set up" or "install" this repo

1. **Check that the machine is a Mac.** Stop and explain if it isn't; this only works on macOS.
2. **Run the installer:**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/zohairrk5/imessage-mcp/main/install.sh | bash
   ```
   If the repo is already cloned and you're in it, run `npm install --omit=dev && node bin/setup.js` instead.
   The script clones to `~/.imessage-mcp` and installs dependencies. It runs a self-test, then registers the server with
   Claude Code (user scope), plus Cursor and Codex when they're installed. It also opens the Claude Desktop extension installer.
3. **Read the output and act on it:**
   - **"doesn't have Full Disk Access"** (exit code 2): you can't grant this yourself. Tell the user exactly what to do:
     open *System Settings > Privacy & Security > Full Disk Access* and turn on the app named in the output (their terminal or editor).
     Add **Claude** too if they use Claude Desktop. Then fully quit and reopen that app.
     After that, run `node ~/.imessage-mcp/bin/setup.js --check`, which exits 0 once it works.
   - **"Opened the Claude Desktop installer"**: tell the user to click **Install** in Claude Desktop.
4. **Tell the user to start a new session or chat** so the tools load, then suggest a first prompt like "What's unread in my texts?"

## Rules

- Never send a message (`send_imessage`) during setup or testing.
- Don't print the user's message contents while verifying; the self-test only reports a conversation count.
- Don't add this server to `claude_desktop_config.json`. Servers started from that file don't inherit Claude's
  Full Disk Access and fail with "unable to open database file". Claude Desktop must use the `.mcpb` extension.
- For MCP clients the script doesn't configure, use the config it prints:
  `{"imessage-mcp": {"command": "<absolute node path>", "args": ["~/.imessage-mcp/server.js" expanded]}}`.
  The app running the client needs Full Disk Access.

## Working on the code

- `server.js` holds the whole server: SQLite access through `/usr/bin/sqlite3`, the contacts index, decoding and the tools.
- Test any tool without an MCP client: `node server.js --cli <tool> '<json args>'`, e.g. `node server.js --cli list_conversations '{"limit":5}'`.
- `bin/setup.js` is the installer and `manifest.json` is the Claude Desktop extension manifest.
- Releases: bump `version` in `package.json`, `manifest.json` and the `Server` constructor in `server.js`, then push a `vX.Y.Z` tag.
  GitHub Actions builds `imessage-mcp.mcpb` and attaches it to the release.
- chat.db facts that matter:
  - Timestamps are nanoseconds since 2001, so select them as `CAST(x AS REAL)`.
  - Message text is often only in `attributedBody`, an NSAttributedString typedstream. See `decodeAttributedBody`.
  - Tapbacks are `associated_message_type` 2000–3999.
