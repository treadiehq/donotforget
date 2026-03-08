import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, EventRow, SessionRow, RelatedCapture } from "../shared/types";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeftIcon,
  ClipboardDocumentIcon,
  DocumentTextIcon,
  EyeIcon,
  HomeIcon,
  PencilIcon,
  PlusIcon,
  EllipsisHorizontalIcon,
  PlayIcon,
  ShareIcon as ShareIconSolid,
  StopIcon,
  ShieldCheckIcon,
  MicrophoneIcon,
  XMarkIcon
} from "@heroicons/react/24/solid";
import { Cog6ToothIcon, MagnifyingGlassIcon, SparklesIcon, ChevronDownIcon, LightBulbIcon, QueueListIcon } from "@heroicons/react/24/outline";
import { MarkdownEditor } from "./MarkdownEditor";
import { SettingsModal } from "./SettingsModal";
import { SearchPalette } from "./SearchPalette";
import { FloatingChat } from "./FloatingChat";

function formatDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

function toDateStr(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function DailySummaryCard({ dateStr, enabled }: { dateStr: string; enabled: boolean }) {
  const [summary, setSummary] = useState<{ content: string; isAi: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    window.sessionCaptureApi.getDailySummary(dateStr).then((s) => {
      if (s) setSummary({ content: s.content, isAi: s.isAi });
    }).catch(() => {});
  }, [dateStr]);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const result = await window.sessionCaptureApi.generateDailySummary(dateStr);
      if (result) {
        setSummary({ content: result.content, isAi: result.isAi });
        setExpanded(true);
      }
    } catch {}
    setGenerating(false);
  }

  if (!summary && !enabled) return null;

  if (!summary) {
    return (
      <button className="daily-summary-generate" onClick={handleGenerate} disabled={generating}>
        <SparklesIcon className="daily-summary-icon" />
        <span>{generating ? "Generating recap..." : "Generate daily recap"}</span>
      </button>
    );
  }

  return (
    <div className="daily-summary-card">
      <button className="daily-summary-header" onClick={() => setExpanded(!expanded)}>
        <SparklesIcon className="daily-summary-icon" />
        <span className="daily-summary-label">Daily Recap</span>
        {summary.isAi ? <span className="daily-summary-badge">AI</span> : null}
        <ChevronDownIcon className={`daily-summary-chevron ${expanded ? "expanded" : ""}`} />
      </button>
      {expanded && (
        <div className="daily-summary-body">
          <Markdown remarkPlugins={[remarkGfm]}>{summary.content}</Markdown>
        </div>
      )}
    </div>
  );
}

function TranscriptModal({ events, sessionTitle, onClose }: { events: EventRow[]; sessionTitle: string; onClose: () => void }) {
  const voiceEvents = events.filter((e) => e.source === "voice");

  function handleOverlayClick(e: { target: EventTarget | null; currentTarget: EventTarget | null }) {
    if (e.target === e.currentTarget) onClose();
  }

  function copyAll() {
    const text = voiceEvents
      .map((e) => {
        const time = new Date(e.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return `[${time}] ${e.text.trim()}`;
      })
      .join("\n\n");
    navigator.clipboard.writeText(text);
  }

  return (
    <div className="transcript-overlay" onClick={handleOverlayClick}>
      <div className="transcript-modal">
        <div className="transcript-header">
          <div className="transcript-title-row">
            <QueueListIcon className="transcript-title-icon" />
            <span className="transcript-title">Transcript</span>
            <span className="transcript-session-name">{sessionTitle}</span>
          </div>
          <div className="transcript-header-actions">
            {voiceEvents.length > 0 && (
              <button className="transcript-copy-btn" onClick={copyAll} title="Copy full transcript">
                <ClipboardDocumentIcon style={{ width: 14, height: 14 }} />
                Copy all
              </button>
            )}
            <button className="transcript-close-btn" onClick={onClose} aria-label="Close">
              <XMarkIcon style={{ width: 16, height: 16 }} />
            </button>
          </div>
        </div>

        <div className="transcript-body">
          {voiceEvents.length === 0 ? (
            <div className="transcript-empty">
              <MicrophoneIcon style={{ width: 28, height: 28, opacity: 0.3 }} />
              <p>No voice captures in this session yet.</p>
              <p className="transcript-empty-hint">Use the mic button in the toolbar to record.</p>
            </div>
          ) : (
            voiceEvents.map((e) => {
              const time = new Date(e.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
              return (
                <div key={e.id} className="transcript-entry">
                  <div className="transcript-entry-meta">
                    <MicrophoneIcon style={{ width: 12, height: 12 }} />
                    <span className="transcript-entry-time">{time}</span>
                  </div>
                  <p className="transcript-entry-text">{e.text.trim()}</p>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function RelatedCapturesPanel({ captures, onNavigate }: { captures: RelatedCapture[]; onNavigate: (sessionId: number) => void }) {
  const [expanded, setExpanded] = useState(true);
  if (captures.length === 0) return null;
  return (
    <div className="related-captures-panel">
      <button className="related-captures-header" onClick={() => setExpanded((e) => !e)}>
        <LightBulbIcon className="related-captures-icon" />
        <span>Related from memory</span>
        <ChevronDownIcon className={`daily-summary-chevron ${expanded ? "expanded" : ""}`} />
      </button>
      {expanded && (
        <div className="related-captures-body">
          {captures.map((c) => (
            <button key={c.eventId} className="related-capture-row" onClick={() => onNavigate(c.sessionId)}>
              <span className="related-capture-session">{c.sessionTitle}</span>
              <span className="related-capture-text">{c.text.slice(0, 120)}{c.text.length > 120 ? "…" : ""}</span>
              <span className="related-capture-score">{Math.round(c.score * 100)}% match</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PrivacyOnboardingModal({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const QUICK_BLOCKS = [
    { label: "1Password", pattern: "1password", checked: true },
    { label: "Terminal", pattern: "terminal", checked: false },
    { label: "Keychain Access", pattern: "keychain", checked: true },
    { label: "Banking (Safari)", pattern: "safari", checked: false },
    { label: "iTerm2", pattern: "iterm", checked: false },
  ];
  const [checked, setChecked] = useState<Record<string, boolean>>(
    Object.fromEntries(QUICK_BLOCKS.map((b) => [b.pattern, b.checked]))
  );
  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    setSaving(true);
    for (const b of QUICK_BLOCKS) {
      if (checked[b.pattern]) {
        try {
          await window.sessionCaptureApi.addRule({ appPattern: b.pattern, action: "block", minWords: 0, extractCitations: false, note: `Privacy: ${b.label}` });
        } catch {}
      }
    }
    setSaving(false);
    onDone();
  }

  return (
    <div className="settings-overlay" style={{ zIndex: 9999 }}>
      <div className="settings-modal" style={{ maxWidth: 460, minHeight: "auto" }}>
        <div className="settings-content" style={{ padding: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <ShieldCheckIcon style={{ width: 24, height: 24, color: "var(--accent)" }} />
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Privacy First</h2>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20, lineHeight: 1.5 }}>
            Do Not Forget captures text from every app while recording. Choose which apps should <strong>never</strong> be captured.
            You can always change this in Settings → Capture Rules.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
            {QUICK_BLOCKS.map((b) => (
              <label key={b.pattern} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!!checked[b.pattern]}
                  onChange={(e) => setChecked((prev) => ({ ...prev, [b.pattern]: e.target.checked }))}
                  style={{ width: 16, height: 16, cursor: "pointer" }}
                />
                <span>Block <strong>{b.label}</strong></span>
              </label>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button className="about-update-btn about-update-available" style={{ flex: 1 }} onClick={handleConfirm} disabled={saving}>
              {saving ? "Saving…" : "Apply & Continue"}
            </button>
            <button className="about-update-btn" onClick={onSkip}>Skip for now</button>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-tertiary, #999)", marginTop: 12, textAlign: "center" }}>
            All data stays local on your Mac. Nothing is sent to any server.
          </p>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<AppState>({ recording: false, currentSessionId: null, wsClients: 0 });
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [shareUrl, setShareUrl] = useState<string>("");
  const [showMore, setShowMore] = useState<boolean>(false);
  const [view, setView] = useState<"list" | "detail">("list");
  const [editorMode, setEditorMode] = useState<"preview" | "edit">("preview");
  const [toast, setToast] = useState<string | null>(null);
  const [localTitle, setLocalTitle] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [userHandle, setUserHandle] = useState("");
  const [userName, setUserName] = useState("");
  const [aiEnabled, setAiEnabled] = useState(false);
  const [dailyRecapEnabled, setDailyRecapEnabled] = useState(true);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [draftVersion, setDraftVersion] = useState(0);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; ready: boolean } | null>(null);
  const [relatedCaptures, setRelatedCaptures] = useState<RelatedCapture[]>([]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceTranscribing, setVoiceTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const titleFocused = useRef(false);
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const moreRef = useRef<HTMLDivElement>(null);
  const wasRecordingRef = useRef(false);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // --- Click-outside to close dropdown ---
  useEffect(() => {
    if (!showMore) return;
    function handleClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setShowMore(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMore]);

  // --- Global keyboard shortcuts ---
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "k") {
        e.preventDefault();
        setShowSearch((s) => !s);
        return;
      }
      if (meta && e.key === "e" && view === "detail") {
        e.preventDefault();
        setEditorMode((m) => (m === "preview" ? "edit" : "preview"));
      }
      if (e.key === "Escape" && view === "detail" && editorMode === "edit") {
        e.preventDefault();
        setEditorMode("preview");
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [view, editorMode]);

  async function refreshSessions() {
    const rows = await window.sessionCaptureApi.listSessions();
    setSessions(rows);
  }

  async function refreshEvents(sessionId: number | null) {
    if (!sessionId) {
      setEvents([]);
      return;
    }
    const rows = await window.sessionCaptureApi.listEvents(sessionId);
    setEvents(rows);
  }

  useEffect(() => {
    window.sessionCaptureApi.getState().then(setState);
    window.sessionCaptureApi.getSettings().then((s) => {
      setUserHandle(s.handle || "");
      setUserName(s.name || "");
      setAiEnabled(s.aiEnabled === "true");
      setDailyRecapEnabled(s.dailyRecapEnabled !== "false");
      // Show onboarding on first launch (no name set yet)
      if (!s.privacyOnboardingDone && !s.name) {
        setShowOnboarding(true);
      }
    }).catch(() => {});
    refreshSessions();

    const offRelated = window.sessionCaptureApi.onRelatedCaptures((captures) => {
      setRelatedCaptures(captures);
      // Auto-dismiss related captures after 30s
      setTimeout(() => setRelatedCaptures([]), 30000);
    });

    const offAvailable = window.sessionCaptureApi.onUpdateAvailable((info) => {
      setUpdateAvailable({ version: info.version, ready: false });
    });
    const offDownloaded = window.sessionCaptureApi.onUpdateDownloaded((info) => {
      setUpdateAvailable({ version: info.version, ready: true });
    });
    const offState = window.sessionCaptureApi.onStateChanged(async (nextState) => {
      const justStartedRecording = nextState.recording && !wasRecordingRef.current;
      wasRecordingRef.current = nextState.recording;
      setState(nextState);
      await refreshSessions();
      if (justStartedRecording && nextState.currentSessionId) {
        setSelectedSessionId(nextState.currentSessionId);
      }
    });
    const offEvents = window.sessionCaptureApi.onEventsUpdated(async (sessionId) => {
      if (selectedSessionId === sessionId) {
        await refreshEvents(sessionId);
      }
      await refreshSessions();
    });

    return () => {
      offAvailable();
      offDownloaded();
      offState();
      offEvents();
      offRelated();
    };
  }, [selectedSessionId]);

  useEffect(() => {
    refreshEvents(selectedSessionId);
    const selected = sessions.find((s) => s.id === selectedSessionId);
    if (selected?.shareUrl) {
      setShareUrl(selected.shareUrl);
    } else {
      setShareUrl("");
    }
  }, [selectedSessionId, sessions]);

  const sessionsByDay = useMemo(() => {
    const groups: Array<{ day: string; rows: SessionRow[] }> = [];
    for (const session of sessions) {
      const day = formatDay(session.createdAt);
      const previous = groups.at(-1);
      if (!previous || previous.day !== day) {
        groups.push({ day, rows: [session] });
      } else {
        previous.rows.push(session);
      }
    }
    return groups;
  }, [sessions]);

  async function onToggleRecording() {
    const targetSessionId = selectedSessionId ?? selectedSession?.id ?? state.currentSessionId ?? undefined;
    await window.sessionCaptureApi.toggleRecording(targetSessionId);
  }

  async function onCreateSession() {
    const newId = await window.sessionCaptureApi.createSession();
    await refreshSessions();
    setSelectedSessionId(newId);
    await refreshEvents(newId);
    setView("detail");
  }

  async function onCopySession() {
    if (!selectedSessionId) return;
    await window.sessionCaptureApi.copySession(selectedSessionId);
    showToast("Copied to clipboard");
  }

  async function onCreateShare() {
    if (!selectedSessionId) return;
    const url = await window.sessionCaptureApi.createShare(selectedSessionId);
    setShareUrl(url);
    await refreshSessions();
    showToast("Share link created");
  }

  async function onRevokeShare() {
    if (!selectedSessionId) return;
    await window.sessionCaptureApi.revokeShare(selectedSessionId);
    setShareUrl("");
    await refreshSessions();
    setShowMore(false);
    showToast("Share link revoked");
  }

  async function onExportMarkdown() {
    if (!selectedSessionId) return;
    await window.sessionCaptureApi.exportMarkdown(selectedSessionId);
    setShowMore(false);
    showToast("Exported Markdown");
  }

  async function onExportJson() {
    if (!selectedSessionId) return;
    await window.sessionCaptureApi.exportJson(selectedSessionId);
    setShowMore(false);
    showToast("Exported JSON");
  }

  async function onDeleteSession() {
    if (!selectedSessionId) return;
    const ok = window.confirm("Delete this session and all captured events?");
    if (!ok) return;
    const result = await window.sessionCaptureApi.deleteSession(selectedSessionId);
    if (!result.deleted) return;
    setShowMore(false);
    setSelectedSessionId(result.nextSessionId);
    await refreshSessions();
    await refreshEvents(result.nextSessionId);
    showToast("Session deleted");
  }

  async function onStartHelper() {
    await window.sessionCaptureApi.startHelper();
    setShowMore(false);
  }

  async function onToggleVoice() {
    if (voiceRecording) {
      // Stop recording — mediaRecorder's onstop will handle the rest
      mediaRecorderRef.current?.stop();
      return;
    }
    if (!selectedSessionId) return;
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/ogg";
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setVoiceRecording(false);
        setVoiceTranscribing(true);

        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          const cleanMime = mimeType.split(";")[0];

          const result = await window.sessionCaptureApi.voiceTranscribe(
            selectedSessionId!, base64, cleanMime
          );

          setVoiceTranscribing(false);
          if (!result.ok) {
            setVoiceError(result.error ?? "Transcription failed.");
            setTimeout(() => setVoiceError(null), 4000);
          } else {
            await refreshEvents(selectedSessionId!);
            showToast("Voice captured");
          }
        };
        reader.readAsDataURL(blob);
      };

      recorder.start();
      setVoiceRecording(true);
    } catch (err: any) {
      setVoiceError(err.message?.includes("Permission") ? "Microphone access denied." : "Could not access microphone.");
      setTimeout(() => setVoiceError(null), 4000);
    }
  }

  const helperConnected = state.wsClients > 0;
  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;

  // Sync local title from DB, but not while user is actively editing
  useEffect(() => {
    if (!titleFocused.current && selectedSession) {
      setLocalTitle(selectedSession.title);
    }
  }, [selectedSession?.id, selectedSession?.title]);

  return (
    <div className="app-shell">
      <div className="shell-card">
        <aside className="left-rail">
          <div className="rail-logo mb-2">
            <svg width="18" height="18" viewBox="0 0 296 296" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Do Not Forget" role="img">
              <path d="M148 296C82.3198 296 26.6344 253.215 7.28906 193.996H134C141.732 193.996 148 187.728 148 179.996C148 172.264 141.732 165.996 134 165.996L1.08594 165.996C0.370867 160.097 0 154.092 0 148C0 141.906 0.371222 135.897 1.08691 129.996L134 129.996C141.732 129.996 148 123.728 148 115.996C148 108.264 141.732 101.996 134 101.996L7.29102 101.996C26.6386 42.781 82.3226 0 148 0C229.738 0 296 66.2619 296 148C296 229.738 229.738 296 148 296Z" fill="currentColor"/>
            </svg>
          </div>
          <button className="rail-btn active" data-tooltip="Home" onClick={() => setView("list")}>
            <HomeIcon className="rail-icon" />
          </button>
          <button className="rail-btn" data-tooltip="Search (⌘K)" onClick={() => setShowSearch(true)}>
            <MagnifyingGlassIcon className="rail-icon" />
          </button>
          <button className="rail-btn" data-tooltip="New Session" onClick={onCreateSession}>
            <PlusIcon className="rail-icon" />
          </button>
          <div className="rail-spacer" />
          <button className="rail-btn" data-tooltip="Settings" onClick={() => setShowSettings(true)}>
            <Cog6ToothIcon className="rail-icon" />
          </button>
        </aside>

        <main className="workspace">
          <div className={`view-container ${view === "detail" ? "show-detail" : "show-list"}`}>
            <section className="list-view">
              {updateAvailable && (
                <div className="update-banner">
                  <span>A new version v{updateAvailable.version} is available</span>
                  {updateAvailable.ready ? (
                    <button onClick={() => window.sessionCaptureApi.installUpdate()}>
                      Restart to install
                    </button>
                  ) : (
                    <button disabled>Downloading…</button>
                  )}
                  <button className="update-banner-dismiss" onClick={() => setUpdateAvailable(null)} aria-label="Dismiss">
                    &times;
                  </button>
                </div>
              )}

              {sessions.length > 0 && (
                <header className="list-header">
                  <div>
                    <h1 className="flex items-center">
                      <span className="">Welcome{userName ? `, ${userName}` : "!"}</span>
                    </h1>
                    <p>Capture selected, focused or copied text across apps into recording sessions.</p>
                  </div>
                  <div className="list-header-actions">
                    <button className="new-session-btn" onClick={onCreateSession}>
                      New
                    </button>
                  </div>
                </header>
              )}

              {sessions.length === 0 ? (
                <div className="empty-state">
                  <div className="flex items-center justify-center mb-4"> 
                    {/* <DocumentTextIcon /> */}
                    <svg width="35" height="35" viewBox="0 0 296 296" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Do Not Forget" role="img">
                      <path d="M148 296C82.3198 296 26.6344 253.215 7.28906 193.996H134C141.732 193.996 148 187.728 148 179.996C148 172.264 141.732 165.996 134 165.996L1.08594 165.996C0.370867 160.097 0 154.092 0 148C0 141.906 0.371222 135.897 1.08691 129.996L134 129.996C141.732 129.996 148 123.728 148 115.996C148 108.264 141.732 101.996 134 101.996L7.29102 101.996C26.6386 42.781 82.3226 0 148 0C229.738 0 296 66.2619 296 148C296 229.738 229.738 296 148 296Z" fill="currentColor"/>
                    </svg>
                  </div>
                  <h2 className="empty-state-title">Welcome{userName ? `, ${userName}` : ""}!</h2>
                  <p className="empty-state-desc">
                   Capture selected, focused or copied text across apps into recording sessions.
                  </p>
                  <button className="empty-state-btn" onClick={onCreateSession}>
                    <PlusIcon className="empty-state-btn-icon" />
                    Create your first session
                  </button>
                  <div className="empty-state-hints">
                    <div className="empty-state-hint">
                      <span className="empty-state-hint-num">1</span>
                      <span>Create a session</span>
                    </div>
                    <div className="empty-state-hint">
                      <span className="empty-state-hint-num">2</span>
                      <span>Hit record and switch to any app</span>
                    </div>
                    <div className="empty-state-hint">
                      <span className="empty-state-hint-num">3</span>
                      <span>Select, copy or focus text, it's captured automatically</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="session-feed">
                  {sessionsByDay.map((group) => (
                    <div key={group.day} className="day-group">
                      <h3 className="day-label">{group.day}</h3>
                      <DailySummaryCard dateStr={toDateStr(group.rows[0].createdAt)} enabled={dailyRecapEnabled} />
                      {group.rows.map((session) => (
                        <button
                          key={session.id}
                          className={session.id === selectedSessionId ? "session-row active" : "session-row"}
                          onClick={() => {
                            setSelectedSessionId(session.id);
                            setView("detail");
                          }}
                        >
                          <span className="session-row-icon-box" aria-hidden>
                            <DocumentTextIcon className="session-row-icon" />
                          </span>
                          <span className="session-row-main">
                            <span className="session-row-title">{session.title}</span>
                            {session.preview ? (
                              <span className="session-row-meta">{session.preview}</span>
                            ) : null}
                          </span>
                          <span className="session-row-right">
                            <span className="session-row-time">{new Date(session.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {aiEnabled && (
                <FloatingChat key={`list-${settingsVersion}`} sessionId={null} context="list" />
              )}
            </section>

            <section className="detail-view">
              <header className="detail-header">
                <button className="ghost-btn" onClick={() => { setView("list"); setSelectedSessionId(null); }} data-tooltip="Back to sessions" data-tooltip-pos="bottom-left">
                  <ArrowLeftIcon className="icon" />
                </button>
                <input
                  className="detail-title-input"
                  value={localTitle}
                  onFocus={() => { titleFocused.current = true; }}
                  onChange={(e) => {
                    if (!selectedSessionId) return;
                    setLocalTitle(e.target.value);
                    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
                    const id = selectedSessionId;
                    const val = e.target.value;
                    titleSaveTimer.current = setTimeout(() => {
                      const title = val.trim() || "Untitled";
                      window.sessionCaptureApi.renameSession(id, title);
                    }, 600);
                  }}
                  onBlur={(e) => {
                    titleFocused.current = false;
                    if (!selectedSessionId) return;
                    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
                    const title = e.target.value.trim() || "Untitled";
                    setLocalTitle(title);
                    window.sessionCaptureApi.renameSession(selectedSessionId, title);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  spellCheck={false}
                />
                <div className="top-actions">
                  <button
                    className={editorMode === "preview" ? "action-btn active" : "action-btn"}
                    onClick={() => setEditorMode("preview")}
                    aria-label="Preview"
                    data-tooltip="Preview (⌘E)" data-tooltip-pos="bottom"
                  >
                    <EyeIcon className="icon" />
                  </button>
                  <button
                    className={editorMode === "edit" ? "action-btn active" : "action-btn"}
                    onClick={() => setEditorMode("edit")}
                    aria-label="Edit"
                    data-tooltip="Edit (⌘E)" data-tooltip-pos="bottom"
                  >
                    <PencilIcon className="icon" />
                  </button>
                  <div className="action-divider" />
                  <button
                    className={state.recording ? "action-btn recording-btn" : "action-btn"}
                    onClick={onToggleRecording}
                    aria-label={state.recording ? "Stop recording" : "Start recording"}
                    data-tooltip={state.recording ? "Stop recording" : "Start recording"} data-tooltip-pos="bottom"
                  >
                    {state.recording ? <StopIcon className="icon" /> : <PlayIcon className="icon" />}
                  </button>
                  <button
                    className={voiceRecording ? "action-btn voice-recording-btn" : voiceTranscribing ? "action-btn voice-transcribing-btn" : "action-btn"}
                    onClick={onToggleVoice}
                    disabled={!selectedSessionId || voiceTranscribing}
                    aria-label={voiceRecording ? "Stop voice recording" : "Record voice"}
                    data-tooltip={voiceRecording ? "Stop & transcribe" : voiceTranscribing ? "Transcribing…" : "Voice capture"} data-tooltip-pos="bottom"
                  >
                    <MicrophoneIcon className="icon" />
                  </button>
                  {events.some((e) => e.source === "voice") && (
                    <button
                      className="action-btn"
                      onClick={() => setShowTranscript(true)}
                      aria-label="View transcript"
                      data-tooltip="View transcript" data-tooltip-pos="bottom"
                    >
                      <QueueListIcon className="icon" />
                    </button>
                  )}
                  <button
                    className="action-btn"
                    disabled={!selectedSessionId}
                    onClick={onCreateShare}
                    aria-label="Share local link"
                    data-tooltip="Share local link" data-tooltip-pos="bottom"
                  >
                    <ShareIconSolid className="icon" />
                  </button>
                  <div className="more-wrap" ref={moreRef}>
                    <button
                      className="action-btn"
                      onClick={() => setShowMore((s) => !s)}
                      aria-label="More actions"
                      data-tooltip="More actions" data-tooltip-pos="bottom"
                    >
                      <EllipsisHorizontalIcon className="icon" />
                    </button>
                    {showMore ? (
                      <div className="more-menu">
                        <button className="menu-btn" disabled={!selectedSessionId} onClick={onCopySession}>
                          Copy Markdown
                        </button>
                        <button className="menu-btn" disabled={!selectedSessionId} onClick={onExportMarkdown}>
                          Export Markdown
                        </button>
                        <button className="menu-btn" disabled={!selectedSessionId} onClick={onExportJson}>
                          Export JSON
                        </button>
                        {!helperConnected ? (
                          <>
                            <button className="menu-btn" onClick={onStartHelper}>
                              Start Helper
                            </button>
                            <button className="menu-btn" onClick={() => { window.sessionCaptureApi.openAccessibilitySettings(); setShowMore(false); }}>
                              Enable Accessibility
                            </button>
                          </>
                        ) : null}
                        {selectedSessionId && shareUrl ? (
                          <button className="menu-btn" onClick={onRevokeShare}>
                            Revoke Share
                          </button>
                        ) : null}
                        {selectedSessionId ? (
                          <button className="menu-btn danger" onClick={onDeleteSession}>
                            Delete Session
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </header>

              {voiceError && (
                <div className="voice-error-banner">
                  <MicrophoneIcon style={{ width: 13, height: 13, flexShrink: 0 }} />
                  {voiceError}
                </div>
              )}

              {shareUrl ? (
                <div className="share-box">
                  <a
                    href={shareUrl}
                    className="share-link"
                    onClick={(e) => {
                      e.preventDefault();
                      window.open(shareUrl, "_blank");
                    }}
                  >
                    {shareUrl}
                  </a>
                  <button
                    className="share-copy-btn"
                    onClick={() => {
                      navigator.clipboard.writeText(shareUrl);
                      showToast("Link copied");
                    }}
                    data-tooltip="Copy link" data-tooltip-pos="bottom"
                  >
                    <ClipboardDocumentIcon className="icon" />
                  </button>
                </div>
              ) : null}

              <MarkdownEditor
                events={events}
                sessionTitle={selectedSession?.title ?? "Session"}
                mode={editorMode}
                recording={state.recording}
                sessionId={selectedSessionId}
                onStartRecording={onToggleRecording}
                draftVersion={draftVersion}
              />
              {relatedCaptures.length > 0 && (
                <RelatedCapturesPanel
                  captures={relatedCaptures}
                  onNavigate={(sid) => {
                    setSelectedSessionId(sid);
                    setRelatedCaptures([]);
                  }}
                />
              )}
              {aiEnabled && (
                <FloatingChat
                  key={`${selectedSessionId}-${settingsVersion}`}
                  sessionId={selectedSessionId}
                  context="detail"
                  onDraftApplied={() => setDraftVersion((v) => v + 1)}
                />
              )}
            </section>
          </div>
        </main>
      </div>

      {toast ? (
        <div className="toast" key={toast}>
          {toast}
        </div>
      ) : null}

      {showSearch && (
        <SearchPalette
          onClose={() => setShowSearch(false)}
          onSelect={(sessionId) => {
            setSelectedSessionId(sessionId);
            setView("detail");
          }}
        />
      )}

      {showTranscript && (
        <TranscriptModal
          events={events}
          sessionTitle={selectedSession?.title ?? "Session"}
          onClose={() => setShowTranscript(false)}
        />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => {
            setShowSettings(false);
            setSettingsVersion((v) => v + 1);
            window.sessionCaptureApi.getSettings().then((s) => {
              setUserHandle(s.handle || "");
              setUserName(s.name || "");
              setAiEnabled(s.aiEnabled === "true");
              setDailyRecapEnabled(s.dailyRecapEnabled !== "false");
            }).catch(() => {});
          }}
          onAiEnabledChange={setAiEnabled}
          onDataCleared={async () => {
            setShowSettings(false);
            setSelectedSessionId(null);
            setEvents([]);
            setView("list");
            await refreshSessions();
          }}
        />
      )}

      {showOnboarding && (
        <PrivacyOnboardingModal
          onDone={() => {
            setShowOnboarding(false);
            window.sessionCaptureApi.setSetting("privacyOnboardingDone", "true").catch(() => {});
          }}
          onSkip={() => {
            setShowOnboarding(false);
            window.sessionCaptureApi.setSetting("privacyOnboardingDone", "true").catch(() => {});
          }}
        />
      )}
    </div>
  );
}
