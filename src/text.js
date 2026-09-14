import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { create as createFont, openSync as openFontSync } from "fontkit";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const registered = new Map();
const parsed = new Map();
const ASSET_FONTS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
const BUNDLED_EMOJI_FONT = join(ASSET_FONTS, "NotoColorEmoji.ttf");
const EMOJI_FONT = process.env.FONT_EMOJI || BUNDLED_EMOJI_FONT;

export const FONT_PRESETS = {
  inter: [join(ASSET_FONTS, "Inter.ttf"), "/usr/share/fonts/truetype/inter/Inter-Bold.ttf", "/usr/share/fonts/opentype/inter/Inter-Bold.otf"],
  poppins: [join(ASSET_FONTS, "Poppins-Bold.ttf"), "/usr/share/fonts/truetype/poppins/Poppins-Bold.ttf"],
  montserrat: [join(ASSET_FONTS, "Montserrat.ttf"), "/usr/share/fonts/truetype/montserrat/Montserrat-Bold.ttf"],
  roboto: [join(ASSET_FONTS, "Roboto.ttf"), "/usr/share/fonts/truetype/roboto/unhinted/RobotoTTF/Roboto-Bold.ttf", "/usr/share/fonts/truetype/roboto/Roboto-Bold.ttf"],
  arial: ["/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"],
  georgia: ["/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf"],
  "bebas-neue": [join(ASSET_FONTS, "BebasNeue-Regular.ttf"), "/usr/share/fonts/truetype/bebas-neue/BebasNeue-Regular.ttf"],
  oswald: [join(ASSET_FONTS, "Oswald.ttf"), "/usr/share/fonts/truetype/oswald/Oswald-Bold.ttf"],
};

function firstExisting(paths) {
  return paths.find((path) => existsSync(path)) ?? null;
}

function fontconfig(name) {
  try {
    const path = execFileSync("fc-match", ["-f", "%{file}", name], { encoding: "utf8" }).trim();
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

export function validateFontFile(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 12 || bytes.length > 5 * 1024 * 1024) throw new Error("font size is invalid");
  const magic = bytes.subarray(0, 4).toString("latin1");
  const sfnt = bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0;
  if (!sfnt && !["OTTO", "wOFF", "wOF2"].includes(magic)) throw new Error("unsupported font header");
  const font = createFont(bytes);
  if (!font || !Number(font.numGlyphs)) throw new Error("font has no usable glyphs");
  parsed.set(path, font);
  return { family: String(font.familyName || font.fullName || "Custom").slice(0, 80), glyphs: Number(font.numGlyphs) };
}

export function resolveFont(config = {}, customPath = null) {
  const preset = String(config.preset || "poppins").toLowerCase();
  let path = null;
  let source = "preset";
  let validation = "not_required";
  if (config.source === "custom" && customPath) {
    try {
      validateFontFile(customPath);
      path = customPath;
      source = "custom";
      validation = "validated";
    } catch {
      validation = "fallback_invalid_custom";
    }
  }
  path ||= firstExisting(FONT_PRESETS[preset] || FONT_PRESETS.poppins);
  path ||= firstExisting([
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  ]);
  path ||= fontconfig(preset === "georgia" ? "serif:style=Bold" : `${preset}:style=Bold`);
  path ||= fontconfig("sans-serif:style=Bold");
  if (!path) throw new Error("no usable headline font found");
  const configuredEmoji = firstExisting([EMOJI_FONT, BUNDLED_EMOJI_FONT, "/usr/share/fonts/opentype/noto/NotoColorEmoji.ttf"]);
  const matchedEmoji = fontconfig("Noto Color Emoji");
  const emojiPath = configuredEmoji || (matchedEmoji && /emoji/i.test(matchedEmoji) ? matchedEmoji : null);
  return { path, preset, source, validation, emojiPath };
}

function familyFor(path) {
  if (registered.has(path)) return registered.get(path);
  const family = `ClipForge-${registered.size + 1}`;
  if (!GlobalFonts.registerFromPath(path, family)) throw new Error(`font registration failed: ${path}`);
  registered.set(path, family);
  return family;
}

export function createMeasurer(fontPath, options = {}, emojiPath = null) {
  const family = familyFor(fontPath);
  const emojiFamily = emojiPath && existsSync(emojiPath) ? familyFor(emojiPath) : family;
  const canvas = createCanvas(8, 8);
  const ctx = canvas.getContext("2d");
  return (text, size, letterSpacing = 0) => {
    const glyphs = Array.from(String(text));
    const measured = glyphs.reduce((total, char) => {
      const selectedFamily = isEmoji(char) ? emojiFamily : family;
      ctx.font = `${options.italic ? "italic " : ""}${Number(options.weight || 700)} ${size}px "${selectedFamily}"`;
      return total + ctx.measureText(char).width;
    }, 0);
    return measured + Math.max(0, glyphs.length - 1) * Number(letterSpacing || 0);
  };
}

function isEmoji(char) {
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(char);
}

function glyphBitmap(char, family, fontSize, weight, italic) {
  const side = Math.max(128, Math.ceil(fontSize * 4));
  const canvas = createCanvas(side, side);
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";
  ctx.font = `${italic ? "italic " : ""}${Number(weight || 700)} ${fontSize}px "${family}"`;
  ctx.fillText(char, Math.round(fontSize), Math.round(fontSize));
  const pixels = ctx.getImageData(0, 0, side, side);
  let left = side, top = side, right = -1, bottom = -1;
  for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) {
    if (pixels.data[(y * side + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) return null;
  return { canvas, left, top, width: right - left + 1, height: bottom - top + 1 };
}

function fontObject(path) {
  if (!parsed.has(path)) parsed.set(path, openFontSync(path));
  return parsed.get(path);
}

export function coverage(fontPath, text, emojiPath = EMOJI_FONT) {
  const primary = fontObject(fontPath);
  const emoji = emojiPath && existsSync(emojiPath) ? fontObject(emojiPath) : null;
  const missing = [];
  let emojiFallbackUsed = false;
  for (const char of Array.from(String(text))) {
    const cp = char.codePointAt(0);
    if (!cp || /\s/u.test(char) || cp === 0xfe0f) continue;
    if (primary.hasGlyphForCodePoint(cp)) continue;
    if (emoji?.hasGlyphForCodePoint(cp)) emojiFallbackUsed = true;
    else missing.push(`U+${cp.toString(16).toUpperCase()}`);
  }
  return { emojiFallbackUsed, missing: [...new Set(missing)].slice(0, 12) };
}

export function renderTextOverlay({ width, height, lines, fontPath, emojiPath, fontSize, color, align, lineSpacing, letterSpacing, weight, italic }) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const primaryFamily = familyFor(fontPath);
  const emojiFamily = emojiPath && existsSync(emojiPath) ? familyFor(emojiPath) : primaryFamily;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  const step = fontSize * lineSpacing;
  lines.forEach((line, row) => {
    const chars = Array.from(line);
    const emojiChars = [];
    while (chars.length && isEmoji(chars.at(-1))) emojiChars.unshift(chars.pop());
    const words = chars.join("").trimEnd();
    ctx.font = `${italic ? "italic " : ""}${Number(weight || 700)} ${fontSize}px "${primaryFamily}"`;
    const wordsWidth = ctx.measureText(words).width;
    const emojiGap = words && emojiChars.length ? fontSize * 0.22 : 0;
    const emojiWidths = emojiChars.map((char) => {
      const bitmap = glyphBitmap(char, emojiFamily, fontSize, weight, italic);
      return { char, bitmap, width: bitmap ? fontSize * 1.02 * (bitmap.width / bitmap.height) : fontSize };
    });
    const total = wordsWidth + emojiGap + emojiWidths.reduce((sum, emoji) => sum + emoji.width, 0);
    let x = align === "left" ? 0 : align === "right" ? width - total : (width - total) / 2;
    if (words) {
      ctx.font = `${italic ? "italic " : ""}${Number(weight || 700)} ${fontSize}px "${primaryFamily}"`;
      ctx.fillText(words, x, row * step);
      x += wordsWidth + emojiGap;
    }
    for (const emoji of emojiWidths) {
      const targetHeight = fontSize * 1.02;
      if (emoji.bitmap) ctx.drawImage(emoji.bitmap.canvas, emoji.bitmap.left, emoji.bitmap.top, emoji.bitmap.width, emoji.bitmap.height, x, row * step, emoji.width, targetHeight);
      x += emoji.width;
    }
  });
  return { png: canvas.toBuffer("image/png"), coverage: coverage(fontPath, lines.join(" "), emojiPath) };
}

export function renderFontPreview({ text, config = {}, customPath = null }) {
  const width = 1080;
  const height = 600;
  const safeLeft = 80;
  const safeRight = width - 80;
  const resolved = resolveFont(config, customPath);
  const measure = createMeasurer(resolved.path, config, resolved.emojiPath);
  let fontSize = 76;
  const words = String(text).trim().split(/\s+/);
  let lines = [];
  while (fontSize >= 38) {
    lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(candidate, fontSize, Number(config.letterSpacing || 0)) > safeRight - safeLeft) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
    if (lines.length <= Number(config.maxLines || 3)) break;
    fontSize -= 2;
  }
  const lineSpacing = Number(config.lineSpacing || 1.18);
  const textHeight = fontSize + Math.max(0, lines.length - 1) * fontSize * lineSpacing;
  const overlay = renderTextOverlay({
    width: safeRight - safeLeft,
    height: Math.ceil(textHeight + 8),
    lines,
    fontPath: resolved.path,
    emojiPath: resolved.emojiPath,
    fontSize,
    color: "#111111",
    align: config.align || "center",
    lineSpacing,
    letterSpacing: Number(config.letterSpacing || 0),
    weight: config.weight || 700,
    italic: config.italic === true,
  });
  return {
    png: overlay.png,
    width: safeRight - safeLeft,
    height: Math.ceil(textHeight + 8),
    canvasWidth: width,
    canvasHeight: height,
    offsetX: safeLeft,
    offsetY: Math.round((height - 18 - textHeight) / 2),
    fontSize,
    lines,
    coverage: overlay.coverage,
    font: resolved,
  };
}