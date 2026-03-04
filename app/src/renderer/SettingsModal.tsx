import { useCallback, useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { XMarkIcon } from "@heroicons/react/24/solid";
import { Cog6ToothIcon, SparklesIcon, InformationCircleIcon } from "@heroicons/react/24/outline";

type Tab = "general" | "ai" | "about";

const TABS: { id: Tab; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: "general", label: "General", Icon: Cog6ToothIcon },
  { id: "ai", label: "AI Behavior", Icon: SparklesIcon },
  { id: "about", label: "About", Icon: InformationCircleIcon }
];

const AI_PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" }
];

const AI_MODELS: Record<string, { value: string; label: string }[]> = {
  openai: [{ value: "gpt-5.2", label: "GPT-5.2" }],
  anthropic: [{ value: "claude-opus-4-6", label: "Claude Opus 4.6" }],
  google: [{ value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" }]
};

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

function validateHandle(v: string): string | null {
  if (!v) return null;
  if (v.length < 3) return "At least 3 characters";
  if (v.length > 30) return "Max 30 characters";
  if (/^-|-$/.test(v)) return "No leading or trailing hyphens";
  if (!/^[a-z0-9-]+$/.test(v)) return "Only lowercase letters, numbers, hyphens";
  return null;
}

interface SettingsModalProps {
  onClose: () => void;
  onAiEnabledChange?: (enabled: boolean) => void;
  onDataCleared?: () => void;
}

export function SettingsModal({ onClose, onAiEnabledChange, onDataCleared }: SettingsModalProps) {
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const pendingChanges = useRef<Record<string, string>>({});

  useEffect(() => {
    window.sessionCaptureApi.getSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    }).catch(() => {
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose]
  );

  const updateSetting = useCallback((key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    pendingChanges.current[key] = value;
    if (key === "aiEnabled") {
      onAiEnabledChange?.(value === "true");
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      Object.entries(pendingChanges.current).forEach(([k, v]) => {
        window.sessionCaptureApi.setSetting(k, v).catch(() => {});
      });
      pendingChanges.current = {};
    }, 400);
  }, [onAiEnabledChange]);

  if (!loaded) return null;

  const handleError = validateHandle(settings.handle || "");
  const isHandleValid = !settings.handle || (!handleError && HANDLE_RE.test(settings.handle));
  const previewSubdomain = settings.handle && isHandleValid ? settings.handle : "donotforget";

  return (
    <div className="settings-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="settings-modal">
        <div className="settings-sidebar">
          <h2 className="settings-sidebar-title">Settings</h2>
          <nav className="settings-nav">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`settings-nav-item ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                <t.Icon className="settings-nav-icon" />
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="settings-content">
          <button className="settings-close" onClick={onClose} aria-label="Close">
            <XMarkIcon />
          </button>

          {tab === "general" && (
            <GeneralTab
              settings={settings}
              onUpdate={updateSetting}
              handleError={handleError}
              previewSubdomain={previewSubdomain}
              onDataCleared={() => { onDataCleared?.(); onClose(); }}
            />
          )}
          {tab === "ai" && (
            <AIBehaviorTab settings={settings} onUpdate={updateSetting} />
          )}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </div>
  );
}

function GeneralTab({
  settings,
  onUpdate,
  handleError,
  previewSubdomain,
  onDataCleared
}: {
  settings: Record<string, string>;
  onUpdate: (key: string, value: string) => void;
  handleError: string | null;
  previewSubdomain: string;
  onDataCleared: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  async function handleClearAll() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    await window.sessionCaptureApi.clearAllData();
    setConfirming(false);
    onDataCleared();
  }

  return (
    <div className="settings-tab-content">
      <h3 className="settings-tab-title">General</h3>

      <div className="settings-field">
        <label className="settings-label" htmlFor="settings-name">
          Name
        </label>
        <input
          id="settings-name"
          className="settings-input"
          type="text"
          placeholder="Your name"
          value={settings.name || ""}
          onChange={(e) => onUpdate("name", e.target.value)}
        />
        <p className="settings-hint">Displayed on shared session pages.</p>
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="settings-handle">
          Handle
        </label>
        <input
          id="settings-handle"
          className="settings-input"
          type="text"
          placeholder="yourhandle"
          value={settings.handle || ""}
          onChange={(e) => onUpdate("handle", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
        />
        {handleError && <p className="settings-error">{handleError}</p>}
        <p className="settings-hint">
          Your share links will be{" "}
          <code className="settings-url-preview">{previewSubdomain}.localhost:1455/...</code>
        </p>
      </div>

      <div className="danger-zone">
        <div className="danger-zone-label">Danger Zone</div>
        <div className="danger-zone-row">
          <div className="danger-zone-info">
            <span className="danger-zone-title">Clear all data</span>
            <span className="danger-zone-desc">Permanently delete all sessions, captures, and drafts.</span>
          </div>
          <button
            className={`danger-zone-btn ${confirming ? "confirming" : ""}`}
            onClick={handleClearAll}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? "Confirm — this cannot be undone" : "Clear All Data"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AIBehaviorTab({
  settings,
  onUpdate
}: {
  settings: Record<string, string>;
  onUpdate: (key: string, value: string) => void;
}) {
  const enabled = settings.aiEnabled === "true";
  const provider = settings.aiProvider || "openai";
  const model = settings.aiModel || AI_MODELS[provider]?.[0]?.value || "";
  const models = AI_MODELS[provider] || [];

  const providerHints: Record<string, string> = {
    openai: "platform.openai.com",
    anthropic: "platform.claude.com",
    google: "aistudio.google.com"
  };

  return (
    <div className="settings-tab-content">
      <div className="ai-section-label">AI Provider</div>
      <p className="ai-section-desc">
        Choose an AI provider for session analysis and chat.
      </p>

      <div className={`ai-settings-body ${enabled ? "" : "disabled"}`}>
        <div className="ai-row">
          <div className="ai-row-info">
            <span className="ai-row-title">Provider</span>
            <span className="ai-row-desc">Select the AI service to use.</span>
          </div>
          <div className="settings-select-wrap">
            <select
              className="settings-select"
              value={provider}
              disabled={!enabled}
              onChange={(e) => {
                onUpdate("aiProvider", e.target.value);
                const firstModel = AI_MODELS[e.target.value]?.[0]?.value || "";
                onUpdate("aiModel", firstModel);
              }}
            >
              {AI_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="ai-row">
          <div className="ai-row-info">
            <span className="ai-row-title">Model</span>
            <span className="ai-row-desc">Choose the model for this provider.</span>
          </div>
          <div className="settings-select-wrap">
            <select
              className="settings-select"
              value={model}
              disabled={!enabled}
              onChange={(e) => onUpdate("aiModel", e.target.value)}
            >
              {models.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="ai-row">
          <div className="ai-row-info">
            <span className="ai-row-title">API Key</span>
            <span className="ai-row-desc">
              Get a key at{" "}
              <a
                href={`https://${providerHints[provider] || "platform.openai.com"}`}
                className="ai-row-link"
                onClick={(e) => { e.preventDefault(); window.open((e.target as HTMLAnchorElement).href, "_blank"); }}
              >
                {providerHints[provider] || "platform.openai.com"}
              </a>
            </span>
          </div>
          <input
            className="settings-input ai-key-input"
            type="password"
            placeholder="sk-..."
            value={settings.aiApiKey || ""}
            disabled={!enabled}
            onChange={(e) => onUpdate("aiApiKey", e.target.value)}
          />
        </div>
      </div>

      <div className="about-divider" />

      <div className="ai-section-label">AI Behavior</div>
      <p className="ai-section-desc">
        Tune how AI interacts with your sessions and content.
      </p>

      <div className={`ai-settings-body ${enabled ? "" : "disabled"}`}>
        <div className="ai-row">
          <div className="ai-row-info">
            <span className="ai-row-title">Smart Summaries</span>
            <span className="ai-row-desc">
              Automatically generate summaries of captured sessions.
            </span>
          </div>
          <button
            className={`ai-enable-btn ${settings.aiSmartSummaries === "true" ? "active" : ""}`}
            disabled={!enabled}
            onClick={() =>
              onUpdate("aiSmartSummaries", settings.aiSmartSummaries === "true" ? "false" : "true")
            }
          >
            <span className="ai-enable-knob" />
          </button>
        </div>

        <div className="ai-row">
          <div className="ai-row-info">
            <span className="ai-row-title">Content Enhancement</span>
            <span className="ai-row-desc">
              AI-powered suggestions to improve and organize captured content.
            </span>
          </div>
          <button
            className={`ai-enable-btn ${settings.aiContentEnhancement === "true" ? "active" : ""}`}
            disabled={!enabled}
            onClick={() =>
              onUpdate(
                "aiContentEnhancement",
                settings.aiContentEnhancement === "true" ? "false" : "true"
              )
            }
          >
            <span className="ai-enable-knob" />
          </button>
        </div>
      </div>

      <div className="about-divider" />

      <div className="ai-row" style={{ opacity: 1, pointerEvents: "auto" }}>
        <div className="ai-row-info">
          <span className="ai-row-title">Enable AI</span>
          <span className="ai-row-desc">
            Turn on AI-powered chat and features.
          </span>
        </div>
        <button
          className={`ai-enable-btn ${enabled ? "active" : ""}`}
          onClick={() => onUpdate("aiEnabled", enabled ? "false" : "true")}
        >
          <span className="ai-enable-knob" />
        </button>
      </div>
    </div>
  );
}

function AboutTab() {
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "latest" | "available" | "error">("idle");
  const [version, setVersion] = useState("0.1.0");
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion?: string; releaseUrl?: string; downloadUrl?: string }>({});

  useEffect(() => {
    window.sessionCaptureApi.getVersion().then(setVersion).catch(() => {});
  }, []);

  const checkForUpdates = async () => {
    setUpdateStatus("checking");
    try {
      const result = await window.sessionCaptureApi.checkForUpdates();
      if (result.error) {
        console.error("Update check error:", result.error);
        setUpdateStatus("error");
      } else if (result.available) {
        setUpdateStatus("available");
        setUpdateInfo({
          latestVersion: result.latestVersion,
          releaseUrl: result.releaseUrl,
          downloadUrl: result.downloadUrl
        });
      } else {
        setUpdateStatus("latest");
      }
    } catch {
      setUpdateStatus("error");
    }
  };

  const openDownload = () => {
    const url = updateInfo.downloadUrl || updateInfo.releaseUrl;
    if (url) window.open(url, "_blank");
  };

  return (
    <div className="settings-tab-content">
      <div className="about-header">
        <div className="about-title">About Do Not Forget</div>
        <div className="about-tagline">Capture everything. Forget nothing.</div>
      </div>

      <div className="about-divider" />

      <div className="about-row">
        <span className="about-row-label">Version</span>
        <span className="about-row-value">{version}</span>
      </div>

      <div className="about-row">
        <span className="about-row-label">License</span>
        <span className="about-row-value">FSL-1.1-MIT</span>
      </div>

      <div className="about-divider" />

      <div className="about-row">
        <span className="about-row-label">Updates</span>
        {updateStatus === "available" ? (
          <button className="about-update-btn about-update-available" onClick={openDownload}>
            <svg className="about-update-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download v{updateInfo.latestVersion}
          </button>
        ) : (
          <button
            className="about-update-btn"
            onClick={checkForUpdates}
            disabled={updateStatus === "checking"}
          >
            {updateStatus === "checking" ? (
              <>
                <svg className="about-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Checking...
              </>
            ) : (
              <>
                <svg className="about-update-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 4v6h6M23 20v-6h-6" />
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
                </svg>
                {updateStatus === "latest" ? "You're up to date" : updateStatus === "error" ? "Check failed — retry" : "Check for Updates"}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
