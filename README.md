# imessage-mcp

**Slack-style context over your iMessages, for Claude and other AI assistants.**

If your team, startup or friends live in iMessage instead of Slack, this gives your assistant the same kind of access a Slack
integration would. It can browse conversations, read group chats, search everything you've ever texted and see who said what by
real contact name. It runs entirely on your Mac.

> "What's unread in my texts? Rank what actually matters."
> "Catch me up on the founders group chat from this week."
> "What did Alex say about the pricing change, and when?"
> "Find the address someone sent me last month."
> "What was in the screenshot Sam sent in the team chat?"
> "Draft a reply to Alex saying I'll be 10 minutes late; I'll send it myself."
> "Text Mom happy birthday tomorrow at 9am."
> "Save Jordan's new work number, 214 555 0123, to his contact."

## Install

### Easiest: let your coding agent do it

Paste this into Claude Code, Cursor, Codex or any coding agent:

```
Set up https://github.com/zohairrk5/imessage-mcp for me
```

The agent follows [`AGENTS.md`](AGENTS.md): it runs the installer, registers the server, and tells you the one permission you need to grant.

### One command

```bash
curl -fsSL https://raw.githubusercontent.com/zohairrk5/imessage-mcp/main/install.sh | bash
```

This downloads the code to `~/.imessage-mcp` and checks it can read your messages. It registers the server with **Claude Code**,
and with **Cursor** and **Codex** if they're installed. For **Claude Desktop**, it opens the extension installer, where you click **Install**.

### Claude Desktop only

Download `imessage-mcp.mcpb` from the [latest release](https://github.com/zohairrk5/imessage-mcp/releases/latest) and double-click it.

### The one manual step: Full Disk Access

macOS protects your Messages database, so the app running the server needs **Full Disk Access**:
*System Settings > Privacy & Security > Full Disk Access*, then turn on:

- **Claude** if you use Claude Desktop
- your **terminal** (Terminal, iTerm, Warp, Ghostty…) if you use Claude Code or another CLI agent
- **Cursor**, **VS Code** and so on if you use an agent inside an editor

Quit and reopen the app afterwards. Check it with `node ~/.imessage-mcp/bin/setup.js --check`.

## What it can do

| Tool | What it does |
|---|---|
| `list_conversations` | Your DMs and group chats by recent activity, with unread counts and a preview, like a Slack channel list |
| `read_conversation` | A transcript of a DM or group chat by contact name, group name, phone, email or `chat:<id>`. Shows sender names, inline replies, reactions and attachments. Filter with `since`/`before`, or jump to the messages `around` any message |
| `search_messages` | Searches every message, case-insensitive. Filter by conversation, sender (or `"me"`) and time range |
| `get_unread_imessages` | Unread messages grouped by conversation |
| `list_attachments` | Browses the files, photos and videos sent in a chat (or everywhere), filtered by type (`pdf`, `image`, `video`, `files`, …), file name, sender and date |
| `view_attachments` | Opens a message's attachments. Photos and screenshots are shown so the assistant can see them (HEIC converted automatically); PDFs, Word docs, Markdown, text, CSV, JSON and code are read as text. Scanned PDFs show their first page |
| `save_attachment` | Copies any attachment to a folder, `~/Downloads` by default, without overwriting existing files |
| `search_contacts` | Contacts by name, phone (any format) or email, with their conversation if one exists and the contact's id |
| `create_contact` | Adds a contact to the Contacts app: name, company, phone numbers and emails with labels (mobile, home, work…). If someone already has that number or email, nothing is created and that contact is shown instead. See [Editing contacts](#editing-contacts) |
| `update_contact` | Changes a contact's name or company, and adds, changes or removes phone numbers and emails. It only edits when the name, number, email or id matches exactly one contact, and shows the contact before and after |
| `send_imessage` | Sends to a person or group chat. It only sends when the name matches exactly one recipient; otherwise it lists the candidates |
| `draft_imessage` | Writes a message into the compose box of the right chat in Messages and **doesn't send it**. Messages opens on that chat; you read it, edit it if you like, and press Return yourself. Works for people and group chats |
| `schedule_imessage` | Sends a message at a later time ("in 2h", "tomorrow 9am", "2026-11-20 08:00"), even with Claude closed. See [Scheduled messages](#scheduled-messages) |
| `list_scheduled_imessages` | What's scheduled, soonest first, plus anything that was missed |
| `cancel_scheduled_imessage` | Cancels a scheduled message. To change one, cancel it and schedule it again |

### Drafts

`draft_imessage` opens the chat through the `sms:` link Messages registers on every Mac, with the text filled in. It needs no
extra permission and can't send anything: nothing presses Return for you. If that chat already had unsent text in its compose box,
the draft replaces it.

### Editing contacts

`create_contact` and `update_contact` save through Apple's Contacts framework, the same way the Contacts app does, so changes sync to
iCloud, Google and your phone. The Contacts databases themselves are never written to.

- **One-time permission.** The first time you add or edit a contact, macOS asks whether the app running the server (Claude, or your
  terminal or editor) may access your contacts. Click **OK**. If you clicked Don't Allow, turn it on in
  *System Settings > Privacy & Security > Contacts*. The Contacts app doesn't open.
- **New contacts go into your default account** (set in *Contacts > Settings > General > Default Account*) unless you name another,
  such as iCloud or Google. The result says which account it went to.
- **It never guesses which contact.** If a name matches several contacts (including the same person saved twice), nothing changes and
  you get the candidates with their numbers and ids to choose from.
- **Every edit shows the contact before and after**, so a wrong change is easy to spot and undo.
- Notes can't be edited: macOS doesn't let scripts read or write contact notes. Deleting whole contacts isn't offered; removing a
  single number or email is.
- `node ~/.imessage-mcp/bin/setup.js --check` shows whether Contacts access is allowed.

### Scheduled messages

Scheduled messages are kept in `~/Library/Application Support/imessage-mcp/scheduled.json`. When you schedule the first one, a small
background job is added (`~/Library/LaunchAgents/com.github.zohairrk5.imessage-mcp.scheduler.plist`). It checks once a minute and sends
what's due, so a message goes out within a minute of its time **even if Claude and your terminal are closed**. When nothing is left to
send, the job removes itself.

- **The Mac has to be on and awake.** If it's asleep or off at the scheduled time, the message is sent when it wakes only if that's
  within 15 minutes. Later than that it isn't sent at all (a text arriving hours late is worse than none); it's kept as *missed*, and
  your assistant tells you the next time it uses any iMessage tool.
- **One-time permission.** The first time you schedule a message, macOS asks whether **“osascript” may control “Messages”**. Click
  **OK**. The background job runs through Apple's `osascript`, so the permission survives Node updates. If you clicked Don't Allow,
  turn it on in *System Settings > Privacy & Security > Automation > osascript > Messages*.
- **Never sent twice.** A message is marked as sending before it's handed to Messages and removed once sent. If the Mac crashes in that
  moment, it's flagged *interrupted* (check the chat) rather than sent again.
- The recipient is worked out when you schedule, exactly as `send_imessage` would, so the job doesn't need to read your messages.
- `node ~/.imessage-mcp/bin/setup.js --check` shows how many messages are pending and whether the job is running.

## Compared with the official "Read and Send iMessages" extension

Claude Desktop ships an official iMessage extension from Anthropic. imessage-mcp started as a fix for the problems we hit with it
(version 0.1.11) and grew into a full replacement. Use whichever suits you; you can run both.

| | Official extension (v0.1.11) | imessage-mcp |
|---|---|---|
| **Who sent a message** | Raw phone numbers (`+15125550123`) | Contact names, found automatically (below) |
| **Contact search** | Goes through the Contacts app via AppleScript and can hang on large address books | Reads the Contacts database directly; answers in milliseconds |
| **Message text** | Recent messages are often garbled: a stray first character, `iI` at the end, or "content not readable" | Decodes Apple's stored message format; matched every message with a known plain-text copy, and decoded all 400k messages in a real history |
| **Group chats** | Can't open a group chat; your own messages in groups are missing | Opens any group by name, with every sender named |
| **Finding a conversation** | Phone number only | Contact name, group name, any phone format, email, or chat ID |
| **Search** | None | Searches every message, filtered by person, chat and date |
| **Overview** | A flat list of unread messages | A Slack-style list of conversations with unread counts and previews |
| **Context** | The last N messages | Time ranges, plus the messages around any search hit |
| **Replies, reactions, unsent messages, attachments** | Not shown | Shown inline |
| **Photos and screenshots** | Can't be seen | The assistant can view them, with HEIC converted automatically |
| **PDFs, docs and other files** | Can't be opened | Read as text, browsed by type, and saved to any folder |
| **One person across iMessage, SMS and email** | Separate threads | Merged into one conversation |
| **Large histories** | Reads can fail once output passes 1 MB | No limit problems |
| **Sending** | Sends to whatever string it's given | Sends only when the name matches exactly one recipient; otherwise lists the candidates |
| **Works in** | Claude Desktop | Claude Desktop, Claude Code, Cursor, Codex and any MCP client |

### Contacts hook up automatically

You don't need to configure or export anything. On each call the server reads the Contacts databases on your Mac,
covering every account (iCloud, Google, Exchange and so on) under `~/Library/Application Support/AddressBook`. It reloads them
whenever they change, so a contact you save shows up by name on the next request. Phone numbers are matched on their last
10 digits, so `(512) 555-0123`, `512-555-0123` and `+15125550123` are all the same person, and emails are matched case-insensitively.

## Privacy

- **Local only.** The server reads `~/Library/Messages/chat.db` and your Contacts databases **read-only** and makes no network requests.
  Your assistant only sees what a tool call returns. Contact edits go through macOS's Contacts framework, which syncs them like any edit.
- **Sending is explicit.** `send_imessage` and `schedule_imessage` are the only tools that send anything, and MCP clients ask you before
  running them. `draft_imessage` only fills in a compose box. `save_attachment` only copies a file into a folder you choose.
  `create_contact` and `update_contact` are the only tools that change your contacts, and they can't delete one.
- Scheduled messages are stored on your Mac in a file only your user can read, and removed once sent. The background job's log
  (`scheduler.log` next to it) records ids and outcomes, never message text.
- It isn't affiliated with or endorsed by Apple.

## Other MCP clients

Any client that runs stdio MCP servers works. Point it at Node and `server.js`:

```json
{
  "mcpServers": {
    "imessage-mcp": { "command": "/absolute/path/to/node", "args": ["/Users/you/.imessage-mcp/server.js"] }
  }
}
```

## Troubleshooting

- **"unable to open database file" / "Full Disk Access"**: the app running the server needs Full Disk Access (see above). Quit and reopen it afterwards.
- **Claude Desktop: don't add it to `claude_desktop_config.json`.** Servers started from that file run as a separate Node process
  without Claude's permissions. Install the `.mcpb` extension instead; extensions run inside Claude and inherit its access.
- **A sender shows as a phone number**: that number isn't saved in Contacts. Save it and the name appears.
- **Tools don't show up**: start a new session or chat after installing.
- **"macOS is blocking this server from Contacts"**: turn on the app running the server in *System Settings > Privacy & Security > Contacts*.
- **A scheduled message didn't send**: ask your assistant to list scheduled messages; it shows why. Check that the Automation permission
  for osascript is on (above) and that `setup.js --check` reports the background sender running.

## Uninstall

```bash
claude mcp remove imessage-mcp -s user   # Claude Code
launchctl bootout gui/$(id -u)/com.github.zohairrk5.imessage-mcp.scheduler 2>/dev/null   # scheduled-message job, if any
rm -f ~/Library/LaunchAgents/com.github.zohairrk5.imessage-mcp.scheduler.plist
rm -rf ~/.imessage-mcp ~/Library/Application\ Support/imessage-mcp
```

In Claude Desktop, remove it under *Settings > Extensions*. In Cursor or Codex, delete the `imessage-mcp` entry from `~/.cursor/mcp.json` or `~/.codex/config.toml`.

## Development

```bash
git clone https://github.com/zohairrk5/imessage-mcp && cd imessage-mcp && npm install
node server.js --cli list_conversations '{"limit":5}'   # run any tool directly
npm test                                                 # scheduler and contact-editing tests (never touch Messages or Contacts)
```

See [`AGENTS.md`](AGENTS.md) for how the code is laid out and how releases work.

## License

MIT
