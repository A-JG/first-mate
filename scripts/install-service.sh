#!/usr/bin/env bash
# Runs the dispatcher in the background whenever you are logged in, and
# restarts it if it stops. Remove with: scripts/install-service.sh --remove
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
UNIT="$HOME/.config/systemd/user/firstmate.service"
if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now firstmate.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Removed the firstmate service."
  exit 0
fi
NODE="$(command -v node)"
CLAUDE_DIR="$(dirname "$(command -v claude)")"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT
[Unit]
Description=First Mate voice dispatcher for Claude Code
After=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/src/server.js
Restart=on-failure
RestartSec=5
Environment=PATH=$CLAUDE_DIR:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now firstmate.service
echo "First Mate is running. Logs: journalctl --user -u firstmate -f"
echo "To keep it running when you are logged out: loginctl enable-linger $USER"
