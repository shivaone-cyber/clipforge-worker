// Configuration-driven render engine.
// Every preset is just a RenderConfig object; there is no per-preset FFmpeg code.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { classifySource, cropWindow, fitDimensions } from "./analyze.js";
import { encoderArgs, enhancementFilters, professionalGrade } from "./quality.js";
import { createMeasurer, renderTextOverlay, resolveFont } from "./text.js";

const run = promisify(execFile);

// The Docker image ships DejaVu + Liberation; the fallbacks keep the engine
// runnable on any host that has some usable TrueType font.
function pick(candidates) {
  for (const path of candidates) if (existsSync(path)) return path;
  for (const dir of ["/usr/share/fonts/truetype", "/usr/share/fonts", "/Library/Fonts"]) {
    if (!existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = `${current}/${entry.name}`;
        if (entry.isDirectory()) stack.push(full);
        else if (/\.(ttf|otf)$/i.test(entry.name)) return full;
      }
    }
  }
  try {
    const found = execFileSync("fc-match", ["-f", "%{file}", "sans-serif"], { encoding: "utf8" }).trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* fontconfig not installed */
  }
  throw new Error("no usable font found on this system");
}

const D = "/usr/share/fonts/truetype/dejavu";
const L = "/usr/share/fonts/truetype/liberation";

export const FONTS = {
  get regular() {
    return process.env.FONT_REGULAR || pick([`${D}/DejaVuSans.ttf`, `${L}/LiberationSans-Regular.ttf`]);
  },
  get bold() {
    return process.env.FONT_BOLD || pick([`${D}/DejaVuSans-Bold.ttf`, `${L}/LiberationSans-Bold.ttf`]);
  },
  get italic() {
    return process.env.FONT_ITALIC || pick([`${L}/LiberationSans-Italic.ttf`, `${D}/DejaVuSans-Oblique.ttf`]);
  },
  get boldItalic() {
    return (
      process.env.FONT_BOLD_ITALIC ||
      pick([`${L}/LiberationSans-BoldItalic.ttf`, `${D}/DejaVuSans-BoldOblique.ttf`])
    );
  },
};

const GRADES = {
  natural: () => null,
  // Default Kick Story treatment: balanced exposure, controlled highlights and
  // shadows, natural saturation. Skin tones are deliberately untouched.
  professional: (i) => professionalGrade(i),
  clean: (i) => `eq=contrast=${1 + 0.12 * i}:saturation=${1 + 0.06 * i}:brightness=${0.02 * i}`,
  "high-contrast": (i) => `eq=contrast=${1 + 0.3 * i}:saturation=${1 + 0.12 * i}`,
  cinematic: (i) => `eq=contrast=${1 + 0.18 * i}:saturation=${1 - 0.12 * i}:gamma=${1 - 0.05 * i}`,
  warm: (i) => `eq=saturation=${1 + 0.1 * i},colorbalance=rs=${0.08 * i}:bs=${-0.06 * i}`,
  cool: (i) => `eq=saturation=${1 + 0.08 * i},colorbalance=rs=${-0.06 * i}:bs=${0.09 * i}`,
  vibrant: (i) => `eq=saturation=${1 + 0.35 * i}:contrast=${1 + 0.1 * i}`,
  bw: () => "hue=s=0",
};

const BG_COLORS = { white: "white", black: "black" };

function color(value, fallback) {
  const v = String(value ?? fallback ?? "white").trim();
  return v.startsWith("#") ? `0x${v.slice(1)}` : v;
}

// Presets store intensity on a 0-100 scale; the filters want roughly 0-2.
function intensity(value) {
  const n = Number(value ?? 50);
  const scaled = n > 2 ? n / 50 : n;
  return Math.max(0, Math.min(2, scaled));
}

function esc(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "\\%");
}

// Rough but reliable wrap: DejaVu/Liberation average ~0.5em per glyph.
export function wrap(text, fontSize, maxWidth, maxLines, measure) {
  const widthOf = measure ? (value) => measure(value, fontSize) : (value) => Array.from(value).length * fontSize * 0.55;
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (widthOf(candidate) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let tail = kept[maxLines - 1];
    while (tail.length > 1 && widthOf(`${tail}…`) > maxWidth) tail = tail.slice(0, -1);
    kept[maxLines - 1] = `${tail.trimEnd()}…`;
    return kept;
  }
  return lines;
}

// Hooks are copy, not captions. Remove common filler and shorten at a word
// boundary before wrapping; shrinking a long description into tiny type is not
// an acceptable fallback for the dedicated headline area.
export function compactHeadline(text, maxChars = 56) {
  let value = String(text ?? "")
    .replace(/\b(?:in this (?:video|clip)|watch as|the moment when|this is the moment)\b/gi, "")
    .replace(/\s+([,!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const emoji = Array.from(value).filter((char) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(char)).slice(0, 2);
  if (emoji.length) {
    const wordsOnly = Array.from(value)
      .filter((char) => !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(char))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    value = `${wordsOnly} ${emoji.join("")}`;
  }
  if (Array.from(value).length <= maxChars) return value;
  const words = value.split(" ");
  let short = "";
  for (const word of words) {
    const next = short ? `${short} ${word}` : word;
    if (Array.from(next).length > maxChars - 1) break;
    short = next;
  }
  return `${short || Array.from(value).slice(0, maxChars - 1).join("")}…`;
}

function drawTextChain(lines, opts) {
  const { fontFile, fontSize, color, startY, canvasW, lineSpacing, align, boxX } = opts;
  return lines.map((line, i) => {
    const y = Math.round(startY + i * (fontSize * (lineSpacing ?? 1.22)));
    const x =
      align === "left"
        ? boxX ?? 80
        : align === "right"
          ? `${canvasW - (boxX ?? 80)}-text_w`
          : "(w-text_w)/2";
    return [
      "drawtext=",
      `fontfile='${fontFile}'`,
      `:text='${esc(line)}'`,
      `:fontcolor=${color}`,
      `:fontsize=${fontSize}`,
      `:x=${x}`,
      `:y=${y}:fix_bounds=1`,
    ].join("");
  });
}

// FFmpeg's drawtext y coordinate addresses the glyph box, not a typographic
// baseline. These conservative font metrics keep accents/italics inside the
// declared safe rectangle on every bundled fallback font.
export function fitHeadlineLayout(text, opts) {
  const safeLeft = Math.max(0, Math.round(opts.safeLeft));
  const safeRight = Math.min(opts.canvasW, Math.round(opts.safeRight));
  const safeTop = Math.max(0, Math.round(opts.safeTop));
  const safeBottom = Math.min(opts.regionH, Math.round(opts.safeBottom));
  const maxLines = Math.max(1, Math.min(3, Number(opts.maxLines ?? 2)));
  const lineSpacing = Math.max(1, Number(opts.lineSpacing ?? 1.22));
  const minSize = Math.max(18, Math.min(Number(opts.fontSize ?? 58), 30));
  const maxWidth = Math.max(80, safeRight - safeLeft);
  const safeHeight = Math.max(1, safeBottom - safeTop);

  let fontSize = Math.max(minSize, Number(opts.fontSize ?? 58));
  let lines = [];
  let lineStep = 0;
  let textHeight = 0;
  while (fontSize >= minSize) {
    lines = wrap(text, fontSize, maxWidth, maxLines, opts.measure);
    lineStep = fontSize * lineSpacing;
    // Include ascender/italic overshoot and descender safety instead of using
    // lines*fontSize, which was too tall and caused the first line to clip.
    textHeight = fontSize + Math.max(0, lines.length - 1) * lineStep;
    if (textHeight <= safeHeight) break;
    fontSize -= 2;
  }

  fontSize = Math.max(minSize, fontSize);
  lines = wrap(text, fontSize, maxWidth, maxLines, opts.measure);
  lineStep = fontSize * lineSpacing;
  textHeight = fontSize + Math.max(0, lines.length - 1) * lineStep;
  const startY = opts.anchorBottom
    ? Math.floor(safeBottom - textHeight)
    : Math.max(safeTop, Math.round(safeTop + (safeHeight - textHeight) / 2));
  const bottom = startY + textHeight;
  if (bottom > safeBottom) {
    throw new Error(`headline text does not fit safe rectangle (${startY}..${bottom} outside ${safeTop}..${safeBottom})`);
  }
  return {
    lines,
    fontSize,
    lineSpacing,
    startY,
    bbox: { x: safeLeft, y: startY, width: maxWidth, height: Math.ceil(textHeight) },
    safeRect: { left: safeLeft, top: safeTop, right: safeRight, bottom: safeBottom },
  };
}

// The user's explicit request, read from the canonical V2 contract first and
// only then from the legacy per-video field. There is no passthrough branch:
// a Kick Story request can only ever produce KICK_STORY_RECOMPOSE.
export function requestedModeOf(config) {
  const top = String(config?.requestedMode ?? "").toLowerCase();
  if (top === "kick_story") return "kick_story";
  if (top === "original_9_16") return "original_9_16";
  const canonical = String(config?.mode ?? "").toUpperCase();
  if (canonical === "KICK_STORY_RECOMPOSE") return "kick_story";
  if (canonical === "FULL_FRAME_9_16") return "original_9_16";
  const legacy = String(config?.video?.mode ?? "auto");
  if (legacy === "kick-story-recompose") return "kick_story";
  if (legacy === "original") return "original_9_16";
  if (legacy === "reframe") return "reframe";
  return "auto";
}

export function resolveRenderMode(config, meta, detectedRect, canvasW, canvasH) {
  const requested = requestedModeOf(config);
  if (requested === "kick_story") return "KICK_STORY_RECOMPOSE";
  if (requested === "original_9_16") return "FULL_FRAME_9_16";
  if (requested === "reframe") return "REFRAME_SOURCE";
  return classifySource(meta, detectedRect, canvasW / canvasH).mode;
}

export function buildFilterGraph(config, meta, resolved) {
  const [canvasW, canvasH] = String(config.canvas || "1080x1920").split("x").map(Number);
  const detectedRect = meta.content_rect ?? { x: 0, y: 0, w: meta.width, h: meta.height };
  const grade = GRADES[config.color_grade?.name ?? "professional"] ?? GRADES.professional;
  const gradeFilter = grade ? grade(intensity(config.color_grade?.intensity)) : null;

  // Final render decision, resolved BEFORE any sizing/padding math.
  // ABSOLUTE PRECEDENCE: an explicit user request wins over the AI plan, the
  // source dimensions and the deterministic classifier — always.
  const sourceMode = resolveRenderMode(config, meta, detectedRect, canvasW, canvasH);
  const decision = classifySource(meta, detectedRect, canvasW / canvasH);
  const detected = decision.mode;
  const content = sourceMode === "FULL_FRAME_9_16" ? decision.rect : detectedRect;

  if (sourceMode === "FULL_FRAME_9_16") {
    return buildFullFrameGraph({ config, meta, resolved, canvasW, canvasH, content, gradeFilter, detected });
  }

  if (sourceMode === "KICK_STORY_RECOMPOSE") {
    return buildKickStoryRecomposeGraph({ config, meta, resolved, canvasW, canvasH, content, gradeFilter, detected });
  }



  const adaptive = config.video?.adaptive === true;
  const topPadding = adaptive ? Math.max(0, Math.min(canvasH, Number(config.video?.topPadding ?? 120))) : null;
  const bottomPadding = adaptive ? Math.max(0, Math.min(canvasH, Number(config.video?.bottomPadding ?? 100))) : null;
  const boxW = Math.min(config.video?.width ?? canvasW, canvasW);
  const boxH = adaptive
    ? Math.max(2, canvasH - topPadding - bottomPadding)
    : Math.min(config.video?.height ?? canvasH, canvasH);
  const cropMode = config.video?.crop ?? "safe-fit";
  const contentMeta = { ...meta, width: content.w, height: content.h, aspect: content.w / content.h };
  const requestedCrop =
    cropMode === "manual" && config.video?.manual
      ? config.video.manual
      : cropMode === "safe-fit"
        ? null
        : cropWindow(contentMeta, boxW / boxH, config.video?.zoom ?? 1, cropMode === "center" ? "fill" : cropMode);
  const safeFit = !requestedCrop;
  const fitted = safeFit ? fitDimensions(contentMeta, boxW, boxH) : { width: boxW, height: boxH };
  const vw = fitted.width;
  const vh = fitted.height;
  const position = config.video?.position ?? "center";
  const boxY = adaptive
    ? topPadding
    : position === "top"
      ? Math.round(canvasH * 0.12)
      : position === "bottom"
        ? canvasH - boxH - Math.round(canvasH * 0.12)
        : Math.round((canvasH - boxH) / 2);
  const vy = safeFit ? boxY + Math.round((boxH - vh) / 2) : boxY;
  const vx = Math.round((canvasW - vw) / 2);

  const relativeCrop = requestedCrop ?? { x: 0, y: 0, w: content.w, h: content.h };
  const crop = { x: content.x + relativeCrop.x, y: content.y + relativeCrop.y, w: relativeCrop.w, h: relativeCrop.h };
  const cropAmount = {
    width: Number(((1 - crop.w / meta.width) * 100).toFixed(2)),
    height: Number(((1 - crop.h / meta.height) * 100).toFixed(2)),
  };

  const parts = [];
  const bgMode = config.background?.mode ?? "white";


  if (bgMode === "blurred") {
    parts.push(
      `[0:v]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},boxblur=40:2,eq=brightness=-0.08[bg]`,
    );
  } else {
    const bg = bgMode === "custom" ? color(config.background?.custom, "white") : BG_COLORS[bgMode] || "white";
    parts.push(`color=c=${bg}:s=${canvasW}x${canvasH}:d=${meta.duration.toFixed(3)}:r=${Number(meta.fps) > 0 ? Number(meta.fps).toFixed(3) : 30}[bg]`);
  }

  const needsCrop = crop.x !== 0 || crop.y !== 0 || crop.w !== meta.width || crop.h !== meta.height;
  const fgFilters = [
    ...(needsCrop ? [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : []),
    `scale=${vw}:${vh}:flags=lanczos`,
    "setsar=1",
  ];
  fgFilters.push(...enhancementFilters(meta));
  if (gradeFilter) fgFilters.push(gradeFilter);
  parts.push(`[0:v]${fgFilters.join(",")}[fg]`);

  parts.push(`[bg][fg]overlay=${vx}:${vy}:shortest=1[composed]`);

  // Text is drawn on the composed canvas so it always sits above the footage.
  const draws = [];
  const headline = config.headline ?? {};
  if (headline.enabled && resolved.headline) {
    const size = headline.size ?? 58;
    const italic = headline.italic !== false;
    const bold = (headline.weight ?? 600) >= 600;
    const fontFile = italic ? (bold ? FONTS.boldItalic : FONTS.italic) : bold ? FONTS.bold : FONTS.regular;
    const maxWidth = canvasW - 160;
    const lines = wrap(resolved.headline, size, maxWidth, headline.maxLines ?? 3);
    const blockH = (lines.length - 1) * size * 1.22 + size;
    const topArea = headline.position === "bottom" ? canvasH - (canvasH - (vy + vh)) : vy;
    const startY =
      headline.position === "bottom"
        ? Math.round(vy + vh + (canvasH - (vy + vh) - blockH) / 2)
        : Math.round((topArea - blockH) / 2);
    draws.push(
      ...drawTextChain(lines, {
        fontFile,
        fontSize: size,
        color: color(headline.color, "black"),
        startY: Math.max(40, startY),
        canvasW,
        lineSpacing: headline.lineSpacing ?? 1.22,
        align: headline.align ?? "center",
      }),
    );
  }

  const branding = config.branding ?? {};
  if (branding.enabled && (resolved.brandText || branding.text)) {
    const size = Math.round((headline.size ?? 58) * 0.55);
    const text = resolved.brandText || branding.text;
    const y =
      branding.position === "top"
        ? Math.round(canvasH * 0.035)
        : Math.round(canvasH - canvasH * 0.045 - size);
    draws.push(
      ...drawTextChain([text], {
        fontFile: FONTS.bold,
        fontSize: size,
        color: color(branding.color, "black"),
        startY: y,
        canvasW,
        align: "center",
      }),
    );
  }

  const label = draws.length ? `[composed]${draws.join(",")}[out]` : `[composed]null[out]`;
  parts.push(label);

  return { graph: parts.join(";"), sourceMode, detectedMode: detected, canvasW, canvasH, sourceAspect: Number(meta.aspect.toFixed(5)), contentRect: content, crop, cropAmount, cropMode: safeFit ? "safe-fit" : cropMode, enhancement: enhancementFilters(meta), gradeFilter, vx, vy, vw, vh, topPadding: vy, bottomPadding: canvasH - vy - vh };
}

// FULL_FRAME_9_16: the source IS the composition. Scale it directly to the
// output, preserving aspect ratio. No inner box, no outer background, no
// second letterbox layer. Only colour grade and branding overlay are applied.
function buildFullFrameGraph({ config, meta, resolved, canvasW, canvasH, content, gradeFilter, detected }) {
  const needsCrop =
    content.x !== 0 || content.y !== 0 || content.w !== meta.width || content.h !== meta.height;
  const filters = [
    ...(needsCrop ? [`crop=${content.w}:${content.h}:${content.x}:${content.y}`] : []),
    // increase + centre crop absorbs only the sub-2% aspect difference; never stretches.
    `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${canvasW}:${canvasH}`,
    "setsar=1",
  ];
  filters.push(...enhancementFilters(meta));
  if (gradeFilter) filters.push(gradeFilter);

  const parts = [`[0:v]${filters.join(",")}[composed]`];

  const draws = [];
  const branding = config.branding ?? {};
  if (branding.enabled && (resolved.brandText || branding.text)) {
    const size = Math.round((config.headline?.size ?? 58) * 0.55);
    const text = resolved.brandText || branding.text;
    const y =
      branding.position === "top"
        ? Math.round(canvasH * 0.035)
        : Math.round(canvasH - canvasH * 0.045 - size);
    draws.push(
      ...drawTextChain([text], {
        fontFile: FONTS.bold,
        fontSize: size,
        color: color(branding.color, "white"),
        startY: y,
        canvasW,
        align: "center",
      }),
    );
  }

  parts.push(draws.length ? `[composed]${draws.join(",")}[out]` : `[composed]null[out]`);

  const cropAmount = {
    width: Number(((1 - content.w / meta.width) * 100).toFixed(2)),
    height: Number(((1 - content.h / meta.height) * 100).toFixed(2)),
  };

  return {
    graph: parts.join(";"),
    sourceMode: "FULL_FRAME_9_16",
    detectedMode: detected,
    canvasW,
    canvasH,
    sourceAspect: Number(meta.aspect.toFixed(5)),
    contentRect: content,
    crop: content,
    cropAmount,
    cropMode: "full-frame",
    enhancement: enhancementFilters(meta),
    gradeFilter,
    vx: 0,
    vy: 0,
    vw: canvasW,
    vh: canvasH,
    topPadding: 0,
    bottomPadding: 0,
  };
}

function roundEven(value) {
  const r = Math.max(2, Math.round(value));
  return r - (r % 2);
}

function floorEven(value) {
  const floored = Math.max(0, Math.floor(value));
  return floored - (floored % 2);
}

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

function sourceMaskFilter(mask, meta, crop) {
  if (!mask) return { filter: null, source: null, transformed: null };
  const source = {
    x: clampInt(mask.x, 0, meta.width - 2, 0),
    y: clampInt(mask.y, 0, meta.height - 2, 0),
    width: clampInt(mask.width, 8, meta.width, 8),
    height: clampInt(mask.height, 8, meta.height, 8),
  };
  source.width = Math.min(source.width, meta.width - source.x);
  source.height = Math.min(source.height, meta.height - source.y);
  if (source.x < crop.x || source.y < crop.y || source.x + source.width > crop.x + crop.w || source.y + source.height > crop.y + crop.h) {
    throw Object.assign(new Error("old hook mask is not fully contained in foreground crop"), { reason: "hook_mask_geometry", retryable: false });
  }
  const sx = 1080 / crop.w;
  return {
    filter: `delogo=x=${source.x}:y=${source.y}:w=${source.width}:h=${source.height}:show=0`,
    source,
    transformed: {
      x: Math.round((source.x - crop.x) * sx),
      y: Math.round((source.y - crop.y) * sx),
      width: Math.round(source.width * sx),
      height: Math.round(source.height * sx),
    },
  };
}

  // Protected regions must be fully contained in the selected source window.
function cropHitsProtected(cy, ch, contentH, regions) {
  for (const region of regions ?? []) {
    const top = Number(region.y) * contentH;
    const bottom = top + Number(region.height) * contentH;
    if (top < cy || bottom > cy + ch) return true;
  }
  return false;
}

// KICK_STORY_RECOMPOSE: dedicated composition, never the contain/inner-box math.
// Background layer → sharp protected foreground (full canvas width, x=0) →
// headline region → untouched lower background. Foreground geometry is computed once
// and is byte-identical across White, Black and Blur — only the background
// pixels differ.
function buildKickStoryRecomposeGraph({ config, meta, resolved, canvasW, canvasH, content, gradeFilter, detected }) {
  // Reference-derived composition: a compact 24.5% headline region, followed
  // immediately by at most 59.4% full-width source. The remainder is simply
  // the selected background; it is never a generated footer.
  const topH = clampInt(config.video?.headlineHeight ?? canvasH * 0.245, 240, Math.round(canvasH * 0.32), Math.round(canvasH * 0.245));
  const maxVideoH = clampInt(config.video?.maxForegroundHeight ?? canvasH * 0.594, 400, canvasH - topH, Math.round(canvasH * 0.594));
  const regionH = maxVideoH;
  const regionAspect = canvasW / regionH;

  const contentMeta = {
    ...meta,
    width: content.w,
    height: content.h,
    aspect: content.w / content.h,
    orientation: content.h > content.w ? "vertical" : content.w === content.h ? "square" : "horizontal",
  };
  const cropMode = config.video?.crop ?? "safe-fit";
  const framing =
    config.video?.framingMode ??
    (cropMode === "fill" ? "fill" : cropMode === "smart" ? "smart_crop" : "safe_fit");
  const subject = config.video?.subject ?? { x: 0.5, y: 0.5 };
  const protectedRegions = Array.isArray(config.video?.protectedRegions) ? config.video.protectedRegions : [];

  // Width is sacred: cw is only reduced for Fill on wide sources. Everything
  // else keeps the full source width and crops vertically only when needed.
  let cw = content.w;
  let ch = Math.min(content.h, roundEven(content.w / regionAspect));
  if (framing === "fill") {
    // Fill the middle region exactly, even for wide sources (may crop width).
    if (contentMeta.aspect > regionAspect) {
      ch = content.h;
      cw = roundEven(content.h * regionAspect);
    }
  }
  const zoom = framing === "fill" ? Math.max(1, Number(config.video?.zoom ?? 1)) : 1;
  cw = Math.min(cw, roundEven(cw / zoom) === cw ? cw : roundEven(cw / zoom));
  ch = Math.min(ch, roundEven(ch / zoom));

  const maxCx = content.w - cw;
  const maxCy = content.h - ch;
  // Subject positioning may steer horizontal framing, but never the vertical
  // policy: BOTTOM_FIRST always keeps the top of the source (embedded hook,
  // captions, faces) and removes empty lower space first.
  const cropPreference = String(config.video?.cropPreference ?? "BOTTOM_FIRST").toUpperCase();
  const cx = maxCx > 0 ? Math.round(maxCx * Math.min(1, Math.max(0, Number(subject.x) || 0.5))) : 0;
  // The whole detected story block is protected when it fits. When it does
  // not, the upper region is protected as far as the crop reaches and the
  // lower strip band (KICK strip / creator overlay) stays protected, forcing
  // cy = 0 for any crop that can satisfy both.
  const storyBlockProtected = { x: 0, y: 0, width: 1, height: content.h > ch ? Math.min(1, ch / content.h) : 1 };
  const stripBand = { x: 0, y: 0.9, width: 1, height: 0.1 };
  const effectiveProtected = content.h > ch
    ? [storyBlockProtected, stripBand, ...protectedRegions]
    : [storyBlockProtected, ...protectedRegions];
  const candidates = [...new Set(cropPreference === "BOTTOM_FIRST"
    ? [0, Math.round(maxCy * 0.5), maxCy]
    : [Math.round(maxCy * 0.5), 0, maxCy])].map((v) => Math.max(0, Math.min(maxCy, v)));
  let cy = candidates[0] ?? 0;
  for (const candidate of candidates) {
    if (!cropHitsProtected(candidate, ch, content.h, effectiveProtected)) {
      cy = candidate;
      break;
    }
  }

  const regions = meta.story_regions;
  // Source framing ends here. The lower-padding operation never participates
  // in this crop: it is applied to the already completed outer canvas only.
  const crop = { x: content.x + cx, y: content.y + cy, w: cw, h: ch };
  const cropTop = cy;
  const cropBottom = content.h - (cy + ch);
  const protectedRegionIntersections = effectiveProtected.filter((region) => {
    const top = Number(region.y) * content.h;
    const bottom = top + Number(region.height) * content.h;
    return top < cy || bottom > cy + ch;
  }).length;
  // The KICK strip sits at the bottom edge of the embedded story block. It is
  // protected only when the complete block survives the crop; otherwise fail
  // closed rather than deliver a cut or covered strip.
  const kickTop = Number(regions?.kickStripRegion?.top ?? content.y);
  const kickBottom = Number(regions?.kickStripRegion?.bottom ?? content.y + content.h);
  const kickStripProtected = kickTop >= crop.y && kickBottom <= crop.y + crop.h;
  // Scale proportionally to exactly canvas width; height follows the crop.
  const vw = canvasW;
  const vh = roundEven((crop.h * canvasW) / cw);
  const vx = 0;
  // The protected foreground begins immediately below the headline. Any unused
  // canvas below it belongs to the selected background.
  const vy = topH;
  const bottomH = canvasH - vy - vh;
  if (bottomH < 0) {
    throw Object.assign(new Error(`foreground exceeds canvas (${vy}+${vh}>${canvasH})`), { reason: "geometry", retryable: false });
  }
  if (!kickStripProtected) {
    throw Object.assign(new Error("KICK strip/protected story block would be cut by the crop — refusing to render"), { reason: "kick_strip", retryable: false });
  }
  // Reference-balanced outer trim. It is based only on the empty canvas below
  // the completed foreground and is capped before that margin becomes smaller
  // than the upper composition zone. Foreground geometry is never recalculated.
  const outerTrimEnabled = config.video?.outerBackgroundTrimEnabled !== false;
  // The supplied reference family uses a tighter lower surround than the
  // initial 25% pass. Trim 35% of outer background only, capped so the lower
  // surround can never become smaller than the untouched upper surround.
  const requestedOuterTrimPercent = 35;
  const requestedOuterTrimPixels = outerTrimEnabled ? floorEven(bottomH * (requestedOuterTrimPercent / 100)) : 0;
  const alreadyBalanced = bottomH <= Math.round(vy * 1.1);
  const balanceCap = floorEven(Math.max(0, bottomH - vy));
  const actualOuterTrimPixels = !outerTrimEnabled || alreadyBalanced ? 0 : Math.min(requestedOuterTrimPixels, balanceCap);
  const finalCanvasH = canvasH - actualOuterTrimPixels;
  const finalBottomH = finalCanvasH - (vy + vh);
  const actualOuterTrimPercent = bottomH > 0 ? Number(((actualOuterTrimPixels / bottomH) * 100).toFixed(2)) : 0;
  const trimSkippedReason = actualOuterTrimPixels === 0 ? (outerTrimEnabled ? "BALANCED_ALREADY" : "DISABLED_FOR_BASELINE") : null;
  const cropAmount = {
    width: Number(((1 - cw / meta.width) * 100).toFixed(2)),
    height: Number(((1 - ch / meta.height) * 100).toFixed(2)),
  };

  // Background style only ever changes the [bg] layer.
  const style =
    config.background?.style ??
    (config.background?.mode === "blurred" ? "blur" : config.background?.mode === "black" ? "black" : "white");
  const parts = [];
  const hookMask = sourceMaskFilter(config.video?.oldHookMask, meta, crop);
  if (config.aiHookEnabled === false && hookMask.source) {
    throw Object.assign(new Error("AI-off render cannot contain an old-hook mask"), { reason: "hook_state", retryable: false });
  }
  if (resolved.hookAction === "REPLACE_OLD_HOOK" && (!hookMask.source || !resolved.headline)) {
    throw Object.assign(new Error("replacement action requires a source mask and headline"), { reason: "hook_state", retryable: false });
  }
  if (resolved.hookAction === "ADD_NEW_HOOK" && (hookMask.source || !resolved.headline)) {
    throw Object.assign(new Error("add-hook action requires an unmasked source and headline"), { reason: "hook_state", retryable: false });
  }
  if (resolved.hookAction === "PRESERVE_SOURCE" && (hookMask.source || resolved.headline)) {
    throw Object.assign(new Error("preserve-source action cannot mask or add a headline"), { reason: "hook_state", retryable: false });
  }
  if (style === "blur") {
    // Build the full-canvas blur from the same protected source window, not
    // from a previously composed 9:16 frame whose old white/black bands would
    // otherwise survive as flat areas. This branch never receives the hook
    // mask; the sharp foreground is composed independently below.
    parts.push(
      `[0:v]split=2[bgsource][fgsource]`,
      `[bgsource]crop=${content.w}:${content.h}:${content.x}:${content.y},scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},boxblur=40:2,eq=brightness=-0.08[bg]`,
    );
    if (hookMask.filter) parts.push(`[fgsource]${hookMask.filter}[masked_source]`);
  } else {
    const bg = style === "black" ? "black" : "white";
    parts.push(`color=c=${bg}:s=${canvasW}x${canvasH}:d=${meta.duration.toFixed(3)}:r=${Number(meta.fps) > 0 ? Number(meta.fps).toFixed(3) : 30}[bg]`);
  }

  const needsCrop = crop.x !== 0 || crop.y !== 0 || crop.w !== meta.width || crop.h !== meta.height;
  const sourceLabel = hookMask.filter ? "[masked_source]" : style === "blur" ? "[fgsource]" : "[0:v]";
  if (hookMask.filter && style !== "blur") parts.push(`[0:v]${hookMask.filter}[masked_source]`);
  const finishFilters = [`scale=${vw}:${vh}:flags=lanczos`, "setsar=1", ...enhancementFilters(meta)];
  if (gradeFilter) finishFilters.push(gradeFilter);
  const fgFilters = [...(needsCrop ? [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : []), ...finishFilters];
  parts.push(`${sourceLabel}${fgFilters.join(",")}[fg]`);
  parts.push(`[bg][fg]overlay=${vx}:${vy}:shortest=1[composed]`);

  // On a black background, black text would vanish — flip to white.
  const textColor = (value) => {
    const raw = String(value ?? "").trim().toLowerCase();
    if (style === "black" && (!raw || ["black", "#000", "#000000", "0x000000"].includes(raw))) return "white";
    return color(value, style === "black" ? "white" : "black");
  };

  const draws = [];
  const headline = config.headline ?? {};
  let headlineLayout = null;
  let typography = null;
  if (headline.enabled && resolved.headline) {
    const horizontalPadding = clampInt(headline.safeHorizontalPadding ?? 80, 40, Math.round(canvasW * 0.25), 80);
    const verticalPadding = clampInt(headline.safeVerticalPadding ?? 32, 20, Math.max(20, Math.round(topH * 0.3)), 32);
    const headlineGapToVideo = clampInt(headline.safeGap ?? 38, 32, 48, 38);
    const font = resolveFont(config.fontConfig, resolved.customFontPath);
    const measure = createMeasurer(font.path, { weight: config.fontConfig?.weight, italic: config.fontConfig?.italic }, font.emojiPath);
    const fittedText = compactHeadline(resolved.headline);
    headlineLayout = fitHeadlineLayout(fittedText, {
      canvasW,
      regionH: topH,
      fontSize: headline.size ?? 58,
      maxLines: Math.min(3, headline.maxLines ?? 2),
      lineSpacing: headline.lineSpacing ?? 1.22,
      safeLeft: horizontalPadding,
      safeRight: canvasW - horizontalPadding,
      safeTop: verticalPadding,
      safeBottom: vy - headlineGapToVideo,
      anchorBottom: true,
      measure,
    });
    typography = {
      text: fittedText,
      lines: headlineLayout.lines,
      fontPath: font.path,
      emojiPath: font.emojiPath,
      fontSource: font.source,
      fontPreset: font.preset,
      fontValidation: font.validation,
      fontSize: headlineLayout.fontSize,
      color: style === "black" || style === "blur" ? "white" : textColor(headline.color),
      align: config.fontConfig?.align ?? headline.align ?? "center",
      lineSpacing: config.fontConfig?.lineSpacing ?? headlineLayout.lineSpacing,
      letterSpacing: config.fontConfig?.letterSpacing ?? headline.letterSpacing ?? 0,
      weight: config.fontConfig?.weight ?? headline.weight ?? 700,
      italic: config.fontConfig?.italic ?? headline.italic ?? false,
      x: headlineLayout.bbox.x,
      y: headlineLayout.bbox.y,
      width: headlineLayout.bbox.width,
      height: headlineLayout.bbox.height,
      contrastMode: style === "black" || style === "blur" ? "light_on_dark" : "dark_on_light",
      headlineTop: headlineLayout.bbox.y,
      headlineBottom: headlineLayout.bbox.y + headlineLayout.bbox.height,
      videoTop: vy,
      headlineGapToVideo: vy - (headlineLayout.bbox.y + headlineLayout.bbox.height),
    };
  }

  // No branding/footer is drawn for Kick Story. Branding already embedded in
  // the protected source remains inside that source block.
  parts.push(draws.length ? `[composed]${draws.join(",")}[out]` : `[composed]null[out]`);

  return {
    graph: parts.join(";"),
    sourceMode: "KICK_STORY_RECOMPOSE",
    detectedMode: detected,
    canvasW,
    canvasH: finalCanvasH,
    baseCanvasH: canvasH,
    sourceAspect: Number(meta.aspect.toFixed(5)),
    contentRect: content,
    crop,
    cropAmount,
    cropMode: framing,
    cropTop,
    cropBottom,
    cropPreference,
    protectedRegionIntersections,
    kickStripProtected,
    backgroundStyle: style,
    vx,
    vy,
    vw,
    vh,
    topPadding: topH,
    bottomPadding: bottomH,
    generatedFooter: false,
    lowerBackgroundOnly: true,
    videoBottom: vy + vh,
    foregroundHeight: vh,
    sourceHeight: meta.height,
    protectedStoryTop: regions?.protectedStoryTop ?? null,
    sourceTop: regions?.sourceTop ?? null,
    sourceBottom: regions?.sourceBottom ?? null,
    upperHookRegion: regions?.upperHookRegion ?? null,
    mainContentRegion: regions?.mainContentRegion ?? null,
    emptyLowerStart: regions?.emptyLowerRegion?.top ?? null,
    emptyLowerEnd: regions?.emptyLowerRegion?.bottom ?? null,
    kickStripTop: regions?.kickStripRegion?.top ?? null,
    kickStripBottom: regions?.kickStripRegion?.bottom ?? null,
    expendableLowerHeight: regions?.expendableLowerHeight ?? 0,
    outerPaddingTop: regions?.outerPaddingRegion?.top ?? null,
    outerPaddingBottom: regions?.outerPaddingRegion?.bottom ?? null,
    outerPaddingHeight: regions?.outerPaddingHeight ?? 0,
    outerPaddingRemovedPixels: 0,
    requestedCropPercent: 0,
    requestedRemovalPixels: requestedOuterTrimPixels,
    actualRemovedPixels: actualOuterTrimPixels,
    actualRemovedPercent: actualOuterTrimPercent,
    removalMode: actualOuterTrimPixels > 0 ? "OUTER_BACKGROUND_ONLY" : "NONE",
    trimScope: "OUTER_BACKGROUND_ONLY",
    trimSkippedReason,
    requestedTrimPercent: requestedOuterTrimPercent,
    originalSourceForegroundHeight: crop.h,
    assembledSourceHeight: crop.h,
    joinPosition: null,
    backgroundTopHeight: vy,
    backgroundBottomHeight: finalBottomH,
    lowerBackgroundHeightBefore: bottomH,
    lowerBackgroundHeightAfter: finalBottomH,
    upperBackgroundHeight: vy,
    finalCanvasHeight: finalCanvasH,
    foregroundChanged: false,
    kickStripChanged: false,
    leftEdgeCovered: vx === 0,
    rightEdgeCovered: vx + vw === canvasW,
    protectedRegions: protectedRegions.length,
    hookReplacement: hookMask.source ? {
      state: "replaced",
      applied_before_crop_scale: true,
      source_mask: hookMask.source,
      transformed_mask: hookMask.transformed,
    } : {
      state: resolved.hookAction === "ADD_NEW_HOOK" && resolved.headline ? "added_no_old_hook" : "not_generated",
      applied_before_crop_scale: false,
      source_mask: null,
      transformed_mask: null,
    },
    headlineSafeTop: headlineLayout?.safeRect.top ?? null,
    headlineSafeBottom: headlineLayout?.safeRect.bottom ?? null,
    headlineSafeLeft: headlineLayout?.safeRect.left ?? null,
    headlineSafeRight: headlineLayout?.safeRect.right ?? null,
    headlineBoundingBox: headlineLayout?.bbox ?? null,
    headlineTop: typography?.headlineTop ?? null,
    headlineBottom: typography?.headlineBottom ?? null,
    headlineGapToVideo: typography?.headlineGapToVideo ?? null,
    headlineFontSize: headlineLayout?.fontSize ?? null,
    typography,
    enhancement: enhancementFilters(meta),
    gradeFilter,
  };
}


export async function render({ input, output, config, meta, resolved, onLog }) {
  const built = buildFilterGraph(config, meta, resolved);
  const requestedMode = requestedModeOf(config);
  built.requestedMode = requestedMode;
  built.rendererBranch = built.sourceMode;

  // Fail loudly rather than silently returning a full-frame/passthrough result.
  if (requestedMode === "kick_story" && built.rendererBranch !== "KICK_STORY_RECOMPOSE") {
    throw Object.assign(
      new Error(`kick_story request resolved to ${built.rendererBranch} — refusing to render`),
      { reason: "mode_precedence", retryable: false },
    );
  }
  if (requestedMode === "kick_story" && (built.vx !== 0 || built.vw !== built.canvasW)) {
    throw Object.assign(
      new Error(`kick_story foreground not full width (vx=${built.vx} vw=${built.vw})`),
      { reason: "geometry", retryable: false },
    );
  }
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
  ];
  if (built.typography) {
    const overlay = renderTextOverlay({
      width: built.typography.width,
      height: built.typography.height,
      lines: built.typography.lines,
      fontPath: built.typography.fontPath,
      emojiPath: built.typography.emojiPath,
      fontSize: built.typography.fontSize,
      color: built.typography.color,
      align: built.typography.align,
      lineSpacing: built.typography.lineSpacing,
      letterSpacing: built.typography.letterSpacing,
      weight: built.typography.weight,
      italic: built.typography.italic,
    });
    const overlayPath = join(dirname(output), "headline.png");
    await writeFile(overlayPath, overlay.png);
    args.push("-loop", "1", "-i", overlayPath);
    built.graph = `${built.graph.replace(/\[out\]$/, "[before_headline]")};[before_headline][1:v]overlay=${built.typography.x}:${built.typography.y}:shortest=1[out]`;
    built.typography = {
      ...built.typography,
      emojiFallbackUsed: overlay.coverage.emojiFallbackUsed,
      missingGlyphs: overlay.coverage.missing,
      measured: true,
    };
  }
  if (built.sourceMode === "KICK_STORY_RECOMPOSE" && built.canvasH < built.baseCanvasH) {
    built.graph = `${built.graph.replace(/\[out\]$/, "[before_outer_trim]")};[before_outer_trim]crop=${built.canvasW}:${built.canvasH}:0:0[out]`;
  }
  args.push("-filter_complex", built.graph, "-map", "[out]");

  const encoder = encoderArgs(meta, { hasAudio: meta.has_audio });
  args.push(...encoder.args, output);
  built.outputFps = encoder.fps;

  onLog?.(`layout requested_mode=${built.requestedMode} renderer_branch=${built.rendererBranch} source_mode=${built.sourceMode} detected=${built.detectedMode} source_aspect=${built.sourceAspect} content_rect=${JSON.stringify(built.contentRect)} final_canvas=${built.canvasW}x${built.canvasH} final_video=${built.vw}x${built.vh} video_top=${built.vy} video_bottom=${built.videoBottom ?? built.vy + built.vh} foreground_height=${built.vh} background_top_height=${built.backgroundTopHeight ?? built.vy} background_bottom_before=${built.lowerBackgroundHeightBefore ?? built.bottomPadding} background_bottom_after=${built.backgroundBottomHeight ?? built.bottomPadding} outer_trim=${built.actualRemovedPixels ?? 0} background_style=${built.backgroundStyle ?? config.background?.style ?? config.background?.mode} headline_top=${built.headlineTop ?? "none"} headline_bottom=${built.headlineBottom ?? "none"} headline_gap=${built.headlineGapToVideo ?? "none"} crop_amount=${JSON.stringify(built.cropAmount)} crop=${JSON.stringify(built.crop)} mode=${built.cropMode}`);
  built.ffmpegStarted = true;
  built.ffmpegGraph = built.graph;
  const startedAt = Date.now();
  try {
    await run("ffmpeg", args, { maxBuffer: 1024 * 1024 * 16 });
  } catch (error) {
    // Attach the pieces the diagnostics need: exit code, stderr tail and a
    // filter-graph summary (never the signed input/output URLs).
    error.stderr = String(error.stderr ?? "").slice(-4000);
    error.graphSummary = `filters=${built.graph.split(";").length} branch=${built.rendererBranch} fg=${built.vw}x${built.vh}@${built.vx},${built.vy}`;
    error.code = error.code ?? null;
    onLog?.(`ffmpeg failed exit=${error.code} ${error.stderr.slice(-600)}`);
    throw error;
  }
  built.ffmpegExitCode = 0;
  built.ffmpegMs = Date.now() - startedAt;
  onLog?.(`ffmpeg ok exit=0 in ${built.ffmpegMs}ms graph_filters=${built.graph.split(";").length} fps=${built.outputFps} grade=${config.color_grade?.name ?? "natural"} enhancement=${JSON.stringify(built.enhancement ?? [])}`);
  return built;
}
