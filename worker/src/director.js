// AI Video Director client (worker side).
// Samples a few frames, asks the cloud for an edit plan, and merges it into the
// render config. The provider key lives only in the cloud — never here.
// Any failure (disabled, timeout, bad JSON, rate limit) falls back silently to
// the deterministic FFprobe/FFmpeg pipeline.

import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { api } from "./api.js";
import { requestedModeOf } from "./render.js";

const run = promisify(execFile);

const ENABLED = String(process.env.AI_DIRECTOR ?? "true").toLowerCase() !== "false";
const FRAME_COUNT = Math.min(5, Math.max(3, Number(process.env.AI_DIRECTOR_FRAMES || 3)));
const TIMEOUT_MS = Number(process.env.AI_DIRECTOR_TIMEOUT_MS || 45000);
const MIN_CONFIDENCE = Number(process.env.AI_DIRECTOR_MIN_CONFIDENCE || 0.6);

// Timestamp-seek sampling: 3 frames at ~5% / 50% / 90% (5 only when asked for).
// `-ss` before `-i` keeps this an input seek, so the full video is never decoded.
// The extractions are independent files, so they run concurrently.
export async function sampleFrames(input, meta, dir, count = 3) {
  const span = Math.max(meta.duration || 0, 1);
  const ratios = count >= 5 ? [0.05, 0.3, 0.5, 0.7, 0.9] : count === 4 ? [0.05, 0.4, 0.7, 0.9] : [0.05, 0.5, 0.9];
  const shots = await Promise.all(
    ratios.map(async (ratio, i) => {
      const file = join(dir, `frame-${i}.jpg`);
      try {
        await run("ffmpeg", [
          "-y", "-hide_banner", "-loglevel", "error",
          "-ss", (span * ratio).toFixed(2), "-i", input,
          "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", file,
        ]);
        const data = (await readFile(file)).toString("base64");
        await unlink(file).catch(() => {});
        return data;
      } catch {
        return null; // a missing frame is not fatal
      }
    }),
  );
  return shots.filter(Boolean);
}

// Merge an AI plan into the render config, never past hard safety limits.
// An explicit user mode (original / kick-story-recompose) always wins — the AI
// may then only refine spacing, subject position and protected regions.
export function applyPlan(config, plan, meta, onLog) {
  const next = {
    ...config,
    video: { ...(config.video || {}) },
    headline: { ...(config.headline || {}) },
    background: { ...(config.background || {}) },
  };
  const requested = requestedModeOf(config);
  const explicit = requested !== "auto";
  const aiMode =
    plan.mode === "KICK_STORY_RECOMPOSE"
      ? "kick-story-recompose"
      : plan.mode === "REFRAME_SOURCE"
        ? "reframe"
        : "original";
  if (explicit) {
    if (plan.mode && plan.mode !== String(config.mode ?? "").toUpperCase()) {
      onLog?.(
        `AI_PLAN_REJECTED field=mode ai=${plan.mode} kept=${requested} reason=explicit_user_mode_wins`,
      );
    }
  } else {
    next.video.mode = aiMode;
    next.video.crop =
      plan.cropMode === "SMART_CROP" ? "smart" : plan.cropMode === "FILL" ? "fill" : "safe-fit";
    next.video.framingMode =
      plan.cropMode === "SMART_CROP" ? "smart_crop" : plan.cropMode === "FILL" ? "fill" : "safe_fit";
  }
  if (aiMode === "reframe" || aiMode === "kick-story-recompose") {
    next.video.adaptive = true;
    next.video.topPadding = plan.topPadding;
    next.video.bottomPadding = plan.bottomPadding;
    if (plan.headline && next.headline.enabled !== false) {
      next.headline.enabled = true;
      next.headline.text = next.headline.text || plan.headline;
      next.headline.position = plan.headlinePosition;
    }
  }
  // AI never overrides an explicit user background choice.
  if (!next.background.style && ["white", "black", "blur"].includes(String(plan.background))) {
    next.background.style = plan.background;
    next.background.mode = plan.background === "blur" ? "blurred" : plan.background;
  }
  next.video.subject = plan.subjectPosition;
  if (Array.isArray(plan.importantRegions) && plan.importantRegions.length) {
    next.video.protectedRegions = plan.importantRegions.slice(0, 8);
  }
  const b = plan.contentBounds;
  const full = b.x === 0 && b.y === 0 && b.width === meta.width && b.height === meta.height;
  if (!full && b.width >= meta.width * 0.5 && b.height >= meta.height * 0.5) {
    next.content_rect = { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  return next;
}

export async function direct({ job, input, meta, dir, config, onLog }) {
  if (!ENABLED) {
    onLog?.("AI_FALLBACK reason=disabled — deterministic renderer");
    return { config, plan: null, frames: [], reason: "disabled", attempted: false };
  }
  const startedAt = Date.now();
  try {
    const frames = await sampleFrames(input, meta, dir, FRAME_COUNT);
    if (!frames.length) {
      onLog?.("AI_FALLBACK reason=no_frames — deterministic renderer");
      return { config, plan: null, frames: [], reason: "no_frames", attempted: false };
    }
    onLog?.(`AI_REQUEST_STARTED frames=${frames.length} timeout_ms=${TIMEOUT_MS}`);

    const result = await Promise.race([
      api.analyze({
        job_id: job.id,
        frames,
        width: meta.width,
        height: meta.height,
        duration: meta.duration,
        content_rect: meta.content_rect,
        preset: job.preset_slug,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("ai timeout")), TIMEOUT_MS)),
    ]);
    const latency = Date.now() - startedAt;
    onLog?.(`AI_RESPONSE_RECEIVED latency_ms=${latency} model=${result?.model ?? "unknown"} plan=${result?.plan ? "present" : "missing"}`);

    const plan = result?.plan;
    if (!plan) {
      onLog?.("AI_FALLBACK reason=unavailable — deterministic renderer");
      return { config, plan: null, frames, reason: "unavailable", attempted: true, latency };
    }
    if (plan.confidence < MIN_CONFIDENCE) {
      onLog?.(`AI_PLAN_REJECTED reason=low_confidence value=${plan.confidence} min=${MIN_CONFIDENCE}`);
      onLog?.("AI_FALLBACK reason=low_confidence — deterministic renderer");
      return { config, plan, frames, reason: "low_confidence", attempted: true, latency };
    }
    onLog?.(
      `AI_PLAN_VALIDATED mode=${plan.mode} crop=${plan.cropMode} confidence=${plan.confidence} headline=${JSON.stringify(plan.headline)}`,
    );
    return { config: applyPlan(config, plan, meta, onLog), plan, frames, reason: "applied", attempted: true, latency };
  } catch (error) {
    onLog?.(`AI_FALLBACK reason=error detail=${error.message} latency_ms=${Date.now() - startedAt} — deterministic renderer`);
    return { config, plan: null, frames: [], reason: "error", attempted: true };
  }
}
