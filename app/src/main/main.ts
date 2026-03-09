import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, clipboard, shell, utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { Tunnel as CfTunnel, bin as cfBin, install as cfInstall } from "cloudflared";
import type { CapturePayload, AppState, CaptureRule, AppTag, WebhookConfig, MediaAttachment } from "../shared/types";
import { IPC } from "../shared/types";
import { SessionDb } from "./db";
import { sessionToJson, sessionToMarkdown } from "./exporters";
import { ShareServer } from "./shareServer";
import { KEYCHAIN_KEYS, keychainGet, keychainSet, keychainDelete } from "./keychain";
import { autoUpdater } from "electron-updater";

interface TunnelHandle {
  readonly url: string;
  on(event: "disconnect" | "reconnect" | "expire" | "error", listener: (detail?: string) => void): this;
  close(): Promise<void>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createTunnel } = require(require.resolve("private-connect").replace("dist/index.js", "dist/tunnel.js")) as {
  createTunnel: (options: { port: number; host?: string }) => Promise<TunnelHandle>;
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let cachedAppVersion: string | null = null;

// ---------------------------------------------------------------------------
// AI utility process
// ---------------------------------------------------------------------------
let aiProc: UtilityProcess | null = null;
let aiProcReady = false;
const aiPending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();

function startAiWorker() {
  if (aiProc) return;
  const workerPath = path.join(__dirname, "aiWorker.cjs");
  if (!existsSync(workerPath)) {
    console.warn("[aiWorker] worker not found at", workerPath);
    return;
  }
  aiProc = utilityProcess.fork(workerPath, [], { stdio: "pipe" });
  aiProcReady = true;

  aiProc.on("message", (msg: any) => {
    const pending = aiPending.get(msg.id);
    if (!pending) return;
    aiPending.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.result as string);
    } else {
      pending.reject(new Error(msg.error || "AI worker error"));
    }
  });

  aiProc.on("exit", () => {
    aiProc = null;
    aiProcReady = false;
    // Reject any in-flight requests
    for (const [id, p] of aiPending) {
      p.reject(new Error("AI worker exited unexpectedly"));
      aiPending.delete(id);
    }
    // Restart unless the app is quitting
    if (!isQuitting) {
      setTimeout(() => startAiWorker(), 1000).unref();
    }
  });
}

function callAiWorker(
  provider: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048,
  imageDataUri?: string
): Promise<string> {
  if (!aiProc || !aiProcReady) {
    return Promise.reject(new Error("AI worker not available"));
  }
  return new Promise((resolve, reject) => {
    const id = randomBytes(8).toString("hex");
    aiPending.set(id, { resolve, reject });
    aiProc!.postMessage({ id, type: "callAi", provider, model, apiKey, systemPrompt, userMessage, maxTokens, imageDataUri });
  });
}

function transcribeAudioWorker(
  provider: string,
  apiKey: string,
  audioBase64: string,
  mimeType: string
): Promise<string> {
  if (!aiProc || !aiProcReady) {
    return Promise.reject(new Error("AI worker not available"));
  }
  return new Promise((resolve, reject) => {
    const id = randomBytes(8).toString("hex");
    aiPending.set(id, { resolve, reject });
    aiProc!.postMessage({ id, type: "transcribeAudio", provider, apiKey, audioBase64, mimeType });
  });
}
let helperProc: ChildProcess | null = null;
let recording = false;
let currentSessionId: number | null = null;
let wsClientCount = 0;
let isQuitting = false;
let db!: SessionDb;
let shareServer!: ShareServer;
const helperSockets = new Set<WebSocket>();
let captureWss: WebSocketServer | null = null;
const autoTitledSessions = new Set<number>();
let tunnelChild: CfTunnel | ChildProcess | TunnelHandle | null = null;
let tunnelUrl: string | null = null;
let tunnelReconnecting = false;
let activeTunnelProvider: "privateconnect" | "cloudflare" | null = null;

function getState(): AppState {
  return {
    recording,
    currentSessionId,
    wsClients: wsClientCount
  };
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.PUSH_STATE_CHANGED, getState());
  if (currentSessionId) {
    mainWindow.webContents.send(IPC.PUSH_EVENTS_UPDATED, currentSessionId);
  }
}

function sendRecordingStateToHelpers() {
  const message = JSON.stringify({
    type: "recordingState",
    payload: { recording }
  });
  for (const socket of helperSockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    title: "Do Not Forget",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.resolve(app.getAppPath(), "dist", "renderer", "index.html"));
  }

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
}

function setTrayMenu() {
  if (!tray) return;
  const label = recording ? "Recording" : "Idle";
  const contextMenu = Menu.buildFromTemplate([
    { label: `Status: ${label}`, enabled: false },
    {
      label: recording ? "Stop Recording" : "Start Recording",
      click: () => toggleRecording()
    },
    {
      label: "Open Do Not Forget",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    {
      label: "Quit",
      click: () => {
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip(`Do Not Forget (${label})`);
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAKUlEQVR4AWP4z8Dwn4GB4T8DAwPDfxgY/jMwMPxHYAQxA6MwojQAAIaYB8hIwrKyAAAAAElFTkSuQmCC"
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  setTrayMenu();
}

function startRecording(targetSessionId?: number | null) {
  if (recording) return;
  if (targetSessionId) {
    const target = db.getSession(targetSessionId);
    currentSessionId = target ? target.id : db.createSession();
  } else if (!currentSessionId) {
    currentSessionId = db.createSession();
  }
  recording = true;
  setTrayMenu();
  sendRecordingStateToHelpers();
  broadcastState();

  const session = db.getSession(currentSessionId!);
  if (session) {
    fireWebhooks("session_start", { sessionId: currentSessionId!, sessionTitle: session.title }).catch(() => {});
  }
}

function stopRecording() {
  if (!recording) return;
  const sessionId = currentSessionId;
  recording = false;
  setTrayMenu();
  sendRecordingStateToHelpers();
  broadcastState();

  if (sessionId) {
    generateSmartSummary(sessionId).catch(() => {});
    const session = db.getSession(sessionId);
    const events = db.getEvents(sessionId);
    if (session) {
      fireWebhooks("session_end", {
        sessionId,
        sessionTitle: session.title,
        eventCount: events.length,
        apps: [...new Set(events.map((e) => e.app))],
        createdAt: session.createdAt
      }).catch(() => {});
    }
  }
}

// ── Related Captures (Thought Completion) ───────────────────────────────────

/** Simple TF-IDF–style similarity for fast in-process related capture lookup. */
function computeTextSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 2));
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const t of ta) { if (tb.has(t)) intersection++; }
  return intersection / (ta.size + tb.size - intersection);
}

async function findAndPushRelatedCaptures(sessionId: number, newText: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const candidates = db.getRecentEventsForSimilarity(sessionId, 200);
  const scored = candidates
    .map((c) => ({ ...c, score: computeTextSimilarity(newText, c.text) }))
    .filter((c) => c.score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (scored.length > 0) {
    mainWindow.webContents.send(IPC.PUSH_RELATED_CAPTURES, scored);

    // Persist high-confidence links to the semantic knowledge graph
    const highConfidence = scored.filter((c) => c.score >= 0.25);
    if (highConfidence.length > 0) {
      // Get the most recent event in this session to link from
      const recentEvents = db.getRecentEventsForSimilarity(sessionId, 1);
      const sourceEventId = recentEvents[0]?.id;
      if (sourceEventId) {
        db.addSemanticLinks(
          highConfidence.map((c) => ({ sourceEventId, targetEventId: c.id, score: c.score }))
        );
      }
    }
  }
}

// ── Webhook Firing ───────────────────────────────────────────────────────────

async function fireWebhooks(trigger: string, payload: Record<string, unknown>) {
  const hooks = db.listWebhooks().filter((h) => h.enabled && h.trigger === trigger);
  for (const hook of hooks) {
    try {
      await fetch(hook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger, ...payload, app: "Do Not Forget" }),
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      // Silently fail — webhook errors shouldn't interrupt the user
    }
  }
}

/** Delegates all AI network calls to the utilityProcess worker off the main thread. */
async function callAiProvider(
  provider: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048
): Promise<string> {
  return callAiWorker(provider, model, apiKey, systemPrompt, userMessage, maxTokens);
}

const VALID_MODELS: Record<string, string[]> = {
  openai: ["gpt-5.2", "gpt-5.3-codex", "gpt-4o", "gpt-4o-mini"],
  anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  google: ["gemini-3.1-pro", "gemini-3.1-flash-lite", "gemini-3-flash"]
};
const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-5.2",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-3.1-pro"
};

function getModelForProvider(provider: string, model: string): string {
  const valid = VALID_MODELS[provider] || [];
  if (model && valid.includes(model)) return model;
  return DEFAULT_MODELS[provider] || "gpt-5.2";
}

// ── Citation Extraction ──────────────────────────────────────────────────────

async function extractCitationsFromCapture(sessionId: number, text: string) {
  const settings = db.getAllSettings();
  if (settings.aiEnabled !== "true") return;
  const apiKey = await keychainGet("aiApiKey");
  if (!apiKey) return;

  const provider = settings.aiProvider || "openai";
  const model = getModelForProvider(provider, settings.aiModel || "");
  const systemPrompt = `You are a citation extractor. Given text from a research source, extract any references, URLs, author names, paper titles, publication names, or bibliographic data. Format each citation on its own line prefixed with "— ". If there are no citations, respond with exactly: NO_CITATIONS`;

  try {
    const result = await callAiProvider(provider, model, apiKey, systemPrompt, text.slice(0, 4000), 512);
    if (!result || result.trim() === "NO_CITATIONS") return;

    const existing = db.getDraft(sessionId);
    const citationBlock = `\n\n### Extracted Citations\n${result.trim()}`;
    db.saveDraft(sessionId, existing ? existing + citationBlock : citationBlock);
    broadcastState();
  } catch {
    // Best-effort
  }
}

function buildRichEventContext(events: Array<{ ts: number; app: string; window: string | null; source: string; text: string }>): string {
  const appGroups = new Map<string, string[]>();
  for (const e of events) {
    const key = e.window ? `${e.app} — ${e.window}` : e.app;
    if (!appGroups.has(key)) appGroups.set(key, []);
    appGroups.get(key)!.push(e.text);
  }
  const parts: string[] = [];
  for (const [source, texts] of appGroups) {
    parts.push(`[From ${source}]\n${texts.join("\n")}`);
  }
  return parts.join("\n\n");
}

async function generateSmartSummary(sessionId: number) {
  const settings = db.getAllSettings();
  if (settings.aiEnabled !== "true" || settings.aiSmartSummaries !== "true") return;
  const apiKey = await keychainGet("aiApiKey");
  if (!apiKey) return;

  const provider = settings.aiProvider || "openai";
  const model = getModelForProvider(provider, settings.aiModel || "");

  const session = db.getSession(sessionId);
  const events = db.getEvents(sessionId);
  if (!events.length) return;

  const richContext = buildRichEventContext(events);
  const apps = [...new Set(events.map((e) => e.app))];
  const duration = events.length > 1
    ? `${Math.round((events[events.length - 1].ts - events[0].ts) / 60000)} minutes`
    : "brief";

  const systemPrompt = `You are a sharp, perceptive note-taker. You just watched someone work across ${apps.join(", ")} for about ${duration}. Your job is to write a summary that a busy person would actually find useful when they come back to this later.

Write like a thoughtful colleague, not a robot. Be specific — names, numbers, decisions, and action items matter more than vague descriptions.

Rules:
- Start with "## Summary" as markdown heading
- Write 3-5 tight bullet points. Every bullet should earn its place.
- Lead with the most important finding, decision, or takeaway
- If there are action items or next steps, call them out explicitly
- If there are key facts (names, URLs, numbers, dates, code snippets), preserve them
- Match the tone of the captured content — technical content gets technical summaries, casual content gets casual summaries
- Never start bullets with "The user" — write as if the reader IS the user
- No preamble, no "Here's your summary", just the summary itself`;

  try {
    const summary = await callAiProvider(provider, model, apiKey, systemPrompt,
      `Session: "${session?.title || "Untitled"}"\nCaptured from: ${apps.join(", ")}\nDuration: ${duration}\n\n${richContext.slice(0, 10000)}`
    );
    const existing = db.getDraft(sessionId);
    if (existing) {
      db.saveDraft(sessionId, `${summary}\n\n---\n\n${existing}`);
    } else {
      const rawContent = events.map((e) => `> ${e.text}`).join("\n\n");
      db.saveDraft(sessionId, `${summary}\n\n---\n\n${rawContent}`);
    }
    broadcastState();
  } catch {
    // Silently fail
  }
}

async function generateAutoTitle(sessionId: number) {
  if (autoTitledSessions.has(sessionId)) return;
  const settings = db.getAllSettings();
  if (settings.aiEnabled !== "true") return;
  const apiKey = await keychainGet("aiApiKey");
  if (!apiKey) return;

  const session = db.getSession(sessionId);
  if (!session) return;
  if (!session.title.startsWith("Session ")) return;

  const events = db.getEvents(sessionId);
  if (events.length < 3) return;

  autoTitledSessions.add(sessionId);

  const provider = settings.aiProvider || "openai";
  const model = getModelForProvider(provider, settings.aiModel || "");
  const apps = [...new Set(events.map((e) => e.app))];
  const snippet = events.slice(0, 8).map((e) => e.text.slice(0, 200)).join("\n");

  const systemPrompt = `Generate a short, descriptive title (3-7 words) for a note-taking session. The title should capture the main topic or activity. Return ONLY the title text — no quotes, no punctuation at the end, no explanation.`;

  try {
    const title = await callAiProvider(provider, model, apiKey, systemPrompt,
      `Apps used: ${apps.join(", ")}\n\nCaptured text:\n${snippet.slice(0, 2000)}`,
      64
    );
    const cleaned = title.replace(/^["']|["']$/g, "").replace(/\.+$/, "").trim();
    if (cleaned && cleaned.length > 1 && cleaned.length < 80) {
      db.renameSession(sessionId, cleaned);
      broadcastState();
    }
  } catch {
    autoTitledSessions.delete(sessionId);
  }
}

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayDateStr(): string {
  const d = new Date(Date.now() - 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildStructuredDigest(dateStr: string): string | null {
  const sessions = db.getSessionsForDate(dateStr);
  if (!sessions.length) return null;

  const d = new Date(dateStr + "T00:00:00");
  const dayLabel = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const lines: string[] = [`## Daily Recap — ${dayLabel}`, ""];

  let totalCaptures = 0;
  const allApps = new Set<string>();

  for (const s of sessions) {
    const events = db.getEvents(s.id);
    totalCaptures += events.length;
    events.forEach((e) => allApps.add(e.app));
  }

  lines.push(`**${sessions.length}** session${sessions.length > 1 ? "s" : ""} · **${totalCaptures}** captures · ${[...allApps].join(", ") || "no apps"}`);
  lines.push("");

  for (const s of sessions) {
    const events = db.getEvents(s.id);
    const time = new Date(s.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const apps = [...new Set(events.map((e) => e.app))];
    const preview = s.preview ? ` — ${s.preview}` : "";
    lines.push(`- **${time}** · ${s.title} (${events.length} captures from ${apps.join(", ") || "unknown"})${preview}`);
  }

  if (allApps.size > 1) {
    lines.push("");
    lines.push("### App Usage");
    const appCounts: Record<string, number> = {};
    for (const s of sessions) {
      const events = db.getEvents(s.id);
      for (const e of events) {
        appCounts[e.app] = (appCounts[e.app] || 0) + 1;
      }
    }
    const sorted = Object.entries(appCounts).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      lines.push(`- ${name}: ${count} capture${count > 1 ? "s" : ""}`);
    }
  }

  return lines.join("\n");
}

async function generateDailySummary(dateStr: string): Promise<string | null> {
  const existing = db.getDailySummary(dateStr);
  if (existing) return existing.content;

  const settings = db.getAllSettings();
  if (settings.dailyRecapEnabled === "false") return null;

  const sessions = db.getSessionsForDate(dateStr);
  if (!sessions.length) return null;

  const aiEnabled = settings.aiEnabled === "true";
  const apiKey = aiEnabled ? await keychainGet("aiApiKey") : null;

  if (!aiEnabled || !apiKey) {
    const digest = buildStructuredDigest(dateStr);
    if (digest) db.saveDailySummary(dateStr, digest, false);
    return digest;
  }

  const provider = settings.aiProvider || "openai";
  const model = getModelForProvider(provider, settings.aiModel || "");

  const d = new Date(dateStr + "T00:00:00");
  const dayLabel = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const sessionParts: string[] = [];
  let totalCaptures = 0;
  const allApps = new Set<string>();

  for (const s of sessions) {
    const events = db.getEvents(s.id);
    totalCaptures += events.length;
    const apps = [...new Set(events.map((e) => e.app))];
    apps.forEach((a) => allApps.add(a));
    const draft = db.getDraft(s.id);
    const content = draft || events.map((e) => e.text).join("\n");
    const time = new Date(s.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    sessionParts.push(`--- Session: "${s.title}" (${time}, ${events.length} captures from ${apps.join(", ")}) ---\n${content.slice(0, 3000)}`);
  }

  const systemPrompt = `You are writing a concise daily summary for ${dayLabel}. The user had ${sessions.length} session${sessions.length > 1 ? "s" : ""} with ${totalCaptures} captures across ${[...allApps].join(", ")}.

Your job is to synthesize the day's work into a useful recap. Think of it as a journal entry that helps them remember what they did and what matters.

Rules:
- Start with "## Daily Recap — ${dayLabel}"
- Write 4-7 bullet points covering the day's key activities, decisions, and takeaways
- Group related work across sessions — don't just repeat session titles
- Call out action items or unfinished work explicitly
- If there were patterns (e.g. spent most of the day on X), mention it
- Preserve specific names, numbers, URLs that might be useful later
- Be conversational — write like a thoughtful colleague, not a report generator
- No preamble. Just the recap.`;

  try {
    const summary = await callAiProvider(provider, model, apiKey, systemPrompt,
      sessionParts.join("\n\n").slice(0, 15000),
      2048
    );
    db.saveDailySummary(dateStr, summary, true);
    broadcastState();
    return summary;
  } catch {
    const digest = buildStructuredDigest(dateStr);
    if (digest) db.saveDailySummary(dateStr, digest, false);
    return digest;
  }
}

let dailySummaryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDailySummary() {
  if (dailySummaryTimer) clearTimeout(dailySummaryTimer);

  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 55, 0);
  let delay = endOfDay.getTime() - now.getTime();
  if (delay < 0) delay += 86400000;

  dailySummaryTimer = setTimeout(async () => {
    const settings = db.getAllSettings();
    if (settings.dailyRecapEnabled !== "false") {
      const dateStr = todayDateStr();
      const sessions = db.getSessionsForDate(dateStr);
      if (sessions.length > 0) {
        await generateDailySummary(dateStr).catch(() => {});
      }
    }
    scheduleDailySummary();
  }, delay);
}

async function ensureTunnel(): Promise<string> {
  const provider = (db.getSetting("tunnelProvider") || "privateconnect") as "privateconnect" | "cloudflare";

  if (tunnelChild && tunnelUrl && activeTunnelProvider === provider) return tunnelUrl;

  if (tunnelChild) closeTunnel();

  await shareServer.start();

  if (provider === "cloudflare") {
    if (!existsSync(cfBin)) {
      await cfInstall(cfBin);
    }

    const child = CfTunnel.quick("http://127.0.0.1:1455");
    tunnelChild = child;
    activeTunnelProvider = "cloudflare";

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Tunnel URL timeout")), 30000);
      child.once("url", (u) => {
        clearTimeout(timeout);
        resolve(u);
      });
      child.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    tunnelUrl = url;

    child.on("exit", () => {
      tunnelChild = null;
      tunnelUrl = null;
      activeTunnelProvider = null;
      if (!isQuitting && !tunnelReconnecting && db.hasSharedSessions()) {
        reconnectTunnel();
      }
    });
  } else {
    const url = await startPrivateConnectTunnel();
    tunnelUrl = url;
  }

  db.updateAllShareUrls(tunnelUrl!);
  broadcastState();

  return tunnelUrl!;
}

async function startPrivateConnectTunnel(): Promise<string> {
  const handle = await createTunnel({ port: 1455 });
  tunnelChild = handle;
  activeTunnelProvider = "privateconnect";

  handle.on("disconnect", () => {
    tunnelUrl = null;
    activeTunnelProvider = null;
  });

  handle.on("reconnect", () => {
    const url = handle.url;
    tunnelUrl = url;
    activeTunnelProvider = "privateconnect";
    db.updateAllShareUrls(url);
    broadcastState();
  });

  handle.on("expire", () => {
    tunnelChild = null;
    tunnelUrl = null;
    activeTunnelProvider = null;
    if (!isQuitting && !tunnelReconnecting && db.hasSharedSessions()) {
      reconnectTunnel();
    }
  });

  return handle.url;
}

async function reconnectTunnel() {
  if (tunnelReconnecting) return;
  tunnelReconnecting = true;
  const delays = [2000, 4000, 8000, 15000, 30000];
  for (let i = 0; i < delays.length; i++) {
    await new Promise((r) => setTimeout(r, delays[i]));
    if (isQuitting || !db.hasSharedSessions()) break;
    try {
      await ensureTunnel();
      tunnelReconnecting = false;
      return;
    } catch {}
  }
  tunnelReconnecting = false;
}

function closeTunnel() {
  if (tunnelChild) {
    const c = tunnelChild;
    tunnelChild = null;
    tunnelUrl = null;
    activeTunnelProvider = null;
    if (c instanceof CfTunnel) {
      c.stop();
    } else if ("close" in c && typeof c.close === "function") {
      c.close();
    } else {
      (c as ChildProcess).kill();
    }
  }
}

function toggleRecording(targetSessionId?: number | null) {
  if (recording) {
    stopRecording();
  } else {
    startRecording(targetSessionId);
  }
}

function createNewSession() {
  currentSessionId = db.createSession();
  broadcastState();
  return currentSessionId;
}

function setActiveSession(sessionId: number | null) {
  if (sessionId == null) return currentSessionId;
  const target = db.getSession(sessionId);
  if (!target) return currentSessionId;
  currentSessionId = target.id;
  broadcastState();
  return currentSessionId;
}

function deleteSession(sessionId: number) {
  const deleted = db.deleteSession(sessionId);
  if (!deleted) return { deleted: false, nextSessionId: currentSessionId };

  if (currentSessionId === sessionId) {
    const next = db.listSessions()[0];
    currentSessionId = next ? next.id : null;
  }
  broadcastState();
  return { deleted: true, nextSessionId: currentSessionId };
}

function startCaptureSocketServer() {
  if (captureWss) return;
  let wss: WebSocketServer;
  try {
    wss = new WebSocketServer({ host: "127.0.0.1", port: 3737 });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") {
      console.warn("Capture socket port 3737 already in use; reusing existing server.");
      return;
    }
    throw error;
  }
  captureWss = wss;
  wss.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.warn("Capture socket port 3737 already in use; another app instance may be running.");
      return;
    }
    console.error("Capture socket server error:", error);
  });
  wss.on("connection", (socket) => {
    helperSockets.add(socket);
    wsClientCount += 1;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "recordingState", payload: { recording } }));
    }
    broadcastState();
    socket.on("close", () => {
      helperSockets.delete(socket);
      wsClientCount = Math.max(0, wsClientCount - 1);
      broadcastState();
    });
    socket.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.type === "toggleRecording") {
        toggleRecording();
        return;
      }
      if (msg?.type !== "capture" || !recording || !currentSessionId) return;
      const payload = msg.payload as CapturePayload;
      if (!payload || typeof payload.text !== "string") return;
      const normalizedPayload: CapturePayload = {
        ts: Number(payload.ts) || Date.now(),
        app: payload.app || "Unknown",
        window: payload.window ?? "",
        source: payload.source === "selection" ? "selection" : "focused",
        text: payload.text
      };
      const isOwnUiCapture =
        normalizedPayload.app.toLowerCase() === "electron" &&
        (normalizedPayload.window ?? "").toLowerCase().includes("do not forget");
      if (isOwnUiCapture) return;

      // Enforce capture rules
      const wordCount = normalizedPayload.text.trim().split(/\s+/).filter(Boolean).length;
      const ruleCheck = db.checkCaptureRule(normalizedPayload.app, wordCount);
      if (!ruleCheck.allowed) return;

      db.insertCapture(currentSessionId, normalizedPayload);
      broadcastState();
      generateAutoTitle(currentSessionId).catch(() => {});
      findAndPushRelatedCaptures(currentSessionId, normalizedPayload.text).catch(() => {});

      // If the matching rule requests citation extraction, run it async
      if (ruleCheck.extractCitations) {
        extractCitationsFromCapture(currentSessionId, normalizedPayload.text).catch(() => {});
      }
    });
  });
}

async function exportSession(sessionId: number, format: "md" | "json") {
  const session = db.getSession(sessionId);
  if (!session) return;
  const events = db.getEvents(sessionId);
  const content = format === "md" ? sessionToMarkdown(session, events) : sessionToJson(session, events);
  const ext = format === "md" ? "md" : "json";
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: `Export ${format.toUpperCase()}`,
    defaultPath: `${session.title.replace(/[^\w.-]+/g, "_")}.${ext}`
  });
  if (!canceled && filePath) {
    await writeFile(filePath, content, "utf8");
  }
}

function copySession(sessionId: number) {
  const session = db.getSession(sessionId);
  if (!session) return;
  const events = db.getEvents(sessionId);
  clipboard.writeText(sessionToMarkdown(session, events));
}

function getHelperPath() {
  const candidates = [
    // Dev (running from /app)
    path.resolve(process.cwd(), "..", "native-helper", ".build", "debug", "SessionCaptureHelper"),
    // When appPath points at /app/dist/main
    path.resolve(app.getAppPath(), "..", "..", "..", "native-helper", ".build", "debug", "SessionCaptureHelper"),
    // Packaged app resource path (future)
    path.resolve(process.resourcesPath, "helper", "SessionCaptureHelper")
  ];
  const found = candidates.find((p) => existsSync(p));
  return found ?? candidates[0];
}

function startHelper(): { ok: boolean; message: string } {
  if (helperProc && !helperProc.killed) {
    return { ok: true, message: "Helper already running." };
  }
  const helperPath = getHelperPath();
  if (!existsSync(helperPath)) {
    return { ok: false, message: `Helper binary not found at ${helperPath}` };
  }
  try {
    helperProc = spawn(helperPath, [], { detached: false, stdio: "ignore" });
    helperProc.on("error", () => {
      helperProc = null;
    });
    helperProc.on("exit", () => {
      helperProc = null;
    });
    return { ok: true, message: "Helper started." };
  } catch {
    return { ok: false, message: `Failed to start helper at ${helperPath}` };
  }
}

async function initIpc() {
  ipcMain.handle(IPC.STATE_GET, () => getState());
  ipcMain.handle(IPC.SESSIONS_LIST, () => db.listSessions());
  ipcMain.handle(IPC.SESSION_CREATE, () => createNewSession());
  ipcMain.handle(IPC.SESSION_SET_ACTIVE, (_event, sessionId: number | null) => setActiveSession(sessionId));
  ipcMain.handle(IPC.SESSION_DELETE, (_event, sessionId: number) => deleteSession(sessionId));
  ipcMain.handle(IPC.SESSION_RENAME, (_event, sessionId: number, title: string) => {
    const ok = db.renameSession(sessionId, title);
    if (ok) broadcastState();
    return ok;
  });
  ipcMain.handle(IPC.EVENTS_LIST, (_event, sessionId: number) => db.getEvents(sessionId));
  ipcMain.handle(IPC.RECORDING_TOGGLE, (_event, targetSessionId?: number | null) => {
    toggleRecording(targetSessionId);
    return getState();
  });
  ipcMain.handle(IPC.EXPORT_MARKDOWN, async (_event, sessionId: number) => exportSession(sessionId, "md"));
  ipcMain.handle(IPC.EXPORT_JSON, async (_event, sessionId: number) => exportSession(sessionId, "json"));
  ipcMain.handle(IPC.SESSION_COPY, (_event, sessionId: number) => copySession(sessionId));
  ipcMain.handle(IPC.SHARE_CREATE, async (_event, sessionId: number) => {
    const baseUrl = await ensureTunnel();
    const token = randomBytes(18).toString("base64url");
    const fullUrl = `${baseUrl}/${token}`;
    db.setShareToken(sessionId, token, fullUrl);
    return fullUrl;
  });
  ipcMain.handle(IPC.SHARE_REVOKE, async (_event, sessionId: number) => {
    db.setShareToken(sessionId, null);
    if (!db.hasSharedSessions()) {
      await closeTunnel();
    }
    return true;
  });
  ipcMain.handle(IPC.SESSION_SAVE_DRAFT, (_event, sessionId: number, content: string) => {
    db.saveDraft(sessionId, content);
    return true;
  });
  ipcMain.handle(IPC.SESSION_GET_DRAFT, (_event, sessionId: number) => {
    return db.getDraft(sessionId);
  });
  ipcMain.handle(IPC.HELPER_START, () => startHelper());
  ipcMain.handle(IPC.ACCESSIBILITY_OPEN, async () => {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    );
  });
  ipcMain.handle(IPC.SESSIONS_SEARCH, (_event, query: string) => db.searchSessions(query));
  ipcMain.handle(IPC.SETTINGS_GET_ALL, async () => {
    const s = db.getAllSettings();
    // Keychain-backed keys: remove SQLite value (migration may have left a stale row) and
    // replace with a sentinel so the UI knows a key is configured without seeing the raw value.
    for (const k of KEYCHAIN_KEYS) {
      delete s[k];
      const val = await keychainGet(k);
      if (val) s[k] = "__configured__";
    }
    return s;
  });
  ipcMain.handle(IPC.SETTINGS_SET, async (_event, key: string, value: string) => {
    if (KEYCHAIN_KEYS.has(key)) {
      // Never persist API keys in SQLite — store in Keychain only
      if (value && value !== "__configured__") {
        await keychainSet(key, value);
      } else if (!value) {
        await keychainDelete(key);
      }
      // Ensure no stale plaintext row remains in SQLite
      db.deleteSetting(key);
      return;
    }
    db.setSetting(key, value);
    if (key === "handle") {
      shareServer.setHandle(value);
    }
    if (key === "tunnelProvider" && db.hasSharedSessions()) {
      closeTunnel();
      ensureTunnel()
        .then(() => broadcastState())
        .catch(() => {});
    }
  });
  ipcMain.handle(IPC.DATA_CLEAR_ALL, () => {
    db.clearAllData();
    broadcastState();
  });
  ipcMain.handle(IPC.DAILY_SUMMARY_GET, async (_event, dateStr: string) => {
    const existing = db.getDailySummary(dateStr);
    if (existing) return existing;
    return null;
  });
  ipcMain.handle(IPC.DAILY_SUMMARY_GENERATE, async (_event, dateStr: string) => {
    const content = await generateDailySummary(dateStr);
    return content ? db.getDailySummary(dateStr) : null;
  });
  ipcMain.handle(IPC.DAILY_SUMMARIES_LIST, () => {
    return db.listDailySummaries();
  });
  ipcMain.handle(IPC.AI_CHAT, async (_event, message: string, sessionId: number | null) => {
    const settings = db.getAllSettings();
    if (settings.aiEnabled !== "true") return "AI is not enabled. Go to Settings → AI Behavior to enable.";
    const apiKey = await keychainGet("aiApiKey");
    if (!apiKey) return "No API key configured. Add one in Settings → AI Behavior.";

    const provider = settings.aiProvider || "openai";
    const model = getModelForProvider(provider, settings.aiModel || "");

    let context: string;
    let systemPrompt: string;

    if (sessionId) {
      const session = db.getSession(sessionId);
      const draft = db.getDraft(sessionId);
      const events = db.getEvents(sessionId);
      const richContext = buildRichEventContext(events);
      const content = draft || richContext || "(empty session)";
      const apps = [...new Set(events.map((e) => e.app))];

      context = `Session: "${session?.title || "Untitled"}" (${new Date(session?.createdAt || 0).toLocaleDateString()})\nCaptured from: ${apps.join(", ")}\nCaptures: ${events.length}\n\n${content}`;

      systemPrompt = `You are a smart assistant inside a note-taking app. The user captured text from various apps into a session. You have the full session content below — use it to answer their question.

<session title="${session?.title || "Untitled"}" date="${new Date(session?.createdAt || 0).toLocaleDateString()}" captures="${events.length}" apps="${apps.join(", ")}">
${content.slice(0, 12000)}
</session>

Rules:
- NEVER just list or repeat the raw captured text back. The user can already see it.
- THINK about what they're asking and give a genuinely useful, synthesized answer.
- If they ask "what's in here" — summarize the key themes and highlights, don't dump everything.
- If they ask about a specific detail — give a clear, direct answer with just the relevant info.
- Be conversational and concise. Write like a smart colleague, not a search engine.
- Use markdown: bold for emphasis, bullet points for lists, code blocks for code.
- If it's not in the session, say so. Don't make things up.`;
    } else {
      context = db.getAllSessionsContext();
      if (!context) context = "(No sessions yet)";
      const sessionCount = db.listSessions().length;

      systemPrompt = `You are a smart assistant inside a note-taking app. The user has ${sessionCount} sessions of captured text from various apps. All session content is below — use it to answer their question.

<sessions>
${context.slice(0, 15000)}
</sessions>

Rules:
- NEVER just list or repeat raw captured text. The user can already see their sessions.
- THINK about their question and give a genuinely useful, synthesized answer.
- When referencing info, mention which session it's from (by title) so they can find it.
- Connect dots across sessions if relevant info appears in multiple places.
- If they ask something broad — give a concise summary of the key points, not a dump.
- Be conversational. Write like a smart colleague who has read all their notes.
- Use markdown: bold for key info, bullet points for lists, keep it scannable.
- If nothing matches their question, say so honestly. Don't make things up.`;
    }

    try {
      return await callAiProvider(provider, model, apiKey, systemPrompt, message);
    } catch (err: any) {
      return `Request failed: ${err.message || err}`;
    }
  });

  ipcMain.handle(IPC.AI_ENHANCE, async (_event, sessionId: number) => {
    const settings = db.getAllSettings();
    if (settings.aiEnabled !== "true") return "AI is not enabled.";
    if (settings.aiContentEnhancement !== "true") return "Content Enhancement is not enabled. Turn it on in Settings → AI Behavior.";
    const apiKey = await keychainGet("aiApiKey");
    if (!apiKey) return "No API key configured.";

    const provider = settings.aiProvider || "openai";
    const model = getModelForProvider(provider, settings.aiModel || "");

    const session = db.getSession(sessionId);
    const draft = db.getDraft(sessionId);
    const events = db.getEvents(sessionId);
    const richContext = buildRichEventContext(events);
    const content = draft || richContext;
    if (!content?.trim()) return "No content to enhance.";

    const apps = [...new Set(events.map((e) => e.app))];

    const systemPrompt = `You are a professional editor working with raw captured text. This content was automatically captured from ${apps.join(", ")} — it's raw, possibly messy, with duplicates and fragments. Your job is to turn it into something someone would actually want to read and reference later.

Think of yourself as a brilliant assistant who takes someone's scattered notes and turns them into a clean, well-organized document — while keeping every important detail.

Instructions:
1. First, give 2-3 specific, actionable observations about the content (not generic advice). What's interesting? What patterns do you see? What's missing?

2. Then produce the enhanced version:
   - Remove exact and near-duplicates (captured text often has repeats)
   - Group related content under clear, descriptive headings
   - Fix grammar and formatting, but preserve technical terms, code, URLs, and names exactly
   - If there are action items or decisions buried in the text, pull them out into their own section
   - If there's code, keep it in proper code blocks with language hints
   - Preserve the substance — don't water down technical content or oversimplify
   - Add context where fragments are unclear, using [brackets] to indicate your additions
   - The result should read like well-organized notes, not an AI essay

Format your response as:
### What I noticed
(your observations)

### Enhanced content
(the improved document)`;

    try {
      return await callAiProvider(provider, model, apiKey, systemPrompt,
        `Session: "${session?.title || "Untitled"}"\nCaptured from: ${apps.join(", ")}\n\nRaw content:\n${content.slice(0, 12000)}`,
        4096
      );
    } catch (err: any) {
      return `Request failed: ${err.message || err}`;
    }
  });

  ipcMain.handle(IPC.APP_GET_VERSION, () => cachedAppVersion ?? app.getVersion());

  ipcMain.handle(IPC.APP_CHECK_FOR_UPDATES, async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) return { available: false };
      const current = autoUpdater.currentVersion.version;
      const latest = result.updateInfo.version;
      const isNewer = latest.localeCompare(current, undefined, { numeric: true, sensitivity: "base" }) > 0;
      return { available: isNewer, currentVersion: current, latestVersion: latest };
    } catch (err: any) {
      return { available: false, error: err.message || "Network error" };
    }
  });

  ipcMain.handle(IPC.APP_INSTALL_UPDATE, () => {
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle(IPC.APP_CANCEL_UPDATE_DOWNLOAD, () => {
    notifyDownloadFailed("Download cancelled.");
  });

  // ── Capture Rules ────────────────────────────────────────────────────────
  ipcMain.handle(IPC.RULES_LIST, () => db.listCaptureRules());
  ipcMain.handle(IPC.RULES_ADD, (_e, rule: Omit<CaptureRule, "id" | "createdAt">) => db.addCaptureRule(rule));
  ipcMain.handle(IPC.RULES_UPDATE, (_e, id: number, rule: Partial<CaptureRule>) => db.updateCaptureRule(id, rule));
  ipcMain.handle(IPC.RULES_DELETE, (_e, id: number) => db.deleteCaptureRule(id));

  // ── App Tags ─────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.APP_TAGS_LIST, () => db.listAppTags());
  ipcMain.handle(IPC.APP_TAGS_SET, (_e, appName: string, tag: string) => { db.setAppTag(appName, tag); return true; });
  ipcMain.handle(IPC.APP_TAGS_DELETE, (_e, appName: string) => { db.deleteAppTag(appName); return true; });

  // ── Webhooks ─────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.WEBHOOKS_LIST, () => db.listWebhooks());
  ipcMain.handle(IPC.WEBHOOKS_ADD, (_e, hook: Omit<WebhookConfig, "id" | "createdAt">) => db.addWebhook(hook));
  ipcMain.handle(IPC.WEBHOOKS_UPDATE, (_e, id: number, hook: Partial<WebhookConfig>) => db.updateWebhook(id, hook));
  ipcMain.handle(IPC.WEBHOOKS_DELETE, (_e, id: number) => db.deleteWebhook(id));
  ipcMain.handle(IPC.WEBHOOKS_TEST, async (_e, id: number) => {
    const hooks = db.listWebhooks();
    const hook = hooks.find((h) => h.id === id);
    if (!hook) return { ok: false, error: "Webhook not found" };
    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: hook.trigger, test: true, app: "Do Not Forget" }),
        signal: AbortSignal.timeout(8000)
      });
      return { ok: res.ok, status: res.status };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ── Media Attachments ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.MEDIA_LIST, (_e, sessionId: number) => db.getMediaAttachments(sessionId));
  ipcMain.handle(IPC.MEDIA_DELETE, (_e, id: number) => db.deleteMediaAttachment(id));
  ipcMain.handle(IPC.MEDIA_ADD, async (_e, sessionId: number, filename: string, mimeType: string, dataB64: string, caption?: string) => {
    const settings = db.getAllSettings();
    let aiDescription: string | undefined;

    // If AI is configured, describe the image using whichever provider is active
    if (settings.aiEnabled === "true" && mimeType.startsWith("image/")) {
      const apiKey = await keychainGet("aiApiKey");
      const provider = settings.aiProvider || "openai";
      if (apiKey) {
        try {
          aiDescription = await callAiWorker(
            provider,
            getModelForProvider(provider, settings.aiModel || ""),
            apiKey,
            "Describe this image concisely in 1-2 sentences. Focus on the most important content, text, or structure visible.",
            "What is in this image?",
            256,
            `data:${mimeType};base64,${dataB64}`
          );
        } catch {
          // Vision description is best-effort
        }
      }
    }

    const id = db.addMediaAttachment(sessionId, filename, mimeType, dataB64, caption, aiDescription);
    return { id, aiDescription: aiDescription ?? null };
  });

  // ── AI: Describe Image (standalone) ──────────────────────────────────────
  ipcMain.handle(IPC.AI_DESCRIBE_IMAGE, async (_e, mimeType: string, dataB64: string) => {
    const settings = db.getAllSettings();
    if (settings.aiEnabled !== "true") return null;
    const apiKey = await keychainGet("aiApiKey");
    if (!apiKey) return null;
    const provider = settings.aiProvider || "openai";
    try {
      return await callAiWorker(
        provider,
        getModelForProvider(provider, settings.aiModel || ""),
        apiKey,
        "Describe this image concisely in 1-2 sentences. Focus on the most important content, text, or structure visible.",
        "What is in this image?",
        256,
        `data:${mimeType};base64,${dataB64}`
      );
    } catch {
      return null;
    }
  });

  // ── AI: Related Captures (on-demand) ─────────────────────────────────────
  ipcMain.handle(IPC.AI_RELATED_CAPTURES, (_e, sessionId: number, text: string) => {
    const candidates = db.getRecentEventsForSimilarity(sessionId, 200);
    return candidates
      .map((c) => ({ ...c, score: computeTextSimilarity(text, c.text) }))
      .filter((c) => c.score >= 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  });

  // ── Voice Capture: transcribe + insert as event ───────────────────────────
  ipcMain.handle(IPC.VOICE_TRANSCRIBE, async (_e, sessionId: number, audioBase64: string, mimeType: string) => {
    const settings = db.getAllSettings();
    if (settings.aiEnabled !== "true") return { ok: false, error: "AI is not enabled." };

    // Audio provider can differ from text AI provider — falls back to main provider
    const audioProvider = settings.audioProvider || settings.aiProvider || "openai";

    // Resolve API key: prefer dedicated audio key, then fall back to main AI key
    const audioApiKey = await keychainGet("audioApiKey");
    const mainApiKey = await keychainGet("aiApiKey");
    const apiKey = audioApiKey || mainApiKey;

    if (!apiKey) return { ok: false, error: "No API key configured." };
    const provider = audioProvider;

    try {
      const transcript = await transcribeAudioWorker(provider, apiKey, audioBase64, mimeType);
      if (!transcript.trim()) return { ok: false, error: "No speech detected." };

      // Insert as a voice event into the session
      if (sessionId) {
        const payload: CapturePayload = {
          ts: Date.now(),
          app: "Microphone",
          window: undefined,
          source: "voice",
          text: transcript
        };
        db.insertCapture(sessionId, payload);
        broadcastState();
        generateAutoTitle(sessionId).catch(() => {});
      }

      return { ok: true, transcript };
    } catch (err: any) {
      return { ok: false, error: err.message || "Transcription failed." };
    }
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// --- Auto-updater setup ---
autoUpdater.autoDownload = false; // ask the user first
autoUpdater.autoInstallOnAppQuit = true;

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;   // 10 minutes total
const STALLED_NO_PROGRESS_MS = 2 * 60 * 1000; // 2 minutes with no progress = stalled
let downloadTimeoutId: ReturnType<typeof setTimeout> | null = null;
let stalledCheckId: ReturnType<typeof setTimeout> | null = null;
let lastProgressPercent = -1;
let lastProgressTime = 0;

function clearDownloadTimers() {
  if (downloadTimeoutId) {
    clearTimeout(downloadTimeoutId);
    downloadTimeoutId = null;
  }
  if (stalledCheckId) {
    clearTimeout(stalledCheckId);
    stalledCheckId = null;
  }
  lastProgressPercent = -1;
  lastProgressTime = 0;
}

function notifyDownloadFailed(message: string) {
  clearDownloadTimers();
  mainWindow?.setProgressBar(-1);
  mainWindow?.webContents.send(IPC.PUSH_UPDATE_ERROR, { message });
}

autoUpdater.on("update-available", async (info) => {
  mainWindow?.webContents.send(IPC.PUSH_UPDATE_AVAILABLE, { version: info.version });

  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Update Available",
    message: `A new version of Do Not Forget is available!`,
    detail: `Version ${info.version} is now available — you have ${autoUpdater.currentVersion.version}.\n\nWould you like to download it now?`,
    buttons: ["Download", "Remind Me Later", "Skip This Version"],
    defaultId: 0,
    cancelId: 1,
    icon: nativeImage.createFromPath(
      app.isPackaged
        ? path.join(process.resourcesPath, "../build/icon.png")
        : path.join(__dirname, "../../../build/icon.png")
    )
  });

  if (response === 0) {
    clearDownloadTimers();
    lastProgressTime = Date.now();
    downloadTimeoutId = setTimeout(() => {
      notifyDownloadFailed("Download timed out. Check your connection and try again.");
    }, DOWNLOAD_TIMEOUT_MS);
    stalledCheckId = setTimeout(function checkStalled() {
      const now = Date.now();
      if (lastProgressTime > 0 && now - lastProgressTime > STALLED_NO_PROGRESS_MS) {
        notifyDownloadFailed("Download stalled. Check your connection and try again.");
        return;
      }
      stalledCheckId = setTimeout(checkStalled, 30 * 1000); // recheck every 30s
    }, STALLED_NO_PROGRESS_MS);
    autoUpdater.downloadUpdate();
  }
});

autoUpdater.on("download-progress", (progress) => {
  lastProgressPercent = Math.round(progress.percent);
  lastProgressTime = Date.now();
  mainWindow?.webContents.send(IPC.PUSH_UPDATE_PROGRESS, { percent: lastProgressPercent });
  mainWindow?.setProgressBar(progress.percent / 100);
});

autoUpdater.on("update-downloaded", async (info) => {
  clearDownloadTimers();
  mainWindow?.setProgressBar(-1);
  mainWindow?.webContents.send(IPC.PUSH_UPDATE_DOWNLOADED, { version: info.version });

  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Ready to Install",
    message: "Update Ready to Install",
    detail: `Version ${info.version} has been downloaded and is ready to install. Relaunch now to apply the update.`,
    buttons: ["Install and Relaunch", "Later"],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 0) {
    autoUpdater.quitAndInstall();
  }
});

autoUpdater.on("error", (err) => {
  console.error("[autoUpdater] error:", err.message);
  notifyDownloadFailed(err.message);
});

app.whenReady().then(async () => {
  // Resolve the app version once at startup rather than on every IPC call.
  const versionCandidates = [
    path.join(__dirname, "../../../package.json"),
    path.join(app.getAppPath(), "package.json")
  ];
  for (const p of versionCandidates) {
    try {
      const pkg = JSON.parse(require("fs").readFileSync(p, "utf-8"));
      if (pkg.version && !pkg.version.startsWith("35.")) { cachedAppVersion = pkg.version; break; }
    } catch {}
  }
  if (!cachedAppVersion) cachedAppVersion = app.getVersion();

  db = new SessionDb();
  shareServer = new ShareServer(db);
  const savedHandle = db.getSetting("handle");
  if (savedHandle) shareServer.setHandle(savedHandle);
  if (db.hasSharedSessions()) {
    ensureTunnel().catch(() => {});
  }

  // One-time migration: move any API key stored in plaintext SQLite into the Keychain
  const legacyKey = db.getSetting("aiApiKey");
  if (legacyKey) {
    const existing = await keychainGet("aiApiKey");
    if (!existing) await keychainSet("aiApiKey", legacyKey);
    db.deleteSetting("aiApiKey");
  }

  startAiWorker();
  await initIpc();
  createWindow();
  createTray();
  startCaptureSocketServer();
  startHelper();
  scheduleDailySummary();

  // Delay the initial update check so it doesn't compete with startup I/O.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 15_000).unref();

  if (db.getSetting("dailyRecapEnabled") !== "false") {
    const yesterday = yesterdayDateStr();
    if (!db.getDailySummary(yesterday) && db.getSessionsForDate(yesterday).length > 0) {
      generateDailySummary(yesterday).catch(() => {});
    }
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  closeTunnel();
  if (helperProc && !helperProc.killed) {
    helperProc.kill();
  }
  if (aiProc) {
    aiProc.kill();
    aiProc = null;
  }
});
