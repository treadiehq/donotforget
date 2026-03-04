import { useRef, useState, useEffect } from "react";
import { SparklesIcon } from "@heroicons/react/24/outline";

interface FloatingChatProps {
  sessionId: number | null;
  context: "list" | "detail";
}

export function FloatingChat({ sessionId, context }: FloatingChatProps) {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<
    { role: "user" | "assistant"; content: string }[]
  >([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.sessionCaptureApi.getSettings().then((s) => {
      setHasKey(!!s.aiApiKey);
    }).catch(() => setHasKey(false));
  }, []);

  useEffect(() => {
    if (expanded && inputRef.current && hasKey) {
      inputRef.current.focus();
    }
  }, [expanded, hasKey]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = async () => {
    const text = message.trim();
    if (!text || loading) return;

    setExpanded(true);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setMessage("");
    setLoading(true);

    try {
      const result = await window.sessionCaptureApi.aiChat(text, sessionId);
      setMessages((prev) => [...prev, { role: "assistant", content: result }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I couldn't process that. Check your AI settings." }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleEnhance = async () => {
    if (!sessionId || loading) return;
    setExpanded(true);
    setMessages((prev) => [...prev, { role: "user", content: "Enhance this session's content" }]);
    setLoading(true);

    try {
      const result = await window.sessionCaptureApi.aiEnhance(sessionId);
      setMessages((prev) => [...prev, { role: "assistant", content: result }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I couldn't enhance the content. Check your AI settings." }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const contextLabel =
    context === "detail" && sessionId ? "Ask about this session..." : "Ask anything...";

  if (hasKey === false) {
    return (
      <div className="floating-chat">
        <div className="floating-chat-bar floating-chat-nokey">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="floating-chat-nokey-icon">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
          </svg>
          <span className="floating-chat-nokey-text">
            Add an API key in <strong>Settings → AI Behavior</strong> to start chatting
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`floating-chat ${expanded ? "expanded" : ""}`}>
      {expanded && messages.length > 0 && (
        <div className="floating-chat-messages" ref={scrollRef}>
          {messages.map((msg, i) => (
            <div key={i} className={`floating-chat-msg ${msg.role}`}>
              <div className="floating-chat-msg-bubble">{msg.content}</div>
            </div>
          ))}
          {loading && (
            <div className="floating-chat-msg assistant">
              <div className="floating-chat-msg-bubble">
                <span className="floating-chat-typing">
                  <span /><span /><span />
                </span>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="floating-chat-bar">
        <input
          ref={inputRef}
          className="floating-chat-input"
          type="text"
          placeholder={contextLabel}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onFocus={() => setExpanded(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
            if (e.key === "Escape") {
              setExpanded(false);
              inputRef.current?.blur();
            }
          }}
        />
        <div className="floating-chat-actions">
          {expanded && messages.length > 0 && (
            <button
              className="floating-chat-clear"
              onClick={() => {
                setMessages([]);
                setExpanded(false);
              }}
            >
              Clear
            </button>
          )}
          {context === "detail" && sessionId && (
            <button
              className="floating-chat-enhance"
              disabled={loading}
              onClick={handleEnhance}
              title="Enhance content"
            >
              <SparklesIcon className="floating-chat-enhance-icon" />
              Enhance
            </button>
          )}
          <button
            className="floating-chat-send"
            disabled={!message.trim() || loading}
            onClick={handleSubmit}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
