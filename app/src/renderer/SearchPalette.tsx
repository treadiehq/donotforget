import { useCallback, useEffect, useRef, useState } from "react";
import { MagnifyingGlassIcon, DocumentTextIcon } from "@heroicons/react/24/solid";
import type { SessionRow } from "../shared/types";

interface SearchPaletteProps {
  onClose: () => void;
  onSelect: (sessionId: number) => void;
}

export function SearchPalette({ onClose, onSelect }: SearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionRow[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;

    if (!query.trim()) {
      setResults([]);
      setSearched(false);
      return () => { active = false; };
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      window.sessionCaptureApi
        .searchSessions(query.trim())
        .then((rows) => {
          if (!active) return;
          setResults(rows);
          setSearched(true);
          setActiveIndex(0);
        })
        .catch(() => {});
    }, 150);
    return () => {
      active = false;
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query]);

  const handleSelect = useCallback(
    (sessionId: number) => {
      onSelect(sessionId);
      onClose();
    },
    [onSelect, onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[activeIndex]) {
        handleSelect(results[activeIndex].id);
      }
    },
    [results, activeIndex, handleSelect, onClose]
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose]
  );

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric"
    });
  }

  return (
    <div className="search-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="search-palette" onKeyDown={handleKeyDown}>
        <div className="search-input-row">
          <MagnifyingGlassIcon className="search-input-icon" />
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="Search sessions..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="search-esc">esc</kbd>
        </div>

        {results.length > 0 && (
          <div className="search-results">
            {results.map((session, i) => (
              <button
                key={session.id}
                className={`search-result ${i === activeIndex ? "active" : ""}`}
                onClick={() => handleSelect(session.id)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <DocumentTextIcon className="search-result-icon" />
                <div className="search-result-content">
                  <span className="search-result-title">{session.title}</span>
                  {session.preview && (
                    <span className="search-result-preview">{session.preview}</span>
                  )}
                </div>
                <span className="search-result-date">{formatDate(session.createdAt)}</span>
              </button>
            ))}
          </div>
        )}

        {searched && query.trim() && results.length === 0 && (
          <div className="search-empty">No sessions found</div>
        )}
      </div>
    </div>
  );
}
