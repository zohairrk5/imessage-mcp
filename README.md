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
| `view_attachments` | Shows the photos and screenshots in a message so the assistant can actually see them. HEIC and other formats are converted automatically |
| `search_contacts` | Contacts by name, phone (any format) or email, with their conversation if one exists |
| `send_imessage` | Sends to a person or group chat. It only sends when the name matches exactly one recipient; otherwise it lists the candidates |

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
  Your assistant only sees what a tool call returns.
- **Sending is explicit.** `send_imessage` is the only tool that changes anything, and MCP clients ask you before running it.
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

## Uninstall

```bash
claude mcp remove imessage-mcp -s user   # Claude Code
rm -rf ~/.imessage-mcp
```

In Claude Desktop, remove it under *Settings > Extensions*. In Cursor or Codex, delete the `imessage-mcp` entry from `~/.cursor/mcp.json` or `~/.codex/config.toml`.

## Development

```bash
git clone https://github.com/zohairrk5/imessage-mcp && cd imessage-mcp && npm install
node server.js --cli list_conversations '{"limit":5}'   # run any tool directly
```

See [`AGENTS.md`](AGENTS.md) for how the code is laid out and how releases work.

## License

MIT
