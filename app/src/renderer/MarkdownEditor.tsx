import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DocumentTextIcon, PlayIcon, PhotoIcon } from "@heroicons/react/24/solid";
import type { EventRow, MediaAttachment } from "../shared/types";

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
      const sourceLabel = event.source === "voice" ? "🎙 voice" : event.source;
      lines.push(`### ${appWindow}`);
      lines.push(`> ${sourceLabel} - ${time}`);
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
  draftVersion?: number;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function insertAtCursor(ta: HTMLTextAreaElement, text: string): string {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  return ta.value.substring(0, start) + text + ta.value.substring(end);
}

export function MarkdownEditor({ events, sessionTitle, mode, recording, sessionId, onStartRecording, draftVersion = 0 }: MarkdownEditorProps) {
  const [content, setContent] = useState("");
  const [lastEventCount, setLastEventCount] = useState(0);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [mediaAttachments, setMediaAttachments] = useState<MediaAttachment[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
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

  // Load media attachments when session changes
  useEffect(() => {
    if (!sessionId) { setMediaAttachments([]); return; }
    window.sessionCaptureApi.listMedia(sessionId).then(setMediaAttachments).catch(() => {});
  }, [sessionId]);

  const handleImageFile = useCallback(async (file: File) => {
    if (!sessionIdRef.current) return;
    if (!file.type.startsWith("image/")) return;
    setUploadingImage(true);
    try {
      const b64 = await fileToBase64(file);
      const result = await window.sessionCaptureApi.addMedia(sessionIdRef.current, file.name, file.type, b64);
      const dataUri = `data:${file.type};base64,${b64}`;
      const altText = result.aiDescription ? result.aiDescription.slice(0, 80) : file.name;
      const mdImage = `\n\n![${altText}](${dataUri})\n`;

      setContent((prev) => {
        if (textareaRef.current) {
          const updated = insertAtCursor(textareaRef.current, mdImage);
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              const pos = textareaRef.current.selectionStart + mdImage.length;
              textareaRef.current.selectionStart = textareaRef.current.selectionEnd = pos;
            }
          });
          return updated;
        }
        return prev + mdImage;
      });

      setMediaAttachments((prev) => [...prev, { id: result.id, filename: file.name, mimeType: file.type, dataB64: b64, caption: null, aiDescription: result.aiDescription, createdAt: Date.now() }]);
    } catch {}
    setUploadingImage(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) await handleImageFile(file);
  }, [handleImageFile]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      await handleImageFile(file);
    }
  }, [handleImageFile]);

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

  // Reload draft when externally applied (e.g. from Enhance)
  useEffect(() => {
    if (!sessionId || draftVersion === 0) return;
    window.sessionCaptureApi.getDraft(sessionId).then((draft) => {
      if (draft !== null) setContent(draft);
    }).catch(() => {});
  }, [draftVersion]);

  // Append new events to content
  useEffect(() => {
    if (!draftLoaded) return;
    if (events.length > lastEventCount) {
      const newEvents = events.slice(lastEventCount);
      const newMd = eventsToMarkdown(newEvents);
      if (newMd) {
        setContent((prev) => (prev ? prev + "\n\n" + newMd : newMd));
      }
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
    <div
      className={`md-editor ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {mode === "preview" ? (
        <div className="md-preview prose" ref={previewRef}>
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      ) : (
        <div className="md-textarea-wrap">
          <textarea
            ref={textareaRef}
            className="md-textarea"
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            spellCheck={false}
          />
        </div>
      )}
      <div className="md-footer">
        <span>{stats.words} words</span>
        <span>{stats.chars} chars</span>
        <span>{events.length} captures</span>
        <span className="md-footer-spacer" />
        <button
          className={`md-image-btn ${uploadingImage ? "uploading" : ""}`}
          title="Insert image (or drag & drop / paste)"
          onClick={() => imageInputRef.current?.click()}
          disabled={!sessionId || uploadingImage}
        >
          <PhotoIcon style={{ width: 14, height: 14 }} />
          {uploadingImage ? " Uploading…" : " Image"}
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) await handleImageFile(file);
            e.target.value = "";
          }}
        />
      </div>
      {dragOver && (
        <div className="md-drop-overlay">
          <PhotoIcon style={{ width: 32, height: 32, opacity: 0.6 }} />
          <span>Drop image to insert</span>
        </div>
      )}
    </div>
  );
}
