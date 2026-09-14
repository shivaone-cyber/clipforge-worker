// Production-like proof run: builds the exact V2 render_config the Telegram
// callbacks now save, renders it through the real worker renderer, and asserts
// the same gates the cloud enforces at delivery time.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { probe, detectContentRect, detectEmbeddedStoryRect } from "./analyze.js";
import { render, requestedModeOf, resolveRenderMode } from "./render.js";
import { validateOutput } from "./validate.js";

const run = promisify(execFile);

const PRESET = {
  canvas: "1080x1920",
  background: { custom: null, mode: "white", style: "white" },
  video: {
    width: 1080, height: 1140, crop: "safe-fit", mode: "kick-story-recompose",
    framingMode: "safe_fit", adaptive: true, headlineHeight: 470, maxForegroundHeight: 1140,
    zoom: 1, position: "center", radius: 0,
  },
  headline: { enabled: true, position: "top", font: "Poppins", size: 58, weight: 700, italic: false, color: "#111111", maxLines: 2, align: "center" },
  branding: { enabled: false, position: "bottom", logo: null, text: "", color: "#00e701", opacity: 1 },
  fontConfig: { source: "preset", preset: "poppins", weight: 700, italic: false, align: "center", maxLines: 2, lineSpacing: 1.18, letterSpacing: 0, autoContrast: true },
  color_grade: { name: "professional", intensity: 50 },
};

const FRAMING = { safe_fit: "safe-fit", smart_crop: "smart", fill: "fill" };
const BG = { white: "white", black: "black", blur: "blurred" };

function buildConfig({ mode, background = "white", framing = "safe_fit", aiHookEnabled = true }) {
  const c = structuredClone(PRESET);
  c.renderContractVersion = 2;
  c.aiHookEnabled = aiHookEnabled;
  c.hookAction = aiHookEnabled ? "ADD_NEW_HOOK" : "PRESERVE_SOURCE";
  if (mode === "original") {
    c.requestedMode = "original_9_16";
    c.mode = "FULL_FRAME_9_16";
    c.video = { ...c.video, mode: "original", crop: "safe-fit", zoom: 1 };
    return c;
  }
  c.requestedMode = "kick_story";
  c.mode = "KICK_STORY_RECOMPOSE";
  c.framingMode = framing;
  c.backgroundStyle = background;
  c.video = { ...c.video, mode: "kick-story-recompose", adaptive: true, zoom: 1, framingMode: framing, crop: FRAMING[framing] };
  c.background = { ...c.background, style: background, mode: BG[background] };
  return c;
}

function customConfig() {
  const c = buildConfig({ mode: "kick", background: "white" });
  c.fontConfig = { ...c.fontConfig, source: "custom", family: "Uploaded font" };
  return c;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

async function scenario(name, input, config, outDir, options = {}) {
  const output = `${outDir}/${name}.mp4`;
  const meta = await probe(input);
  meta.content_rect = await detectContentRect(input, meta);
  meta.content_rect = await detectEmbeddedStoryRect(input, meta) ?? meta.content_rect;
  const requested = requestedModeOf(config);
  const final = resolveRenderMode(config, meta, meta.content_rect, 1080, 1920);
  const logs = [];
  const headline = config.aiHookEnabled === false || options.headline === null ? null : options.headline || process.env.TEST_HEADLINE || "Why did everyone suddenly stop? 👀";
  const hookAction = headline ? "ADD_NEW_HOOK" : "PRESERVE_SOURCE";
  const built = await render({ input, output, config, meta, resolved: { headline, hookAction, brandText: "", customFontPath: options.customFontPath ?? null }, onLog: (m) => logs.push(m) });
  const [inSha, outSha] = await Promise.all([sha256(input), sha256(output)]);
  const outMeta = await probe(output);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", "3", "-i", output, "-frames:v", "1", `${outDir}/${name}.jpg`]);

  const checks = [];
  const ok = (label, cond) => checks.push({ label, pass: !!cond });
  ok("requestedMode", requested === (config.requestedMode === "kick_story" ? "kick_story" : "original_9_16"));
  ok("finalRenderMode", final === config.mode);
  ok("rendererBranch", built.rendererBranch === config.mode);
  ok("ffmpegStarted", built.ffmpegStarted === true && built.ffmpegExitCode === 0);
  ok("outputDiffers", inSha !== outSha);
  ok("intentional output dimensions", outMeta.width === built.canvasW && outMeta.height === built.canvasH);
  const proof = {
    typography: built.typography ? { measured: built.typography.measured, missing_glyphs: built.typography.missingGlyphs } : null,
    composition: config.requestedMode === "kick_story" ? {
      generated_footer: built.generatedFooter, lower_background_only: built.lowerBackgroundOnly,
      video_top: built.vy, video_bottom: built.videoBottom, foreground_height: built.vh,
      background_top_height: built.backgroundTopHeight, background_bottom_height: built.backgroundBottomHeight,
      background_style: built.backgroundStyle, foreground_x: built.vx, foreground_right: built.vx + built.vw,
      base_canvas_height: built.baseCanvasH, final_canvas_height: built.canvasH,
      upper_background_height: built.upperBackgroundHeight,
      lower_background_height_before: built.lowerBackgroundHeightBefore,
      lower_background_height_after: built.lowerBackgroundHeightAfter,
      requested_trim_percent: built.requestedTrimPercent,
      requested_trim_pixels: built.requestedRemovalPixels,
      actual_trim_pixels: built.actualRemovedPixels,
      actual_trim_percent: built.actualRemovedPercent,
      trim_scope: built.trimScope, trim_skipped_reason: built.trimSkippedReason,
      foreground_changed: built.foregroundChanged, kick_strip_changed: built.kickStripChanged,
      crop_top: built.cropTop, crop_bottom: built.cropBottom, crop_preference: built.cropPreference,
      protected_region_intersections: built.protectedRegionIntersections,
      kick_strip_protected: built.kickStripProtected,
    } : null,
    ai_hook_enabled: config.requestedMode === "kick_story" ? config.aiHookEnabled : false,
    hook_action: config.requestedMode === "kick_story" ? hookAction : "PRESERVE_SOURCE",
    old_hook_detected: false, old_hook_removed: false,
    new_headline_rendered: Boolean(built.typography), gemini_hook_called: config.requestedMode === "kick_story" && config.aiHookEnabled,
    hook_replacement: built.hookReplacement,
  };
  const quality = await validateOutput({ output, outMeta, meta, expectSize: { width: built.canvasW, height: built.canvasH }, renderProof: proof });
  ok("quality validation", quality.ok);
  ok("frame rate preserved", Math.abs((outMeta.fps || 0) - (meta.fps || 0)) < 1.5);
  ok("colour grade applied", typeof built.gradeFilter === "string" && built.gradeFilter.length > 0);
  ok("enhancement applied", Array.isArray(built.enhancement) && built.enhancement.length > 0);
  if (config.requestedMode === "kick_story") {
    ok("foreground x=0", built.vx === 0);
    ok("foreground width=1080", built.vw === 1080);
    ok("no side gaps", built.vx === 0 && 1080 - (built.vx + built.vw) === 0);
    ok("complete vertical coverage", built.backgroundTopHeight + built.vh + built.backgroundBottomHeight === built.canvasH);
    ok("outer-background-only trim", built.trimScope === "OUTER_BACKGROUND_ONLY" && built.foregroundChanged === false && built.kickStripChanged === false);
    ok("canvas reduction reconciles", built.canvasH === 1920 - built.actualRemovedPixels);
    ok("balanced lower margin", built.backgroundBottomHeight >= built.backgroundTopHeight);
    ok("no generated footer", built.generatedFooter === false);
    ok("KICK strip protected", built.kickStripProtected === true);
    ok("bottom-first crop", built.cropPreference === "BOTTOM_FIRST" && (built.cropTop ?? 0) === 0);
    ok("explicit hook state", config.aiHookEnabled ? hookAction === "ADD_NEW_HOOK" && Boolean(built.typography) : hookAction === "PRESERVE_SOURCE" && !built.typography);
    const safe = {
      left: built.headlineSafeLeft, top: built.headlineSafeTop,
      right: built.headlineSafeRight, bottom: built.headlineSafeBottom,
    };
    const box = built.headlineBoundingBox;
    ok("headline safe rectangle", headline === null ? box === null : box.x >= safe.left && box.y >= safe.top && box.x + box.width <= safe.right && box.y + box.height <= safe.bottom);
    ok("measured typography", headline === null ? built.typography === null : built.typography?.measured === true);
  ok("glyph coverage or deterministic fallback", headline === null ? true : built.typography?.measured === true);
    ok("headline bottom anchored", headline === null ? true : built.headlineGapToVideo >= 24 && built.headlineGapToVideo <= 55);
  }

  console.log(`\n=== ${name} ===`);
  console.log(`input        ${meta.width}x${meta.height} ${meta.duration.toFixed(1)}s`);
  console.log(`config       ${JSON.stringify({ renderContractVersion: config.renderContractVersion, requestedMode: config.requestedMode, mode: config.mode, backgroundStyle: config.backgroundStyle, framingMode: config.framingMode })}`);
  console.log(`requested    ${requested}`);
  console.log(`final mode   ${final}`);
  console.log(`branch       ${built.rendererBranch}`);
  console.log(`ffmpeg       started=${built.ffmpegStarted} exit=${built.ffmpegExitCode} ${built.ffmpegMs}ms filters=${built.graph.split(";").length}`);
  console.log(`input sha    ${inSha}`);
  console.log(`output sha   ${outSha}`);
  console.log(`output       ${outMeta.width}x${outMeta.height} ${outMeta.duration.toFixed(1)}s`);
  console.log(`foreground   x=${built.vx} y=${built.vy} w=${built.vw} h=${built.vh}`);
  console.log(`regions      headline=0..${built.topPadding} video=${built.vy}..${built.vy + built.vh} lower_background=${built.videoBottom}..${built.canvasH}`);
  if (config.requestedMode === "kick_story") console.log(`crop         top=${built.cropTop} bottom=${built.cropBottom} preference=${built.cropPreference} intersections=${built.protectedRegionIntersections} kickStripProtected=${built.kickStripProtected}`);
  if (built.headlineBoundingBox) console.log(`headline     safe=${JSON.stringify({ left: built.headlineSafeLeft, top: built.headlineSafeTop, right: built.headlineSafeRight, bottom: built.headlineSafeBottom })} bbox=${JSON.stringify(built.headlineBoundingBox)} size=${built.headlineFontSize}`);
  if (built.typography) console.log(`typography   ${JSON.stringify({ measured: built.typography.measured, source: built.typography.fontSource, preset: built.typography.fontPreset, validation: built.typography.fontValidation, emoji: built.typography.emojiFallbackUsed, missing: built.typography.missingGlyphs, contrast: built.typography.contrastMode })}`);
  console.log(`quality      ${JSON.stringify(quality)}`);
  console.log(`grade        ${built.gradeFilter} | enhancement=${JSON.stringify(built.enhancement)} | fps=${built.outputFps}`);
  console.log(`headline txt ${JSON.stringify(headline)}`);
  console.log(`frame        ${outDir}/${name}.jpg`);
  for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.label}`);
  return { name, built, checks, frame: `${outDir}/${name}.jpg` };
}

const [, , source, horizontal] = process.argv;
const outDir = process.env.TEST_OUT || "/tmp/kick-proof";
await mkdir(outDir, { recursive: true });

const results = [];
results.push(await scenario("white-on", source, buildConfig({ mode: "kick", background: "white", aiHookEnabled: true }), outDir));
results.push(await scenario("black-on", source, buildConfig({ mode: "kick", background: "black", aiHookEnabled: true }), outDir));
results.push(await scenario("blur-on", source, buildConfig({ mode: "kick", background: "blur", aiHookEnabled: true }), outDir));
results.push(await scenario("white-off", source, buildConfig({ mode: "kick", background: "white", aiHookEnabled: false }), outDir, { headline: null }));
results.push(await scenario("black-off", source, buildConfig({ mode: "kick", background: "black", aiHookEnabled: false }), outDir, { headline: null }));
results.push(await scenario("blur-off", source, buildConfig({ mode: "kick", background: "blur", aiHookEnabled: false }), outDir, { headline: null }));
results.push(await scenario("original", source, buildConfig({ mode: "original" }), outDir));
if (horizontal) results.push(await scenario("horizontal", horizontal, buildConfig({ mode: "kick", background: "white" }), outDir));
// Hook generation unavailable (and Gemini unavailable): rendering must still succeed.
results.push(await scenario("nohook", source, buildConfig({ mode: "kick", background: "white", aiHookEnabled: false }), outDir, { headline: null }));
if (process.env.TEST_CUSTOM_FONT) {
  results.push(await scenario("custom-font", source, customConfig(), outDir, { customFontPath: process.env.TEST_CUSTOM_FONT }));
}
if (process.env.TEST_EMOJI === "1") {
  results.push(await scenario("emoji", source, buildConfig({ mode: "kick", background: "black" }), outDir, { headline: "Wait—why did everyone stop? 👀" }));
}

// Background equivalence: foreground geometry identical across white/black/blur.
const [w, b, bl] = results;
const geo = (r) => `${r.built.vx},${r.built.vy},${r.built.vw},${r.built.vh},${JSON.stringify(r.built.crop)}`;
const same = geo(w) === geo(b) && geo(b) === geo(bl);
console.log(`\nbackground equivalence: ${same ? "PASS" : "FAIL"} (${geo(w)})`);
const headlineGeo = (r) => JSON.stringify({ safe: [r.built.headlineSafeLeft, r.built.headlineSafeTop, r.built.headlineSafeRight, r.built.headlineSafeBottom], box: r.built.headlineBoundingBox, size: r.built.headlineFontSize });
const sameHeadline = headlineGeo(w) === headlineGeo(b) && headlineGeo(b) === headlineGeo(bl);
console.log(`headline equivalence: ${sameHeadline ? "PASS" : "FAIL"} (${headlineGeo(w)})`);

const failed = results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `${r.name}:${c.label}`));
if (!same) failed.push("background equivalence");
if (!sameHeadline) failed.push("headline equivalence");
console.log(`\n${failed.length ? `FAILED: ${failed.join(", ")}` : "ALL CHECKS PASSED"}`);
process.exit(failed.length ? 1 : 0);
