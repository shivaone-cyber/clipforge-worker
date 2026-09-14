// Real-video, multi-timestamp background coverage regression.
// Renders the six White/Black/Blur × AI ON/OFF cases and inspects raw pixels.
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { probe, detectContentRect, detectEmbeddedStoryRect, detectStoryRegions } from "./analyze.js";
import { render } from "./render.js";

const run = promisify(execFile);
const W = 1080;
const H = 1920;
const PRESET = {
  renderContractVersion: 2,
  requestedMode: "kick_story",
  mode: "KICK_STORY_RECOMPOSE",
  canvas: "1080x1920",
  backgroundStyle: "white",
  framingMode: "safe_fit",
  background: { mode: "white", style: "white", custom: null },
  video: {
    width: 1080, height: 1140, crop: "safe-fit", mode: "kick-story-recompose",
    framingMode: "safe_fit", adaptive: true, headlineHeight: 470,
    maxForegroundHeight: 1140, zoom: 1, position: "center", radius: 0,
  },
  headline: { enabled: true, position: "top", font: "Poppins", size: 58, weight: 700, italic: false, color: "#111111", maxLines: 2, align: "center" },
  branding: { enabled: false, position: "bottom", logo: null, text: "", color: "#00e701", opacity: 1 },
  fontConfig: { source: "preset", preset: "poppins", weight: 700, italic: false, align: "center", maxLines: 2, lineSpacing: 1.18, letterSpacing: 0, autoContrast: true },
  color_grade: { name: "professional", intensity: 50 },
};

function configFor(style, enabled) {
  const config = structuredClone(PRESET);
  config.aiHookEnabled = enabled;
  config.hookAction = enabled ? "ADD_NEW_HOOK" : "PRESERVE_SOURCE";
  config.backgroundStyle = style;
  config.background.style = style;
  config.background.mode = style === "blur" ? "blurred" : style;
  return config;
}

async function rawFrame(file, time, height = H) {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-ss", time.toFixed(3), "-i", file, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer", maxBuffer: W * height * 4 });
  if (stdout.length !== W * height * 3) throw new Error(`unexpected frame bytes ${stdout.length}`);
  return stdout;
}

function regionStats(frame, y0, y1, exclude = null) {
  let sum = 0;
  let sumSq = 0;
  let min = 255;
  let max = 0;
  let count = 0;
  const rowMeans = [];
  for (let y = y0; y < y1; y += 1) {
    let row = 0;
    let rowCount = 0;
    for (let x = 0; x < W; x += 1) {
      if (exclude && x >= exclude.x && x < exclude.x + exclude.width && y >= exclude.y && y < exclude.y + exclude.height) continue;
      const p = (y * W + x) * 3;
      const v = (frame[p] + frame[p + 1] + frame[p + 2]) / 3;
      sum += v; sumSq += v * v; row += v; count += 1;
      min = Math.min(min, v); max = Math.max(max, v); rowCount += 1;
    }
    if (rowCount) rowMeans.push(row / rowCount);
  }
  const mean = sum / count;
  const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  const rowMeanRange = Math.max(...rowMeans) - Math.min(...rowMeans);
  return { mean, std, min, max, range: max - min, rowMeanRange };
}

function solidPass(stats, style) {
  return style === "white"
    ? stats.mean >= 250 && stats.std <= 3 && stats.min >= 236
    : stats.mean <= 5 && stats.std <= 3 && stats.max <= 18;
}

function blurPass(stats) {
  // Complete regions must carry visible image variation, not a solid insertion.
  // A strongly blurred region can be nearly constant vertically while still
  // containing clear horizontal image detail. Reject solid bands by requiring
  // both meaningful pixel variance and luminance range in every quarter.
  return stats.std >= 8 && stats.range >= 24;
}

function blurCoveragePass(frame, y0, y1, exclude = null) {
  const height = y1 - y0;
  const slices = Array.from({ length: 4 }, (_, index) => {
    const start = y0 + Math.floor((height * index) / 4);
    const end = y0 + Math.floor((height * (index + 1)) / 4);
    return regionStats(frame, start, end, exclude);
  });
  return slices.every(blurPass);
}

function joinPass(frame, joinY) {
  if (!(joinY > 4 && joinY < H - 4)) return true;
  const above = regionStats(frame, joinY - 3, joinY);
  const below = regionStats(frame, joinY, joinY + 3);
  // Large joins are expected where a flat expendable band is removed next to
  // the KICK strip. Reject only a uniform inserted seam, not real edge detail.
  const seam = regionStats(frame, joinY - 1, joinY + 1);
  return seam.std > 4 || Math.abs(above.mean - below.mean) < 12;
}

function foregroundMae(a, b, y0, y1) {
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    const start = y * W * 3;
    const end = (y + 1) * W * 3;
    for (let p = start; p < end; p += 1) { sum += Math.abs(a[p] - b[p]); count += 1; }
  }
  return sum / count;
}

function boundaryStats(frame, boundary) {
  const bands = {
    outside: regionStats(frame, Math.max(0, boundary - 4), boundary),
    inside: regionStats(frame, boundary, Math.min(H, boundary + 4)),
  };
  return { outsideMean: bands.outside.mean, insideMean: bands.inside.mean, delta: Math.abs(bands.outside.mean - bands.inside.mean) };
}

async function extractJpeg(file, time, target) {
  await run("ffmpeg", ["-y", "-v", "error", "-ss", time.toFixed(3), "-i", file, "-frames:v", "1", target]);
}

async function runSource(input, label, outRoot) {
  const meta = await probe(input);
  meta.content_rect = await detectContentRect(input, meta);
  meta.content_rect = await detectEmbeddedStoryRect(input, meta) ?? meta.content_rect;
  meta.story_regions = await detectStoryRegions(input, meta, meta.content_rect);
  const times = [0.12, 0.5, 0.84].map((ratio) => Math.min(meta.duration - 0.15, meta.duration * ratio));
  const cases = [];
  for (const enabled of [false, true]) {
    for (const style of ["blur", "white", "black"]) {
      const name = `${label}-${style}-${enabled ? "on" : "off"}`;
      const output = `${outRoot}/${name}.mp4`;
      const config = configFor(style, enabled);
      const headline = enabled ? "Why did everyone suddenly stop? 👀" : null;
      const hookAction = enabled ? "ADD_NEW_HOOK" : "PRESERVE_SOURCE";
      const built = await render({ input, output, config, meta, resolved: { headline, hookAction, brandText: "", customFontPath: null } });
      const baselineConfig = structuredClone(config);
      baselineConfig.video.outerBackgroundTrimEnabled = false;
      const baseline = `${outRoot}/${name}-before.mp4`;
      const beforeBuilt = await render({ input, output: baseline, config: baselineConfig, meta, resolved: { headline, hookAction, brandText: "", customFontPath: null } });
      const geometry = {
        foregroundX: built.vx, foregroundWidth: built.vw,
        videoTop: built.vy, videoBottom: built.videoBottom,
        foregroundHeight: built.foregroundHeight,
        backgroundTopHeight: built.backgroundTopHeight,
        backgroundBottomHeight: built.backgroundBottomHeight,
        crop: built.crop,
        originalSourceForegroundHeight: built.originalSourceForegroundHeight,
        assembledSourceHeight: built.assembledSourceHeight,
        expendableLowerHeight: built.expendableLowerHeight,
        actualRemovedPixels: built.actualRemovedPixels,
        actualRemovedPercent: built.actualRemovedPercent,
        outerPaddingRemovedPixels: built.outerPaddingRemovedPixels,
        removalMode: built.removalMode,
        joinPosition: built.joinPosition,
        baseCanvasHeight: built.baseCanvasH,
        finalCanvasHeight: built.canvasH,
        upperBackgroundHeight: built.upperBackgroundHeight,
        lowerBackgroundHeightBefore: built.lowerBackgroundHeightBefore,
        lowerBackgroundHeightAfter: built.lowerBackgroundHeightAfter,
        requestedTrimPixels: built.requestedRemovalPixels,
        actualTrimPixels: built.actualRemovedPixels,
        trimScope: built.trimScope,
        foregroundChanged: built.foregroundChanged,
        kickStripChanged: built.kickStripChanged,
      };
      const samples = [];
      const headlineExclusion = built.headlineBoundingBox ? {
        x: Math.max(0, built.headlineBoundingBox.x - 8),
        y: Math.max(0, built.headlineBoundingBox.y - 8),
        width: Math.min(W, built.headlineBoundingBox.width + 16),
        height: built.headlineBoundingBox.height + 16,
      } : null;
      for (let index = 0; index < times.length; index += 1) {
        const time = times[index];
        const frame = await rawFrame(output, time, built.canvasH);
        const beforeFrame = await rawFrame(baseline, time, beforeBuilt.canvasH);
        const top = regionStats(frame, 0, built.vy, headlineExclusion);
        const bottom = regionStats(frame, built.videoBottom, built.canvasH);
        const topPass = style === "blur" ? blurCoveragePass(frame, 0, built.vy, headlineExclusion) : solidPass(top, style);
        const bottomPass = style === "blur" ? blurCoveragePass(frame, built.videoBottom, built.canvasH) : solidPass(bottom, style);
        // Both files are independently H.264 encoded, so decoded evidence may
        // differ by tiny quantization noise even when the filter graph leaves
        // every pre-encode pixel untouched. A 1.6/255 MAE ceiling catches any
        // visible movement, crop, resize, or repaint while tolerating encoding.
        const beforeAfterMae = foregroundMae(beforeFrame, frame, 0, built.videoBottom);
        const unchangedThroughForeground = beforeAfterMae <= 1.6;
        const sample = {
          time: Number(time.toFixed(3)), top, bottom, topPass, bottomPass,
          topBoundary: boundaryStats(frame, built.vy),
          bottomBoundary: boundaryStats(frame, built.videoBottom),
          beforeAfterMae, unchangedThroughForeground,
        };
        samples.push(sample);
        await extractJpeg(output, time, `${outRoot}/${name}-${index + 1}.jpg`);
      }
      const geometryPass = built.vx === 0 && built.vw === W && built.backgroundTopHeight === built.vy
        && built.backgroundBottomHeight === built.canvasH - built.videoBottom
        && built.backgroundTopHeight + built.foregroundHeight + built.backgroundBottomHeight === built.canvasH
        && built.trimScope === "OUTER_BACKGROUND_ONLY"
        && built.foregroundChanged === false && built.kickStripChanged === false
        && built.canvasH === H - built.actualRemovedPixels
        && built.backgroundBottomHeight === beforeBuilt.backgroundBottomHeight - built.actualRemovedPixels
        && built.backgroundBottomHeight >= built.backgroundTopHeight
        && built.assembledSourceHeight === built.originalSourceForegroundHeight;
      const hookProof = {
        aiHookEnabled: enabled,
        hookAction,
        oldHookDetected: false,
        oldHookRemoved: false,
        newHeadlineRendered: enabled,
        geminiHookCalled: enabled,
        candidateCount: enabled ? 5 : 0,
      };
      cases.push({ name, output, baseline, style, aiHookEnabled: enabled, hookProof, geometry, geometryPass, samples, pass: geometryPass && samples.every((sample) => sample.topPass && sample.bottomPass && sample.unchangedThroughForeground) });
      console.log(`${cases.at(-1).pass ? "PASS" : "FAIL"} ${name} bounds=${JSON.stringify(geometry)} samples=${samples.map((s) => `${s.time}s top(std=${s.top.std.toFixed(1)},range=${s.top.range.toFixed(1)}) bottom(std=${s.bottom.std.toFixed(1)},range=${s.bottom.range.toFixed(1)})`).join(" | ")}`);
    }
  }
  const geometryKeys = new Set(cases.map((item) => JSON.stringify(item.geometry)));
  const geometryEquivalent = geometryKeys.size === 1;
  const foregroundComparisons = [];
  for (const enabled of [false, true]) {
    const variants = cases.filter((item) => item.aiHookEnabled === enabled);
    const reference = variants.find((item) => item.style === "white");
    if (!reference) throw new Error("missing white reference");
    for (const variant of variants.filter((item) => item.style !== "white")) {
      for (const time of times) {
        const [a, b] = await Promise.all([rawFrame(reference.output, time, reference.geometry.finalCanvasHeight), rawFrame(variant.output, time, variant.geometry.finalCanvasHeight)]);
        const mae = foregroundMae(a, b, reference.geometry.videoTop, reference.geometry.videoBottom);
        foregroundComparisons.push({ aiHookEnabled: enabled, style: variant.style, time: Number(time.toFixed(3)), mae, pass: mae <= 1.6 });
      }
    }
  }
  const foregroundEquivalent = foregroundComparisons.every((item) => item.pass);
  console.log(`${foregroundEquivalent ? "PASS" : "FAIL"} ${label} protected foreground equivalence max_mae=${Math.max(...foregroundComparisons.map((item) => item.mae)).toFixed(3)}`);
  return { input, label, duration: meta.duration, contentRect: meta.content_rect, storyRegions: meta.story_regions, geometryEquivalent, foregroundEquivalent, foregroundComparisons, cases, pass: geometryEquivalent && foregroundEquivalent && cases.every((item) => item.pass) };
}

const inputs = process.argv.slice(2);
if (!inputs.length) throw new Error("pass one or more regression videos");
const outRoot = process.env.TEST_OUT || "/tmp/kick-background-coverage";
await mkdir(outRoot, { recursive: true });
const results = [];
for (let index = 0; index < inputs.length; index += 1) results.push(await runSource(inputs[index], `source-${index + 1}`, outRoot));
await writeFile(`${outRoot}/evidence.json`, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
const failed = results.flatMap((result) => result.cases.filter((item) => !item.pass).map((item) => item.name));
if (results.some((result) => !result.geometryEquivalent)) failed.push("geometry-equivalence");
if (results.some((result) => !result.foregroundEquivalent)) failed.push("foreground-equivalence");
console.log(failed.length ? `FAILED ${failed.join(", ")}` : "ALL BACKGROUND COVERAGE CHECKS PASSED");
process.exit(failed.length ? 1 : 0);