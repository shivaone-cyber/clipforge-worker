// AI hook/caption client (worker side). The provider key lives only in the
// cloud. Any failure — disabled, timeout, 429, malformed JSON, low confidence —
// silently keeps whatever headline the job already had.

import { api } from "./api.js";
import { sampleFrames } from "./director.js";

const ENABLED = String(process.env.AI_HOOK ?? "true").toLowerCase() !== "false";
const TIMEOUT_MS = Number(process.env.AI_HOOK_TIMEOUT_MS || 45000);
const MIN_CONFIDENCE = Number(process.env.AI_HOOK_MIN_CONFIDENCE || 0.45);
const MASK_CONFIDENCE = Number(process.env.OLD_HOOK_MIN_CONFIDENCE || 0.82);

const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
const intersection = (a, b) => {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
};

export function assessHookReplacement(hook, meta, additionalProtected = []) {
  const old = hook?.oldHook;
  if (!hook?.hook || !old) return { allowed: false, reason: "missing_analysis", mask: null };
  if (old.state === "absent") {
    return old.confidence >= MASK_CONFIDENCE
      ? { allowed: true, reason: "no_old_hook", mask: null }
      : { allowed: false, reason: "absence_low_confidence", mask: null };
  }
  if (old.state !== "present") return { allowed: false, reason: "old_hook_uncertain", mask: null };
  if (old.confidence < MASK_CONFIDENCE) return { allowed: false, reason: "old_hook_low_confidence", mask: null };
  if (old.stableAcrossFrames !== true) return { allowed: false, reason: "old_hook_not_stable", mask: null };
  const r = old.region;
  if (!r || r.width < 0.04 || r.height < 0.012 || area(r) > 0.18 || r.y + r.height > 0.48) {
    return { allowed: false, reason: "old_hook_region_unsafe", mask: null };
  }
  const overlap = [...(old.protectedRegions ?? []), ...(additionalProtected ?? [])].some((protectedRegion) => {
    const shared = intersection(r, protectedRegion);
    return shared > 0 && shared / Math.max(0.000001, Math.min(area(r), area(protectedRegion))) > 0.01;
  });
  if (overlap) return { allowed: false, reason: "old_hook_intersects_protected", mask: null };
  const x = Math.max(0, Math.floor(r.x * meta.width));
  const y = Math.max(0, Math.floor(r.y * meta.height));
  const right = Math.min(meta.width, Math.ceil((r.x + r.width) * meta.width));
  const bottom = Math.min(meta.height, Math.ceil((r.y + r.height) * meta.height));
  const mask = { x, y, width: right - x, height: bottom - y, confidence: old.confidence };
  if (mask.width < 8 || mask.height < 8) return { allowed: false, reason: "old_hook_mask_too_small", mask: null };
  return { allowed: true, reason: "safe_replace", mask };
}

export function styleLabel(config) {
  return [
    config?.requestedMode ?? config?.mode ?? "kick_story",
    config?.backgroundStyle ?? config?.background?.style ?? "white",
    config?.framingMode ?? config?.video?.framingMode ?? "safe_fit",
  ].join(" ");
}

export async function makeHook({ job, input, meta, dir, config, frames, onLog }) {
  if (config?.aiHookEnabled === false || config?.hookAction === "PRESERVE_SOURCE" || !ENABLED) {
    onLog?.("HOOK_FALLBACK reason=disabled");
    return { hook: null, analysis: null, reason: "disabled", attempted: false, geminiCalled: false };
  }
  const startedAt = Date.now();
  try {
    const shots = frames?.length ? frames : await sampleFrames(input, meta, dir);
    if (!shots.length) {
      onLog?.("HOOK_FALLBACK reason=no_frames");
      return { hook: null, analysis: null, reason: "no_frames", attempted: false, geminiCalled: false };
    }
    onLog?.(`HOOK_REQUEST_STARTED frames=${shots.length} style=${styleLabel(config)}`);
    const result = await Promise.race([
      api.hook({
        job_id: job.id,
        frames: shots,
        width: meta.width,
        height: meta.height,
        duration: meta.duration,
        style: styleLabel(config),
        ai_hook_enabled: true,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("hook timeout")), TIMEOUT_MS)),
    ]);
    const latency = Date.now() - startedAt;
    const hook = result?.hook;
    if (!hook?.hook) {
      onLog?.(`HOOK_FALLBACK reason=unavailable latency_ms=${latency}`);
      return { hook: null, analysis: null, reason: "unavailable", attempted: true, geminiCalled: true };
    }
    if (Number(hook.confidence) < MIN_CONFIDENCE) {
      onLog?.(`HOOK_REJECTED reason=low_confidence value=${hook.confidence} min=${MIN_CONFIDENCE}`);
      return { hook: null, analysis: hook, reason: "low_confidence", attempted: true, geminiCalled: true };
    }
    if (Number(hook.specificity) < 0.55 || !String(hook.evidence ?? "").trim()) {
      onLog?.(`HOOK_REJECTED reason=not_grounded specificity=${Number(hook.specificity) || 0}`);
      return { hook: null, analysis: hook, reason: "not_grounded", attempted: true, geminiCalled: true };
    }
    const replacement = assessHookReplacement(hook, meta, config?.video?.protectedRegions);
    if (!replacement.allowed) {
      onLog?.(`HOOK_REPLACEMENT_REJECTED reason=${replacement.reason} old_hook_state=${hook.oldHook?.state ?? "missing"} confidence=${Number(hook.oldHook?.confidence) || 0}`);
      return { hook: null, analysis: hook, reason: replacement.reason, attempted: true, geminiCalled: true, replacement, candidateMetrics: hook.candidateMetrics ?? null };
    }
    onLog?.(
      `HOOK_GENERATED latency_ms=${latency} confidence=${hook.confidence} specificity=${hook.specificity} curiosity=${hook.curiosity} naturalness=${hook.naturalness} score=${hook.compositeScore} candidates=${hook.candidateMetrics?.generated ?? 0} rejected=${hook.candidateMetrics?.rejected ?? 0} old_hook=${hook.oldHook.state} replacement=${replacement.reason}`,
    );
    return { hook, analysis: hook, reason: "applied", attempted: true, geminiCalled: true, latency, replacement };
  } catch (error) {
    onLog?.(`HOOK_FALLBACK reason=error detail=${error.message}`);
    return { hook: null, analysis: null, reason: "error", attempted: true, geminiCalled: true };
  }
}
