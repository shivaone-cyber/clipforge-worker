import { createServer } from "node:http";
// ClipForge local render worker.
// Pull model: this process reaches OUT over HTTPS. Nothing on your machine is exposed.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { api, WORKER_ID, WORKER_VERSION } from "./api.js";
import { detectContentRect, detectEmbeddedStoryRect, detectStoryRegions, probe } from "./analyze.js";
import { direct } from "./director.js";
import { makeHook } from "./hook.js";
import { validateOutput } from "./validate.js";
import { compactHeadline, render, requestedModeOf, resolveRenderMode } from "./render.js";
import { resolveSource } from "./sources/index.js";
import { renderFontPreview } from "./text.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 4000);

// Custom fonts are cached by asset path + size so the same font is downloaded
// once per machine instead of once per render.
const FONT_CACHE_DIR = join(tmpdir(), "clipforge-font-cache");

async function cachedCustomFont(fontUrl, assetPath) {
  await mkdir(FONT_CACHE_DIR, { recursive: true });
  const ext = String(assetPath ?? "font.ttf").split(".").pop().replace(/[^a-z0-9]/gi, "") || "ttf";
  const key = createHash("sha256").update(String(assetPath ?? fontUrl)).digest("hex").slice(0, 32);
  const file = join(FONT_CACHE_DIR, `${key}.${ext}`);
  try {
    const cached = await stat(file);
    if (cached.size > 0) return { path: file, cached: true };
  } catch {
    // not cached yet
  }
  const res = await fetch(fontUrl);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.byteLength) throw new Error("empty font file");
  await writeFile(file, bytes);
  return { path: file, cached: false };
}

// Sanitize an AI/user headline before it ever reaches the text rasterizer:
// control characters and zero-width joiner spam break glyph measurement.
function sanitizeHeadline(text) {
  if (!text) return null;
  const clean = String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return clean || null;
}

function stage(timings, name) {
  const at = Date.now();
  return () => {
    timings[name] = Date.now() - at;
  };
}

async function fileState(file) {
  try {
    const s = await stat(file);
    return { exists: true, bytes: s.size };
  } catch {
    return { exists: false, bytes: 0 };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

let stopping = false;
process.on("SIGTERM", () => { stopping = true; console.log(new Date().toISOString(), "SIGTERM received"); });
process.on("SIGINT", () => { stopping = true; console.log(new Date().toISOString(), "SIGINT received"); });

if (process.env.PORT) {
  createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(stopping ? 503 : 200);
      res.end(stopping ? "stopping" : "ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(process.env.PORT);
}

async function uploadRendered(upload, file, contentType = "video/mp4") {
  const body = await readFile(file);
  const res = await fetch(upload.url, {
    method: "PUT",
    headers: { "Content-Type": contentType, "x-upsert": "true" },
    body,
  });
  if (!res.ok) throw new Error(`upload failed [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  return body.byteLength;
}

async function processJob(job, upload) {
  const dir = await mkdtemp(join(tmpdir(), "clipforge-"));
  const input = join(dir, "input.mp4");
  const output = join(dir, "output.mp4");
  const startedAt = Date.now();
  const timings = {};
  const diag = { job_id: job.id, worker_version: WORKER_VERSION, stage: "init" };
  let beat;

  try {
    // Heartbeat every 15s: AI, FFmpeg, QA and upload all run under this lease.
    beat = setInterval(() => api.heartbeat(job.id).catch(() => {}), 15_000);

    if (job.source_kind === "font_preview" && job.render_config?.previewType === "font") {
      const config = job.render_config;
      let customFontPath = null;
      if (job.font_url && config.fontConfig?.source === "custom") {
        const fontResponse = await fetch(job.font_url);
        if (!fontResponse.ok) throw Object.assign(new Error(`font download ${fontResponse.status}`), { reason: "font", retryable: false });
        customFontPath = join(dir, `custom.${String(config.fontConfig?.customFontPath ?? "font.ttf").split(".").pop()}`);
        await writeFile(customFontPath, new Uint8Array(await fontResponse.arrayBuffer()));
      }
      const preview = renderFontPreview({ text: config.previewText, config: config.fontConfig, customPath: customFontPath });
      const canvas = createCanvas(preview.canvasWidth, preview.canvasHeight);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, preview.canvasWidth, preview.canvasHeight);
      ctx.fillStyle = "#00e701";
      ctx.fillRect(0, preview.canvasHeight - 18, preview.canvasWidth, 18);
      ctx.drawImage(await loadImage(preview.png), preview.offsetX, preview.offsetY);
      const previewPath = join(dir, "font-preview.png");
      await writeFile(previewPath, canvas.toBuffer("image/png"));
      const bytes = await uploadRendered(upload, previewPath, "image/png");
      const proof = {
        preview: true,
        output_width: preview.canvasWidth,
        output_height: preview.canvasHeight,
        typography: {
          measured: true,
          font_source: preview.font.source,
          font_preset: preview.font.preset,
          font_validation: preview.font.validation,
          emoji_fallback_used: preview.coverage.emojiFallbackUsed,
          missing_glyphs: preview.coverage.missing,
        },
        quality: { ok: preview.coverage.missing.length === 0, problems: preview.coverage.missing.length ? ["missing glyphs"] : [] },
      };
      if (!proof.quality.ok) throw Object.assign(new Error("font preview glyph validation failed"), { reason: "quality", retryable: false });
      log(job.id, `FONT_PREVIEW_PROOF ${JSON.stringify(proof)}`);
      await api.complete(job.id, { output_path: upload.path, output_bytes: bytes, duration_ms: Date.now() - startedAt, render_proof: proof });
      log(job.id, "font preview delivered");
      return;
    }

    const fromLink = !job.source_url && job.source_reference;
    diag.stage = "download";
    await api.progress(job.id, {
      status: "downloading",
      step: 1,
      label: fromLink ? "Fetching video" : "Receiving video",
    });
    let done = stage(timings, "download_ms");
    await resolveSource(job, input, (m) => log(job.id, m));
    const sourceStat = await stat(input);
    if (!sourceStat.size) throw Object.assign(new Error("downloaded source is empty"), { reason: "download", retryable: false });
    diag.input_bytes = sourceStat.size;
    done();
    log(job.id, `source ready (${(sourceStat.size / 1024 / 1024).toFixed(1)} MB)`);

    diag.stage = "ffprobe";
    await api.progress(job.id, { status: "analyzing", step: 3, label: "Analyzing video" });
    let meta;
    done = stage(timings, "ffprobe_ms");
    try {
      meta = await probe(input);
      meta.content_rect = await detectContentRect(input, meta);
    } catch (error) {
      throw Object.assign(error, { reason: "probe", retryable: false });
    }
    done();
    if (!(meta.width > 0) || !(meta.height > 0) || !(meta.duration > 0)) {
      throw Object.assign(new Error(`unusable source metadata ${meta.width}x${meta.height} ${meta.duration}s`), {
        reason: "probe",
        retryable: false,
      });
    }
    Object.assign(diag, {
      source_width: meta.width,
      source_height: meta.height,
      source_fps: meta.fps ?? null,
      source_codec: meta.codec ?? null,
      source_duration: meta.duration,
      source_has_audio: meta.has_audio === true,
    });
    await api.progress(job.id, {
      status: "analyzing",
      step: 4,
      label: "Analyzing video",
      analysis: meta,
      log: { step: "probe", message: `${meta.width}x${meta.height} ${meta.duration.toFixed(1)}s ${meta.codec}` },
    });

    let config = job.render_config || {};
    if (Number(config.renderContractVersion) >= 2 && requestedModeOf(config) === "kick_story") {
      const embeddedRect = await detectEmbeddedStoryRect(input, meta);
      if (embeddedRect) {
        meta.content_rect = embeddedRect;
        log(job.id, `EMBEDDED_STORY_FOREGROUND ${JSON.stringify(embeddedRect)}`);
      }
      const cropStartedAt = Date.now();
      meta.story_regions = await detectStoryRegions(input, meta, meta.content_rect);
      timings.crop_ms = Date.now() - cropStartedAt;
      log(job.id, `STORY_REGIONS ${JSON.stringify(meta.story_regions)}`);
    }
    diag.requested_mode = config.requestedMode ?? config.mode ?? null;
    diag.background_style = config.backgroundStyle ?? config.background?.style ?? null;
    diag.framing_mode = config.framingMode ?? config.video?.framingMode ?? null;
    diag.font_preset = config.fontConfig?.preset ?? null;
    diag.font_source = config.fontConfig?.source ?? null;

    // Font preparation runs alongside the AI work — it writes its own file only.
    diag.stage = "font_prepare";
    const fontDone = stage(timings, "font_prepare_ms");
    const fontPromise = (async () => {
      if (!(job.font_url && config.fontConfig?.source === "custom")) return null;
      try {
        const { path, cached } = await cachedCustomFont(job.font_url, config.fontConfig?.customFontPath);
        log(job.id, `FONT_READY source=custom cached=${cached}`);
        return path;
      } catch (error) {
        log(job.id, `FONT_FALLBACK reason=download_failed detail=${error.message}`);
        return null;
      }
    })().finally(fontDone);

    // AI director: analysis only, fully optional, never blocks the render.
    diag.stage = "ai_analysis";
    const aiDone = stage(timings, "ai_analysis_ms");
    const directorLogs = [];
    const directed = await direct({
      job,
      input,
      meta,
      dir,
      config,
      onLog: (message) => { directorLogs.push(message); log(job.id, message); },
    });
    aiDone();
    config = directed.config;
    if (config.content_rect) {
      if (Number(config.renderContractVersion) >= 2 && requestedModeOf(config) === "kick_story" && meta.story_regions) {
        log(job.id, `AI_PLAN_REJECTED field=content_rect ai=${JSON.stringify(config.content_rect)} kept=${JSON.stringify(meta.content_rect)} reason=protected_story_regions_win`);
      } else {
        meta.content_rect = config.content_rect;
      }
    }
    diag.ai_reason = directed.reason;
    for (const message of directorLogs) {
      await api
        .progress(job.id, { status: "analyzing", step: 4, label: "Analyzing video", log: { step: "ai_director", message } })
        .catch(() => {});
    }

    const customFontPath = await fontPromise;
    diag.font_resolved = customFontPath ? "custom" : config.fontConfig?.source === "custom" ? "fallback" : "preset";

    const isV2KickStory = Number(config.renderContractVersion) >= 2 && requestedModeOf(config) === "kick_story";
    if (isV2KickStory && (typeof config.aiHookEnabled !== "boolean" || !["PRESERVE_SOURCE", "ADD_NEW_HOOK"].includes(config.hookAction))) {
      throw Object.assign(new Error("V2 Kick Story requires an explicit AI hook choice"), { reason: "hook_config", retryable: false });
    }
    const aiHookEnabled = config.aiHookEnabled === true;
    // Never trust a stale mask from a queued config. Only this run's accepted
    // detection may attach one, and AI-off always starts from source pixels.
    config = { ...config, video: { ...(config.video ?? {}) } };
    delete config.video.oldHookMask;
    const resolved = {
      // AI-off keeps the embedded source hook untouched and never creates a
      // second generated headline.
      headline: null,
      brandText: config.branding?.text ?? null,
      customFontPath,
      hookAction: "PRESERVE_SOURCE",
    };

    // AI hook: runs AFTER the user's style choices are final. A failure here can
    // never stop the render — the existing headline (or none) is kept.
    diag.stage = "hook";
    const hookDone = stage(timings, "hook_ms");
    await api.progress(job.id, { status: "editing", step: 4, label: aiHookEnabled ? "Creating hook" : "Using main video hook" });
    const hookLogs = [];
    const hooked = await makeHook({
      job, input, meta, dir, config,
      frames: directed.frames,
      onLog: (message) => { hookLogs.push(message); log(job.id, message); },
    });
    hookDone();
    if (aiHookEnabled && hooked.hook?.hook && hooked.replacement?.allowed) {
      resolved.headline = sanitizeHeadline(compactHeadline(hooked.hook.hook, 55));
      resolved.hookReason = hooked.hook.reason ?? null;
      resolved.hookAction = hooked.replacement.mask ? "REPLACE_OLD_HOOK" : "ADD_NEW_HOOK";
      config = {
        ...config,
        video: {
          ...(config.video ?? {}),
          ...(hooked.replacement.mask ? { oldHookMask: hooked.replacement.mask } : {}),
        },
      };
    }
    if (!aiHookEnabled) resolved.hookReason = "original_source_hook_preserved";
    diag.hook = resolved.headline;
    diag.hook_reason = hooked.reason;
    for (const message of hookLogs) {
      await api
        .progress(job.id, { status: "editing", step: 4, label: "Creating hook", log: { step: "ai_hook", message } })
        .catch(() => {});
    }

    diag.stage = "layout";
    await api.progress(job.id, { status: "editing", step: 5, label: "Applying layout" });
    await api.progress(job.id, { status: "rendering", step: 6, label: "Rendering" });
    const requestedMode = requestedModeOf(config);
    const finalRenderMode = resolveRenderMode(config, meta, meta.content_rect, 1080, 1920);
    const debug = {
      jobId: job.id,
      telegramRequestId: job.telegram_message_id ?? null,
      requestedMode,
      requestedBackgroundStyle: config.backgroundStyle ?? config.background?.style ?? null,
      requestedFramingMode: config.framingMode ?? config.video?.framingMode ?? null,
      inputWidth: meta.width,
      inputHeight: meta.height,
      finalRenderMode,
      rendererBranch: finalRenderMode,
      aiAttempted: directed.attempted === true,
      aiSuccess: directed.reason === "applied",
      aiFailureReason: directed.reason === "applied" ? null : directed.reason,
      hookAttempted: hooked.attempted === true,
      hookSuccess: hooked.reason === "applied",
      hookFailureReason: hooked.reason === "applied" ? null : hooked.reason,
      hookReplacement: hooked.replacement?.reason ?? null,
      aiHookEnabled,
      hookAction: resolved.hookAction,
      oldHookDetected: hooked.analysis?.oldHook?.state === "present",
      oldHookRemoved: resolved.hookAction === "REPLACE_OLD_HOOK",
      newHeadlineRendered: Boolean(resolved.headline),
      geminiHookCalled: hooked.geminiCalled === true,
      headline: resolved.headline,
      ffmpegStarted: false,
    };
    log(job.id, `KICK_STORY_DEBUG ${JSON.stringify(debug)}`);
    await api
      .progress(job.id, { status: "rendering", step: 6, label: "Rendering", log: { step: "kick_story_debug", message: JSON.stringify(debug) } })
      .catch(() => {});

    // Pre-flight: everything FFmpeg needs must exist and be sane before we
    // start a long encode, so a failure names its own cause.
    diag.stage = "preflight";
    diag.render_mode = finalRenderMode;
    const preflight = [];
    try {
      const ready = await stat(input);
      if (!ready.size) preflight.push("input file is empty");
    } catch {
      preflight.push("input file missing before render");
    }
    if (resolved.customFontPath) {
      try {
        const f = await stat(resolved.customFontPath);
        if (!f.size) preflight.push("custom font file is empty");
      } catch {
        preflight.push("custom font file missing");
        resolved.customFontPath = null;
      }
    }
    if (!(meta.fps > 0)) preflight.push(`invalid source fps ${meta.fps}`);
    if (preflight.length) {
      throw Object.assign(new Error(`pre-flight failed: ${preflight.join("; ")}`), {
        reason: "preflight",
        retryable: false,
      });
    }

    diag.stage = "ffmpeg";
    const renderDone = stage(timings, "render_ms");
    let built;
    try {
      const renderLogs = [];
      built = await render({ input, output, config, meta, resolved, onLog: (message) => { renderLogs.push(message); log(job.id, message); } });
      for (const message of renderLogs) {
        await api.progress(job.id, { status: "rendering", step: 6, label: "Rendering", log: { step: "layout", message } });
      }
    } catch (error) {
      diag.ffmpeg_exit_code = error.code ?? null;
      diag.ffmpeg_stderr_tail = String(error.stderr ?? "").slice(-1500);
      diag.ffmpeg_graph_summary = String(error.graphSummary ?? "").slice(0, 600);
      throw Object.assign(error, { reason: "render" });
    }
    renderDone();
    diag.ffmpeg_exit_code = 0;

    // Hard production assertions — never deliver an unchanged source for a
    // Kick Story job, and never deliver the wrong geometry.
    const [inputSha, outputSha] = await Promise.all([sha256(input), sha256(output)]);
    const outMeta = await probe(output);
    const proof = {
      input_sha256: inputSha,
      output_sha256: outputSha,
      output_width: outMeta.width,
      output_height: outMeta.height,
      foreground_x: built.vx,
      foreground_width: built.vw,
      left_edge_gap: built.vx,
      right_edge_gap: 1080 - (built.vx + built.vw),
      renderer_branch: built.rendererBranch,
      ffmpeg_started: built.ffmpegStarted === true,
      headline_safe_rect: built.headlineSafeTop == null ? null : {
        top: built.headlineSafeTop,
        bottom: built.headlineSafeBottom,
        left: built.headlineSafeLeft,
        right: built.headlineSafeRight,
      },
      headline_bounding_box: built.headlineBoundingBox ?? null,
      output_fps: built.outputFps ?? null,
      color_grade: config.color_grade?.name ?? "professional",
      enhancement: built.enhancement ?? [],
      typography: built.typography ? {
        measured: built.typography.measured === true,
        font_source: built.typography.fontSource,
        font_preset: built.typography.fontPreset,
        font_validation: built.typography.fontValidation,
        emoji_fallback_used: built.typography.emojiFallbackUsed === true,
        missing_glyphs: built.typography.missingGlyphs ?? [],
        contrast_mode: built.typography.contrastMode,
        line_count: built.typography.lines?.length ?? 0,
        font_size: built.typography.fontSize,
        headline_top: built.typography.headlineTop,
        headline_bottom: built.typography.headlineBottom,
        video_top: built.typography.videoTop,
        headline_gap_to_video: built.typography.headlineGapToVideo,
      } : null,
      composition: requestedMode === "kick_story" ? {
        generated_footer: built.generatedFooter,
        lower_background_only: built.lowerBackgroundOnly,
        video_top: built.vy,
        video_bottom: built.videoBottom,
        foreground_height: built.vh,
        background_top_height: built.vy,
        background_bottom_height: built.backgroundBottomHeight,
        base_canvas_width: 1080,
        base_canvas_height: built.baseCanvasH ?? 1920,
        final_canvas_width: built.canvasW,
        final_canvas_height: built.canvasH,
        foreground_bottom: built.videoBottom,
        upper_background_height: built.upperBackgroundHeight,
        lower_background_height_before: built.lowerBackgroundHeightBefore,
        lower_background_height_after: built.lowerBackgroundHeightAfter,
        requested_trim_percent: built.requestedTrimPercent,
        requested_trim_pixels: built.requestedRemovalPixels,
        actual_trim_pixels: built.actualRemovedPixels,
        actual_trim_percent: built.actualRemovedPercent,
        trim_scope: built.trimScope,
        trim_skipped_reason: built.trimSkippedReason,
        foreground_changed: built.foregroundChanged,
        kick_strip_changed: built.kickStripChanged,
        background_style: built.backgroundStyle,
        foreground_x: built.vx,
        foreground_right: built.vx + built.vw,
        crop_top: built.cropTop ?? null,
        crop_bottom: built.cropBottom ?? null,
        crop_preference: built.cropPreference ?? null,
        protected_region_intersections: built.protectedRegionIntersections ?? null,
        kick_strip_protected: built.kickStripProtected ?? null,
        framing_fallback: built.framingFallback ?? null,
        foreground_fit: built.foregroundFit ?? null,
        source_height: built.sourceHeight ?? meta.height,
        source_top: built.sourceTop ?? null,
        source_bottom: built.sourceBottom ?? null,
        protected_story_top: built.protectedStoryTop ?? null,
        upper_hook_region: built.upperHookRegion ?? null,
        main_content_region: built.mainContentRegion ?? null,
        empty_lower_start: built.emptyLowerStart ?? null,
        empty_lower_end: built.emptyLowerEnd ?? null,
        kick_strip_top: built.kickStripTop ?? null,
        kick_strip_bottom: built.kickStripBottom ?? null,
        expendable_lower_height: built.expendableLowerHeight ?? 0,
        outer_padding_top: built.outerPaddingTop ?? null,
        outer_padding_bottom: built.outerPaddingBottom ?? null,
        outer_padding_height: built.outerPaddingHeight ?? 0,
        outer_padding_removed_pixels: built.outerPaddingRemovedPixels ?? 0,
        requested_crop_percent: built.requestedCropPercent ?? 0,
        requested_removal_pixels: built.requestedRemovalPixels ?? 0,
        actual_removed_pixels: built.actualRemovedPixels ?? 0,
        actual_removed_percent: built.actualRemovedPercent ?? 0,
        removal_mode: built.removalMode ?? "NONE",
        original_source_foreground_height: built.originalSourceForegroundHeight ?? null,
        assembled_source_height: built.assembledSourceHeight ?? null,
        join_position: built.joinPosition ?? null,
      } : null,
      hook: hooked.hook?.hook ?? null,
      hook_confidence: hooked.hook?.confidence ?? null,
      hook_specificity: hooked.hook?.specificity ?? null,
      hook_curiosity: hooked.hook?.curiosity ?? null,
      hook_naturalness: hooked.hook?.naturalness ?? null,
      hook_selected_score: hooked.hook?.compositeScore ?? null,
      hook_candidates_generated: hooked.hook?.candidateMetrics?.generated ?? hooked.candidateMetrics?.generated ?? 0,
      hook_candidates_rejected: hooked.hook?.candidateMetrics?.rejected ?? hooked.candidateMetrics?.rejected ?? 0,
      hook_rejection_counts: hooked.hook?.candidateMetrics?.rejectionCounts ?? hooked.candidateMetrics?.rejectionCounts ?? {},
      hook_duplicate_source_text: hooked.hook?.candidateMetrics?.duplicateSourceText ?? null,
      hook_emoji_count: resolved.headline ? Array.from(resolved.headline).filter((char) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(char)).length : 0,
      ai_hook_attempted: hooked.attempted === true,
      ai_hook_skipped: hooked.attempted !== true,
      ai_hook_enabled: aiHookEnabled,
      hook_action: resolved.hookAction,
      old_hook_detected: hooked.analysis?.oldHook?.state === "present",
      old_hook_removed: built.hookReplacement?.state === "replaced",
      new_headline_rendered: Boolean(built.typography),
      gemini_hook_called: hooked.geminiCalled === true,
      hook_replacement: built.hookReplacement ?? null,
    };
    log(job.id, `RENDER_PROOF ${JSON.stringify(proof)}`);
    await api
      .progress(job.id, { status: "uploading", step: 7, label: "Uploading", log: { step: "render_proof", message: JSON.stringify(proof) } })
      .catch(() => {});

    diag.stage = "qa";
    const qaDone = stage(timings, "qa_ms");
    const quality = await validateOutput({ output, outMeta, meta, expectSize: { width: built.canvasW, height: built.canvasH }, renderProof: proof });
    qaDone();
    proof.quality = quality;
    log(job.id, `QUALITY_VALIDATION ${JSON.stringify(quality)}`);
    await api
      .progress(job.id, { status: "uploading", step: 7, label: "Uploading", log: { step: "quality", message: JSON.stringify(quality) } })
      .catch(() => {});
    if (!quality.ok) {
      throw Object.assign(new Error(`quality validation failed: ${quality.problems.join("; ")}`), {
        reason: "quality",
        retryable: false,
      });
    }

    if (requestedMode === "kick_story") {
      const problems = [];
      if (inputSha === outputSha) problems.push("output identical to source");
      if (outMeta.width !== built.canvasW || outMeta.height !== built.canvasH) problems.push(`output ${outMeta.width}x${outMeta.height}`);
      const protectedSafeFit = built.foregroundFit === "SCALED_TO_FIT";
      if (protectedSafeFit) {
        // Protected-safe framing: the complete protected block (upper hook,
        // footage, creator overlay, KICK strip) could not fit at full canvas
        // width, so the untouched foreground was scaled down and centred
        // rather than cropped. Side surrounds must stay symmetric.
        if (Math.abs(proof.left_edge_gap - proof.right_edge_gap) > 2) problems.push("protected-safe foreground not centred");
        if (built.kickStripProtected !== true) problems.push("KICK strip not protected");
      } else {
        if (proof.foreground_x !== 0 || proof.foreground_width !== 1080) problems.push("foreground not full width");
        if (proof.left_edge_gap !== 0 || proof.right_edge_gap !== 0) problems.push("side gaps present");
      }
      if (built.rendererBranch !== "KICK_STORY_RECOMPOSE") problems.push(`branch ${built.rendererBranch}`);
      const safe = proof.headline_safe_rect;
      const box = proof.headline_bounding_box;
      if (resolved.headline && (!safe || !box || box.x < safe.left || box.y < safe.top || box.x + box.width > safe.right || box.y + box.height > safe.bottom)) {
        problems.push("headline outside safe rectangle");
      }
      if (problems.length) {
        throw Object.assign(new Error(`Kick Story assertion failed: ${problems.join("; ")}`), {
          reason: "assertion",
          retryable: false,
        });
      }
    }

    diag.stage = "upload";
    const uploadDone = stage(timings, "upload_ms");
    await api.progress(job.id, { status: "uploading", step: 7, label: "Uploading" });
    if (!upload?.url) throw Object.assign(new Error("no upload url"), { reason: "upload" });
    const bytes = await uploadRendered(upload, output);
    const onDisk = await stat(output);
    uploadDone();
    timings.total_ms = Date.now() - startedAt;
    log(job.id, `STAGE_TIMINGS ${JSON.stringify(timings)}`);
    await api
      .progress(job.id, { status: "uploading", step: 7, label: "Uploading", log: { step: "timings", message: JSON.stringify(timings) } })
      .catch(() => {});

    diag.stage = "complete";
    await api.complete(job.id, {
      output_path: upload.path,
      output_bytes: bytes || onDisk.size,
      duration_ms: Date.now() - startedAt,
      analysis: meta,
      headline: resolved.headline,
      render_proof: proof,
      caption: resolved.hookReason ?? null,
      timings,
    });
    log(job.id, `done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (error) {
    const reason = error.reason || "render";
    // Fail closed: nothing has been delivered, and the diagnostics below are
    // sanitized (no URLs, secrets, frames or prompts).
    diag.failure_stage = diag.stage;
    diag.failure_reason = reason;
    diag.retryable = error.retryable !== false;
    diag.timings = { ...timings, total_ms: Date.now() - startedAt };
    diag.output_state = await fileState(output);
    diag.input_state = await fileState(input);
    diag.error_message = String(error.message ?? "").slice(0, 500);
    log(job.id, "FAILED", reason, error.message);
    log(job.id, `RENDER_FAILURE ${JSON.stringify(diag)}`);
    await api
      .fail(
        job.id,
        reason,
        `${error.message}\n${(error.stderr || "").slice(0, 800)}`,
        error.retryable !== false,
        error.userMessage || null,
        diag,
      )
      .catch(() => {});
  } finally {
    if (beat) clearInterval(beat);
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  log(`ClipForge worker ${WORKER_VERSION} (${WORKER_ID}) started`);
  let idleLogged = false;
  let backoff = 0;
  for (;;) {
    if (stopping) {
      log("graceful shutdown: exiting");
      process.exit(0);
    }
    try {
      const { job, upload } = await api.claim();
      backoff = 0;
      if (!job) {
        if (!idleLogged) {
          log("waiting for jobs…");
          idleLogged = true;
        }
        await sleep(POLL_MS);
        continue;
      }
      idleLogged = false;
      log(`claimed job ${job.id} (${job.preset_slug}, attempt ${job.attempt})`);
      await processJob(job, upload);
    } catch (error) {
      backoff = Math.min(backoff + 5000, 60000);
      log(`poll error: ${error.message}. retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

main();
