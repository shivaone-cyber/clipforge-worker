import { hostname } from "node:os";
// HTTPS client for the ClipForge cloud. Pull-based: nothing listens locally.

const BASE = (process.env.API_BASE_URL || "").replace(/\/$/, "");
const SECRET = process.env.WORKER_SECRET || "";
const rawId = process.env.WORKER_ID || hostname() || "worker";
export const WORKER_ID = `${rawId}-${process.env.RAILWAY_REPLICA_ID || Math.random().toString(36).slice(2, 6)}`;
export const WORKER_VERSION = "2.2.1";
// Declared to the queue on every claim. The cloud refuses to lease a V2
// Kick Story job to a worker that does not advertise both of these.
export const RENDER_CONTRACT_VERSIONS = [1, 2];
export const CAPABILITIES = ["KICK_STORY_RECOMPOSE", "FULL_FRAME_9_16", "REFRAME_SOURCE", "QUALITY_PIPELINE", "AI_HOOK", "SAFE_HOOK_MASK_V1", "AI_HOOK_STATE_V1", "FULL_BACKGROUND_V1", "MEASURED_TYPOGRAPHY_V1", "CUSTOM_FONTS_V1", "EMOJI_FALLBACK_V1"];

if (!BASE) throw new Error("API_BASE_URL is not set");
if (!SECRET) throw new Error("WORKER_SECRET is not set");

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Worker-Secret": SECRET,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed [${res.status}]: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export const api = {
  claim: () =>
    post("/api/public/worker/claim", {
      worker_id: WORKER_ID,
      worker_version: WORKER_VERSION,
      render_contract_versions: RENDER_CONTRACT_VERSIONS,
      capabilities: CAPABILITIES,
    }),
  hook: (payload) => post("/api/public/worker/hook", { worker_id: WORKER_ID, ...payload }),
  analyze: (payload) => post("/api/public/worker/analyze", { worker_id: WORKER_ID, ...payload }),
  heartbeat: (jobId) => post("/api/public/worker/heartbeat", { job_id: jobId, worker_id: WORKER_ID }),
  progress: (jobId, patch) => post("/api/public/worker/progress", { job_id: jobId, worker_id: WORKER_ID, ...patch }),
  complete: (jobId, patch) => post("/api/public/worker/complete", { job_id: jobId, worker_id: WORKER_ID, ...patch }),
  fail: (jobId, reason, detail, retryable = true, userMessage = null, diagnostics = null) =>
    post("/api/public/worker/fail", {
      job_id: jobId,
      worker_id: WORKER_ID,
      reason,
      detail,
      retryable,
      ...(userMessage ? { user_message: userMessage } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    }),
};
