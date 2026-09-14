// Regression: Kick Story + Smart Crop + Blur on a 1080x1920 source whose KICK
// strip sits near the bottom. Smart Crop must never cut the protected strip;
// it must fall back to protected-safe framing instead of failing the render.
//
//   node src/selftest-protected-strip.js
// Requires ffmpeg/ffprobe on PATH. No network, no secrets.

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { detectContentRect, detectEmbeddedStoryRect, probe } from "./analyze.js";
import { render } from "./render.js";

const run = promisify(execFile);
const OUT_DIR = process.env.PROTECTED_TEST_OUT ?? "/tmp/protected-strip-test";
const STRIP_TOP = 1700;
const STRIP_H = 120;

const results = [];
let failures = 0;
function check(name, condition, detail) {
  results.push(`${condition ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function frameRGB(file, t, w, h) {
  const { stdout } = await run(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", file,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 64 },
  );
  return { buf: stdout, w, h };
}

// Rows whose centre pixels are the strip's magenta.
function stripRows({ buf, w, h }) {
  const isMagenta = (x, y) => {
    const o = (y * w + x) * 3;
    return buf[o] > 170 && buf[o + 1] < 90 && buf[o + 2] > 170;
  };
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y += 1) {
    let hits = 0;
    for (let x = Math.round(w * 0.3); x < Math.round(w * 0.7); x += 8) if (isMagenta(x, y)) hits += 1;
    const solid = hits >= Math.floor(((w * 0.4) / 8) * 0.9);
    if (solid) {
      if (top === -1) top = y;
      bottom = y;
    }
  }
  return { top, bottom, height: top === -1 ? 0 : bottom - top + 1 };
}

function config() {
  return {
    canvas: "1080x1920",
    renderContractVersion: 2,
    requestedMode: "kick_story",
    mode: "KICK_STORY_RECOMPOSE",
    aiHookEnabled: true,
    hookAction: "ADD_NEW_HOOK",
    background: { mode: "blurred", style: "blur" },
    video: {
      width: 0, height: 0, crop: "smart", mode: "kick-story-recompose",
      framingMode: "smart_crop", zoom: 1, position: "center", radius: 0,
      adaptive: true, headlineHeight: 470, maxForegroundHeight: 1140,
    },
    headline: { enabled: true, text: "PROTECTED STRIP REGRESSION", position: "top", font: "sans", size: 58, weight: 700, italic: true, color: "black", maxLines: 2, align: "center" },
    branding: { enabled: false, position: "bottom", logo: null, text: "", color: "black", opacity: 1 },
    color_grade: { name: "natural", intensity: 50 },
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const input = join(OUT_DIR, "kick-strip-src.mp4");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-vf", `drawbox=x=0:y=${STRIP_TOP}:w=1080:h=${STRIP_H}:color=magenta@1.0:t=fill,drawbox=x=0:y=${STRIP_TOP + STRIP_H}:w=1080:h=${1920 - STRIP_TOP - STRIP_H}:color=black@1.0:t=fill`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input]);

  const meta = await probe(input);
  meta.content_rect = await detectContentRect(input, meta).catch(() => undefined);
  meta.content_rect = (await detectEmbeddedStoryRect(input, meta)) ?? meta.content_rect;

  const srcFrame = await frameRGB(input, 2, meta.width, meta.height);
  const srcStrip = stripRows(srcFrame);
  check("source strip detected", srcStrip.height >= STRIP_H - 6, JSON.stringify(srcStrip));

  const output = join(OUT_DIR, "kick-strip-smartcrop-blur.mp4");
  const logs = [];
  let built = null;
  let renderError = null;
  try {
    built = await render({
      input, output, config: config(), meta,
      resolved: { headline: config().headline.text, hookAction: "ADD_NEW_HOOK", brandText: null },
      onLog: (l) => logs.push(l),
    });
  } catch (error) {
    renderError = error;
  }
  check("render succeeds (no kick_strip failure)", renderError === null, renderError ? `${renderError.reason ?? ""} ${renderError.message}` : "");
  if (!built) {
    console.log(results.join("\n"));
    process.exit(1);
  }

  check("recompose branch", built.sourceMode === "KICK_STORY_RECOMPOSE", built.sourceMode);
  check("KICK strip protected", built.kickStripProtected === true);
  check("protected-safe fallback applied", built.framingFallback === "PROTECTED_SAFE_FIT" || built.cropAmount.height === 0, `${built.framingFallback} fit=${built.foregroundFit}`);
  check("no vertical crop of protected foreground", built.cropTop === 0 && built.crop.y + built.crop.h >= STRIP_TOP + STRIP_H, `cropTop=${built.cropTop} cropBottom=${built.cropBottom} crop=${JSON.stringify(built.crop)}`);
  check("no width crop", built.cropAmount.width === 0, `${built.cropAmount.width}%`);

  const outMeta = await probe(output);
  check("output matches computed canvas", outMeta.width === built.canvasW && outMeta.height === built.canvasH, `${outMeta.width}x${outMeta.height} vs ${built.canvasW}x${built.canvasH}`);
  check("approved trim contract", built.trimScope === "OUTER_BACKGROUND_ONLY" && built.requestedTrimPercent === 35 && built.actualRemovedPixels <= built.requestedRemovalPixels, JSON.stringify({ requested: built.requestedRemovalPixels, actual: built.actualRemovedPixels, reason: built.trimSkippedReason }));
  check("final canvas = 1920 - actual trim", built.finalCanvasHeight === 1920 - built.actualRemovedPixels, `${built.finalCanvasHeight}`);
  check("foreground and strip untouched flags", built.foregroundChanged === false && built.kickStripChanged === false);

  // Pixel check: the strip survives complete, in the expected scaled position.
  const outFrame = await frameRGB(output, 2, outMeta.width, outMeta.height);
  const outStrip = stripRows(outFrame);
  const scale = built.vh / built.crop.h;
  const expectTop = Math.round(built.vy + (STRIP_TOP - built.crop.y) * scale);
  const expectH = Math.round(STRIP_H * scale);
  check("strip present in output", outStrip.height > 0, JSON.stringify(outStrip));
  check("strip height intact", Math.abs(outStrip.height - expectH) <= 4, `actual=${outStrip.height} expected=${expectH}`);
  check("strip position intact", Math.abs(outStrip.top - expectTop) <= 4, `actual=${outStrip.top} expected=${expectTop}`);
  check("strip fully inside foreground", outStrip.top >= built.vy && outStrip.top + outStrip.height <= built.vy + built.vh, `fg=${built.vy}..${built.vy + built.vh}`);

  console.log(results.join("\n"));
  console.log(JSON.stringify({
    canvas: `${outMeta.width}x${outMeta.height}`,
    foreground: { x: built.vx, y: built.vy, w: built.vw, h: built.vh },
    crop: built.crop, cropTop: built.cropTop, cropBottom: built.cropBottom,
    framingFallback: built.framingFallback, foregroundFit: built.foregroundFit,
    trim: { requestedPercent: built.requestedTrimPercent, requestedPixels: built.requestedRemovalPixels, actualPixels: built.actualRemovedPixels, actualPercent: built.actualRemovedPercent, skipped: built.trimSkippedReason },
    strip: { source: srcStrip, output: outStrip },
  }, null, 2));
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} — outputs in ${OUT_DIR}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
