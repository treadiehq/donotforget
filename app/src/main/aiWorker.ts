/**
 * AI worker — runs inside Electron utilityProcess so AI fetch calls never
 * block the main process event loop.
 *
 * Communication protocol (both directions use parentPort):
 *
 *   Renderer → main → worker:
 *     { id: string, type: "callAi" | "smartSummary" | "autoTitle" | "dailySummary", ...args }
 *
 *   Worker → main:
 *     { id: string, ok: true, result: any }
 *     { id: string, ok: false, error: string }
 *
 * The worker is stateless — it receives all data it needs in the request message
 * (apiKey, provider, model, context).  The main process retrieves those from
 * the DB/Keychain before forwarding.
 */

import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("aiWorker must run as a utilityProcess (parentPort missing)");

const port = parentPort;

type AiRequest =
  | { id: string; type: "callAi"; provider: string; model: string; apiKey: string; systemPrompt: string; userMessage: string; maxTokens?: number; imageDataUri?: string }
  | { id: string; type: "transcribeAudio"; provider: string; apiKey: string; audioBase64: string; mimeType: string }
  | { id: string; type: "ping" };

/** Parse a data URI into mimeType + base64 string. Returns null if not a data URI. */
function parseDataUri(uri: string): { mimeType: string; base64: string } | null {
  const m = uri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
}

async function callAiProvider(
  provider: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048,
  imageDataUri?: string
): Promise<string> {
  const imageInfo = imageDataUri ? parseDataUri(imageDataUri) : null;

  if (provider === "openai") {
    // Build user content — text only, or text + image for vision requests
    const userContent: unknown = imageInfo
      ? [
          { type: "text", text: userMessage },
          { type: "image_url", image_url: { url: imageDataUri, detail: "auto" } }
        ]
      : userMessage;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ],
        max_completion_tokens: maxTokens
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content || "No response from model.";

  } else if (provider === "anthropic") {
    const userContent: unknown = imageInfo
      ? [
          {
            type: "image",
            source: { type: "base64", media_type: imageInfo.mimeType, data: imageInfo.base64 }
          },
          { type: "text", text: userMessage }
        ]
      : userMessage;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
        max_tokens: maxTokens
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    return data.content?.[0]?.text || "No response from model.";

  } else if (provider === "google") {
    const userParts: unknown[] = imageInfo
      ? [
          { inline_data: { mime_type: imageInfo.mimeType, data: imageInfo.base64 } },
          { text: userMessage }
        ]
      : [{ text: userMessage }];

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: userParts }],
          generationConfig: { maxOutputTokens: maxTokens }
        })
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from model.";
  }

  throw new Error("Unsupported provider.");
}

/**
 * Transcribe audio using the configured provider.
 * OpenAI → Whisper API (multipart/form-data).
 * Anthropic / Google → base64 audio passed to the chat API with a transcription prompt.
 */
async function transcribeAudio(
  provider: string,
  apiKey: string,
  audioBase64: string,
  mimeType: string
): Promise<string> {
  if (provider === "openai") {
    // Build a multipart form with the audio blob
    const audioBytes = Buffer.from(audioBase64, "base64");
    // Derive a filename extension from mimeType
    const ext = mimeType.includes("webm") ? "webm"
      : mimeType.includes("ogg") ? "ogg"
      : mimeType.includes("mp4") ? "mp4"
      : mimeType.includes("mpeg") ? "mp3"
      : mimeType.includes("wav") ? "wav"
      : "webm";

    // Build form data manually (no FormData in utilityProcess without a browser context)
    const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;
    const CRLF = "\r\n";
    const head = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="audio.${ext}"`,
      `Content-Type: ${mimeType}`,
      "",
      ""
    ].join(CRLF);
    const mid = [
      "",
      `--${boundary}`,
      `Content-Disposition: form-data; name="model"`,
      "",
      "whisper-1",
      `--${boundary}--`,
      ""
    ].join(CRLF);

    const headBuf = Buffer.from(head);
    const midBuf = Buffer.from(mid);
    const body = Buffer.concat([headBuf, audioBytes, midBuf]);

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Whisper API error (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json() as { text: string };
    return data.text?.trim() || "";

  } else if (provider === "anthropic") {
    // Anthropic supports audio input natively for Claude 3.5+
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        system: "You are a transcription engine. Transcribe the audio exactly as spoken. Output only the transcription text, no commentary.",
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: mimeType, data: audioBase64 }
            },
            { type: "text", text: "Transcribe this audio exactly as spoken." }
          ]
        }],
        max_tokens: 2048
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    return data.content?.[0]?.text?.trim() || "";

  } else if (provider === "google") {
    // Gemini supports inline audio
    const ext = mimeType.includes("webm") ? "webm"
      : mimeType.includes("ogg") ? "ogg"
      : mimeType.includes("wav") ? "wav" : "webm";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: "You are a transcription engine. Output only the transcription, no commentary." }] },
          contents: [{
            role: "user",
            parts: [
              { inline_data: { mime_type: `audio/${ext}`, data: audioBase64 } },
              { text: "Transcribe this audio exactly as spoken." }
            ]
          }]
        })
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google API error (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  }

  throw new Error("Unsupported provider for transcription.");
}

port.on("message", async (msg: AiRequest) => {
  if (msg.type === "ping") {
    port.postMessage({ id: msg.id, ok: true, result: "pong" });
    return;
  }

  if (msg.type === "callAi") {
    try {
      const result = await callAiProvider(
        msg.provider, msg.model, msg.apiKey,
        msg.systemPrompt, msg.userMessage, msg.maxTokens,
        msg.imageDataUri
      );
      port.postMessage({ id: msg.id, ok: true, result });
    } catch (err: any) {
      port.postMessage({ id: msg.id, ok: false, error: err.message || String(err) });
    }
    return;
  }

  if (msg.type === "transcribeAudio") {
    try {
      const result = await transcribeAudio(msg.provider, msg.apiKey, msg.audioBase64, msg.mimeType);
      port.postMessage({ id: msg.id, ok: true, result });
    } catch (err: any) {
      port.postMessage({ id: msg.id, ok: false, error: err.message || String(err) });
    }
    return;
  }
});
