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
  | { id: string; type: "callAi"; provider: string; model: string; apiKey: string; systemPrompt: string; userMessage: string; maxTokens?: number }
  | { id: string; type: "ping" };

async function callAiProvider(
  provider: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048
): Promise<string> {
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
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
        messages: [{ role: "user", content: userMessage }],
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
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
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

port.on("message", async (msg: AiRequest) => {
  if (msg.type === "ping") {
    port.postMessage({ id: msg.id, ok: true, result: "pong" });
    return;
  }

  if (msg.type === "callAi") {
    try {
      const result = await callAiProvider(
        msg.provider, msg.model, msg.apiKey,
        msg.systemPrompt, msg.userMessage, msg.maxTokens
      );
      port.postMessage({ id: msg.id, ok: true, result });
    } catch (err: any) {
      port.postMessage({ id: msg.id, ok: false, error: err.message || String(err) });
    }
    return;
  }
});
