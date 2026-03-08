import { useCallback, useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { XMarkIcon } from "@heroicons/react/24/solid";
import { Cog6ToothIcon, SparklesIcon, InformationCircleIcon, ShieldCheckIcon, TagIcon, BoltIcon } from "@heroicons/react/24/outline";
import type { CaptureRule, AppTag, WebhookConfig } from "../shared/types";

type Tab = "general" | "ai" | "capture" | "intelligence" | "automations" | "about";

const TABS: { id: Tab; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: "general", label: "General", Icon: Cog6ToothIcon },
  { id: "ai", label: "AI Behavior", Icon: SparklesIcon },
  { id: "capture", label: "Capture Rules", Icon: ShieldCheckIcon },
  { id: "intelligence", label: "App Intelligence", Icon: TagIcon },
  { id: "automations", label: "Automations", Icon: BoltIcon },
  { id: "about", label: "About", Icon: InformationCircleIcon }
];

const AI_PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" }
];

const AI_MODELS: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o mini" }
  ],
  anthropic: [
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }
  ],
  google: [
    { value: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
    { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
    { value: "gemini-3-flash", label: "Gemini 3 Flash" }
  ]
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

  // Update state lifted here so it survives tab switches
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error">("idle");
  const [updateVersion, setUpdateVersion] = useState<string | undefined>();
  const [downloadPercent, setDownloadPercent] = useState(0);

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

  // Subscribe to updater events at modal level so state persists across tab switches
  useEffect(() => {
    const offAvailable = window.sessionCaptureApi.onUpdateAvailable((info) => {
      setUpdateVersion(info.version);
      setUpdateStatus("available");
    });
    const offProgress = window.sessionCaptureApi.onUpdateProgress((info) => {
      setDownloadPercent(Math.round(info.percent));
      setUpdateStatus("downloading");
    });
    const offDownloaded = window.sessionCaptureApi.onUpdateDownloaded((info) => {
      setUpdateVersion(info.version);
      setUpdateStatus("ready");
    });
    const offError = window.sessionCaptureApi.onUpdateError(() => {
      setUpdateStatus("error");
      setDownloadPercent(0);
    });
    return () => { offAvailable(); offProgress(); offDownloaded(); offError(); };
  }, []);

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
          {tab === "capture" && <CaptureRulesTab />}
          {tab === "intelligence" && <AppIntelligenceTab />}
          {tab === "automations" && <AutomationsTab />}
          {tab === "about" && (
            <AboutTab
              updateStatus={updateStatus}
              updateVersion={updateVersion}
              downloadPercent={downloadPercent}
              onStatusChange={setUpdateStatus}
              onVersionChange={setUpdateVersion}
            />
          )}
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
          Your share links will use a public tunnel so anyone can access them.
        </p>
      </div>

      <div className="ai-row">
        <div className="ai-row-info">
          <span className="ai-row-title">Tunnel Provider</span>
          <span className="ai-row-desc">
            {(settings.tunnelProvider || "privateconnect") === "privateconnect"
              ? "Uses privateconnect.co for public share links."
              : "Uses Cloudflare Quick Tunnels for public share links."}
          </span>
        </div>
        <div className="settings-select-wrap">
          <select
            id="settings-tunnel-provider"
            className="settings-select"
            value={settings.tunnelProvider || "privateconnect"}
            onChange={(e) => onUpdate("tunnelProvider", e.target.value)}
          >
            <option value="privateconnect">Private Connect</option>
            <option value="cloudflare">Cloudflare</option>
          </select>
        </div>
      </div>

      <div className="ai-row" style={{ marginTop: 8 }}>
        <div className="ai-row-info">
          <span className="ai-row-title">Daily Recap</span>
          <span className="ai-row-desc">
            End-of-day summary of all sessions. Uses AI when enabled, otherwise a structured digest.
          </span>
        </div>
        <button
          className={`ai-enable-btn ${settings.dailyRecapEnabled !== "false" ? "active" : ""}`}
          onClick={() =>
            onUpdate("dailyRecapEnabled", settings.dailyRecapEnabled === "false" ? "true" : "false")
          }
        >
          <span className="ai-enable-knob" />
        </button>
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

const AUDIO_PROVIDERS = [
  { value: "openai", label: "OpenAI Whisper (recommended)" },
  { value: "anthropic", label: "Anthropic Claude" },
  { value: "google", label: "Google Gemini" }
];

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

  // Audio provider — defaults to "openai" (Whisper), independent of text AI provider
  const audioProvider = settings.audioProvider || "openai";
  const audioKeyConfigured = settings.audioApiKey === "__configured__";
  // Only show separate key field when audio provider differs from main provider
  const needsSeparateAudioKey = audioProvider !== provider;

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
            placeholder={settings.aiApiKey === "__configured__" ? "Key configured — type to replace" : "sk-..."}
            value={settings.aiApiKey === "__configured__" ? "" : (settings.aiApiKey || "")}
            disabled={!enabled}
            onChange={(e) => onUpdate("aiApiKey", e.target.value)}
          />
        </div>
      </div>

      <div className="about-divider" />

      <div className="ai-section-label">Voice Transcription</div>
      <p className="ai-section-desc">
        Choose which provider handles voice capture. OpenAI Whisper gives the best accuracy and can be used independently of your text AI provider.
      </p>

      <div className={`ai-settings-body ${enabled ? "" : "disabled"}`}>
        <div className="ai-row">
          <div className="ai-row-info">
            <span className="ai-row-title">Audio Provider</span>
            <span className="ai-row-desc">
              {audioProvider === provider
                ? `Using your main ${AI_PROVIDERS.find(p => p.value === provider)?.label} key for audio.`
                : `Independent from your text AI — uses a separate key.`}
            </span>
          </div>
          <div className="settings-select-wrap">
            <select
              className="settings-select"
              value={audioProvider}
              disabled={!enabled}
              onChange={(e) => onUpdate("audioProvider", e.target.value)}
            >
              {AUDIO_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>

        {needsSeparateAudioKey && (
          <div className="ai-row">
            <div className="ai-row-info">
              <span className="ai-row-title">Audio API Key</span>
              <span className="ai-row-desc">
                Key for{" "}
                <a
                  href={`https://${providerHints[audioProvider] || "platform.openai.com"}`}
                  className="ai-row-link"
                  onClick={(e) => { e.preventDefault(); window.open((e.target as HTMLAnchorElement).href, "_blank"); }}
                >
                  {providerHints[audioProvider] || "platform.openai.com"}
                </a>
                {" "}— separate from your text AI key.
              </span>
            </div>
            <input
              className="settings-input ai-key-input"
              type="password"
              placeholder={audioKeyConfigured ? "Key configured — type to replace" : "sk-..."}
              value={audioKeyConfigured ? "" : (settings.audioApiKey || "")}
              disabled={!enabled}
              onChange={(e) => onUpdate("audioApiKey", e.target.value)}
            />
          </div>
        )}
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

// ── Capture Rules Tab ────────────────────────────────────────────────────────

const RULE_ACTION_LABELS: Record<string, string> = {
  allow: "Allow",
  block: "Block"
};

const QUICK_BLOCKLIST = [
  { label: "1Password", pattern: "1password" },
  { label: "Terminal (all)", pattern: "terminal" },
  { label: "iTerm", pattern: "iterm" },
  { label: "Banking (Safari)", pattern: "safari" },
  { label: "Keychain Access", pattern: "keychain" },
];

function CaptureRulesTab() {
  const [rules, setRules] = useState<CaptureRule[]>([]);
  const [adding, setAdding] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const [newAction, setNewAction] = useState<"allow" | "block">("block");
  const [newMinWords, setNewMinWords] = useState(0);
  const [newExtractCitations, setNewExtractCitations] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.sessionCaptureApi.listRules().then(setRules).catch(() => {});
  }, []);

  async function handleAdd() {
    if (!newPattern.trim()) return;
    setSaving(true);
    try {
      await window.sessionCaptureApi.addRule({
        appPattern: newPattern.trim(),
        action: newAction,
        minWords: newMinWords,
        extractCitations: newExtractCitations,
        note: newNote.trim() || null
      });
      const updated = await window.sessionCaptureApi.listRules();
      setRules(updated);
      setAdding(false);
      setNewPattern("");
      setNewAction("block");
      setNewMinWords(0);
      setNewExtractCitations(false);
      setNewNote("");
    } catch {}
    setSaving(false);
  }

  async function handleToggleCitations(id: number, current: boolean) {
    await window.sessionCaptureApi.updateRule(id, { extractCitations: !current });
    setRules((prev) => prev.map((r) => r.id === id ? { ...r, extractCitations: !current } : r));
  }

  async function handleDelete(id: number) {
    await window.sessionCaptureApi.deleteRule(id);
    setRules((prev) => prev.filter((r) => r.id !== id));
  }

  async function handleQuickBlock(pattern: string, label: string) {
    const already = rules.some((r) => r.appPattern.toLowerCase() === pattern);
    if (already) return;
    await window.sessionCaptureApi.addRule({ appPattern: pattern, action: "block", minWords: 0, extractCitations: false, note: `Quick block: ${label}` });
    const updated = await window.sessionCaptureApi.listRules();
    setRules(updated);
  }

  return (
    <div className="settings-tab-content">
      <h3 className="settings-tab-title">Capture Rules</h3>
      <p className="settings-hint" style={{ marginBottom: 16 }}>
        Define which apps are captured and under what conditions. Rules are evaluated in order, first match wins.
        By default, all apps are captured.
      </p>

      <div className="ai-section-label" style={{ marginBottom: 8 }}>Quick Privacy Blocks</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 20 }}>
        {QUICK_BLOCKLIST.map((item) => {
          const blocked = rules.some((r) => r.appPattern.toLowerCase() === item.pattern && r.action === "block");
          return (
            <button
              key={item.pattern}
              className={`quick-block-chip ${blocked ? "active" : ""}`}
              onClick={() => handleQuickBlock(item.pattern, item.label)}
              title={blocked ? "Already blocked" : `Block ${item.label}`}
            >
              {blocked ? "✓ " : "+ "}{item.label}
            </button>
          );
        })}
      </div>

      {rules.length === 0 && !adding && (
        <p className="settings-hint" style={{ marginBottom: 12 }}>No custom rules yet. Add one below or use the quick blocks above.</p>
      )}

      {rules.length > 0 && (
        <div className="rules-list">
          {rules.map((rule) => (
            <div key={rule.id} className="rule-row">
              <span className={`rule-badge ${rule.action}`}>{RULE_ACTION_LABELS[rule.action]}</span>
              <span className="rule-pattern">{rule.appPattern}</span>
              {rule.minWords > 0 && <span className="rule-detail">≥{rule.minWords} words</span>}
              {rule.action === "allow" && (
                <button
                  className={`rule-citations-toggle ${rule.extractCitations ? "active" : ""}`}
                  onClick={() => handleToggleCitations(rule.id, rule.extractCitations)}
                  title={rule.extractCitations ? "Disable citation extraction" : "Enable citation extraction (AI)"}
                >
                  {rule.extractCitations ? "📚 Citations On" : "📚 Citations Off"}
                </button>
              )}
              {rule.note && <span className="rule-note">{rule.note}</span>}
              <button className="rule-delete" onClick={() => handleDelete(rule.id)} title="Remove rule">×</button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="rule-add-form">
          <div className="settings-field" style={{ marginBottom: 8 }}>
            <label className="settings-label">App name / pattern</label>
            <input
              className="settings-input"
              placeholder="e.g. 1password, terminal, slack"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              autoFocus
            />
            <p className="settings-hint">Partial match — "terminal" matches "Terminal.app" and "iTerm2".</p>
          </div>
          <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
            <div className="settings-field" style={{ flex: 1, marginBottom: 0 }}>
              <label className="settings-label">Action</label>
              <div className="settings-select-wrap">
                <select className="settings-select" value={newAction} onChange={(e) => setNewAction(e.target.value as "allow" | "block")}>
                  <option value="block">Block — never capture</option>
                  <option value="allow">Allow — capture only if…</option>
                </select>
              </div>
            </div>
            {newAction === "allow" && (
              <div className="settings-field" style={{ flex: 1, marginBottom: 0 }}>
                <label className="settings-label">Min words</label>
                <input
                  className="settings-input"
                  type="number"
                  min={0}
                  value={newMinWords}
                  onChange={(e) => setNewMinWords(Number(e.target.value))}
                />
              </div>
            )}
          </div>
          {newAction === "allow" && (
            <div className="settings-field" style={{ marginBottom: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={newExtractCitations}
                  onChange={(e) => setNewExtractCitations(e.target.checked)}
                />
                <span className="settings-label" style={{ marginBottom: 0 }}>Extract citations with AI</span>
              </label>
              <p className="settings-hint">When enabled, AI will extract references, URLs, and bibliographic data from each capture and append them to the session draft.</p>
            </div>
          )}
          <div className="settings-field" style={{ marginBottom: 12 }}>
            <label className="settings-label">Note (optional)</label>
            <input
              className="settings-input"
              placeholder="e.g. Privacy — password manager"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="about-update-btn about-update-available" onClick={handleAdd} disabled={saving || !newPattern.trim()}>
              {saving ? "Saving..." : "Add Rule"}
            </button>
            <button className="about-update-btn" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="about-update-btn" style={{ marginTop: 4 }} onClick={() => setAdding(true)}>
          + Add Rule
        </button>
      )}
    </div>
  );
}

// ── App Intelligence Tab ─────────────────────────────────────────────────────

const APP_TAG_OPTIONS = [
  { value: "code", label: "Code" },
  { value: "conversation", label: "Conversation" },
  { value: "research", label: "Research" },
  { value: "terminal", label: "Terminal" },
  { value: "pdf", label: "PDF / Docs" },
  { value: "presentation", label: "Presentation" },
  { value: "notes", label: "Notes" },
  { value: "general", label: "General" },
];

// Apps that the backend auto-detects, grouped by tag
const AUTO_DETECTED: { tag: string; apps: string[] }[] = [
  { tag: "code",         apps: ["Xcode", "VSCode", "Cursor", "Vim", "Nvim", "Emacs", "Sublime Text", "IntelliJ", "PyCharm", "WebStorm", "Android Studio"] },
  { tag: "conversation", apps: ["Slack", "Teams", "Discord", "Zoom", "Telegram", "Messages", "WhatsApp", "Signal", "Mail", "Outlook", "Gmail"] },
  { tag: "research",     apps: ["Safari", "Chrome", "Firefox", "Arc", "Edge", "Brave"] },
  { tag: "terminal",     apps: ["Terminal", "iTerm", "Warp", "Kitty", "Alacritty", "Hyper", "Ghostty"] },
  { tag: "pdf",          apps: ["Preview", "Adobe Acrobat", "PDF Expert"] },
  { tag: "notes",        apps: ["Notes", "Notion", "Obsidian", "Bear", "Logseq", "Craft"] },
];

function AppIntelligenceTab() {
  const [tags, setTags] = useState<AppTag[]>([]);
  const [newApp, setNewApp] = useState("");
  const [newTag, setNewTag] = useState("general");
  const [adding, setAdding] = useState(false);
  // Track which auto-detected app is being overridden inline
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  useEffect(() => {
    window.sessionCaptureApi.listAppTags().then(setTags).catch(() => {});
  }, []);

  async function handleAdd() {
    if (!newApp.trim()) return;
    await window.sessionCaptureApi.setAppTag(newApp.trim(), newTag);
    const updated = await window.sessionCaptureApi.listAppTags();
    setTags(updated);
    setAdding(false);
    setNewApp("");
    setNewTag("general");
  }

  async function handleDelete(appName: string) {
    await window.sessionCaptureApi.deleteAppTag(appName);
    setTags((prev) => prev.filter((t) => t.appName !== appName));
  }

  async function handleTagChange(appName: string, tag: string) {
    await window.sessionCaptureApi.setAppTag(appName, tag);
    setTags((prev) => {
      const exists = prev.some((t) => t.appName === appName);
      if (exists) return prev.map((t) => t.appName === appName ? { ...t, tag: tag as AppTag["tag"] } : t);
      return [...prev, { appName, tag: tag as AppTag["tag"], updatedAt: Date.now() }];
    });
  }

  // Override tag for an auto-detected app (saves to DB)
  // Special value "__block__" creates a capture rule instead of a tag override
  async function handleAutoOverride(appName: string, newTagValue: string) {
    if (newTagValue === "__block__") {
      await window.sessionCaptureApi.addRule({
        appPattern: appName.toLowerCase(),
        action: "block",
        minWords: 0,
        extractCitations: false,
        note: `Blocked from App Intelligence: ${appName}`
      });
      return;
    }
    await window.sessionCaptureApi.setAppTag(appName, newTagValue);
    const updated = await window.sessionCaptureApi.listAppTags();
    setTags(updated);
  }

  // Remove an override for an auto-detected app (reverts to auto-detect)
  async function handleAutoRevert(appName: string) {
    await window.sessionCaptureApi.deleteAppTag(appName);
    setTags((prev) => prev.filter((t) => t.appName !== appName));
  }

  // Get the current effective tag for an auto-detected app (override or default)
  function getEffectiveTag(appName: string, defaultTag: string): string {
    return tags.find((t) => t.appName === appName)?.tag ?? defaultTag;
  }

  function hasOverride(appName: string): boolean {
    return tags.some((t) => t.appName === appName);
  }

  // Custom overrides (not from auto-detected list)
  const autoAppNames = AUTO_DETECTED.flatMap((g) => g.apps.map((a) => a.toLowerCase()));
  const customTags = tags.filter((t) => !autoAppNames.includes(t.appName.toLowerCase()));

  return (
    <div className="settings-tab-content">
      <h3 className="settings-tab-title">App Intelligence</h3>
      <p className="settings-hint" style={{ marginBottom: 16 }}>
        Tag apps so captures are processed contextually. Code editors get syntax-highlighted, conversations get speaker context,
        research captures get citation extraction. Click any app to change its tag or block it.
      </p>

      <div className="ai-section-label" style={{ marginBottom: 8 }}>Auto-detected defaults</div>
      <div className="rules-list" style={{ marginBottom: 16 }}>
        {AUTO_DETECTED.map((group) => (
          <div key={group.tag}>
            <button
              className="rule-row auto-group-header"
              style={{ width: "100%", cursor: "pointer", textAlign: "left" }}
              onClick={() => setExpandedGroup(expandedGroup === group.tag ? null : group.tag)}
            >
              <span className={`rule-badge ${group.tag}`}>{group.tag}</span>
              <span className="rule-pattern" style={{ flex: 1 }}>
                {group.apps.slice(0, 4).join(", ")}{group.apps.length > 4 ? `… +${group.apps.length - 4} more` : ""}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-tertiary, #666)", marginLeft: 4 }}>
                {expandedGroup === group.tag ? "▲" : "▼"}
              </span>
            </button>

            {expandedGroup === group.tag && (
              <div className="auto-group-expanded">
                {group.apps.map((appName) => {
                  const overridden = hasOverride(appName);
                  const effectiveTag = getEffectiveTag(appName, group.tag);
                  return (
                    <div key={appName} className="auto-app-row">
                      <span className="auto-app-name">
                        {overridden && <span className="auto-app-overridden-dot" title="Overridden" />}
                        {appName}
                      </span>
                      <div className="settings-select-wrap" style={{ minWidth: 130 }}>
                        <select
                          className="settings-select"
                          value={effectiveTag}
                          onChange={(e) => handleAutoOverride(appName, e.target.value)}
                        >
                          {APP_TAG_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                          <option value="__block__">Block (never capture)</option>
                        </select>
                      </div>
                      {overridden && (
                        <button
                          className="rule-delete"
                          onClick={() => handleAutoRevert(appName)}
                          title="Revert to auto-detected default"
                          style={{ fontSize: 11, color: "var(--text-tertiary, #888)" }}
                        >
                          ↩
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="ai-section-label" style={{ marginBottom: 8 }}>Custom overrides</div>
      {customTags.length === 0 && !adding && (
        <p className="settings-hint" style={{ marginBottom: 12 }}>No custom overrides yet.</p>
      )}
      {customTags.length > 0 && (
        <div className="rules-list" style={{ marginBottom: 12 }}>
          {customTags.map((t) => (
            <div key={t.appName} className="rule-row">
              <span className="rule-pattern" style={{ flex: 1 }}>{t.appName}</span>
              <div className="settings-select-wrap" style={{ minWidth: 140 }}>
                <select
                  className="settings-select"
                  value={t.tag}
                  onChange={(e) => handleTagChange(t.appName, e.target.value)}
                >
                  {APP_TAG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <button className="rule-delete" onClick={() => handleDelete(t.appName)} title="Remove override">×</button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <div className="rule-add-form">
          <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
            <div className="settings-field" style={{ flex: 2, marginBottom: 0 }}>
              <label className="settings-label">App name</label>
              <input
                className="settings-input"
                placeholder="e.g. Bear, Notion"
                value={newApp}
                onChange={(e) => setNewApp(e.target.value)}
                autoFocus
              />
            </div>
            <div className="settings-field" style={{ flex: 1, marginBottom: 0 }}>
              <label className="settings-label">Tag</label>
              <div className="settings-select-wrap">
                <select className="settings-select" value={newTag} onChange={(e) => setNewTag(e.target.value)}>
                  {APP_TAG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="about-update-btn about-update-available" onClick={handleAdd} disabled={!newApp.trim()}>Add</button>
            <button className="about-update-btn" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="about-update-btn" onClick={() => setAdding(true)}>+ Add Override</button>
      )}
    </div>
  );
}

// ── Automations Tab ──────────────────────────────────────────────────────────

const TRIGGER_LABELS: Record<string, string> = {
  session_end: "Session ends",
  session_start: "Session starts",
  daily_recap: "Daily recap generated"
};

function AutomationsTab() {
  const [hooks, setHooks] = useState<WebhookConfig[]>([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newTrigger, setNewTrigger] = useState<"session_end" | "session_start" | "daily_recap">("session_end");
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean; msg: string }>>({});

  useEffect(() => {
    window.sessionCaptureApi.listWebhooks().then(setHooks).catch(() => {});
  }, []);

  async function handleAdd() {
    if (!newName.trim() || !newUrl.trim()) return;
    setSaving(true);
    try {
      await window.sessionCaptureApi.addWebhook({ name: newName.trim(), url: newUrl.trim(), trigger: newTrigger, enabled: true });
      const updated = await window.sessionCaptureApi.listWebhooks();
      setHooks(updated);
      setAdding(false);
      setNewName("");
      setNewUrl("");
      setNewTrigger("session_end");
    } catch {}
    setSaving(false);
  }

  async function handleToggle(hook: WebhookConfig) {
    await window.sessionCaptureApi.updateWebhook(hook.id, { enabled: !hook.enabled });
    setHooks((prev) => prev.map((h) => h.id === hook.id ? { ...h, enabled: !h.enabled } : h));
  }

  async function handleDelete(id: number) {
    await window.sessionCaptureApi.deleteWebhook(id);
    setHooks((prev) => prev.filter((h) => h.id !== id));
  }

  async function handleTest(id: number) {
    const result = await window.sessionCaptureApi.testWebhook(id);
    setTestResult((prev) => ({
      ...prev,
      [id]: { ok: result.ok, msg: result.ok ? `✓ ${result.status ?? 200}` : `✗ ${result.error ?? "Failed"}` }
    }));
    setTimeout(() => setTestResult((prev) => { const n = { ...prev }; delete n[id]; return n; }), 4000);
  }

  return (
    <div className="settings-tab-content">
      <h3 className="settings-tab-title">Automations</h3>
      <p className="settings-hint" style={{ marginBottom: 16 }}>
        Fire webhooks when events happen. Connect to Zapier, Make, Notion, Slack, or any HTTP endpoint.
        The payload is JSON with session metadata.
      </p>

      {hooks.length === 0 && !adding && (
        <p className="settings-hint" style={{ marginBottom: 12 }}>No webhooks configured yet.</p>
      )}

      {hooks.length > 0 && (
        <div className="rules-list" style={{ marginBottom: 12 }}>
          {hooks.map((hook) => (
            <div key={hook.id} className="rule-row" style={{ flexWrap: "wrap", gap: 6 }}>
              <button
                className={`ai-enable-btn ${hook.enabled ? "active" : ""}`}
                style={{ width: 32, height: 18, flexShrink: 0 }}
                onClick={() => handleToggle(hook)}
                title={hook.enabled ? "Disable" : "Enable"}
              >
                <span className="ai-enable-knob" />
              </button>
              <span className="rule-pattern" style={{ flex: 1 }}>{hook.name}</span>
              <span className="rule-detail">{TRIGGER_LABELS[hook.trigger]}</span>
              {testResult[hook.id] && (
                <span className={`rule-note ${testResult[hook.id].ok ? "" : "error"}`}>{testResult[hook.id].msg}</span>
              )}
              <button className="about-update-btn" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => handleTest(hook.id)}>Test</button>
              <button className="rule-delete" onClick={() => handleDelete(hook.id)} title="Remove">×</button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="rule-add-form">
          <div className="settings-field" style={{ marginBottom: 8 }}>
            <label className="settings-label">Name</label>
            <input className="settings-input" placeholder="e.g. Notify Slack" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          </div>
          <div className="settings-field" style={{ marginBottom: 8 }}>
            <label className="settings-label">Webhook URL</label>
            <input className="settings-input" placeholder="https://hooks.zapier.com/..." value={newUrl} onChange={(e) => setNewUrl(e.target.value)} />
          </div>
          <div className="settings-field" style={{ marginBottom: 12 }}>
            <label className="settings-label">Trigger</label>
            <div className="settings-select-wrap">
              <select className="settings-select" value={newTrigger} onChange={(e) => setNewTrigger(e.target.value as typeof newTrigger)}>
                {Object.entries(TRIGGER_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="about-update-btn about-update-available" onClick={handleAdd} disabled={saving || !newName.trim() || !newUrl.trim()}>
              {saving ? "Saving..." : "Add Webhook"}
            </button>
            <button className="about-update-btn" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="about-update-btn" onClick={() => setAdding(true)}>+ Add Webhook</button>
      )}

      <div className="about-divider" style={{ marginTop: 20 }} />
      <div className="ai-section-label" style={{ marginBottom: 6 }}>Payload format (session_end example)</div>
      <pre className="settings-hint" style={{ fontFamily: "monospace", fontSize: 11, background: "var(--surface-2, rgba(0,0,0,0.05))", padding: 10, borderRadius: 6, overflow: "auto" }}>{`{
  "trigger": "session_end",
  "sessionId": 42,
  "sessionTitle": "My Research Session",
  "eventCount": 18,
  "apps": ["Safari", "Notion"],
  "app": "Do Not Forget"
}`}</pre>
    </div>
  );
}

function AboutTab({
  updateStatus,
  updateVersion,
  downloadPercent,
  onStatusChange,
  onVersionChange,
}: {
  updateStatus: "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error";
  updateVersion: string | undefined;
  downloadPercent: number;
  onStatusChange: (s: "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error") => void;
  onVersionChange: (v: string) => void;
}) {
  const [version, setVersion] = useState("0.1.0");

  useEffect(() => {
    window.sessionCaptureApi.getVersion().then(setVersion).catch(() => {});
  }, []);

  const checkForUpdates = async () => {
    onStatusChange("checking");
    try {
      const result = await window.sessionCaptureApi.checkForUpdates();
      if (result.error) {
        onStatusChange("error");
      } else if (result.available) {
        if (result.latestVersion) onVersionChange(result.latestVersion);
        onStatusChange("downloading");
      } else {
        onStatusChange("latest");
      }
    } catch {
      onStatusChange("error");
    }
  };

  const installUpdate = () => {
    window.sessionCaptureApi.installUpdate();
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
        {updateStatus === "ready" ? (
          <button className="about-update-btn about-update-available" onClick={installUpdate}>
            <svg className="about-update-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Restart to install v{updateVersion}
          </button>
        ) : updateStatus === "downloading" ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <button className="about-update-btn" disabled>
              <svg className="about-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              {downloadPercent > 0 ? `Downloading v${updateVersion}… ${downloadPercent}%` : `Downloading v${updateVersion}…`}
            </button>
            {downloadPercent > 0 && (
              <div style={{ width: 180, height: 3, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${downloadPercent}%`, background: "#818cf8", borderRadius: 2, transition: "width 0.3s" }} />
              </div>
            )}
          </div>
        ) : updateStatus === "available" ? (
          <button className="about-update-btn about-update-available" disabled>
            <svg className="about-update-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            v{updateVersion} available
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
