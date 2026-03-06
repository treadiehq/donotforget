import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, clipboard, shell } from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { Tunnel as CfTunnel, bin as cfBin, install as cfInstall } from "cloudflared";
import type { CapturePayload, AppState } from "../shared/types";
import { SessionDb } from "./db";
import { sessionToJson, sessionToMarkdown } from "./exporters";
import { ShareServer } from "./shareServer";
import { KEYCHAIN_KEYS, keychainGet, keychainSet, keychainDelete } from "./keychain";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
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
let tunnelChild: CfTunnel | ChildProcess | null = null;
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
  mainWindow.webContents.send("state-changed", getState());
  if (currentSessionId) {
    mainWindow.webContents.send("events-updated", currentSessionId);
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
  }
}

async function callAiProvider(
  provider: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048
): Promise<string> {
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        max_completion_tokens: maxTokens
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "No response from model.";
  } else if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        max_tokens: maxTokens
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.content?.[0]?.text || "No response from model.";
  } else if (provider === "google") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: maxTokens }
        })
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from model.";
  }
  throw new Error("Unsupported provider.");
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
  // Resolve private-connect entry point. In a packaged app it lives inside
  // app.asar (a virtual fs), so we swap to the real app.asar.unpacked path
  // which is a normal directory that a spawned child process can read from.
  // All of private-connect's dependencies (socket.io-client etc.) are also
  // unpacked via the asarUnpack config in package.json.
  let binPath: string;
  try {
    binPath = require.resolve("private-connect/dist/index.js");
    binPath = binPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
  } catch {
    throw new Error("private-connect module not found");
  }

  // process.execPath in a packaged Electron app is the Electron binary.
  // ELECTRON_RUN_AS_NODE=1 makes it behave like plain Node.js.
  // NODE_PATH points to the unpacked node_modules so deps like socket.io-client
  // are found by the spawned child process.
  const unpackedNodeModules = path.join(path.dirname(path.dirname(binPath)), "..");
  const child = spawn(process.execPath, [binPath, "tunnel", "1455"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: unpackedNodeModules
    }
  });
  tunnelChild = child;
  activeTunnelProvider = "privateconnect";

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Private Connect tunnel URL timeout"));
    }, 30000);

    let output = "";
    const urlPattern = /https:\/\/[a-z0-9-]+\.privateconnect\.co/;

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(urlPattern);
      if (match) {
        clearTimeout(timeout);
        child.stdout?.removeListener("data", onData);
        child.stderr?.removeListener("data", onErrData);
        resolve(match[0]);
      }
    };
    const onErrData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(urlPattern);
      if (match) {
        clearTimeout(timeout);
        child.stdout?.removeListener("data", onData);
        child.stderr?.removeListener("data", onErrData);
        resolve(match[0]);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onErrData);
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (!tunnelUrl) reject(new Error(`Private Connect exited with code ${code}`));
    });
  });

  child.on("exit", () => {
    tunnelChild = null;
    tunnelUrl = null;
    activeTunnelProvider = null;
    if (!isQuitting && !tunnelReconnecting && db.hasSharedSessions()) {
      reconnectTunnel();
    }
  });

  return url;
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
    } else {
      c.kill();
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
      db.insertCapture(currentSessionId, normalizedPayload);
      broadcastState();
      generateAutoTitle(currentSessionId).catch(() => {});
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
  ipcMain.handle("state:get", () => getState());
  ipcMain.handle("sessions:list", () => db.listSessions());
  ipcMain.handle("session:create", () => createNewSession());
  ipcMain.handle("session:set-active", (_event, sessionId: number | null) => setActiveSession(sessionId));
  ipcMain.handle("session:delete", (_event, sessionId: number) => deleteSession(sessionId));
  ipcMain.handle("session:rename", (_event, sessionId: number, title: string) => {
    const ok = db.renameSession(sessionId, title);
    if (ok) broadcastState();
    return ok;
  });
  ipcMain.handle("events:list", (_event, sessionId: number) => db.getEvents(sessionId));
  ipcMain.handle("recording:toggle", (_event, targetSessionId?: number | null) => {
    toggleRecording(targetSessionId);
    return getState();
  });
  ipcMain.handle("export:markdown", async (_event, sessionId: number) => exportSession(sessionId, "md"));
  ipcMain.handle("export:json", async (_event, sessionId: number) => exportSession(sessionId, "json"));
  ipcMain.handle("session:copy", (_event, sessionId: number) => copySession(sessionId));
  ipcMain.handle("share:create", async (_event, sessionId: number) => {
    const baseUrl = await ensureTunnel();
    const token = randomBytes(18).toString("base64url");
    const fullUrl = `${baseUrl}/${token}`;
    db.setShareToken(sessionId, token, fullUrl);
    return fullUrl;
  });
  ipcMain.handle("share:revoke", async (_event, sessionId: number) => {
    db.setShareToken(sessionId, null);
    if (!db.hasSharedSessions()) {
      await closeTunnel();
    }
    return true;
  });
  ipcMain.handle("session:save-draft", (_event, sessionId: number, content: string) => {
    db.saveDraft(sessionId, content);
    return true;
  });
  ipcMain.handle("session:get-draft", (_event, sessionId: number) => {
    return db.getDraft(sessionId);
  });
  ipcMain.handle("helper:start", () => startHelper());
  ipcMain.handle("accessibility:open-settings", async () => {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    );
  });
  ipcMain.handle("sessions:search", (_event, query: string) => db.searchSessions(query));
  ipcMain.handle("settings:get-all", async () => {
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
  ipcMain.handle("settings:set", async (_event, key: string, value: string) => {
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
  ipcMain.handle("data:clear-all", () => {
    db.clearAllData();
    broadcastState();
  });
  ipcMain.handle("daily-summary:get", async (_event, dateStr: string) => {
    const existing = db.getDailySummary(dateStr);
    if (existing) return existing;
    return null;
  });
  ipcMain.handle("daily-summary:generate", async (_event, dateStr: string) => {
    const content = await generateDailySummary(dateStr);
    return content ? db.getDailySummary(dateStr) : null;
  });
  ipcMain.handle("daily-summaries:list", () => {
    return db.listDailySummaries();
  });
  ipcMain.handle("ai:chat", async (_event, message: string, sessionId: number | null) => {
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

  ipcMain.handle("ai:enhance", async (_event, sessionId: number) => {
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

  ipcMain.handle("app:get-version", () => {
    const candidates = [
      path.join(__dirname, "../../../package.json"),
      path.join(app.getAppPath(), "package.json")
    ];
    for (const p of candidates) {
      try {
        const pkg = JSON.parse(require("fs").readFileSync(p, "utf-8"));
        if (pkg.version && !pkg.version.startsWith("35.")) return pkg.version;
      } catch {}
    }
    return app.getVersion();
  });

  ipcMain.handle("app:check-for-updates", async () => {
    const RELEASES_URL = "https://api.github.com/repos/treadiehq/donotforget/releases/latest";
    try {
      const res = await fetch(RELEASES_URL, { headers: { "User-Agent": "DoNotForget" } });
      if (!res.ok) return { available: false, error: `Version check failed (${res.status})` };
      const data = await res.json();
      const latest = (data.tag_name || "").replace(/^v/, "");
      let current = app.getVersion();
      for (const p of [path.join(__dirname, "../../../package.json"), path.join(app.getAppPath(), "package.json")]) {
        try {
          const v = JSON.parse(require("fs").readFileSync(p, "utf-8")).version;
          if (v && !v.startsWith("35.")) { current = v; break; }
        } catch {}
      }
      if (!latest) return { available: false, error: "No version info found" };
      console.log(`[update-check] current=${current} latest=${latest}`);
      const isNewer = latest.localeCompare(current, undefined, { numeric: true, sensitivity: "base" }) > 0;
      const dmgAsset = (data.assets || []).find((a: any) => a.name.endsWith(".dmg") && a.name.includes("arm64"));
      return {
        available: isNewer,
        currentVersion: current,
        latestVersion: latest,
        releaseUrl: data.html_url || `https://github.com/treadiehq/donotforget/releases/tag/v${latest}`,
        downloadUrl: dmgAsset?.browser_download_url || data.html_url || null
      };
    } catch (err: any) {
      return { available: false, error: err.message || "Network error" };
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

app.whenReady().then(async () => {
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

  await initIpc();
  createWindow();
  createTray();
  startCaptureSocketServer();
  startHelper();
  scheduleDailySummary();

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
});
