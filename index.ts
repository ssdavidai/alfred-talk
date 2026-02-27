/**
 * alfred-talk — OpenClaw plugin for ElevenLabs voice agent integration.
 *
 * Architecture:
 *   1. Agent receives task: "call Mom and ask about lunch"
 *   2. Plugin builds context (vault search, contacts) and composes a prompt
 *   3. Plugin calls ElevenLabs API to trigger outbound call with that prompt
 *   4. ElevenLabs handles the voice conversation (their LLM, their voice)
 *   5. After hangup, ElevenLabs sends webhook with full transcript
 *   6. Plugin processes transcript: notify user's channel + write to vault inbox
 *
 * The LLM for the voice conversation runs inside ElevenLabs (configured in
 * their dashboard). We do NOT proxy /v1/chat/completions.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Paths ────────────────────────────────────────────────────────
const DATA_DIR = join(homedir(), ".openclaw", "alfred-talk");
const TRANSCRIPT_DIR_DEFAULT = join(DATA_DIR, "transcripts");
const VENV_DIR = join(DATA_DIR, "venv");
const ZO_SECRETS_PATH = "/root/.zo_secrets";

// ── Zo Secrets ───────────────────────────────────────────────────

function isZoComputer(): boolean {
  return existsSync(ZO_SECRETS_PATH);
}

function loadZoSecrets(): Record<string, string> {
  if (!existsSync(ZO_SECRETS_PATH)) return {};
  try {
    const content = readFileSync(ZO_SECRETS_PATH, "utf-8");
    const secrets: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        secrets[key] = val;
      }
    }
    return secrets;
  } catch {
    return {};
  }
}

function saveZoSecret(key: string, value: string): void {
  if (!isZoComputer()) return;
  const secrets = loadZoSecrets();
  secrets[key] = value;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(secrets)) {
    lines.push(`${k}="${v}"`);
  }
  writeFileSync(ZO_SECRETS_PATH, lines.join("\n") + "\n");
}
const PROCESSED_FILE_NAME = ".processed";

function ensureDirs(transcriptDir: string) {
  for (const d of [DATA_DIR, transcriptDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

// ── Auto-setup: Python venv + dependencies ───────────────────────

function findVenvPython(): string | null {
  // Try common venv python paths
  for (const p of [
    join(VENV_DIR, "bin", "python3"),
    join(VENV_DIR, "bin", "python"),
    join(VENV_DIR, "Scripts", "python.exe"), // Windows
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function findVenvPip(): string | null {
  for (const p of [
    join(VENV_DIR, "bin", "pip"),
    join(VENV_DIR, "bin", "pip3"),
    join(VENV_DIR, "Scripts", "pip.exe"),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function ensurePythonEnv(logger: any): string {
  const existingPython = findVenvPython();

  // Verify existing venv works (not half-broken)
  if (existingPython) {
    const testResult = spawnSync(existingPython, ["-c", "import fastapi; print('ok')"], {
      stdio: "pipe",
      timeout: 10_000,
    });
    if (testResult.status === 0) {
      return existingPython;
    }
    logger.info("[alfred-talk] Venv exists but dependencies missing, reinstalling...");
  } else {
    logger.info("[alfred-talk] First run — setting up Python environment...");
  }

  // Check python3 exists on system
  const pythonCheck = spawnSync("python3", ["--version"], { stdio: "pipe", timeout: 5_000 });
  if (pythonCheck.status !== 0) {
    const msg = "python3 not found. Install Python 3.10+ and try again.";
    logger.error(`[alfred-talk] ${msg}`);
    throw new Error(msg);
  }
  logger.info(`[alfred-talk] Found ${pythonCheck.stdout?.toString().trim()}`);

  // Nuke broken venv if it exists but is broken
  if (existingPython || existsSync(VENV_DIR)) {
    const rmResult = spawnSync("rm", ["-rf", VENV_DIR], { stdio: "pipe", timeout: 10_000 });
    logger.info("[alfred-talk] Removed broken/incomplete venv");
  }

  // Create fresh venv
  const venvResult = spawnSync("python3", ["-m", "venv", VENV_DIR], {
    stdio: "pipe",
    timeout: 60_000,
  });
  if (venvResult.status !== 0) {
    const stderr = venvResult.stderr?.toString().trim() || "";
    const stdout = venvResult.stdout?.toString().trim() || "";
    const signal = venvResult.signal ? String(venvResult.signal) : "";
    const err = stderr || stdout || signal || `exit code ${venvResult.status}`;
    logger.error(`[alfred-talk] Failed to create venv: ${err}`);
    if (err.includes("ensurepip") || err.includes("No module named")) {
      logger.error("[alfred-talk] Fix: apt install python3-venv (Debian/Ubuntu) or dnf install python3-pip (Fedora)");
    }
    throw new Error(`venv creation failed: ${err}`);
  }

  // Find the python/pip in venv
  const pythonBin = findVenvPython();
  const pipBin = findVenvPip();
  if (!pythonBin || !pipBin) {
    // venv created but no python — python3-venv package is missing
    logger.error("[alfred-talk] venv directory created but no python binary inside.");
    logger.error("[alfred-talk] This means python3-venv is not installed on your system.");
    logger.error("[alfred-talk] Fix: apt install python3-venv (Debian/Ubuntu) or dnf install python3-devel (Fedora)");
    // Clean up the broken venv
    spawnSync("rm", ["-rf", VENV_DIR], { stdio: "pipe" });
    throw new Error("python3-venv not installed. Run: apt install python3-venv");
  }
  logger.info("[alfred-talk] Python venv created");

  // Install dependencies
  const reqFile = join(__dirname, "webhook-server", "requirements.txt");
  if (existsSync(reqFile)) {
    logger.info("[alfred-talk] Installing Python dependencies...");
    const pipResult = spawnSync(pipBin, ["install", "-r", reqFile], {
      stdio: "pipe",
      timeout: 120_000,
    });
    if (pipResult.status !== 0) {
      const stderr = pipResult.stderr?.toString().trim() || "";
      const stdout = pipResult.stdout?.toString().trim() || "";
      const err = stderr || stdout || `exit code ${pipResult.status}`;
      logger.error(`[alfred-talk] pip install failed: ${err}`);
      throw new Error(`pip install failed: ${err}`);
    }
    logger.info("[alfred-talk] Python dependencies installed");
  }

  return pythonBin;
}

// ── Helpers ──────────────────────────────────────────────────────

function getTranscriptDir(cfg: any): string {
  const d = cfg?.transcripts?.dir;
  return d ? d.replace("~", homedir()) : TRANSCRIPT_DIR_DEFAULT;
}

function processedFilePath(transcriptDir: string): string {
  return join(transcriptDir, PROCESSED_FILE_NAME);
}

function loadProcessed(transcriptDir: string): Set<string> {
  const p = processedFilePath(transcriptDir);
  if (!existsSync(p)) return new Set();
  return new Set(
    readFileSync(p, "utf-8").trim().split("\n").filter(Boolean),
  );
}

function markProcessed(transcriptDir: string, path: string) {
  appendFileSync(processedFilePath(transcriptDir), path + "\n");
}

function resolveCallerName(phone: string, contacts: Record<string, string>): string {
  return contacts[phone] || phone || "Unknown caller";
}

// ── Plugin ───────────────────────────────────────────────────────

let webhookProcess: ChildProcess | null = null;

export const id = "alfred-talk";
export const name = "Alfred Talk";

export default function register(api: any) {
  const cfg = () =>
    api.config?.plugins?.entries?.["alfred-talk"]?.config ?? {};

  const transcriptDir = getTranscriptDir(cfg());
  ensureDirs(transcriptDir);

  // ── Background service: webhook receiver ─────────────────────
  api.registerService({
    id: "alfred-talk-webhook",
    start: () => {
      const c = cfg();
      const serverScript = join(__dirname, "webhook-server", "server.py");
      if (!existsSync(serverScript)) {
        api.logger.warn(`[alfred-talk] Webhook server script not found: ${serverScript}`);
        return;
      }

      // Auto-setup Python env on first run
      let pythonBin: string;
      try {
        pythonBin = ensurePythonEnv(api.logger);
      } catch (err: any) {
        api.logger.error(`[alfred-talk] Python setup failed: ${err.message}`);
        return;
      }

      const port = String(c.webhook?.port ?? 8770);
      const tDir = getTranscriptDir(c);
      const env: Record<string, string> = {
        ...process.env,
        WEBHOOK_PORT: port,
        TRANSCRIPT_DIR: tDir,
      };

      if (c.webhook?.secret) env.ELEVENLABS_WEBHOOK_SECRET = c.webhook.secret;

      webhookProcess = spawn(pythonBin, [serverScript], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      webhookProcess.stdout?.on("data", (d: Buffer) =>
        api.logger.info(`[alfred-talk:webhook] ${d.toString().trim()}`),
      );
      webhookProcess.stderr?.on("data", (d: Buffer) =>
        api.logger.warn(`[alfred-talk:webhook] ${d.toString().trim()}`),
      );
      webhookProcess.on("exit", (code: number | null) =>
        api.logger.info(`[alfred-talk:webhook] exited (code=${code})`),
      );

      api.logger.info(`[alfred-talk] Webhook server started on port ${port}`);
    },
    stop: () => {
      if (webhookProcess) {
        webhookProcess.kill("SIGTERM");
        webhookProcess = null;
        api.logger.info("[alfred-talk] Webhook server stopped");
      }
    },
  });

  // ── Hook: watch for new transcript files ─────────────────────
  // When a new transcript JSON lands, process it automatically.
  let watchInterval: ReturnType<typeof setInterval> | null = null;

  api.registerService({
    id: "alfred-talk-transcript-watcher",
    start: () => {
      const c = cfg();
      const tDir = getTranscriptDir(c);

      // Poll every 10 seconds for new transcript files
      watchInterval = setInterval(async () => {
        try {
          await scanAndProcessTranscripts(api, c, tDir);
        } catch (err: any) {
          api.logger.warn(`[alfred-talk] Transcript scan error: ${err.message}`);
        }
      }, 10_000);

      api.logger.info("[alfred-talk] Transcript watcher started (10s poll)");
    },
    stop: () => {
      if (watchInterval) {
        clearInterval(watchInterval);
        watchInterval = null;
        api.logger.info("[alfred-talk] Transcript watcher stopped");
      }
    },
  });

  // ── Agent tool: alfred_talk ──────────────────────────────────
  api.registerTool(
    {
      name: "alfred_talk",
      description:
        "Make outbound AI phone calls via ElevenLabs. Builds context from the vault/knowledge base, " +
        "composes a prompt for the voice agent, and triggers the call. After the call, the transcript " +
        "is automatically processed and delivered to the user's channel.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["call", "list_transcripts", "get_transcript", "status"],
            description: "Action to perform",
          },
          to: {
            type: "string",
            description:
              "Phone number to call (E.164 format, e.g. +36701234567). Required for 'call'.",
          },
          task: {
            type: "string",
            description:
              "What the voice agent should accomplish on this call (e.g. 'ask about lunch plans'). Required for 'call'.",
          },
          firstMessage: {
            type: "string",
            description:
              "Opening message the voice agent says when the call connects. Optional — generated from task if not provided.",
          },
          context: {
            type: "string",
            description:
              "Additional context to inject into the voice agent's prompt (e.g. vault search results, relationship notes). " +
              "The agent should build this from qmd search, contacts, and relevant knowledge before calling.",
          },
          conversationId: {
            type: "string",
            description: "Conversation ID. Required for 'get_transcript'.",
          },
          limit: {
            type: "number",
            description: "Number of recent transcripts to list (default: 10).",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const c = cfg();

        if (params.action === "call") {
          if (!params.to || !params.task) {
            return text("Error: 'to' and 'task' are required for call action.");
          }
          return await makeOutboundCall(api, c, params);
        }

        if (params.action === "list_transcripts") {
          return listTranscripts(getTranscriptDir(c), params.limit ?? 10, c.contacts ?? {});
        }

        if (params.action === "get_transcript") {
          if (!params.conversationId) {
            return text("Error: 'conversationId' required.");
          }
          return getTranscript(getTranscriptDir(c), params.conversationId, c.contacts ?? {});
        }

        if (params.action === "status") {
          const running = webhookProcess !== null && !webhookProcess.killed;
          return text(
            JSON.stringify({
              webhookServer: running ? "running" : "stopped",
              transcriptDir: getTranscriptDir(c),
              processedCount: loadProcessed(getTranscriptDir(c)).size,
            }),
          );
        }

        return text(`Unknown action: ${params.action}`);
      },
    },
    { optional: true },
  );

  // ── CLI command ──────────────────────────────────────────────
  api.registerCli(
    ({ program }: any) => {
      const cmd = program
        .command("alfred-talk")
        .description("Alfred Talk voice agent commands");

      cmd
        .command("status")
        .description("Show voice agent status")
        .action(() => {
          const c = cfg();
          const tDir = getTranscriptDir(c);
          const running = webhookProcess !== null && !webhookProcess.killed;
          console.log(`Webhook server: ${running ? "running" : "stopped"}`);
          console.log(`Transcript dir: ${tDir}`);
          console.log(`Processed: ${loadProcessed(tDir).size} transcripts`);
        });

      cmd
        .command("setup")
        .description("Interactive configuration for alfred-talk")
        .action(async () => {
          const { createInterface } = await import("node:readline");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const ask = (q: string, def?: string): Promise<string> =>
            new Promise((resolve) => {
              const suffix = def ? ` (${def})` : "";
              rl.question(`${q}${suffix}: `, (answer: string) => {
                resolve(answer.trim() || def || "");
              });
            });

          console.log("");
          console.log("╔══════════════════════════════════════════════╗");
          console.log("║       Alfred Talk — Interactive Setup        ║");
          console.log("╚══════════════════════════════════════════════╝");
          console.log("");

          // Load existing config
          const configPath = join(homedir(), ".openclaw", "openclaw.json");
          let fullConfig: any = {};
          try {
            fullConfig = JSON.parse(readFileSync(configPath, "utf-8"));
          } catch {}

          const existing = fullConfig?.plugins?.entries?.["alfred-talk"]?.config ?? {};

          // Load Zo secrets if on a Zo Computer
          const zoSecrets = loadZoSecrets();
          const isZo = isZoComputer();
          if (isZo) {
            console.log("  🖥️  Zo Computer detected — secrets will be saved to /root/.zo_secrets\n");
          }

          console.log("  ElevenLabs credentials (from elevenlabs.io dashboard)\n");

          const existingApiKey = existing.elevenlabs?.apiKey || zoSecrets.ELEVENLABS_API_KEY;
          const apiKey = await ask(
            "  ElevenLabs API Key",
            existingApiKey ? "••••••" + existingApiKey.slice(-4) : undefined,
          );
          const agentId = await ask("  ElevenLabs Agent ID", existing.elevenlabs?.agentId || zoSecrets.ELEVENLABS_AGENT_ID);
          const phoneNumberId = await ask(
            "  ElevenLabs Phone Number ID",
            existing.elevenlabs?.phoneNumberId || zoSecrets.ELEVENLABS_PHONE_NUMBER_ID || "skip",
          );

          console.log("\n  Webhook settings\n");

          const webhookPort = await ask("  Webhook server port", String(existing.webhook?.port ?? 8770));
          const webhookSecret = await ask(
            "  Webhook signing secret",
            existing.webhook?.secret ? "••••••" : "skip",
          );

          console.log("\n  Transcript processing\n");

          const inboxDir = await ask("  Vault inbox directory", existing.transcripts?.inboxDir || "~/vault/inbox");
          const summaryModel = await ask(
            "  Summary model",
            existing.transcripts?.summaryModel || "anthropic/claude-haiku-4-5",
          );

          console.log("\n  Contacts (phone → name mapping)\n");

          const contacts: Record<string, string> = { ...(existing.contacts ?? {}) };
          let addMore = true;
          if (Object.keys(contacts).length > 0) {
            console.log("  Existing contacts:");
            for (const [phone, name] of Object.entries(contacts)) {
              console.log(`    ${phone} → ${name}`);
            }
            console.log("");
          }
          while (addMore) {
            const phone = await ask("  Add contact phone (or 'done')", "done");
            if (phone === "done" || phone === "") {
              addMore = false;
            } else {
              const contactName = await ask(`  Name for ${phone}`);
              if (contactName) contacts[phone] = contactName;
            }
          }

          // Build config
          const pluginConfig: any = {
            elevenlabs: {
              apiKey: apiKey.startsWith("••") ? existing.elevenlabs?.apiKey : apiKey,
              agentId: agentId,
            },
            webhook: {
              port: parseInt(webhookPort) || 8770,
            },
            transcripts: {
              inboxDir: inboxDir,
              summaryModel: summaryModel,
            },
          };

          if (phoneNumberId && phoneNumberId !== "skip") {
            pluginConfig.elevenlabs.phoneNumberId = phoneNumberId;
          }
          if (webhookSecret && webhookSecret !== "skip" && !webhookSecret.startsWith("••")) {
            pluginConfig.webhook.secret = webhookSecret;
          } else if (existing.webhook?.secret) {
            pluginConfig.webhook.secret = existing.webhook.secret;
          }
          if (Object.keys(contacts).length > 0) {
            pluginConfig.contacts = contacts;
          }

          // Write to openclaw.json
          if (!fullConfig.plugins) fullConfig.plugins = {};
          if (!fullConfig.plugins.entries) fullConfig.plugins.entries = {};
          fullConfig.plugins.entries["alfred-talk"] = {
            enabled: true,
            config: pluginConfig,
          };

          try {
            writeFileSync(configPath, JSON.stringify(fullConfig, null, 2) + "\n");
            console.log("\n  ✓ Configuration saved to ~/.openclaw/openclaw.json");
          } catch (err: any) {
            console.error(`\n  ✗ Failed to save config: ${err.message}`);
            console.log("\n  Config to add manually:\n");
            console.log(JSON.stringify({ "alfred-talk": { enabled: true, config: pluginConfig } }, null, 2));
          }

          // Save secrets to Zo Computer if available
          if (isZo) {
            const resolvedApiKey = pluginConfig.elevenlabs.apiKey;
            if (resolvedApiKey) saveZoSecret("ELEVENLABS_API_KEY", resolvedApiKey);
            if (pluginConfig.elevenlabs.agentId) saveZoSecret("ELEVENLABS_AGENT_ID", pluginConfig.elevenlabs.agentId);
            if (pluginConfig.elevenlabs.phoneNumberId) saveZoSecret("ELEVENLABS_PHONE_NUMBER_ID", pluginConfig.elevenlabs.phoneNumberId);
            if (pluginConfig.webhook?.secret) saveZoSecret("ELEVENLABS_WEBHOOK_SECRET", pluginConfig.webhook.secret);
            console.log("  ✓ Secrets saved to /root/.zo_secrets");
          }

          // Detect machine IP
          let machineIp = "localhost";
          try {
            const tsResult = spawnSync("tailscale", ["ip", "-4"], { stdio: "pipe", timeout: 5_000 });
            if (tsResult.status === 0) {
              machineIp = tsResult.stdout?.toString().trim().split("\n")[0] || machineIp;
            } else {
              const hostResult = spawnSync("hostname", ["-I"], { stdio: "pipe", timeout: 5_000 });
              if (hostResult.status === 0) {
                machineIp = hostResult.stdout?.toString().trim().split(" ")[0] || machineIp;
              } else {
                const ifResult = spawnSync("sh", ["-c", "ifconfig | grep 'inet ' | grep -v 127.0.0.1 | head -1 | awk '{print $2}'"], { stdio: "pipe", timeout: 5_000 });
                if (ifResult.status === 0) {
                  machineIp = ifResult.stdout?.toString().trim() || machineIp;
                }
              }
            }
          } catch {}

          const wPort = parseInt(webhookPort) || 8770;
          console.log("\n  Next steps:");
          console.log("  1. Restart gateway: openclaw gateway restart");
          console.log(`  2. Expose webhook publicly (ElevenLabs needs to reach it)`);
          console.log(`     Option A: ngrok http ${wPort}`);
          console.log(`     Option B: tailscale funnel ${wPort} (if on tailnet)`);
          console.log(`     Local URL: http://${machineIp}:${wPort}/elevenlabs-webhook`);
          console.log("  3. Paste the public URL into ElevenLabs Agent → Webhook Settings");
          console.log("");

          rl.close();
        });
    },
    { commands: ["alfred-talk"] },
  );

  api.logger.info("[alfred-talk] Plugin registered");
}

// ── Outbound call ────────────────────────────────────────────────

async function makeOutboundCall(api: any, cfg: any, params: any) {
  const zoSec = loadZoSecrets();
  const apiKey = cfg.elevenlabs?.apiKey ?? process.env.ELEVENLABS_API_KEY ?? zoSec.ELEVENLABS_API_KEY;
  const agentId = cfg.elevenlabs?.agentId ?? process.env.ELEVENLABS_AGENT_ID ?? zoSec.ELEVENLABS_AGENT_ID;
  const phoneNumberId =
    cfg.elevenlabs?.phoneNumberId ?? process.env.ELEVENLABS_PHONE_NUMBER_ID ?? zoSec.ELEVENLABS_PHONE_NUMBER_ID;

  if (!apiKey || !agentId) {
    return text("Error: elevenlabs.apiKey and elevenlabs.agentId must be configured.");
  }

  const { to, task, firstMessage, context } = params;
  const contactName = resolveCallerName(to, cfg.contacts ?? {});

  // Build the voice agent's prompt from the task + context
  const promptParts: string[] = [];
  promptParts.push(`You are making a phone call to ${contactName} (${to}).`);
  promptParts.push(`Your objective: ${task}`);
  if (context) {
    promptParts.push(`\nRelevant context:\n${context}`);
  }
  promptParts.push(
    "\nKeep the conversation natural and warm. Be concise. " +
      "When you've accomplished the objective, wrap up politely.",
  );

  const agentPrompt = promptParts.join("\n");

  // Generate first message if not provided
  const opening =
    firstMessage ||
    `Hello${contactName !== to ? `, ${contactName.split(" ")[0]}` : ""}! This is Alfred calling.`;

  try {
    const resp = await fetch(
      "https://api.elevenlabs.io/v1/convai/conversation/create-phone-call",
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: agentId,
          agent_phone_number_id: phoneNumberId,
          to_number: to,
          conversation_config: {
            agent: {
              prompt: { prompt: agentPrompt },
              first_message: opening,
            },
          },
        }),
      },
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return text(`ElevenLabs API error (${resp.status}): ${errText}`);
    }

    const result: any = await resp.json();
    api.logger.info(
      `[alfred-talk] Outbound call to ${contactName} (${to}): ${JSON.stringify(result)}`,
    );

    return text(
      JSON.stringify({
        status: "call_initiated",
        to,
        contactName,
        task,
        conversationId: result.conversation_id,
        ...result,
      }),
    );
  } catch (err: any) {
    return text(`Failed to initiate call: ${err.message}`);
  }
}

// ── Transcript scanning + processing ─────────────────────────────

async function scanAndProcessTranscripts(api: any, cfg: any, transcriptDir: string) {
  if (!existsSync(transcriptDir)) return;

  const processed = loadProcessed(transcriptDir);

  for (const dateDir of readdirSync(transcriptDir).sort().reverse()) {
    const datePath = join(transcriptDir, dateDir);
    if (dateDir.startsWith(".")) continue;

    let entries: string[];
    try {
      entries = readdirSync(datePath).filter((f: string) => f.endsWith(".json"));
    } catch {
      continue;
    }

    for (const file of entries) {
      const filePath = join(datePath, file);
      if (processed.has(filePath)) continue;

      try {
        await processTranscript(api, cfg, transcriptDir, filePath);
      } catch (err: any) {
        api.logger.warn(`[alfred-talk] Failed to process ${file}: ${err.message}`);
      }
    }
  }
}

async function processTranscript(
  api: any,
  cfg: any,
  transcriptDir: string,
  filePath: string,
) {
  const data = JSON.parse(readFileSync(filePath, "utf-8"));

  const contacts: Record<string, string> = cfg.contacts ?? {};
  const userPhone = data?.data?.user_id ?? data?.user_id ?? "";
  const callerName = resolveCallerName(userPhone, contacts);
  const callDuration = data?.data?.metadata?.call_duration_secs ?? 0;
  const conversationId =
    data?.data?.conversation_id ?? data?.conversation_id ?? "unknown";

  // Build transcript text
  const transcript = data?.data?.transcript ?? data?.transcript ?? [];
  const lines: string[] = [];
  for (const t of transcript) {
    let role = t.role ?? "?";
    if (role === "agent") role = "Alfred";
    else if (role === "user") role = callerName;
    const msg = (t.message ?? "").replace(/<[^>]+>/g, "").trim();
    if (msg && msg.toLowerCase() !== "none") {
      lines.push(`${role}: ${msg}`);
    }
  }

  if (lines.length === 0) {
    markProcessed(transcriptDir, filePath);
    return;
  }

  const transcriptText = lines.join("\n");
  const durationStr = callDuration
    ? `${Math.floor(callDuration / 60)}m${callDuration % 60}s`
    : "unknown duration";

  // Extract timestamp from filename: HH-MM-SS_convId.json
  const fileName = filePath.split("/").pop() ?? "";
  const timeMatch = fileName.match(/^(\d{2})-(\d{2})-(\d{2})_/);
  const timeStr = timeMatch
    ? `${timeMatch[1]}:${timeMatch[2]}`
    : "unknown";
  const dateStr = filePath.split("/").slice(-2, -1)[0] ?? "unknown";

  // 1. Send full transcript + summary to user's channel via OpenClaw messaging
  //    (OpenClaw routes to whatever channel the user is on — Slack, Telegram, etc.)
  try {
    const tools = api.runtime?.tools;
    if (tools?.invoke) {
      // Post full transcript to logs
      await tools.invoke("message", {
        action: "send",
        message:
          `📞 *Voice call with ${callerName}* (${timeStr}, ${durationStr})\n` +
          `Conversation: \`${conversationId}\`\n\n` +
          `\`\`\`${transcriptText}\`\`\``,
      });
    }
  } catch (err: any) {
    api.logger.warn(`[alfred-talk] Notification failed: ${err.message}`);
  }

  // 2. Summarize via subagent
  try {
    const tools = api.runtime?.tools;
    if (tools?.invoke) {
      const summaryModel = cfg.transcripts?.summaryModel ?? "anthropic/claude-haiku-4-5";
      await tools.invoke("sessions_spawn", {
        task:
          `Summarize this phone call in 2-3 sentences. ` +
          `The call was between Alfred (voice agent) and ${callerName} (${durationStr}). ` +
          `Cover: what was discussed, any action items or decisions. ` +
          `Reply with ONLY the summary — no preamble.\n\n` +
          `Transcript:\n${transcriptText}`,
        model: summaryModel,
        mode: "run",
        cleanup: "delete",
        thread: false,
        runTimeoutSeconds: 30,
      });
    }
  } catch (err: any) {
    api.logger.warn(`[alfred-talk] Summary failed: ${err.message}`);
  }

  // 3. Write to vault inbox
  const inboxDir = cfg.transcripts?.inboxDir;
  if (inboxDir) {
    const resolvedInbox = inboxDir.replace("~", homedir());
    const timeSlug = timeStr.replace(":", "");
    const callerSlug = callerName.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const inboxFilename = `voice-${dateStr}-${timeSlug}-${callerSlug}.md`;
    const inboxPath = join(resolvedInbox, inboxFilename);

    const frontmatter =
      `---\ntype: voice-transcript\ndate: ${dateStr}\n` +
      `time: "${timeStr}"\ncaller: "${callerName}"\n` +
      `phone: "${userPhone}"\nduration: "${durationStr}"\n` +
      `conversation_id: "${conversationId}"\n---\n`;
    const body =
      `\n# Voice Call — ${callerName} (${dateStr} ${timeStr})\n\n` +
      `Duration: ${durationStr} | Caller: ${callerName} (${userPhone})\n\n` +
      `${transcriptText}\n`;

    try {
      if (!existsSync(resolvedInbox)) mkdirSync(resolvedInbox, { recursive: true });
      writeFileSync(inboxPath, frontmatter + body);
      api.logger.info(`[alfred-talk] Wrote to vault inbox: ${inboxFilename}`);
    } catch (err: any) {
      api.logger.warn(`[alfred-talk] Inbox write failed: ${err.message}`);
    }
  }

  markProcessed(transcriptDir, filePath);
  api.logger.info(`[alfred-talk] Processed: ${conversationId} (${callerName}, ${durationStr})`);
}

// ── Transcript query helpers ─────────────────────────────────────

function listTranscripts(
  transcriptDir: string,
  limit: number,
  contacts: Record<string, string>,
) {
  const processed = loadProcessed(transcriptDir);
  const files: any[] = [];

  if (!existsSync(transcriptDir)) return text("[]");

  for (const dateDir of readdirSync(transcriptDir).sort().reverse()) {
    if (dateDir.startsWith(".")) continue;
    const datePath = join(transcriptDir, dateDir);
    try {
      for (const file of readdirSync(datePath)
        .filter((f: string) => f.endsWith(".json"))
        .sort()
        .reverse()) {
        const filePath = join(datePath, file);
        const stem = file.replace(".json", "");
        const parts = stem.split("_");
        const timeStr = parts[0]?.replace(/-/g, ":") ?? "";
        const convId = parts.slice(1).join("_");

        // Quick peek at caller
        let caller = "unknown";
        try {
          const d = JSON.parse(readFileSync(filePath, "utf-8"));
          const phone = d?.data?.user_id ?? d?.user_id ?? "";
          caller = resolveCallerName(phone, contacts);
        } catch {}

        files.push({
          timestamp: `${dateDir}T${timeStr}`,
          conversationId: convId,
          caller,
          processed: processed.has(filePath),
        });
        if (files.length >= limit) break;
      }
    } catch {
      continue;
    }
    if (files.length >= limit) break;
  }

  return text(JSON.stringify(files.slice(0, limit)));
}

function getTranscript(
  transcriptDir: string,
  conversationId: string,
  contacts: Record<string, string>,
) {
  if (!existsSync(transcriptDir))
    return text("Transcript directory not found.");

  for (const dateDir of readdirSync(transcriptDir).sort().reverse()) {
    if (dateDir.startsWith(".")) continue;
    const datePath = join(transcriptDir, dateDir);
    try {
      for (const file of readdirSync(datePath)) {
        if (file.includes(conversationId) && file.endsWith(".json")) {
          const data = JSON.parse(readFileSync(join(datePath, file), "utf-8"));
          const transcript = data?.data?.transcript ?? data?.transcript ?? [];
          const lines: string[] = [];
          for (const t of transcript) {
            let role = t.role ?? "?";
            if (role === "agent") role = "Alfred";
            else if (role === "user") {
              const phone = data?.data?.user_id ?? data?.user_id ?? "";
              role = resolveCallerName(phone, contacts);
            }
            const ts = t.time_in_call_secs ?? 0;
            const m = Math.floor(ts / 60);
            const s = Math.floor(ts % 60);
            const msg = (t.message ?? "").trim();
            if (msg) lines.push(`[${m}:${String(s).padStart(2, "0")}] ${role}: ${msg}`);
          }
          return text(
            JSON.stringify({
              conversationId,
              caller: resolveCallerName(
                data?.data?.user_id ?? data?.user_id ?? "",
                contacts,
              ),
              transcript: lines.join("\n"),
            }),
          );
        }
      }
    } catch {
      continue;
    }
  }

  return text(`Transcript not found: ${conversationId}`);
}

function text(t: string) {
  return { content: [{ type: "text", text: t }] };
}
