// Source resolution. Uploads arrive as a signed storage URL; link jobs are
// handed to a platform module keyed by source_kind. Adding TikTok/YouTube
// later means dropping a module in here — the render pipeline below is
// untouched.

import { writeFile } from "node:fs/promises";

import * as instagram from "./instagram.js";

const MODULES = [instagram];
const MAX_BYTES = 190 * 1024 * 1024;

async function downloadDirect(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`download failed [${res.status}]`), { reason: "download" });
  const size = Number(res.headers.get("content-length") || 0);
  if (size > MAX_BYTES) throw Object.assign(new Error("source too large"), { reason: "download", retryable: false });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES)
    throw Object.assign(new Error("source too large"), { reason: "download", retryable: false });
  await writeFile(dest, buffer);
  return buffer.byteLength;
}

export async function resolveSource(job, dest, onLog = () => {}) {
  if (job.source_url) return downloadDirect(job.source_url, dest);

  const url = (job.source_reference || "").trim();
  const mod =
    MODULES.find((m) => m.kind === job.source_kind && m.match(url)) || MODULES.find((m) => m.match(url));
  if (!mod) {
    onLog(`source: no module for kind=${job.source_kind} url=${url.slice(0, 120)}`);
    throw Object.assign(new Error("unsupported source"), {
      reason: "download",
      retryable: false,
      userMessage: "That link type isn't supported yet. Upload the video file instead.",
    });
  }
  onLog(`source: using ${mod.kind} module`);
  return (await mod.fetchVideo(url, dest, onLog)) || 0;
}
