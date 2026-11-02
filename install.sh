#!/usr/bin/env bash
# One-line installer for imessage-mcp:
#   curl -fsSL https://raw.githubusercontent.com/zohairrk5/imessage-mcp/main/install.sh | bash
# Pass setup flags after `bash -s --`, e.g. `| bash -s -- --skip-desktop`.
set -euo pipefail

REPO_URL="https://github.com/zohairrk5/imessage-mcp.git"
DIR="${IMESSAGE_MCP_DIR:-$HOME/.imessage-mcp}"

if [ "$(uname)" != "Darwin" ]; then
  echo "imessage-mcp only runs on macOS." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install it from https://nodejs.org or with: brew install node" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required. Install the Xcode command line tools with: xcode-select --install" >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  echo "Updating $DIR"
  git -C "$DIR" pull --ff-only --quiet
else
  echo "Downloading imessage-mcp to $DIR"
  git clone --quiet --depth 1 "$REPO_URL" "$DIR"
fi

(cd "$DIR" && npm install --omit=dev --no-audit --no-fund --silent)
exec node "$DIR/bin/setup.js" "$@"
