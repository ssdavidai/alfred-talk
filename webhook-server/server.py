"""
Alfred Talk — ElevenLabs Webhook Receiver.

Receives post-call transcription webhooks from ElevenLabs and saves them
as JSON files organized by date. The OpenClaw plugin watches for these
files and handles processing (summarization, notification, vault inbox).

This is a minimal server — it only catches webhooks and persists them.
"""

import os
import json
import hmac
import hashlib
import logging
from pathlib import Path
from datetime import datetime, timezone

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

# ── Config ────────────────────────────────────────────────────────
PORT = int(os.environ.get("WEBHOOK_PORT", "8770"))
TRANSCRIPT_DIR = Path(os.environ.get("TRANSCRIPT_DIR", str(Path.home() / ".openclaw" / "alfred-talk" / "transcripts")))
WEBHOOK_SECRET = os.environ.get("ELEVENLABS_WEBHOOK_SECRET", "")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("alfred-talk-webhook")

app = FastAPI(title="Alfred Talk Webhook Receiver")


def _verify_signature(payload: bytes, sig_header: str, secret: str) -> bool:
    """Verify HMAC signature from ElevenLabs webhook."""
    try:
        parts = sig_header.split(",")
        timestamp = parts[0].split("=", 1)[1]
        signature = parts[1].split("=", 1)[1]
        message = f"{timestamp}.{payload.decode()}"
        expected = hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)
    except Exception as e:
        log.warning(f"Signature parse error: {e}")
        return False


@app.get("/health")
async def health():
    return {"status": "ok", "service": "alfred-talk-webhook"}


@app.post("/elevenlabs-webhook")
async def elevenlabs_webhook(request: Request):
    """Receive post-call transcription webhooks from ElevenLabs."""
    raw_body = await request.body()

    # Verify signature if configured
    if WEBHOOK_SECRET:
        sig = request.headers.get("elevenlabs-signature", "")
        if not sig or not _verify_signature(raw_body, sig, WEBHOOK_SECRET):
            log.warning("Invalid webhook signature")
            raise HTTPException(401, "Invalid signature")

    try:
        payload = json.loads(raw_body)
        event_type = payload.get("type", payload.get("event_type", "unknown"))
        log.info(f"Webhook received: type={event_type}")

        if event_type == "post_call_transcription":
            conversation_id = (
                payload.get("data", {}).get("conversation_id")
                or payload.get("conversation_id", "unknown")
            )

            now = datetime.now(timezone.utc)
            day_dir = TRANSCRIPT_DIR / now.strftime("%Y-%m-%d")
            day_dir.mkdir(parents=True, exist_ok=True)

            base = f"{now.strftime('%H-%M-%S')}_{conversation_id}"
            json_path = day_dir / f"{base}.json"
            json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

            log.info(f"Saved transcript: {json_path}")
        else:
            log.info(f"Ignoring event type: {event_type}")

    except Exception as e:
        log.error(f"Webhook processing error: {e}")

    return JSONResponse({"status": "ok"})


if __name__ == "__main__":
    import uvicorn
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
