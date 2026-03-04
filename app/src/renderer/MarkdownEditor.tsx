import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DocumentTextIcon, PlayIcon } from "@heroicons/react/24/solid";
import type { EventRow } from "../shared/types";

function eventsToMarkdown(events: EventRow[]): string {
  if (events.length === 0) return "";

  const lines: string[] = [];
  let lastApp = "";
  let lastWindow = "";

  for (const event of events) {
    const appWindow = `${event.app}${event.window ? ` - ${event.window}` : ""}`;
    if (appWindow !== `${lastApp}${lastWindow ? ` - ${lastWindow}` : ""}`) {
      if (lines.length > 0) lines.push("");
      const time = new Date(event.ts).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      lines.push(`### ${appWindow}`);
      lines.push(`> ${event.source} - ${time}`);
      lines.push("");
      lastApp = event.app;
      lastWindow = event.window ?? "";
    } else {
      if (lines.length > 0) lines.push("");
    }

    lines.push(event.text.trim());
  }

  return lines.join("\n");
}

interface MarkdownEditorProps {
  events: EventRow[];
  sessionTitle: string;
  mode: "preview" | "edit";
  recording: boolean;
  sessionId: number | null;
  onStartRecording: () => void;
}

export function MarkdownEditor({ events, sessionTitle, mode, recording, sessionId, onStartRecording }: MarkdownEditorProps) {
  const [content, setContent] = useState("");
  const [lastEventCount, setLastEventCount] = useState(0);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const contentRef = useRef(content);
  const sessionIdRef = useRef(sessionId);
  contentRef.current = content;
  sessionIdRef.current = sessionId;

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    if (sessionIdRef.current) {
      window.sessionCaptureApi.saveDraft(sessionIdRef.current, contentRef.current).catch(() => {});
    }
  }, []);

  // Load draft on session change
  useEffect(() => {
    if (!sessionId) return;
    setDraftLoaded(false);
    window.sessionCaptureApi.getDraft(sessionId).then((draft) => {
      if (draft !== null) {
        setContent(draft);
      } else {
        setContent(eventsToMarkdown(events));
      }
      setLastEventCount(events.length);
      setDraftLoaded(true);
    }).catch(() => {
      setContent(eventsToMarkdown(events));
      setLastEventCount(events.length);
      setDraftLoaded(true);
    });
  }, [sessionId]);

  // Append new events to content
  useEffect(() => {
    if (!draftLoaded) return;
    if (events.length > lastEventCount && lastEventCount > 0) {
      const newEvents = events.slice(lastEventCount);
      const newMd = eventsToMarkdown(newEvents);
      if (newMd) {
        setContent((prev) => (prev ? prev + "\n\n" + newMd : newMd));
      }
    } else if (lastEventCount === 0 && events.length > 0 && !content) {
      setContent(eventsToMarkdown(events));
    }
    setLastEventCount(events.length);
  }, [events, draftLoaded]);

  // Auto-scroll preview when recording and new content arrives
  useEffect(() => {
    if (recording && mode === "preview" && previewRef.current) {
      requestAnimationFrame(() => {
        previewRef.current?.scrollTo({ top: previewRef.current.scrollHeight, behavior: "smooth" });
      });
    }
  }, [content, recording, mode]);

  // Flush save on mode switch (edit → preview)
  useEffect(() => {
    if (mode === "preview" && draftLoaded) {
      flushSave();
    }
  }, [mode, draftLoaded, flushSave]);

  // Flush save on unmount
  useEffect(() => {
    return () => { flushSave(); };
  }, [flushSave]);

  // Debounced draft save
  useEffect(() => {
    if (!sessionId || !draftLoaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      window.sessionCaptureApi.saveDraft(sessionId, content).catch(() => {});
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [content, sessionId, draftLoaded]);

  useEffect(() => {
    if (mode === "edit" && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [mode]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setContent(e.target.value);
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const val = ta.value;
        setContent(val.substring(0, start) + "  " + val.substring(end));
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        });
      }
    },
    []
  );

  const stats = useMemo(() => {
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const chars = content.length;
    return { words, chars };
  }, [content]);

  if (events.length === 0 && !content) {
    return (
      <div className="md-editor">
        <div className="md-empty">
          <div className="md-empty-icon">
            <DocumentTextIcon />
          </div>
          <p>No captured text yet</p>
          <p className="md-empty-hint">
            Select text in any app while recording to capture it here.
          </p>
          {!recording ? (
            <button className="md-empty-cta" onClick={onStartRecording}>
              <PlayIcon className="md-empty-cta-icon" />
              Start Recording
            </button>
          ) : (
            <p className="md-empty-hint">Listening for selections...</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="md-editor">
      {mode === "preview" ? (
        <div className="md-preview prose" ref={previewRef}>
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          className="md-textarea"
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
      )}
      <div className="md-footer">
        <span>{stats.words} words</span>
        <span>{stats.chars} chars</span>
        <span>{events.length} captures</span>
      </div>
    </div>
  );
}
