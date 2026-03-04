import { contextBridge, ipcRenderer } from "electron";
import type { AppState } from "../shared/types";

const api = {
  getState: () => ipcRenderer.invoke("state:get") as Promise<AppState>,
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  searchSessions: (query: string) => ipcRenderer.invoke("sessions:search", query),
  createSession: () => ipcRenderer.invoke("session:create") as Promise<number>,
  setActiveSession: async (sessionId: number | null) => {
    try {
      return (await ipcRenderer.invoke("session:set-active", sessionId)) as number | null;
    } catch {
      return null;
    }
  },
  deleteSession: (sessionId: number) =>
    ipcRenderer.invoke("session:delete", sessionId) as Promise<{ deleted: boolean; nextSessionId: number | null }>,
  renameSession: (sessionId: number, title: string) =>
    ipcRenderer.invoke("session:rename", sessionId, title) as Promise<boolean>,
  listEvents: (sessionId: number) => ipcRenderer.invoke("events:list", sessionId),
  toggleRecording: (targetSessionId?: number | null) => ipcRenderer.invoke("recording:toggle", targetSessionId),
  exportMarkdown: (sessionId: number) => ipcRenderer.invoke("export:markdown", sessionId),
  exportJson: (sessionId: number) => ipcRenderer.invoke("export:json", sessionId),
  copySession: (sessionId: number) => ipcRenderer.invoke("session:copy", sessionId),
  createShare: (sessionId: number) => ipcRenderer.invoke("share:create", sessionId) as Promise<string>,
  revokeShare: (sessionId: number) => ipcRenderer.invoke("share:revoke", sessionId),
  saveDraft: (sessionId: number, content: string) =>
    ipcRenderer.invoke("session:save-draft", sessionId, content) as Promise<boolean>,
  getDraft: (sessionId: number) =>
    ipcRenderer.invoke("session:get-draft", sessionId) as Promise<string | null>,
  startHelper: () => ipcRenderer.invoke("helper:start") as Promise<{ ok: boolean; message: string }>,
  openAccessibilitySettings: () => ipcRenderer.invoke("accessibility:open-settings"),
  getSettings: () => ipcRenderer.invoke("settings:get-all") as Promise<Record<string, string>>,
  setSetting: (key: string, value: string) => ipcRenderer.invoke("settings:set", key, value) as Promise<void>,
  aiChat: (message: string, sessionId: number | null) =>
    ipcRenderer.invoke("ai:chat", message, sessionId) as Promise<string>,
  aiEnhance: (sessionId: number) =>
    ipcRenderer.invoke("ai:enhance", sessionId) as Promise<string>,
  clearAllData: () => ipcRenderer.invoke("data:clear-all") as Promise<void>,
  getVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>,
  checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates") as Promise<{
    available: boolean;
    currentVersion?: string;
    latestVersion?: string;
    releaseUrl?: string;
    downloadUrl?: string;
    releaseNotes?: string;
    error?: string;
  }>,
  onStateChanged: (listener: (state: AppState) => void) => {
    const wrapped = (_event: unknown, state: AppState) => listener(state);
    ipcRenderer.on("state-changed", wrapped);
    return () => ipcRenderer.off("state-changed", wrapped);
  },
  onEventsUpdated: (listener: (sessionId: number) => void) => {
    const wrapped = (_event: unknown, sessionId: number) => listener(sessionId);
    ipcRenderer.on("events-updated", wrapped);
    return () => ipcRenderer.off("events-updated", wrapped);
  }
};

contextBridge.exposeInMainWorld("sessionCaptureApi", api);
