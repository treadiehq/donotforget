import { contextBridge, ipcRenderer } from "electron";
import type { AppState } from "../shared/types";
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
  }
};

contextBridge.exposeInMainWorld("sessionCaptureApi", api);
