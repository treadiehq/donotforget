import { contextBridge, ipcRenderer } from "electron";
import type { AppState, CaptureRule, AppTag, WebhookConfig, RelatedCapture } from "../shared/types";
import { IPC } from "../shared/types";

const api = {
  getState: () => ipcRenderer.invoke(IPC.STATE_GET) as Promise<AppState>,
  listSessions: () => ipcRenderer.invoke(IPC.SESSIONS_LIST),
  searchSessions: (query: string) => ipcRenderer.invoke(IPC.SESSIONS_SEARCH, query),
  createSession: () => ipcRenderer.invoke(IPC.SESSION_CREATE) as Promise<number>,
  setActiveSession: async (sessionId: number | null) => {
    try {
      return (await ipcRenderer.invoke(IPC.SESSION_SET_ACTIVE, sessionId)) as number | null;
    } catch {
      return null;
    }
  },
  deleteSession: (sessionId: number) =>
    ipcRenderer.invoke(IPC.SESSION_DELETE, sessionId) as Promise<{ deleted: boolean; nextSessionId: number | null }>,
  renameSession: (sessionId: number, title: string) =>
    ipcRenderer.invoke(IPC.SESSION_RENAME, sessionId, title) as Promise<boolean>,
  listEvents: (sessionId: number) => ipcRenderer.invoke(IPC.EVENTS_LIST, sessionId),
  toggleRecording: (targetSessionId?: number | null) => ipcRenderer.invoke(IPC.RECORDING_TOGGLE, targetSessionId),
  exportMarkdown: (sessionId: number) => ipcRenderer.invoke(IPC.EXPORT_MARKDOWN, sessionId),
  exportJson: (sessionId: number) => ipcRenderer.invoke(IPC.EXPORT_JSON, sessionId),
  copySession: (sessionId: number) => ipcRenderer.invoke(IPC.SESSION_COPY, sessionId),
  createShare: (sessionId: number) => ipcRenderer.invoke(IPC.SHARE_CREATE, sessionId) as Promise<string>,
  revokeShare: (sessionId: number) => ipcRenderer.invoke(IPC.SHARE_REVOKE, sessionId),
  saveDraft: (sessionId: number, content: string) =>
    ipcRenderer.invoke(IPC.SESSION_SAVE_DRAFT, sessionId, content) as Promise<boolean>,
  getDraft: (sessionId: number) =>
    ipcRenderer.invoke(IPC.SESSION_GET_DRAFT, sessionId) as Promise<string | null>,
  startHelper: () => ipcRenderer.invoke(IPC.HELPER_START) as Promise<{ ok: boolean; message: string }>,
  openAccessibilitySettings: () => ipcRenderer.invoke(IPC.ACCESSIBILITY_OPEN),
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET_ALL) as Promise<Record<string, string>>,
  setSetting: (key: string, value: string) => ipcRenderer.invoke(IPC.SETTINGS_SET, key, value) as Promise<void>,
  aiChat: (message: string, sessionId: number | null) =>
    ipcRenderer.invoke(IPC.AI_CHAT, message, sessionId) as Promise<string>,
  aiEnhance: (sessionId: number) =>
    ipcRenderer.invoke(IPC.AI_ENHANCE, sessionId) as Promise<string>,
  clearAllData: () => ipcRenderer.invoke(IPC.DATA_CLEAR_ALL) as Promise<void>,
  getDailySummary: (dateStr: string) =>
    ipcRenderer.invoke(IPC.DAILY_SUMMARY_GET, dateStr) as Promise<{ date: string; content: string; isAi: number; createdAt: number } | null>,
  generateDailySummary: (dateStr: string) =>
    ipcRenderer.invoke(IPC.DAILY_SUMMARY_GENERATE, dateStr) as Promise<{ date: string; content: string; isAi: number; createdAt: number } | null>,
  listDailySummaries: () =>
    ipcRenderer.invoke(IPC.DAILY_SUMMARIES_LIST) as Promise<Array<{ date: string; content: string; isAi: number; createdAt: number }>>,
  getVersion: () => ipcRenderer.invoke(IPC.APP_GET_VERSION) as Promise<string>,
  checkForUpdates: () => ipcRenderer.invoke(IPC.APP_CHECK_FOR_UPDATES) as Promise<{
    available: boolean;
    currentVersion?: string;
    latestVersion?: string;
    error?: string;
  }>,
  installUpdate: () => ipcRenderer.invoke(IPC.APP_INSTALL_UPDATE) as Promise<void>,
  onStateChanged: (listener: (state: AppState) => void) => {
    const wrapped = (_event: unknown, state: AppState) => listener(state);
    ipcRenderer.on(IPC.PUSH_STATE_CHANGED, wrapped);
    return () => ipcRenderer.off(IPC.PUSH_STATE_CHANGED, wrapped);
  },
  onEventsUpdated: (listener: (sessionId: number) => void) => {
    const wrapped = (_event: unknown, sessionId: number) => listener(sessionId);
    ipcRenderer.on(IPC.PUSH_EVENTS_UPDATED, wrapped);
    return () => ipcRenderer.off(IPC.PUSH_EVENTS_UPDATED, wrapped);
  },
  onUpdateAvailable: (listener: (info: { version: string }) => void) => {
    const wrapped = (_event: unknown, info: { version: string }) => listener(info);
    ipcRenderer.on(IPC.PUSH_UPDATE_AVAILABLE, wrapped);
    return () => ipcRenderer.off(IPC.PUSH_UPDATE_AVAILABLE, wrapped);
  },
  onUpdateDownloaded: (listener: (info: { version: string }) => void) => {
    const wrapped = (_event: unknown, info: { version: string }) => listener(info);
    ipcRenderer.on(IPC.PUSH_UPDATE_DOWNLOADED, wrapped);
    return () => ipcRenderer.off(IPC.PUSH_UPDATE_DOWNLOADED, wrapped);
  },
  onUpdateProgress: (listener: (info: { percent: number }) => void) => {
    const wrapped = (_event: unknown, info: { percent: number }) => listener(info);
    ipcRenderer.on(IPC.PUSH_UPDATE_PROGRESS, wrapped);
    return () => ipcRenderer.off(IPC.PUSH_UPDATE_PROGRESS, wrapped);
  },
  onRelatedCaptures: (listener: (captures: RelatedCapture[]) => void) => {
    const wrapped = (_event: unknown, captures: RelatedCapture[]) => listener(captures);
    ipcRenderer.on(IPC.PUSH_RELATED_CAPTURES, wrapped);
    return () => ipcRenderer.off(IPC.PUSH_RELATED_CAPTURES, wrapped);
  },
  // Capture rules
  listRules: () => ipcRenderer.invoke(IPC.RULES_LIST) as Promise<CaptureRule[]>,
  addRule: (rule: Omit<CaptureRule, "id" | "createdAt">) => ipcRenderer.invoke(IPC.RULES_ADD, rule) as Promise<number>,
  updateRule: (id: number, rule: Partial<CaptureRule>) => ipcRenderer.invoke(IPC.RULES_UPDATE, id, rule) as Promise<boolean>,
  deleteRule: (id: number) => ipcRenderer.invoke(IPC.RULES_DELETE, id) as Promise<boolean>,
  // App tags
  listAppTags: () => ipcRenderer.invoke(IPC.APP_TAGS_LIST) as Promise<AppTag[]>,
  setAppTag: (appName: string, tag: string) => ipcRenderer.invoke(IPC.APP_TAGS_SET, appName, tag) as Promise<boolean>,
  deleteAppTag: (appName: string) => ipcRenderer.invoke(IPC.APP_TAGS_DELETE, appName) as Promise<boolean>,
  // Webhooks
  listWebhooks: () => ipcRenderer.invoke(IPC.WEBHOOKS_LIST) as Promise<WebhookConfig[]>,
  addWebhook: (hook: Omit<WebhookConfig, "id" | "createdAt">) => ipcRenderer.invoke(IPC.WEBHOOKS_ADD, hook) as Promise<number>,
  updateWebhook: (id: number, hook: Partial<WebhookConfig>) => ipcRenderer.invoke(IPC.WEBHOOKS_UPDATE, id, hook) as Promise<boolean>,
  deleteWebhook: (id: number) => ipcRenderer.invoke(IPC.WEBHOOKS_DELETE, id) as Promise<boolean>,
  testWebhook: (id: number) => ipcRenderer.invoke(IPC.WEBHOOKS_TEST, id) as Promise<{ ok: boolean; status?: number; error?: string }>,
  // Media attachments
  addMedia: (sessionId: number, filename: string, mimeType: string, dataB64: string, caption?: string) =>
    ipcRenderer.invoke(IPC.MEDIA_ADD, sessionId, filename, mimeType, dataB64, caption) as Promise<{ id: number; aiDescription: string | null }>,
  listMedia: (sessionId: number) => ipcRenderer.invoke(IPC.MEDIA_LIST, sessionId) as Promise<import("../shared/types").MediaAttachment[]>,
  deleteMedia: (id: number) => ipcRenderer.invoke(IPC.MEDIA_DELETE, id) as Promise<boolean>,
  // AI extras
  aiDescribeImage: (mimeType: string, dataB64: string) => ipcRenderer.invoke(IPC.AI_DESCRIBE_IMAGE, mimeType, dataB64) as Promise<string | null>,
  aiRelatedCaptures: (sessionId: number, text: string) => ipcRenderer.invoke(IPC.AI_RELATED_CAPTURES, sessionId, text) as Promise<RelatedCapture[]>,
  // Voice
  voiceTranscribe: (sessionId: number, audioBase64: string, mimeType: string) =>
    ipcRenderer.invoke(IPC.VOICE_TRANSCRIBE, sessionId, audioBase64, mimeType) as Promise<{ ok: boolean; transcript?: string; error?: string }>,
};

contextBridge.exposeInMainWorld("sessionCaptureApi", api);
