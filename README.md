# alfred-talk

OpenClaw plugin for ElevenLabs voice agent integration — make AI phone calls with context-aware prompting and automatic transcript processing.

## What it does

Give your OpenClaw agent the ability to make phone calls. The agent builds context from its knowledge base, composes a prompt, and triggers an outbound call via ElevenLabs Conversational AI. After the call, the transcript is automatically processed and delivered.

```
User: "Call Mom and ask what she wants for lunch Sunday"

┌─────────────────────────────────────────────────────────┐
│  1. Agent searches vault/knowledge for context          │
│     → "Mom = Maria, speaks Spanish, lives in Barcelona"  │
│                                                         │
│  2. Composes prompt + context + first message            │
│     → Sends to ElevenLabs API                           │
│                                                         │
│  3. ElevenLabs calls +34612345678                       │
│     → Handles voice conversation (their LLM + voice)    │
│                                                         │
│  4. Call ends → webhook fires                           │
│     → Transcript saved to disk                          │
│                                                         │
│  5. Plugin processes transcript                         │
│     → Summarizes via Haiku                              │
│     → Notifies user (Slack/Telegram/Discord/etc.)       │
│     → Writes to vault inbox for curator                 │
└─────────────────────────────────────────────────────────┘
```

## Architecture

```
                    ┌──────────────────┐
                    │   ElevenLabs     │
                    │   Voice Agent    │
                    │  (their LLM,    │
                    │   their voice)   │
                    └──────┬───────────┘
                           │
              ┌────────────┼────────────┐
              │ outbound   │ webhook    │
              │ call API   │ callback   │
              │            │            │
         ┌────┴────┐  ┌───┴──────┐     │
         │ alfred  │  │ webhook  │     │
         │ _talk   │  │ server   │     │
         │ tool    │  │ (FastAPI)│     │
         └────┬────┘  └───┬──────┘     │
              │            │            │
         ┌────┴────────────┴────┐       │
         │   OpenClaw Plugin    │       │
         │   (index.ts)         │       │
         │                      │       │
         │  • Transcript watcher│       │
         │  • Summarizer        │       │
         │  • Channel notifier  │       │
         │  • Vault inbox writer│       │
         └──────────────────────┘
```

**Key insight:** The LLM for the voice conversation runs inside ElevenLabs (you select the model in their dashboard). This plugin does NOT proxy LLM calls. It only:
1. Triggers calls with context-rich prompts
2. Catches transcripts via webhook
3. Processes and distributes them

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- [ElevenLabs](https://elevenlabs.io) account with:
  - Conversational AI agent configured
  - Phone number provisioned (or Twilio integration)
  - API key
- A public URL for the webhook (e.g., [ngrok](https://ngrok.com))

## Quick Start

### Option A: Install via npm (recommended)

```bash
openclaw plugins install alfred-talk
openclaw gateway restart
```

### Option B: Install from source

```bash
git clone https://github.com/ssdavidai/alfred-talk.git
cd alfred-talk
chmod +x install.sh
./install.sh

# 3. Configure (see Configuration below)

# 4. Restart OpenClaw
openclaw gateway restart

# 5. Set up webhook URL
ngrok http 8770
# Copy the URL → ElevenLabs Agent Dashboard → Webhook Settings
# Webhook URL: https://YOUR-NGROK.ngrok.io/elevenlabs-webhook
```

## Configuration

Add to your OpenClaw config (`openclaw.json` or via `openclaw config edit`):

```json
{
  "plugins": {
    "entries": {
      "alfred-talk": {
        "enabled": true,
        "config": {
          "elevenlabs": {
            "apiKey": "sk_...",
            "agentId": "agent_xxxx",
            "phoneNumberId": "phnum_xxxx"
          },
          "webhook": {
            "port": 8770,
            "secret": "your-webhook-signing-secret"
          },
          "transcripts": {
            "dir": "~/.openclaw/alfred-talk/transcripts",
            "inboxDir": "~/vault/inbox",
            "summaryModel": "anthropic/claude-haiku-4-5"
          },
          "contacts": {
            "+34612345678": "Mom",
            "+34698765432": "Partner"
          }
        }
      }
    }
  }
}
```

### Configuration Reference

| Key | Description | Default |
|-----|-------------|---------|
| `elevenlabs.apiKey` | ElevenLabs API key | — (required) |
| `elevenlabs.agentId` | ElevenLabs agent ID | — (required) |
| `elevenlabs.phoneNumberId` | ElevenLabs phone number ID | — |
| `webhook.port` | Webhook server port | `8770` |
| `webhook.secret` | ElevenLabs webhook signing secret | — |
| `transcripts.dir` | Where to store transcript JSON files | `~/.openclaw/alfred-talk/transcripts` |
| `transcripts.inboxDir` | Vault inbox for curator processing | — |
| `transcripts.summaryModel` | Model for transcript summarization | `anthropic/claude-haiku-4-5` |
| `contacts` | Phone → name map for caller identification | `{}` |

## Usage

Once configured, your agent can make calls:

```
User: "Call +34612345678 and ask about Sunday lunch"
Agent: [searches vault for context about this number]
Agent: [triggers call via alfred_talk tool]
Agent: "Call initiated to Mom (+34612345678). I'll send you the transcript when it's done."
```

The agent should:
1. Search its knowledge base for context about the person being called
2. Build a rich prompt with relationship details, language preferences, recent context
3. Trigger the call with `alfred_talk` tool
4. The rest is automatic — transcript arrives via webhook and is processed

## CLI

```bash
openclaw alfred-talk status       # Show webhook server status
```

## How It Works (Detailed)

### Outbound Call Flow
1. Agent receives task: "call Mom about lunch"
2. Agent searches vault/knowledge for context about Mom
3. Agent calls `alfred_talk` tool with: phone number, task description, context, optional first message
4. Plugin composes a prompt combining the task + context
5. Plugin calls ElevenLabs `create-phone-call` API with the prompt
6. ElevenLabs places the call, handles the conversation with its own LLM and voice

### Transcript Processing Flow
1. Call ends → ElevenLabs sends POST to `/elevenlabs-webhook`
2. Webhook server saves raw JSON to `transcripts/YYYY-MM-DD/HH-MM-SS_convId.json`
3. Plugin transcript watcher detects new file (10s poll)
4. Processes transcript: resolve caller name, format text
5. Sends full transcript to user's channel (OpenClaw handles routing)
6. Spawns summarizer (Haiku) → sends summary to user
7. Writes structured markdown to vault inbox for curator

## Troubleshooting

**Calls not going through:**
- Verify ElevenLabs API key and agent ID in config
- Check ElevenLabs dashboard for agent status and phone number
- Ensure phone number is in E.164 format (+CountryCode...)

**Transcripts not arriving:**
- Check webhook server is running: `openclaw alfred-talk status`
- Verify ngrok is running and URL is set in ElevenLabs dashboard
- Check webhook server logs: `tail -f ~/.openclaw/alfred-talk/webhook.log`

**Summaries not posting:**
- Verify OpenClaw gateway is running
- Check that the summary model is accessible

## License

MIT
