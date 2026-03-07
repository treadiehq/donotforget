import type { AppState, EventRow, SessionRow } from "../shared/types";

declare global {
  interface Window {
    sessionCaptureApi: {
      getState: () => Promise<AppState>;
      listSessions: () => Promise<SessionRow[]>;
      searchSessions: (query: string) => Promise<SessionRow[]>;
      createSession: () => Promise<number>;
      setActiveSession: (sessionId: number | null) => Promise<number | null>;
      deleteSession: (sessionId: number) => Promise<{ deleted: boolean; nextSessionId: number | null }>;
      renameSession: (sessionId: number, title: string) => Promise<boolean>;
      listEvents: (sessionId: number) => Promise<EventRow[]>;
      toggleRecording: (targetSessionId?: number | null) => Promise<AppState>;
      exportMarkdown: (sessionId: number) => Promise<void>;
      exportJson: (sessionId: number) => Promise<void>;
      copySession: (sessionId: number) => Promise<void>;
      createShare: (sessionId: number) => Promise<string>;
      revokeShare: (sessionId: number) => Promise<void>;
      saveDraft: (sessionId: number, content: string) => Promise<boolean>;
      getDraft: (sessionId: number) => Promise<string | null>;
      startHelper: () => Promise<{ ok: boolean; message: string }>;
      openAccessibilitySettings: () => Promise<void>;
      getSettings: () => Promise<Record<string, string>>;
      setSetting: (key: string, value: string) => Promise<void>;
      clearAllData: () => Promise<void>;
      getDailySummary: (dateStr: string) => Promise<{ date: string; content: string; isAi: number; createdAt: number } | null>;
      generateDailySummary: (dateStr: string) => Promise<{ date: string; content: string; isAi: number; createdAt: number } | null>;
      listDailySummaries: () => Promise<Array<{ date: string; content: string; isAi: number; createdAt: number }>>;
      aiChat: (message: string, sessionId: number | null) => Promise<string>;
      aiEnhance: (sessionId: number) => Promise<string>;
      getVersion: () => Promise<string>;
      checkForUpdates: () => Promise<{
        available: boolean;
        currentVersion?: string;
        latestVersion?: string;
        error?: string;
      }>;
      installUpdate: () => Promise<void>;
      onStateChanged: (listener: (state: AppState) => void) => () => void;
      onEventsUpdated: (listener: (sessionId: number) => void) => () => void;
      onUpdateAvailable: (listener: (info: { version: string }) => void) => () => void;
      onUpdateDownloaded: (listener: (info: { version: string }) => void) => () => void;
      onUpdateProgress: (listener: (info: { percent: number }) => void) => () => void;
    };
  }
}

export {};
