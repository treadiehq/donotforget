import type { AppState, EventRow, SessionRow, CaptureRule, AppTag, WebhookConfig, MediaAttachment, RelatedCapture } from "../shared/types";

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
      aiDescribeImage: (mimeType: string, dataB64: string) => Promise<string | null>;
      aiRelatedCaptures: (sessionId: number, text: string) => Promise<RelatedCapture[]>;
      voiceTranscribe: (sessionId: number, audioBase64: string, mimeType: string) => Promise<{ ok: boolean; transcript?: string; error?: string }>;
      getVersion: () => Promise<string>;
      checkForUpdates: () => Promise<{
        available: boolean;
        currentVersion?: string;
        latestVersion?: string;
        error?: string;
      }>;
      installUpdate: () => Promise<void>;
      // Capture rules
      listRules: () => Promise<CaptureRule[]>;
      addRule: (rule: Omit<CaptureRule, "id" | "createdAt">) => Promise<number>;
      updateRule: (id: number, rule: Partial<CaptureRule>) => Promise<boolean>;
      deleteRule: (id: number) => Promise<boolean>;
      // App tags
      listAppTags: () => Promise<AppTag[]>;
      setAppTag: (appName: string, tag: string) => Promise<boolean>;
      deleteAppTag: (appName: string) => Promise<boolean>;
      // Webhooks
      listWebhooks: () => Promise<WebhookConfig[]>;
      addWebhook: (hook: Omit<WebhookConfig, "id" | "createdAt">) => Promise<number>;
      updateWebhook: (id: number, hook: Partial<WebhookConfig>) => Promise<boolean>;
      deleteWebhook: (id: number) => Promise<boolean>;
      testWebhook: (id: number) => Promise<{ ok: boolean; status?: number; error?: string }>;
      // Media
      addMedia: (sessionId: number, filename: string, mimeType: string, dataB64: string, caption?: string) => Promise<{ id: number; aiDescription: string | null }>;
      listMedia: (sessionId: number) => Promise<MediaAttachment[]>;
      deleteMedia: (id: number) => Promise<boolean>;
      // Push events
      onStateChanged: (listener: (state: AppState) => void) => () => void;
      onEventsUpdated: (listener: (sessionId: number) => void) => () => void;
      onUpdateAvailable: (listener: (info: { version: string }) => void) => () => void;
      onUpdateDownloaded: (listener: (info: { version: string }) => void) => () => void;
      onUpdateProgress: (listener: (info: { percent: number }) => void) => () => void;
      onRelatedCaptures: (listener: (captures: RelatedCapture[]) => void) => () => void;
    };
  }
}

export {};
