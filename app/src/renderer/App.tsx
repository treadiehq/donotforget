import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, EventRow, SessionRow } from "../shared/types";
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
  StopIcon
} from "@heroicons/react/24/solid";
import { Cog6ToothIcon, MagnifyingGlassIcon, SparklesIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
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
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; url: string } | null>(null);
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
    }).catch(() => {});
    refreshSessions();

    window.sessionCaptureApi.checkForUpdates().then((result) => {
      if (result.available && result.latestVersion) {
        setUpdateAvailable({
          version: result.latestVersion,
          url: result.downloadUrl || result.releaseUrl || "https://github.com/treadiehq/donotforget/releases"
        });
      }
    }).catch(() => {});

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
      offState();
      offEvents();
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
                  <span>v{updateAvailable.version} is available</span>
                  <button onClick={() => { window.open(updateAvailable.url, "_blank"); }}>
                    Download
                  </button>
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
    </div>
  );
}
