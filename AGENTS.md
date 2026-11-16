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

- Never send or schedule a message (`send_imessage`, `schedule_imessage`) during setup or testing. `npm test` stubs every send.
- Never rename a real group chat while testing (`rename_group_chat`): every member sees it. Test only on a group whose members are
  all the user's own phone number and Apple ID email (Messages does keep that as a group, style 43), with the user's go-ahead.
  `npm test` fakes every Messages step.
- Never create or edit a real contact while testing (`create_contact`, `update_contact`): the address book syncs to iCloud and the
  user's phone. `npm test` uses a fake Contacts. For a live check, create one obviously fake contact (e.g. "ZZ imessage-mcp Test",
  a 555-01xx number, an example.com email), test only on it, delete it afterwards, and confirm the contact count is unchanged.
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
- Scheduled messages: the queue is `~/Library/Application Support/imessage-mcp/scheduled.json`; a launchd agent
  (`com.github.zohairrk5.imessage-mcp.scheduler`) runs `server.js --run-due` through `/usr/bin/osascript` every minute while
  anything is pending, and removes itself when nothing is. `npm test` covers parsing, the queue and the never-send-twice rules.
- Contact edits go through `CNContactStore` (JavaScript for Automation in `/usr/bin/osascript`, see `CONTACTS_JXA`), never by writing
  the AddressBook files. The card ids in those files (`ZUNIQUEID`, e.g. `…:ABPerson`) are the framework's contact identifiers.
- Drafts open `sms:<handle>&body=…` (people) or `sms://open?groupid=<chat.group_id>&body=…` (groups); they never send.
  Messages ignores the group link for a group it no longer lists (no messages left in chat.db) and opens a New Message
  window to your own Apple ID instead, so group drafts open without the text first and check Messages' window title.
  Never test drafts with the screen locked: System Events sees no windows then, so a test draft can't be read back or cleared.
- Renaming groups drives Messages' window through the Accessibility API from JavaScript for Automation (`AX_JXA`): about 0.25 s a
  step, where System Events' view of the same window took 20-40 s a read. Route: `sms://open?groupid=`, the context menu of the
  `ConversationTitle` button > "Edit Name & Photo" (`edit_name_&_photo`), the sheet's one `AXTextField`, then the "Done" button.
  What was learned mapping it (macOS 26):
  - The window title is not the chat: Messages keeps a window's old title after a rename. The `ConversationTitle` button's
    description (the group's name, or "N People" when unnamed) and the selected row of `ConversationList` (its description starts
    with the same name) are current. Behind an open sheet neither can be read, so steps inside the sheet check the window the sheet
    opened on instead (the sheet is modal to it).
  - Setting the name field's `AXValue` only changes what it shows: Done stays disabled and nothing is saved. Typing the name lets
    the field capitalise and autocorrect it. So the value goes in with a trailing space, then one Delete key is posted to Messages'
    process (`CGEventPostToPid`, no System Events), and the field must then read exactly the new name with Done enabled.
  - Cancel after an edit raises a "Discard Changes" alert on the sheet, which has to be answered too.
  - Conversation-menu identifiers change when Messages is frontmost (`show_details` vs `toggleDetailsFromConversationsMenu`), so
    menu bar items are matched by title.
  - Group photo: the sheet's "Open Gallery" opens a popover picker of the Photos library (`PXPicker…`), with no way to choose a
    file by path, so changing the photo isn't offered. While that popover is up the sheet's Cancel can't be reached.
- Releases: bump `version` in `package.json`, `manifest.json` and the `Server` constructor in `server.js`, then push a `vX.Y.Z` tag.
  GitHub Actions builds `imessage-mcp.mcpb` and attaches it to the release.
- chat.db facts that matter:
  - Timestamps are nanoseconds since 2001, so select them as `CAST(x AS REAL)`.
  - Message text is often only in `attributedBody`, an NSAttributedString typedstream. See `decodeAttributedBody`.
  - Tapbacks are `associated_message_type` 2000–3999.
