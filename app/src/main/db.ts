import Database from "better-sqlite3";
import path from "node:path";
import { app } from "electron";
import type { CapturePayload, EventRow, SessionRow } from "../shared/types";

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
        `SELECT s.id, s.createdAt, s.title, s.isShared, s.shareToken,
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
      .prepare("SELECT id, createdAt, title, isShared, shareToken FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  getEvents(sessionId: number): EventRow[] {
    return this.db
      .prepare("SELECT id, sessionId, ts, app, window, source, text FROM events WHERE sessionId = ? ORDER BY ts ASC")
      .all(sessionId) as EventRow[];
  }

  setShareToken(sessionId: number, token: string | null) {
    if (token) {
      this.db
        .prepare("UPDATE sessions SET isShared = 1, shareToken = ? WHERE id = ?")
        .run(token, sessionId);
    } else {
      this.db
        .prepare("UPDATE sessions SET isShared = 0, shareToken = NULL WHERE id = ?")
        .run(sessionId);
    }
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
        "SELECT id, createdAt, title, isShared, shareToken FROM sessions WHERE shareToken = ? AND isShared = 1"
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
    const like = `%${query}%`;
    return this.db
      .prepare(
        `SELECT DISTINCT s.id, s.createdAt, s.title, s.isShared, s.shareToken,
                (SELECT substr(trim(e.text), 1, 120) FROM events e WHERE e.sessionId = s.id AND trim(e.text) != '' ORDER BY e.ts ASC LIMIT 1) as preview
         FROM sessions s
         LEFT JOIN events e ON e.sessionId = s.id
         LEFT JOIN session_drafts d ON d.sessionId = s.id
         WHERE s.title LIKE ? OR e.text LIKE ? OR d.content LIKE ?
         ORDER BY s.createdAt DESC
         LIMIT 20`
      )
      .all(like, like, like) as SessionRow[];
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

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }
}
