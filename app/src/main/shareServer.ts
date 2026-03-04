import express from "express";
import type { Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { SessionDb } from "./db";
import { sessionToMarkdown } from "./exporters";

function getModelForProvider(provider: string, model: string): string {
  return model || (provider === "anthropic" ? "claude-opus-4-6" : provider === "google" ? "gemini-3.1-pro-preview" : "gpt-5.2");
}

async function callAiProviderShare(
  provider: string, model: string, apiKey: string, systemPrompt: string, userMessage: string
): Promise<string> {
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }], max_tokens: 1024 })
    });
    if (!res.ok) throw new Error(`API error (${res.status})`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "No response.";
  } else if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, system: systemPrompt, messages: [{ role: "user", content: userMessage }], max_tokens: 1024 })
    });
    if (!res.ok) throw new Error(`API error (${res.status})`);
    const data = await res.json();
    return data.content?.[0]?.text || "No response.";
  } else if (provider === "google") {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: "user", parts: [{ text: userMessage }] }], generationConfig: { maxOutputTokens: 1024 } })
    });
    if (!res.ok) throw new Error(`API error (${res.status})`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
  }
  throw new Error("Unsupported provider.");
}

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let inBlockquote = false;
  let inSection = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (raw.startsWith("```")) {
      if (inBlockquote) { out.push("</blockquote>"); inBlockquote = false; }
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        const lang = esc(raw.slice(3).trim());
        out.push(`<pre class="code-block"${lang ? ` data-lang="${lang}"` : ""}><code>`);
        inCode = true;
      }
      continue;
    }

    if (inCode) { out.push(esc(raw)); continue; }

    if (raw.startsWith("> ")) {
      if (!inBlockquote) { out.push('<blockquote>'); inBlockquote = true; }
      out.push(`<p>${esc(raw.slice(2))}</p>`);
      continue;
    }
    if (inBlockquote && raw.trim() === "") { out.push("</blockquote>"); inBlockquote = false; }

    if (raw.startsWith("### ")) {
      if (inSection) out.push("</div>");
      out.push(`<div class="capture-section">`);
      out.push(`<div class="capture-heading">${esc(raw.slice(4))}</div>`);
      inSection = true;
      continue;
    }
    if (raw.startsWith("# ")) { out.push(`<h1>${esc(raw.slice(2))}</h1>`); continue; }
    if (raw.startsWith("## ")) { out.push(`<h2>${esc(raw.slice(3))}</h2>`); continue; }
    if (raw.startsWith("- ")) { out.push(`<li>${esc(raw.slice(2))}</li>`); continue; }
    if (raw.trim() === "") continue;

    const inline = esc(raw).replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    out.push(`<p>${inline}</p>`);
  }

  if (inBlockquote) out.push("</blockquote>");
  if (inCode) out.push("</code></pre>");
  if (inSection) out.push("</div>");
  return out.join("\n");
}

function resolveShareFile(filename: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), "src", "share", filename),
    path.resolve(app.getAppPath(), "src", "share", filename),
    path.resolve(__dirname, "..", "..", "src", "share", filename),
    path.join(process.resourcesPath, "share", filename)
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function loadFile(filename: string): string {
  const filepath = resolveShareFile(filename);
  if (!filepath) return "";
  return readFileSync(filepath, "utf8");
}

const isDev = !!process.env.VITE_DEV_SERVER_URL;

export class ShareServer {
  private app = express();
  private server: Server | null = null;
  private readonly port: number;
  private templateCache: string | null = null;
  private errorTemplateCache: string | null = null;
  private cssCache: string | null = null;
  private handle: string = "";

  constructor(private db: SessionDb, port = 1455) {
    this.port = port;
    this.configure();
  }

  setHandle(handle: string) {
    this.handle = handle.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
  }

  private getTemplate(): string {
    if (!isDev && this.templateCache) return this.templateCache;
    this.templateCache = loadFile("share.template.html");
    return this.templateCache;
  }

  private getErrorTemplate(): string {
    if (!isDev && this.errorTemplateCache) return this.errorTemplateCache;
    this.errorTemplateCache = loadFile("share.404.html");
    return this.errorTemplateCache;
  }

  private getCss(): string {
    if (!isDev && this.cssCache) return this.cssCache;
    this.cssCache = loadFile("share.generated.css");
    return this.cssCache;
  }

  private renderTemplate(template: string, vars: Record<string, string>): string {
    let html = template;
    for (const [key, value] of Object.entries(vars)) {
      html = html.replaceAll(`{{${key}}}`, value);
    }
    return html;
  }

  private renderError(title: string, message: string): string {
    const template = this.getErrorTemplate();
    return this.renderTemplate(template, {
      TITLE: esc(title),
      MESSAGE: esc(message),
      CSS: this.getCss()
    });
  }

  private configure() {
    if (isDev) {
      this.app.use((_req, res, next) => {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        next();
      });
    }

    this.app.use(express.json());

    this.app.get("/api/ai-status", (_req, res) => {
      const settings = this.db.getAllSettings();
      const enabled = settings.aiEnabled === "true" && !!settings.aiApiKey;
      res.json({ enabled });
    });

    this.app.post("/api/ai-chat", async (req, res) => {
      const settings = this.db.getAllSettings();
      if (settings.aiEnabled !== "true" || !settings.aiApiKey) {
        res.status(403).json({ error: "AI not configured" });
        return;
      }
      const { message, token } = req.body;
      if (!message || !token) { res.status(400).json({ error: "Missing message or token" }); return; }

      const session = this.db.getSessionByToken(token);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const provider = settings.aiProvider || "openai";
      const model = getModelForProvider(provider, settings.aiModel || "");
      const draft = this.db.getDraft(session.id);
      const events = this.db.getEvents(session.id);
      const eventText = events.map((e: any) => e.text).join("\n");
      const content = draft || eventText || "(empty)";

      const systemPrompt = `You are an AI assistant on a shared session page from "Do Not Forget", a text capture app. Someone is viewing a shared session and asking questions about it.

Session: "${session.title}" (${new Date(session.createdAt).toLocaleDateString()})

Content:
${content.slice(0, 10000)}

How to respond:
- Answer like a knowledgeable friend who has read this session carefully
- Be direct and concise — no filler
- If they ask for a specific detail, quote the relevant part
- If something isn't in the session, say so honestly
- Use markdown for readability when helpful`;

      try {
        const reply = await callAiProviderShare(provider, model, settings.aiApiKey, systemPrompt, message);
        res.json({ reply });
      } catch (err: any) {
        res.status(500).json({ error: err.message || "AI request failed" });
      }
    });

    this.app.get("/:token", (req, res) => {
      const token = req.params.token;
      const session = this.db.getSessionByToken(token);
      if (!session) {
        res.status(404).send(
          this.renderError("Link expired or revoked", "This share link is no longer valid. The session owner may have revoked access.")
        );
        return;
      }
      const events = this.db.getEvents(session.id);
      const draft = this.db.getDraft(session.id);
      const markdown = draft ?? sessionToMarkdown(session, events, { skipHeader: true });
      const contentHtml = markdownToHtml(markdown);
      const date = new Date(session.createdAt).toLocaleDateString(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric"
      });
      const time = new Date(session.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const captureLabel = `${events.length} capture${events.length !== 1 ? "s" : ""}`;

      const html = this.renderTemplate(this.getTemplate(), {
        TITLE: esc(session.title),
        DATE: `${date} at ${time}`,
        CAPTURES: captureLabel,
        CONTENT: contentHtml,
        MARKDOWN_JSON: JSON.stringify(markdown).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"),
        CSS: this.getCss()
      });

      res.setHeader("content-type", "text/html; charset=utf-8");
      res.send(html);
    });

    this.app.use((_req, res) => {
      res.status(404).send(
        this.renderError("Page not found", "The page you're looking for doesn't exist.")
      );
    });
  }

  start(): Promise<number> {
    if (this.server) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, "127.0.0.1", () => resolve(this.port));
      this.server.on("error", reject);
    });
  }

  urlForToken(token: string): string {
    const subdomain = this.handle || "donotforget";
    return `http://${subdomain}.localhost:${this.port}/${token}`;
  }
}
