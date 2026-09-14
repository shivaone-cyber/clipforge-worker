// Deterministic media analysis. FFprobe answers everything cheap and exact;
// AI is only ever used later for creative decisions, never for metadata.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((s) => s.codec_type === "video");
  const audio = (data.streams || []).find((s) => s.codec_type === "audio");
  if (!video) throw new Error("no video stream");

  const [num, den] = String(video.r_frame_rate || "30/1").split("/").map(Number);
  const rotation = Math.abs(Number(video.rotation ?? video.side_data_list?.[0]?.rotation ?? 0)) % 180;
  const swap = rotation === 90;

  const width = swap ? Number(video.height) : Number(video.width);
  const height = swap ? Number(video.width) : Number(video.height);

  return {
    width,
    height,
    aspect: width / height,
    orientation: height > width ? "vertical" : width === height ? "square" : "horizontal",
    duration: Number(data.format?.duration ?? video.duration ?? 0),
    fps: den ? num / den : 30,
    bitrate: Number(data.format?.bit_rate ?? 0),
    codec: video.codec_name,
    has_audio: Boolean(audio),
    size_bytes: Number(data.format?.size ?? 0),
  };
}

function mostCommonCrop(stderr, sourceWidth, sourceHeight) {
  const matches = [...String(stderr).matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map((match) => ({
    x: Number(match[3]), y: Number(match[4]), w: Number(match[1]), h: Number(match[2]),
  }));
  if (matches.length < 3) return null;
  const counts = new Map();
  for (const rect of matches) {
    const key = `${rect.x}:${rect.y}:${rect.w}:${rect.h}`;
    const item = counts.get(key) ?? { rect, count: 0 };
    item.count += 1;
    counts.set(key, item);
  }
  const winner = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  if (!winner || winner.count / matches.length < 0.65) return null;
  const { rect } = winner;
  const left = rect.x;
  const right = sourceWidth - rect.x - rect.w;
  const top = rect.y;
  const bottom = sourceHeight - rect.y - rect.h;
  const meaningfulBorder = Math.max(left, right) >= sourceWidth * 0.02 || Math.max(top, bottom) >= sourceHeight * 0.02;
  const conservative = rect.w >= sourceWidth * 0.65 && rect.h >= sourceHeight * 0.65;
  const balancedX = Math.min(left, right) >= Math.max(left, right) * 0.45;
  const balancedY = Math.min(top, bottom) >= Math.max(top, bottom) * 0.45;
  return meaningfulBorder && conservative && (balancedX || balancedY) ? rect : null;
}

async function detectCrop(file, meta, filter) {
  try {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-loglevel", "info", "-t", String(Math.min(20, Math.max(3, meta.duration))), "-i", file, "-vf", `fps=1/2,${filter}cropdetect=limit=24:round=2:reset=1`, "-an", "-f", "null", "-"]);
    return mostCommonCrop(stderr, meta.width, meta.height);
  } catch (error) {
    return mostCommonCrop(error.stderr, meta.width, meta.height);
  }
}

// Detect stable black or white bars. Ambiguous scene-dependent crops are ignored.
export async function detectContentRect(file, meta) {
  const full = { x: 0, y: 0, w: meta.width, h: meta.height };
  const [darkBars, lightBars] = await Promise.all([detectCrop(file, meta, ""), detectCrop(file, meta, "negate,")]);
  const candidates = [darkBars, lightBars].filter(Boolean);
  return candidates.length ? candidates.sort((a, b) => b.w * b.h - a.w * a.h)[0] : full;
}

// A failed prior Story render can itself be submitted as the next source. In
// that case ordinary cropdetect sees a complete 9:16 frame and retains its old
// empty bands. This detector looks for a stable, full-width detailed block and
// only returns it when both boundaries are strong across three timestamps.
// It never removes side content and deliberately fails closed to the full frame.
export async function detectEmbeddedStoryRect(file, meta) {
  if (Math.abs(meta.width / meta.height - 9 / 16) / (9 / 16) > 0.02) return null;
  const width = 270;
  const height = 480;
  const times = [0.08, 0.5, 0.86].map((ratio) => Math.min(Math.max(0, meta.duration * ratio), Math.max(0, meta.duration - 0.1)));
  try {
    const rows = await Promise.all(times.map(async (time) => {
      const { stdout } = await run("ffmpeg", [
        "-v", "error", "-ss", time.toFixed(3), "-i", file, "-frames:v", "1",
        "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
      ], { encoding: "buffer", maxBuffer: width * height * 4 });
      if (stdout.length !== width * height * 3) throw new Error("unexpected frame size");
      const result = [];
      for (let y = 0; y < height; y += 1) {
        let sum = 0;
        let sumSq = 0;
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 3;
          const value = (stdout[offset] + stdout[offset + 1] + stdout[offset + 2]) / 3;
          sum += value;
          sumSq += value * value;
        }
        const mean = sum / width;
        result.push(Math.sqrt(Math.max(0, sumSq / width - mean * mean)));
      }
      return result;
    }));
    const variance = Array.from({ length: height }, (_, y) => rows.reduce((sum, row) => sum + row[y], 0) / rows.length);
    const detailed = (start, count) => variance.slice(start, start + count).filter((value) => value >= 22).length >= count * 0.7;
    const quiet = (start, count) => variance.slice(start, start + count).filter((value) => value <= 10).length >= count * 0.8;
    let top = -1;
    for (let y = Math.round(height * 0.08); y < Math.round(height * 0.42); y += 1) {
      if (detailed(y, 24) && variance[y] - variance[Math.max(0, y - 2)] >= 12) { top = y; break; }
    }
    let bottom = -1;
    let bottomStrength = 0;
    const bottomLimit = Math.min(Math.round(height * 0.9), top + Math.round(height * 0.48));
    for (let y = Math.max(top + 80, Math.round(height * 0.45)); y < bottomLimit; y += 1) {
      const strength = variance[Math.max(0, y - 2)] - variance[y];
      if (quiet(y, 24) && strength >= 12 && strength > bottomStrength) {
        bottom = y;
        bottomStrength = strength;
      }
    }
    if (top < 0 || bottom < 0 || bottom - top < height * 0.3 || bottom - top > height * 0.72) return null;
    const scaleX = meta.width / width;
    const scaleY = meta.height / height;
    const y = Math.max(0, Math.round(top * scaleY / 2) * 2);
    const h = Math.min(meta.height - y, Math.round((bottom - top) * scaleY / 2) * 2);
    return { x: 0, y, w: meta.width, h };
  } catch {
    return null;
  }
}

function evenFloor(value) {
  const rounded = Math.max(0, Math.floor(value));
  return rounded - (rounded % 2);
}

// Maps the protected story block and any stable expendable lower area. The
// analysis uses three timestamps and row statistics only; no creative model is
// allowed to decide which source pixels can be removed.
export async function detectStoryRegions(file, meta, storyRect) {
  const rect = storyRect ?? { x: 0, y: 0, w: meta.width, h: meta.height };
  const sampleW = 270;
  const sampleH = 480;
  const times = [0.12, 0.5, 0.84].map((ratio) => Math.min(Math.max(0, meta.duration * ratio), Math.max(0, meta.duration - 0.1)));
  try {
    const frames = await Promise.all(times.map(async (time) => {
      const { stdout } = await run("ffmpeg", [
        "-v", "error", "-ss", time.toFixed(3), "-i", file, "-frames:v", "1",
        "-vf", `scale=${sampleW}:${sampleH}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
      ], { encoding: "buffer", maxBuffer: sampleW * sampleH * 4 });
      if (stdout.length !== sampleW * sampleH * 3) throw new Error("unexpected frame size");
      return stdout;
    }));
    const metrics = frames.map((frame) => Array.from({ length: sampleH }, (_, y) => {
      let sum = 0;
      let sumSq = 0;
      for (let x = 0; x < sampleW; x += 1) {
        const p = (y * sampleW + x) * 3;
        const value = (frame[p] + frame[p + 1] + frame[p + 2]) / 3;
        sum += value;
        sumSq += value * value;
      }
      const mean = sum / sampleW;
      return { mean, std: Math.sqrt(Math.max(0, sumSq / sampleW - mean * mean)) };
    }));
    const stable = Array.from({ length: sampleH }, (_, y) => ({
      mean: metrics.reduce((sum, rows) => sum + rows[y].mean, 0) / metrics.length,
      std: metrics.reduce((sum, rows) => sum + rows[y].std, 0) / metrics.length,
      meanSpread: Math.max(...metrics.map((rows) => rows[y].mean)) - Math.min(...metrics.map((rows) => rows[y].mean)),
    }));
    const sy = meta.height / sampleH;
    const rectTop = Math.max(0, Math.round(rect.y / sy));
    const rectBottom = Math.min(sampleH, Math.round((rect.y + rect.h) / sy));

    // The creator/KICK strip is the last stable high-contrast band in the
    // detected story block. Keep a conservative 6–18% protected band.
    let kickTop = Math.max(rectTop, rectBottom - Math.round((rectBottom - rectTop) * 0.12));
    for (let y = rectBottom - 2; y >= rectTop + Math.round((rectBottom - rectTop) * 0.62); y -= 1) {
      const window = stable.slice(Math.max(rectTop, y - 8), Math.min(rectBottom, y + 8));
      const detail = window.reduce((sum, row) => sum + row.std, 0) / Math.max(1, window.length);
      if (detail >= 24) kickTop = y;
      else if (kickTop < rectBottom - 4) break;
    }
    kickTop = Math.max(rectTop + 2, Math.min(rectBottom - 2, kickTop));

    // Only a stable quiet run directly above the strip is an internal gap.
    // Quiet pixels after the complete strip are outer canvas padding and are
    // measured separately; they must never be reported as source-content crop.
    const quiet = (row) => row.std <= 10 && row.meanSpread <= 5;
    let emptyStart = kickTop;
    while (emptyStart > rectTop && quiet(stable[emptyStart - 1])) emptyStart -= 1;
    let emptyEnd = kickTop;
    let removalMode = "LOWER_INTERNAL_GAP";
    let outerPaddingStart = rectBottom;
    let outerPaddingEnd = rectBottom;
    if (kickTop - emptyStart < Math.round(sampleH * 0.025)) {
      emptyStart = kickTop;
      emptyEnd = kickTop;
      // Permit a narrow antialiased boundary immediately after the strip.
      // It is retained; only the stable quiet run after it is expendable.
      const searchLimit = Math.min(sampleH, rectBottom + Math.round(sampleH * 0.035));
      while (outerPaddingStart < searchLimit && !quiet(stable[outerPaddingStart])) outerPaddingStart += 1;
      outerPaddingEnd = outerPaddingStart;
      while (outerPaddingEnd < sampleH && quiet(stable[outerPaddingEnd])) outerPaddingEnd += 1;
      removalMode = "NONE";
    }

    const sourceTop = evenFloor(rectTop * sy);
    const kickStripTop = evenFloor(kickTop * sy);
    const kickStripBottom = evenFloor(rectBottom * sy);
    const emptyLowerStart = evenFloor(emptyStart * sy);
    const emptyLowerEnd = evenFloor(emptyEnd * sy);
    const expendableLowerHeight = Math.max(0, emptyLowerEnd - emptyLowerStart);
    const detectedOuterPaddingTop = evenFloor(outerPaddingStart * sy);
    const outerPaddingTop = kickStripBottom;
    const outerPaddingBottom = evenFloor(outerPaddingEnd * sy);
    const outerPaddingHeight = Math.max(0, outerPaddingBottom - outerPaddingTop);
    const originalSourceForegroundHeight = kickStripBottom - sourceTop;
    const requestedRemovalPixels = evenFloor(originalSourceForegroundHeight * 0.25);
    const actualRemovedPixels = Math.min(requestedRemovalPixels, expendableLowerHeight);
    const confident = expendableLowerHeight >= Math.round(meta.height * 0.05);
    return {
      sourceTop,
      sourceBottom: meta.height,
      upperHookRegion: { top: sourceTop, bottom: Math.min(kickStripTop, sourceTop + evenFloor((kickStripTop - sourceTop) * 0.25)) },
      mainContentRegion: { top: sourceTop, bottom: kickStripTop },
      emptyLowerRegion: { top: emptyLowerStart, bottom: emptyLowerEnd },
      outerPaddingRegion: { top: outerPaddingTop, bottom: outerPaddingBottom },
      detectedOuterPaddingTop,
      kickStripRegion: { top: kickStripTop, bottom: kickStripBottom },
      protectedStoryTop: sourceTop,
      originalSourceForegroundHeight,
      expendableLowerHeight,
      outerPaddingHeight,
      outerPaddingRemovedPixels: outerPaddingHeight,
      requestedCropPercent: 25,
      requestedRemovalPixels,
      actualRemovedPixels: confident ? actualRemovedPixels : 0,
      actualRemovedPercent: Number(((confident ? actualRemovedPixels : 0) / originalSourceForegroundHeight * 100).toFixed(2)),
      removalMode,
      confidence: confident ? "high" : "uncertain",
      sampleTimes: times.map((time) => Number(time.toFixed(3))),
    };
  } catch {
    return null;
  }
}

const within2pct = (aspect, target) => Math.abs(aspect - target) / target <= 0.02;

// SOURCE_MODE decision. A source that is already a complete 9:16 composition
// must never be shrunk into an inner video box, and its own internal margins
// are part of that composition — so border removal is never applied to it.
export function classifySource(meta, content, targetAspect = 9 / 16) {
  if (within2pct(meta.width / meta.height, targetAspect)) {
    return { mode: "FULL_FRAME_9_16", rect: { x: 0, y: 0, w: meta.width, h: meta.height } };
  }
  const padded =
    content.w !== meta.width || content.h !== meta.height || content.x !== 0 || content.y !== 0;
  // Strict aspect check re-applied AFTER high-confidence redundant-border removal.
  if (padded && within2pct(content.w / content.h, targetAspect)) {
    return { mode: "FULL_FRAME_9_16", rect: content };
  }
  return { mode: padded ? "PADDED_SOURCE" : "REFRAME_SOURCE", rect: content };
}

function even(value) {
  const rounded = Math.max(2, Math.round(value));
  return rounded - (rounded % 2);
}

export function fitDimensions(meta, boxWidth, boxHeight) {
  const scale = Math.min(boxWidth / meta.width, boxHeight / meta.height);
  return { width: even(meta.width * scale), height: even(meta.height * scale) };
}

// Smart Crop only crops when it can retain at least 90% of each source axis.
// Otherwise it falls back to Safe Fit so captions and edge overlays survive.
export function cropWindow(meta, targetAspect, zoom = 1, mode = "smart") {
  const srcAspect = meta.width / meta.height;
  let w;
  let h;
  if (srcAspect > targetAspect) {
    h = meta.height;
    w = Math.round(h * targetAspect);
  } else {
    w = meta.width;
    h = Math.round(w / targetAspect);
  }
  const appliedZoom = mode === "fill" ? Math.max(1, zoom) : 1;
  w = Math.max(2, Math.round(w / appliedZoom));
  h = Math.max(2, Math.round(h / appliedZoom));
  w = Math.min(w, meta.width);
  h = Math.min(h, meta.height);

  const removedWidth = 1 - w / meta.width;
  const removedHeight = 1 - h / meta.height;
  if (mode === "smart" && (removedWidth > 0.1 || removedHeight > 0.1)) return null;

  const x = Math.round((meta.width - w) / 2);
  const yBias = mode === "smart" && meta.orientation === "horizontal" ? 0.45 : 0.5;
  const y = Math.max(0, Math.min(meta.height - h, Math.round((meta.height - h) * yBias)));

  return { x, y, w: even(w), h: even(h) };
}
