export type SourceType = "selection" | "focused" | "clipboard" | "voice" | "screenshot";
export type AppTagType = "code" | "conversation" | "research" | "terminal" | "pdf" | "presentation" | "notes" | "general";
export type CaptureRuleAction = "allow" | "block";
export type WebhookTrigger = "session_end" | "session_start" | "daily_recap";

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
  AI_DESCRIBE_IMAGE: "ai:describe-image",
  AI_RELATED_CAPTURES: "ai:related-captures",
  DAILY_SUMMARY_GET: "daily-summary:get",
  DAILY_SUMMARY_GENERATE: "daily-summary:generate",
  DAILY_SUMMARIES_LIST: "daily-summaries:list",
  APP_GET_VERSION: "app:get-version",
  APP_CHECK_FOR_UPDATES: "app:check-for-updates",
  APP_INSTALL_UPDATE: "app:install-update",
  APP_CANCEL_UPDATE_DOWNLOAD: "app:cancel-update-download",
  // Capture rules
  RULES_LIST: "rules:list",
  RULES_ADD: "rules:add",
  RULES_UPDATE: "rules:update",
  RULES_DELETE: "rules:delete",
  // App tags
  APP_TAGS_LIST: "app-tags:list",
  APP_TAGS_SET: "app-tags:set",
  APP_TAGS_DELETE: "app-tags:delete",
  // Webhooks
  WEBHOOKS_LIST: "webhooks:list",
  WEBHOOKS_ADD: "webhooks:add",
  WEBHOOKS_UPDATE: "webhooks:update",
  WEBHOOKS_DELETE: "webhooks:delete",
  WEBHOOKS_TEST: "webhooks:test",
  // Media attachments
  MEDIA_ADD: "media:add",
  MEDIA_LIST: "media:list",
  MEDIA_DELETE: "media:delete",
  // Voice capture
  VOICE_TRANSCRIBE: "voice:transcribe",
  // main → renderer (send/on)
  PUSH_STATE_CHANGED: "state-changed",
  PUSH_EVENTS_UPDATED: "events-updated",
  PUSH_UPDATE_AVAILABLE: "update:available",
  PUSH_UPDATE_PROGRESS: "update:progress",
  PUSH_UPDATE_DOWNLOADED: "update:downloaded",
  PUSH_UPDATE_ERROR: "update:error",
  PUSH_RELATED_CAPTURES: "related-captures",
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
  appTag?: string | null;
}

export interface AppState {
  recording: boolean;
  currentSessionId: number | null;
  wsClients: number;
}

export interface CaptureRule {
  id: number;
  appPattern: string;
  action: CaptureRuleAction;
  minWords: number;
  extractCitations: boolean;
  note: string | null;
  createdAt: number;
}

export interface AppTag {
  appName: string;
  tag: AppTagType;
  updatedAt: number;
}

export interface WebhookConfig {
  id: number;
  name: string;
  url: string;
  trigger: WebhookTrigger;
  enabled: boolean;
  createdAt: number;
}

export interface MediaAttachment {
  id: number;
  filename: string;
  mimeType: string;
  dataB64: string;
  caption: string | null;
  aiDescription: string | null;
  createdAt: number;
}

export interface RelatedCapture {
  eventId: number;
  score: number;
  text: string;
  sessionId: number;
  sessionTitle: string;
  ts: number;
}
