import Database from "better-sqlite3";
import path from "node:path";
import { app } from "electron";
import type { CapturePayload, EventRow, SessionRow, CaptureRule, AppTag, WebhookConfig } from "../shared/types";

export interface InsertCaptureResult {
  kind: "inserted" | "updated" | "ignored";
}

function overlapRatio(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const small = a.length < b.length ? a : b;
  const large = a.length < b.length ? b : a;
  if (large.includes(small)) return small.length / large.length;

  let prefixLen = 0;
  const maxPrefix = Math.min(small.length, large.length);
  while (prefixLen < maxPrefix && small[prefixLen] === large[prefixLen]) prefixLen++;

  if (prefixLen >= small.length * 0.8) return prefixLen / large.length;

  return 0;
}

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 1)
  );
}

function jaccardSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) intersection += 1;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export class SessionDb {
  private db: Database.Database;

  constructor() {
    const dbPath = path.join(app.getPath("userData"), "session-capture.sqlite");
    this.db = new Database(dbPath);
    this.init();
  }

  private init() {
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        createdAt INTEGER NOT NULL,
        title TEXT NOT NULL,
        isShared INTEGER NOT NULL DEFAULT 0,
        shareToken TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        app TEXT NOT NULL,
        window TEXT,
        source TEXT NOT NULL,
        text TEXT NOT NULL,
        normText TEXT NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(sessionId, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(createdAt DESC);
      CREATE TABLE IF NOT EXISTS session_drafts (
        sessionId INTEGER PRIMARY KEY,
        content TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "shareUrl")) {
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN shareUrl TEXT");
      } catch {
        // Column may already exist; safe to ignore
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_summaries (
        date TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        isAi INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appPattern TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'allow',
        minWords INTEGER NOT NULL DEFAULT 0,
        extractCitations INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        createdAt INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_tags (
        appName TEXT PRIMARY KEY,
        tag TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceEventId INTEGER NOT NULL,
        targetEventId INTEGER NOT NULL,
        score REAL NOT NULL,
        createdAt INTEGER NOT NULL
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_source ON semantic_links(sourceEventId);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_target ON semantic_links(targetEventId);`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'session_end',
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId INTEGER NOT NULL,
        filename TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        dataB64 TEXT NOT NULL,
        caption TEXT,
        aiDescription TEXT,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    // Safe column migration — ALTER TABLE cannot run inside a transaction
    const eventCols = this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (!eventCols.some((c) => c.name === "appTag")) {
      try {
        this.db.exec("ALTER TABLE events ADD COLUMN appTag TEXT");
      } catch {
        // Column may already exist from a concurrent migration attempt; safe to ignore
      }
    }

    this.initFts();
  }

  private initFts() {
    // FTS5 virtual table over events.text for fast full-text search.
    // content= makes it a content table (no data duplication) linked to the real events table.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        text,
        content=events,
        content_rowid=id,
        tokenize='unicode61'
      );

      -- Keep the FTS index in sync with the events table via triggers.
      CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
  }

  createSession(title?: string): number {
    const createdAt = Date.now();
    const t = title ?? `Session ${new Date(createdAt).toLocaleString()}`;
    const stmt = this.db.prepare("INSERT INTO sessions(createdAt, title) VALUES(?, ?)");
    const result = stmt.run(createdAt, t);
    return Number(result.lastInsertRowid);
  }

  deleteSession(sessionId: number): boolean {
    const tx = this.db.transaction((id: number) => {
      this.db.prepare("DELETE FROM events WHERE sessionId = ?").run(id);
      const res = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      return res.changes > 0;
    });
    return tx(sessionId);
  }

  clearAllData(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM events").run();
      this.db.prepare("DELETE FROM sessions").run();
      this.db.prepare("DELETE FROM session_drafts").run();
    });
    tx();
  }

  listSessions(): SessionRow[] {
    return this.db
      .prepare(
        `SELECT s.id, s.createdAt, s.title, s.isShared, s.shareToken, s.shareUrl,
                (SELECT substr(trim(e.text), 1, 120) FROM events e WHERE e.sessionId = s.id AND trim(e.text) != '' ORDER BY e.ts ASC LIMIT 1) as preview
         FROM sessions s ORDER BY s.createdAt DESC`
      )
      .all() as SessionRow[];
  }

  renameSession(sessionId: number, title: string): boolean {
    const res = this.db
      .prepare("UPDATE sessions SET title = ? WHERE id = ?")
      .run(title, sessionId);
    return res.changes > 0;
  }

  getSession(sessionId: number): SessionRow | null {
    const row = this.db
      .prepare("SELECT id, createdAt, title, isShared, shareToken, shareUrl FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  getEvents(sessionId: number): EventRow[] {
    return this.db
      .prepare("SELECT id, sessionId, ts, app, window, source, text FROM events WHERE sessionId = ? ORDER BY ts ASC")
      .all(sessionId) as EventRow[];
  }

  setShareToken(sessionId: number, token: string | null, shareUrl?: string | null) {
    if (token) {
      this.db
        .prepare("UPDATE sessions SET isShared = 1, shareToken = ?, shareUrl = ? WHERE id = ?")
        .run(token, shareUrl ?? null, sessionId);
    } else {
      this.db
        .prepare("UPDATE sessions SET isShared = 0, shareToken = NULL, shareUrl = NULL WHERE id = ?")
        .run(sessionId);
    }
  }

  updateAllShareUrls(baseUrl: string): void {
    const shared = this.db
      .prepare("SELECT id, shareToken FROM sessions WHERE isShared = 1 AND shareToken IS NOT NULL")
      .all() as Array<{ id: number; shareToken: string }>;
    const stmt = this.db.prepare("UPDATE sessions SET shareUrl = ? WHERE id = ?");
    const tx = this.db.transaction(() => {
      for (const s of shared) {
        stmt.run(`${baseUrl}/${s.shareToken}`, s.id);
      }
    });
    tx();
  }

  saveDraft(sessionId: number, content: string): void {
    this.db
      .prepare(
        "INSERT INTO session_drafts(sessionId, content, updatedAt) VALUES(?, ?, ?) ON CONFLICT(sessionId) DO UPDATE SET content = excluded.content, updatedAt = excluded.updatedAt"
      )
      .run(sessionId, content, Date.now());
  }

  getDraft(sessionId: number): string | null {
    const row = this.db
      .prepare("SELECT content FROM session_drafts WHERE sessionId = ?")
      .get(sessionId) as { content: string } | undefined;
    return row?.content ?? null;
  }

  hasSharedSessions(): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sessions WHERE isShared = 1 LIMIT 1")
      .get();
    return row !== undefined;
  }

  getSessionByToken(token: string): SessionRow | null {
    const row = this.db
      .prepare(
        "SELECT id, createdAt, title, isShared, shareToken, shareUrl FROM sessions WHERE shareToken = ? AND isShared = 1"
      )
      .get(token) as SessionRow | undefined;
    return row ?? null;
  }

  insertCapture(sessionId: number, payload: CapturePayload): InsertCaptureResult {
    const normText = normalizeText(payload.text);
    if (!normText) return { kind: "ignored" };

    const recent = this.db
      .prepare(
        "SELECT id, ts, app, window, source, text, normText FROM events WHERE sessionId = ? AND ts >= ? ORDER BY ts DESC LIMIT 60"
      )
      .all(sessionId, payload.ts - 30000) as Array<
      Pick<EventRow, "id" | "ts" | "app" | "window" | "source" | "text"> & { normText: string }
    >;

    const sameContext = (row: { app: string; window: string | null }) =>
      row.app === payload.app && (row.window ?? null) === (payload.window ?? null);

    // Selection-first policy: if user highlighted text, store it once per app/window in session.
    if (
      payload.source === "selection" &&
      this.db
        .prepare(
          "SELECT id FROM events WHERE sessionId = ? AND app = ? AND IFNULL(window, '') = IFNULL(?, '') AND source = 'selection' AND normText = ? LIMIT 1"
        )
        .get(sessionId, payload.app, payload.window ?? null, normText)
    ) {
      return { kind: "ignored" };
    }

    // Strong selection dedupe: treat mostly-overlapping captures from the same
    // app/window as the same highlight to avoid repeat inserts from AX jitter.
    if (payload.source === "selection") {
      const recentSelections = recent.filter((r) => r.source === "selection" && sameContext(r));
      const latestSelection = recentSelections[0];
      if (latestSelection && payload.ts - latestSelection.ts <= 5000) {
        const quickOverlap = Math.max(
          overlapRatio(normText, latestSelection.normText),
          overlapRatio(latestSelection.normText, normText)
        );
        const quickFuzzy = jaccardSimilarity(normText, latestSelection.normText);
        if (quickOverlap >= 0.4 || quickFuzzy >= 0.45) {
          if (normText.length > latestSelection.normText.length) {
            this.db
              .prepare("UPDATE events SET ts = ?, text = ?, normText = ? WHERE id = ?")
              .run(payload.ts, payload.text, normText, latestSelection.id);
            return { kind: "updated" };
          }
          return { kind: "ignored" };
        }
      }

      for (const r of recentSelections) {
        const aInB = overlapRatio(normText, r.normText);
        const bInA = overlapRatio(r.normText, normText);
        const maxOverlap = Math.max(aInB, bInA);
        const fuzzy = jaccardSimilarity(normText, r.normText);
        if (maxOverlap >= 0.5 || fuzzy >= 0.65) {
          // Keep the longer text variant and just update existing row.
          if (normText.length > r.normText.length) {
            this.db
              .prepare("UPDATE events SET ts = ?, text = ?, normText = ? WHERE id = ?")
              .run(payload.ts, payload.text, normText, r.id);
            return { kind: "updated" };
          }
          return { kind: "ignored" };
        }
      }
    }

    // Drop noisy focused captures of short control labels (e.g. "Stop", "Copy", "OK").
    if (payload.source === "focused" && normText.length < 8) {
      return { kind: "ignored" };
    }

    // If recent selection exists in the same context, prefer it over focused auto-captures.
    if (
      payload.source === "focused" &&
      recent.some((r) => r.source === "selection" && sameContext(r) && payload.ts - r.ts <= 10000)
    ) {
      return { kind: "ignored" };
    }

    if (recent.some((r) => r.normText === normText)) return { kind: "ignored" };

    const previous = recent[0];
    if (previous) {
      const newInPrev = overlapRatio(normText, previous.normText);
      if (newInPrev >= 0.7 && previous.normText.length >= normText.length) {
        return { kind: "ignored" };
      }

      const prevInNew = overlapRatio(previous.normText, normText);
      const sameContext =
        previous.app === payload.app &&
        (previous.window ?? null) === (payload.window ?? null) &&
        previous.source === payload.source &&
        Math.abs(payload.ts - previous.ts) <= 2500;

      if (sameContext && prevInNew >= 0.7 && normText.length >= previous.normText.length) {
        this.db
          .prepare("UPDATE events SET ts = ?, text = ?, normText = ? WHERE id = ?")
          .run(payload.ts, payload.text, normText, previous.id);
        return { kind: "updated" };
      }
    }

    this.db
      .prepare(
        "INSERT INTO events(sessionId, ts, app, window, source, text, normText) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(sessionId, payload.ts, payload.app, payload.window ?? null, payload.source, payload.text, normText);
    return { kind: "inserted" };
  }

  searchSessions(query: string): SessionRow[] {
    // Use FTS5 for event text search (fast indexed) and LIKE only for title/draft (small tables).
    const like = `%${query}%`;
    const ftsQuery = query.replace(/['"*]/g, " ").trim();
    return this.db
      .prepare(
        `SELECT DISTINCT s.id, s.createdAt, s.title, s.isShared, s.shareToken, s.shareUrl,
                (SELECT substr(trim(e.text), 1, 120) FROM events e WHERE e.sessionId = s.id AND trim(e.text) != '' ORDER BY e.ts ASC LIMIT 1) as preview
         FROM sessions s
         WHERE s.title LIKE ?
            OR s.id IN (
                 SELECT DISTINCT e.sessionId FROM events_fts
                 JOIN events e ON e.id = events_fts.rowid
                 WHERE events_fts MATCH ?
               )
            OR s.id IN (
                 SELECT d.sessionId FROM session_drafts d WHERE d.content LIKE ?
               )
         ORDER BY s.createdAt DESC
         LIMIT 20`
      )
      .all(like, ftsQuery, like) as SessionRow[];
  }

  getAllSessionsContext(): string {
    const sessions = this.listSessions();
    const parts: string[] = [];
    for (const s of sessions.slice(0, 30)) {
      const draft = this.getDraft(s.id);
      const events = this.getEvents(s.id);
      const apps = [...new Set(events.map((e) => e.app))];
      const eventText = events.map((e) => e.text).join("\n");
      const content = (draft || eventText || "").slice(0, 2000);
      if (!content.trim()) continue;
      const meta = [
        `"${s.title}"`,
        new Date(s.createdAt).toLocaleDateString(),
        `${events.length} captures`,
        apps.length ? `from ${apps.join(", ")}` : null
      ].filter(Boolean).join(" · ");
      parts.push(`--- ${meta} ---\n${content}`);
    }
    return parts.join("\n\n");
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  getSessionsForDate(dateStr: string): SessionRow[] {
    const d = new Date(dateStr + "T00:00:00");
    const startMs = d.getTime();
    const endMs = startMs + 86400000;
    return this.db
      .prepare(
        `SELECT s.id, s.createdAt, s.title, s.isShared, s.shareToken, s.shareUrl,
                (SELECT substr(trim(e.text), 1, 120) FROM events e WHERE e.sessionId = s.id AND trim(e.text) != '' ORDER BY e.ts ASC LIMIT 1) as preview
         FROM sessions s WHERE s.createdAt >= ? AND s.createdAt < ? ORDER BY s.createdAt ASC`
      )
      .all(startMs, endMs) as SessionRow[];
  }

  getDailySummary(dateStr: string): { date: string; content: string; isAi: number; createdAt: number } | null {
    const row = this.db
      .prepare("SELECT date, content, isAi, createdAt FROM daily_summaries WHERE date = ?")
      .get(dateStr) as { date: string; content: string; isAi: number; createdAt: number } | undefined;
    return row ?? null;
  }

  saveDailySummary(dateStr: string, content: string, isAi: boolean): void {
    this.db
      .prepare(
        "INSERT INTO daily_summaries(date, content, isAi, createdAt) VALUES(?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET content = excluded.content, isAi = excluded.isAi, createdAt = excluded.createdAt"
      )
      .run(dateStr, content, isAi ? 1 : 0, Date.now());
  }

  listDailySummaries(): Array<{ date: string; content: string; isAi: number; createdAt: number }> {
    return this.db
      .prepare("SELECT date, content, isAi, createdAt FROM daily_summaries ORDER BY date DESC LIMIT 30")
      .all() as Array<{ date: string; content: string; isAi: number; createdAt: number }>;
  }

  // ── Capture Rules ──────────────────────────────────────────────────────────

  listCaptureRules(): CaptureRule[] {
    return this.db.prepare("SELECT * FROM capture_rules ORDER BY createdAt ASC").all() as CaptureRule[];
  }

  addCaptureRule(rule: Omit<CaptureRule, "id" | "createdAt">): number {
    const res = this.db
      .prepare(
        "INSERT INTO capture_rules(appPattern, action, minWords, extractCitations, note, createdAt) VALUES(?,?,?,?,?,?)"
      )
      .run(rule.appPattern, rule.action, rule.minWords ?? 0, rule.extractCitations ? 1 : 0, rule.note ?? null, Date.now());
    return Number(res.lastInsertRowid);
  }

  updateCaptureRule(id: number, rule: Partial<Omit<CaptureRule, "id" | "createdAt">>): boolean {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (rule.appPattern !== undefined) { fields.push("appPattern = ?"); values.push(rule.appPattern); }
    if (rule.action !== undefined) { fields.push("action = ?"); values.push(rule.action); }
    if (rule.minWords !== undefined) { fields.push("minWords = ?"); values.push(rule.minWords); }
    if (rule.extractCitations !== undefined) { fields.push("extractCitations = ?"); values.push(rule.extractCitations ? 1 : 0); }
    if (rule.note !== undefined) { fields.push("note = ?"); values.push(rule.note); }
    if (!fields.length) return false;
    values.push(id);
    return this.db.prepare(`UPDATE capture_rules SET ${fields.join(", ")} WHERE id = ?`).run(...values).changes > 0;
  }

  deleteCaptureRule(id: number): boolean {
    return this.db.prepare("DELETE FROM capture_rules WHERE id = ?").run(id).changes > 0;
  }

  /** Check capture rules for a given app name. Returns the matching rule or null (allow by default). */
  checkCaptureRule(appName: string, wordCount: number): { allowed: boolean; extractCitations: boolean } {
    const rules = this.listCaptureRules();
    const lower = appName.toLowerCase();
    for (const rule of rules) {
      const pat = rule.appPattern.toLowerCase();
      const matches = pat === "*" || lower.includes(pat) || lower === pat;
      if (matches) {
        if (rule.action === "block") return { allowed: false, extractCitations: false };
        if (rule.action === "allow") {
          const meetsMinWords = wordCount >= (rule.minWords ?? 0);
          return { allowed: meetsMinWords, extractCitations: !!rule.extractCitations };
        }
      }
    }
    return { allowed: true, extractCitations: false };
  }

  // ── App Tags ───────────────────────────────────────────────────────────────

  listAppTags(): AppTag[] {
    return this.db.prepare("SELECT appName, tag, updatedAt FROM app_tags ORDER BY appName ASC").all() as AppTag[];
  }

  setAppTag(appName: string, tag: string): void {
    this.db
      .prepare(
        "INSERT INTO app_tags(appName, tag, updatedAt) VALUES(?,?,?) ON CONFLICT(appName) DO UPDATE SET tag = excluded.tag, updatedAt = excluded.updatedAt"
      )
      .run(appName, tag, Date.now());
  }

  deleteAppTag(appName: string): void {
    this.db.prepare("DELETE FROM app_tags WHERE appName = ?").run(appName);
  }

  getAppTag(appName: string): string | null {
    const row = this.db.prepare("SELECT tag FROM app_tags WHERE appName = ?").get(appName) as { tag: string } | undefined;
    return row?.tag ?? null;
  }

  /** Infer a default tag from the app name if no explicit tag set. */
  inferAppTag(appName: string): string {
    const explicit = this.getAppTag(appName);
    if (explicit) return explicit;
    const lower = appName.toLowerCase();
    if (/xcode|vscode|vim|nvim|emacs|sublime|cursor|android studio|intellij|pycharm|webstorm/.test(lower)) return "code";
    if (/slack|teams|discord|zoom|telegram|messages|whatsapp|signal|mail|outlook|gmail/.test(lower)) return "conversation";
    if (/safari|chrome|firefox|arc|edge|brave/.test(lower)) return "research";
    if (/terminal|iterm|warp|kitty|alacritty|hyper|ghostty/.test(lower)) return "terminal";
    if (/preview|adobe|acrobat|pdf/.test(lower)) return "pdf";
    if (/keynote|powerpoint|slides/.test(lower)) return "presentation";
    if (/notes|notion|obsidian|bear|logseq|roam|craft/.test(lower)) return "notes";
    return "general";
  }

  // ── Semantic Links ─────────────────────────────────────────────────────────

  addSemanticLinks(links: Array<{ sourceEventId: number; targetEventId: number; score: number }>): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO semantic_links(sourceEventId, targetEventId, score, createdAt) VALUES(?,?,?,?)"
    );
    const tx = this.db.transaction(() => {
      for (const l of links) stmt.run(l.sourceEventId, l.targetEventId, l.score, Date.now());
    });
    tx();
  }

  getRelatedEvents(eventId: number, limit = 5): Array<{ eventId: number; score: number; text: string; sessionId: number; sessionTitle: string; ts: number }> {
    return this.db.prepare(`
      SELECT sl.targetEventId as eventId, sl.score, e.text, e.sessionId, e.ts, s.title as sessionTitle
      FROM semantic_links sl
      JOIN events e ON e.id = sl.targetEventId
      JOIN sessions s ON s.id = e.sessionId
      WHERE sl.sourceEventId = ?
      ORDER BY sl.score DESC LIMIT ?
    `).all(eventId, limit) as Array<{ eventId: number; score: number; text: string; sessionId: number; sessionTitle: string; ts: number }>;
  }

  getRecentEventsForSimilarity(excludeSessionId: number, limit = 100): Array<{ id: number; text: string; sessionId: number; sessionTitle: string; ts: number }> {
    return this.db.prepare(`
      SELECT e.id, e.text, e.sessionId, e.ts, s.title as sessionTitle
      FROM events e JOIN sessions s ON s.id = e.sessionId
      WHERE e.sessionId != ? AND length(e.text) > 30
      ORDER BY e.ts DESC LIMIT ?
    `).all(excludeSessionId, limit) as Array<{ id: number; text: string; sessionId: number; sessionTitle: string; ts: number }>;
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  listWebhooks(): WebhookConfig[] {
    return this.db.prepare("SELECT * FROM webhooks ORDER BY createdAt ASC").all() as WebhookConfig[];
  }

  addWebhook(hook: Omit<WebhookConfig, "id" | "createdAt">): number {
    const res = this.db
      .prepare("INSERT INTO webhooks(name, url, trigger, enabled, createdAt) VALUES(?,?,?,?,?)")
      .run(hook.name, hook.url, hook.trigger, hook.enabled ? 1 : 0, Date.now());
    return Number(res.lastInsertRowid);
  }

  updateWebhook(id: number, hook: Partial<Omit<WebhookConfig, "id" | "createdAt">>): boolean {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (hook.name !== undefined) { fields.push("name = ?"); values.push(hook.name); }
    if (hook.url !== undefined) { fields.push("url = ?"); values.push(hook.url); }
    if (hook.trigger !== undefined) { fields.push("trigger = ?"); values.push(hook.trigger); }
    if (hook.enabled !== undefined) { fields.push("enabled = ?"); values.push(hook.enabled ? 1 : 0); }
    if (!fields.length) return false;
    values.push(id);
    return this.db.prepare(`UPDATE webhooks SET ${fields.join(", ")} WHERE id = ?`).run(...values).changes > 0;
  }

  deleteWebhook(id: number): boolean {
    return this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes > 0;
  }

  // ── Media Attachments ──────────────────────────────────────────────────────

  addMediaAttachment(sessionId: number, filename: string, mimeType: string, dataB64: string, caption?: string, aiDescription?: string): number {
    const res = this.db
      .prepare("INSERT INTO media_attachments(sessionId, filename, mimeType, dataB64, caption, aiDescription, createdAt) VALUES(?,?,?,?,?,?,?)")
      .run(sessionId, filename, mimeType, dataB64, caption ?? null, aiDescription ?? null, Date.now());
    return Number(res.lastInsertRowid);
  }

  getMediaAttachments(sessionId: number): Array<{ id: number; filename: string; mimeType: string; dataB64: string; caption: string | null; aiDescription: string | null; createdAt: number }> {
    return this.db.prepare("SELECT id, filename, mimeType, dataB64, caption, aiDescription, createdAt FROM media_attachments WHERE sessionId = ? ORDER BY createdAt ASC").all(sessionId) as Array<{ id: number; filename: string; mimeType: string; dataB64: string; caption: string | null; aiDescription: string | null; createdAt: number }>;
  }

  deleteMediaAttachment(id: number): boolean {
    return this.db.prepare("DELETE FROM media_attachments WHERE id = ?").run(id).changes > 0;
  }
}
