// Visual regression harness for KICK_STORY_RECOMPOSE.
// Renders real clips, extracts frames, and measures the actual geometry so a
// layout bug can never again ship on a written description alone.
//
// Usage:
//   node src/selftest-recompose.js <vertical.mp4> [<target.mp4>] [--keep]
// Requires ffmpeg/ffprobe on PATH. No network, no secrets.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { detectContentRect, detectEmbeddedStoryRect, probe } from "./analyze.js";
import { render } from "./render.js";

const run = promisify(execFile);
const OUT_DIR = process.env.RECOMPOSE_TEST_OUT ?? "/tmp/recompose-test";
const CANVAS_W = 1080;
const CANVAS_H = 1920;

async function frameRGB(file, t) {
  const { stdout } = await run(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", file,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 64 },
  );
  return stdout;
}

// Geometry measurement. The background reference color is sampled from the
// top band corner; margins are contiguous edge columns that match it inside
// the footage band. Solid-row scanning finds the headline/footer bands.
function measure(buf, tolerance = 14) {
  const px = (x, y) => {
    const o = (y * CANVAS_W + x) * 3;
    return [buf[o], buf[o + 1], buf[o + 2]];
  };
  const near = (a, b) => Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance;
  const solidRows = [];
  for (let y = 0; y < CANVAS_H; y += 4) {
    const ref = px(4, y);
    let solid = true;
    for (let x = 4; x < CANVAS_W; x += 16) {
      if (!near(ref, px(x, y))) {
        solid = false;
        break;
      }
    }
    solidRows.push(solid);
  }
  const rowSolid = (y) => solidRows[Math.min(solidRows.length - 1, Math.floor(y / 4))];
  let topEnd = 0;
  while (topEnd < CANVAS_H && rowSolid(topEnd)) topEnd += 4;
  let bottomStart = CANVAS_H;
  while (bottomStart > topEnd && rowSolid(bottomStart - 4)) bottomStart -= 4;

  // Margins: edge columns matching the BACKGROUND color, sampled across the
  // footage band — not columns matching the footage's own edge pixels.
  const bgRef = px(4, 4);
  const bandTop = topEnd + 8;
  const bandBottom = Math.max(bandTop + 8, bottomStart - 8);
  const colIsBg = (x) => {
    for (let y = bandTop; y < bandBottom; y += 16) {
      if (!near(bgRef, px(x, y))) return false;
    }
    return true;
  };
  let leftMargin = 0;
  while (leftMargin < CANVAS_W / 2 && colIsBg(leftMargin)) leftMargin += 2;
  let rightEdge = CANVAS_W - 1;
  while (rightEdge > CANVAS_W / 2 && colIsBg(rightEdge)) rightEdge -= 2;

  return {
    topSolidHeight: topEnd,
    bottomSolidHeight: CANVAS_H - bottomStart,
    footageHeight: bottomStart - topEnd,
    leftMargin,
    rightMargin: CANVAS_W - 1 - rightEdge,
  };
}

function meanAbsDiff(a, b, rect) {
  let sum = 0;
  let n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 4) {
    for (let x = rect.x; x < rect.x + rect.w; x += 4) {
      const o = (y * CANVAS_W + x) * 3;
      sum += Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
      n += 3;
    }
  }
  return n ? sum / n : 0;
}

function baseConfig(backgroundStyle, framingMode, aiHookEnabled = true) {
  return {
    canvas: "1080x1920",
    renderContractVersion: 2,
    requestedMode: "kick_story",
    mode: "KICK_STORY_RECOMPOSE",
    aiHookEnabled,
    hookAction: aiHookEnabled ? "ADD_NEW_HOOK" : "PRESERVE_SOURCE",
    background: { mode: backgroundStyle === "blur" ? "blurred" : backgroundStyle, style: backgroundStyle },
    video: {
      width: 0,
      height: 0,
      crop: framingMode === "fill" ? "fill" : framingMode === "smart_crop" ? "smart" : "safe-fit",
      mode: "kick-story-recompose",
      framingMode,
      zoom: 1,
      position: "center",
      radius: 0,
      adaptive: true,
      headlineHeight: 470,
      maxForegroundHeight: 1140,
    },
    headline: {
      enabled: true,
      text: "REGRESSION TEST HEADLINE",
      position: "top",
      font: "sans",
      size: 58,
      weight: 700,
      italic: true,
      color: "black",
      maxLines: 2,
      align: "center",
    },
    branding: { enabled: false, position: "bottom", logo: null, text: "", color: "black", opacity: 1 },
    color_grade: { name: "natural", intensity: 50 },
  };
}

const results = [];
let failures = 0;

function check(name, condition, detail) {
  results.push(`${condition ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function renderCase(label, input, config, t = 1) {
  const meta = await probe(input);
  meta.content_rect = await detectContentRect(input, meta).catch(() => undefined);
  meta.content_rect = await detectEmbeddedStoryRect(input, meta) ?? meta.content_rect;
  const output = join(OUT_DIR, `${label}.mp4`);
  const logs = [];
  const built = await render({
    input,
    output,
    config,
    meta,
    resolved: { headline: config.aiHookEnabled ? config.headline?.text : null, hookAction: config.hookAction, brandText: config.branding?.text },
    onLog: (line) => logs.push(line),
  });
  const buf = await frameRGB(output, Math.min(t, Math.max(0.5, meta.duration / 2)));
  const geo = measure(buf, config.background?.style === "black" ? 24 : 14);
  await writeFile(join(OUT_DIR, `${label}.log`), `${logs.join("\n")}\n${JSON.stringify({ built, geo }, null, 2)}`);
  return { built, geo, buf, output };
}

async function main() {
  const [vertical, target] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!vertical) {
    console.error("usage: node src/selftest-recompose.js <vertical.mp4> [<target.mp4>]");
    process.exit(2);
  }
  await mkdir(OUT_DIR, { recursive: true });

  // Test 1: the problematic already-9:16 clip, recomposed on White. Its
  // baked-in side margins MUST be stripped and the footage must be full width.
  const bad = await renderCase("vertical-recompose-white", vertical, baseConfig("white", "safe_fit"));
  check("T1 source_mode", bad.built.sourceMode === "KICK_STORY_RECOMPOSE", bad.built.sourceMode);
  check("T1 no left margin", bad.geo.leftMargin <= 8, `left=${bad.geo.leftMargin}px`);
  check("T1 no right margin", bad.geo.rightMargin <= 8, `right=${bad.geo.rightMargin}px`);
  check("T1 complete vertical coverage", bad.built.backgroundTopHeight + bad.built.vh + bad.built.backgroundBottomHeight === CANVAS_H, `top=${bad.built.backgroundTopHeight}px foreground=${bad.built.vh}px bottom=${bad.built.backgroundBottomHeight}px`);
  check("T1 no generated footer", bad.built.generatedFooter === false);
  check("T1 foreground full width", bad.built.vx === 0 && bad.built.vw === CANVAS_W, `vx=${bad.built.vx} vw=${bad.built.vw}`);
  check("T1 headline inside safe rectangle", bad.built.headlineBoundingBox && bad.built.headlineBoundingBox.y >= bad.built.headlineSafeTop && bad.built.headlineBoundingBox.y + bad.built.headlineBoundingBox.height <= bad.built.headlineSafeBottom, JSON.stringify(bad.built.headlineBoundingBox));

  // Test 2: White vs Black vs Blur — identical foreground geometry AND pixels.
  const black = await renderCase("vertical-recompose-black", vertical, baseConfig("black", "safe_fit"));
  const blur = await renderCase("vertical-recompose-blur", vertical, baseConfig("blur", "safe_fit"));
  for (const [name, other] of [["black", black], ["blur", blur]]) {
    const sameGeo =
      other.built.vx === bad.built.vx && other.built.vw === bad.built.vw && other.built.vh === bad.built.vh &&
      other.built.vy === bad.built.vy && JSON.stringify(other.built.crop) === JSON.stringify(bad.built.crop);
    check(`T2 ${name} geometry identical`, sameGeo, JSON.stringify({ vx: other.built.vx, vy: other.built.vy, vw: other.built.vw, vh: other.built.vh }));
    check(`T2 ${name} headline geometry identical`, JSON.stringify(other.built.headlineBoundingBox) === JSON.stringify(bad.built.headlineBoundingBox), JSON.stringify(other.built.headlineBoundingBox));
    const fg = { x: bad.built.vx, y: bad.built.vy, w: bad.built.vw, h: bad.built.vh };
    const diff = meanAbsDiff(bad.buf, other.buf, fg);
    check(`T2 ${name} foreground pixels identical`, diff < 3, `meanAbsDiff=${diff.toFixed(2)}`);
  }

  // Test 3: explicit Original 9:16 on a TRUE full-frame 9:16 source.
  const fullSrc = join(OUT_DIR, "fullframe-src.mp4");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=6", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", fullSrc]);
  const origCfg = baseConfig("white", "safe_fit");
  origCfg.requestedMode = "original_9_16";
  origCfg.mode = "FULL_FRAME_9_16";
  origCfg.video.mode = "original";
  const orig = await renderCase("vertical-original", fullSrc, origCfg);
  check("T3 full frame", orig.built.sourceMode === "FULL_FRAME_9_16" && orig.built.vw === CANVAS_W && orig.built.vh === CANVAS_H && orig.built.vy === 0, `mode=${orig.built.sourceMode} ${orig.built.vw}x${orig.built.vh}@${orig.built.vx},${orig.built.vy}`);
  check("T3 zero crop", orig.built.cropAmount.width === 0 && orig.built.cropAmount.height === 0, JSON.stringify(orig.built.cropAmount));
  check("T3 no background bands", orig.geo.topSolidHeight <= 16 && orig.geo.bottomSolidHeight <= 16, `top=${orig.geo.topSolidHeight} bottom=${orig.geo.bottomSolidHeight}`);

  // Test 4: horizontal synthetic source recomposed.
  const horiz = join(OUT_DIR, "horizontal-src.mp4");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", horiz]);
  const h = await renderCase("horizontal-recompose-white", horiz, baseConfig("white", "safe_fit"));
  check("T4 recompose", h.built.sourceMode === "KICK_STORY_RECOMPOSE", h.built.sourceMode);
  check("T4 footage full width", h.built.vx === 0 && h.built.vw === CANVAS_W && h.geo.leftMargin <= 8 && h.geo.rightMargin <= 8, `vw=${h.built.vw} margins=${h.geo.leftMargin}/${h.geo.rightMargin}`);
  check("T4 lower background", h.built.bottomPadding >= 0 && h.built.generatedFooter === false, `bottom=${h.built.bottomPadding}px`);
  check("T4 no width crop on safe fit", h.built.cropAmount.width <= 1, `widthCrop=${h.built.cropAmount.width}%`);

  // Test 5: desired-target clip, recomposed, must hold the same structure.
  if (target) {
    const tg = await renderCase("target-recompose-white", target, baseConfig("white", "safe_fit"));
    check("T5 target no side margins", tg.geo.leftMargin <= 8 && tg.geo.rightMargin <= 8, `margins=${tg.geo.leftMargin}/${tg.geo.rightMargin}`);
    check("T5 target coverage", tg.built.backgroundTopHeight + tg.built.vh + tg.built.backgroundBottomHeight === CANVAS_H, `top=${tg.built.backgroundTopHeight} foreground=${tg.built.vh} bottom=${tg.built.backgroundBottomHeight}`);
  }

  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} — outputs in ${OUT_DIR}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
