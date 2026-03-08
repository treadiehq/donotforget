export type SourceType = "selection" | "focused" | "clipboard";

/** Single source of truth for every IPC channel name used between main and renderer. */
export const IPC = {
  // renderer → main (invoke/handle)
  STATE_GET: "state:get",
  SESSIONS_LIST: "sessions:list",
  SESSIONS_SEARCH: "sessions:search",
  SESSION_CREATE: "session:create",
  SESSION_SET_ACTIVE: "session:set-active",
  SESSION_DELETE: "session:delete",
  SESSION_RENAME: "session:rename",
  SESSION_SAVE_DRAFT: "session:save-draft",
  SESSION_GET_DRAFT: "session:get-draft",
  SESSION_COPY: "session:copy",
  EVENTS_LIST: "events:list",
  RECORDING_TOGGLE: "recording:toggle",
  EXPORT_MARKDOWN: "export:markdown",
  EXPORT_JSON: "export:json",
  SHARE_CREATE: "share:create",
  SHARE_REVOKE: "share:revoke",
  HELPER_START: "helper:start",
  ACCESSIBILITY_OPEN: "accessibility:open-settings",
  SETTINGS_GET_ALL: "settings:get-all",
  SETTINGS_SET: "settings:set",
  DATA_CLEAR_ALL: "data:clear-all",
  AI_CHAT: "ai:chat",
  AI_ENHANCE: "ai:enhance",
  DAILY_SUMMARY_GET: "daily-summary:get",
  DAILY_SUMMARY_GENERATE: "daily-summary:generate",
  DAILY_SUMMARIES_LIST: "daily-summaries:list",
  APP_GET_VERSION: "app:get-version",
  APP_CHECK_FOR_UPDATES: "app:check-for-updates",
  APP_INSTALL_UPDATE: "app:install-update",
  // main → renderer (send/on)
  PUSH_STATE_CHANGED: "state-changed",
  PUSH_EVENTS_UPDATED: "events-updated",
  PUSH_UPDATE_AVAILABLE: "update:available",
  PUSH_UPDATE_PROGRESS: "update:progress",
  PUSH_UPDATE_DOWNLOADED: "update:downloaded",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

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
  shareUrl: string | null;
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
