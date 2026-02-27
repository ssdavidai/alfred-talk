#!/bin/bash
set -euo pipefail

# ── Alfred Talk — OpenClaw Plugin Installer ───────────────────────
# Installs the ElevenLabs voice agent plugin for OpenClaw.
#
# What it does:
#   1. Creates Python venv for the webhook server
#   2. Installs the plugin into OpenClaw
#   3. Creates a launchd (macOS) or systemd (Linux) service for the webhook server
#   4. Outputs next-step configuration instructions

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/.openclaw/alfred-talk"
VENV_DIR="$DATA_DIR/venv"
TRANSCRIPT_DIR="$DATA_DIR/transcripts"

echo "╔══════════════════════════════════════════╗"
echo "║        Alfred Talk — Installer           ║"
echo "╚══════════════════════════════════════════╝"
echo

# ── Step 1: Create directories ────────────────────────────────────
echo "→ Creating directories..."
mkdir -p "$DATA_DIR" "$TRANSCRIPT_DIR"

# ── Step 2: Python venv for webhook server ────────────────────────
echo "→ Setting up Python venv..."
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install -q -r "$SCRIPT_DIR/webhook-server/requirements.txt"
echo "  ✓ Python dependencies installed"

# ── Step 3: Install into OpenClaw ─────────────────────────────────
echo "→ Installing plugin into OpenClaw..."
if command -v openclaw &>/dev/null; then
    openclaw plugins install "$SCRIPT_DIR" || {
        echo "  ⚠ Auto-install failed. Manual install:"
        echo "    cp -r $SCRIPT_DIR ~/.openclaw/extensions/alfred-talk"
        echo "    Then restart gateway: openclaw gateway restart"
    }
else
    echo "  ⚠ openclaw CLI not found. Manual install:"
    echo "    cp -r $SCRIPT_DIR ~/.openclaw/extensions/alfred-talk"
fi

# ── Step 4: Create service ────────────────────────────────────────
echo "→ Creating webhook server service..."

if [[ "$(uname)" == "Darwin" ]]; then
    # macOS: launchd
    PLIST_PATH="$HOME/Library/LaunchAgents/com.alfred-talk.webhook.plist"
    cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.alfred-talk.webhook</string>
    <key>ProgramArguments</key>
    <array>
        <string>$VENV_DIR/bin/python3</string>
        <string>$SCRIPT_DIR/webhook-server/server.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR/webhook-server</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$DATA_DIR/webhook.log</string>
    <key>StandardErrorPath</key>
    <string>$DATA_DIR/webhook.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TRANSCRIPT_DIR</key>
        <string>$TRANSCRIPT_DIR</string>
    </dict>
</dict>
</plist>
EOF
    launchctl load "$PLIST_PATH" 2>/dev/null || true
    echo "  ✓ launchd service created: $PLIST_PATH"
else
    # Linux: systemd
    SERVICE_PATH="$HOME/.config/systemd/user/alfred-talk-webhook.service"
    mkdir -p "$(dirname "$SERVICE_PATH")"
    cat > "$SERVICE_PATH" << EOF
[Unit]
Description=Alfred Talk Webhook Server
After=network.target

[Service]
ExecStart=$VENV_DIR/bin/python3 $SCRIPT_DIR/webhook-server/server.py
WorkingDirectory=$SCRIPT_DIR/webhook-server
Environment=TRANSCRIPT_DIR=$TRANSCRIPT_DIR
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable alfred-talk-webhook
    systemctl --user start alfred-talk-webhook
    echo "  ✓ systemd service created and started"
fi

# ── Done ──────────────────────────────────────────────────────────
echo
echo "╔══════════════════════════════════════════╗"
echo "║           Installation Complete          ║"
echo "╚══════════════════════════════════════════╝"
echo
echo "Next steps:"
echo
echo "1. Configure your OpenClaw config (openclaw.json):"
echo
echo '   "plugins": {'
echo '     "entries": {'
echo '       "alfred-talk": {'
echo '         "enabled": true,'
echo '         "config": {'
echo '           "elevenlabs": {'
echo '             "apiKey": "YOUR_ELEVENLABS_API_KEY",'
echo '             "agentId": "YOUR_AGENT_ID",'
echo '             "phoneNumberId": "YOUR_PHONE_NUMBER_ID"'
echo '           },'
echo '           "webhook": {'
echo '             "port": 8770'
echo '           },'
echo '           "transcripts": {'
echo '             "inboxDir": "~/vault/inbox"'
echo '           },'
echo '           "contacts": {'
echo '             "+36701234567": "Mom",'
echo '             "+36709876543": "Dad"'
echo '           }'
echo '         }'
echo '       }'
echo '     }'
echo '   }'
echo
echo "2. Set up a public URL for the webhook (e.g., ngrok):"
echo "   ngrok http 8770"
echo "   Then paste the URL into ElevenLabs Agent → Webhook Settings"
echo "   Webhook URL: https://YOUR-NGROK.ngrok.io/elevenlabs-webhook"
echo
echo "3. Restart OpenClaw gateway:"
echo "   openclaw gateway restart"
echo
echo "4. Test: tell your agent 'call +1234567890 and say hello'"
