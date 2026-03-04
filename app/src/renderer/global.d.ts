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
      aiChat: (message: string, sessionId: number | null) => Promise<string>;
      aiEnhance: (sessionId: number) => Promise<string>;
      getVersion: () => Promise<string>;
      checkForUpdates: () => Promise<{
        available: boolean;
        currentVersion?: string;
        latestVersion?: string;
        releaseUrl?: string;
        downloadUrl?: string;
        releaseNotes?: string;
        error?: string;
      }>;
      onStateChanged: (listener: (state: AppState) => void) => () => void;
      onEventsUpdated: (listener: (sessionId: number) => void) => () => void;
    };
  }
}

export {};
