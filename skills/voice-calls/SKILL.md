# Skill: Voice Calls (alfred-talk)

Make and manage AI voice calls via ElevenLabs Conversational AI.

## When to use
- User asks to **call someone** by phone
- User asks about **recent phone calls** or transcripts
- User asks to **check voice call status**

## How it works
1. User says: "Call Mom and ask about lunch plans"
2. You search your knowledge (qmd, vault, contacts) for relevant context about the person
3. You call the `alfred_talk` tool with `action: "call"`, the phone number, the task description, and the context you gathered
4. ElevenLabs handles the actual phone conversation using its own voice and LLM
5. When the call ends, the transcript is automatically delivered to the user's channel and saved to the vault inbox

## Tool: alfred_talk

### Make a call
```json
{
  "action": "call",
  "to": "+34612345678",
  "task": "Ask about what she wants for lunch on Sunday",
  "context": "This is Maria, user's mother. She speaks Spanish. She lives in Barcelona.",
  "firstMessage": "Hola Maria! Soy Alfred, el asistente de tu hijo."
}
```

**Important:** Always build context BEFORE calling. Search the vault, check contacts, review recent conversations about this person. The context is injected into the voice agent's prompt.

### List recent transcripts
```json
{
  "action": "list_transcripts",
  "limit": 5
}
```

### Get a specific transcript
```json
{
  "action": "get_transcript",
  "conversationId": "abc123"
}
```

### Check status
```json
{
  "action": "status"
}
```

## Notes
- Phone numbers must be in E.164 format (e.g., +36701234567)
- The voice agent's LLM runs inside ElevenLabs — we only provide the prompt and context
- Transcripts are automatically processed: summary sent to user, full transcript to vault inbox
- Build rich context before every call — the voice agent is only as good as the context you give it
