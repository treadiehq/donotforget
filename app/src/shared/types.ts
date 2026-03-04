export type SourceType = "selection" | "focused" | "clipboard";

export interface CapturePayload {
  ts: number;
  app: string;
  window?: string;
  source: SourceType;
  text: string;
}

export interface SessionRow {
  id: number;
  createdAt: number;
  title: string;
  isShared: number;
  shareToken: string | null;
  preview: string | null;
}

export interface EventRow {
  id: number;
  sessionId: number;
  ts: number;
  app: string;
  window: string | null;
  source: SourceType;
  text: string;
}

export interface AppState {
  recording: boolean;
  currentSessionId: number | null;
  wsClients: number;
}
