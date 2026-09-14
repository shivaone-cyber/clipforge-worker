import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { coverage, createMeasurer, renderTextOverlay, resolveFont, validateFontFile } from "./text.js";
import { fitHeadlineLayout } from "./render.js";

const font = resolveFont({ source: "preset", preset: "inter" });
const validated = validateFontFile(font.path);
assert.ok(validated.glyphs > 100, "font parser should expose glyphs");
const measure = createMeasurer(font.path);
const width = measure("ClipForge typography", 58);
assert.ok(width > 250 && width < 900, `unexpected measured width ${width}`);
const layout = fitHeadlineLayout("Wait—this changes everything 👀", {
  canvasW: 1080, regionH: 307, fontSize: 64, maxLines: 3, lineSpacing: 1.18,
  safeLeft: 80, safeRight: 1000, safeTop: 32, safeBottom: 275, measure,
});
assert.ok(layout.bbox.y >= 32 && layout.bbox.y + layout.bbox.height <= 275);
const rendered = renderTextOverlay({
  width: layout.bbox.width, height: layout.bbox.height, lines: layout.lines,
  fontPath: font.path, emojiPath: font.emojiPath, fontSize: layout.fontSize,
  color: "#ffffff", align: "center", lineSpacing: layout.lineSpacing, letterSpacing: 0,
});
assert.ok(rendered.png.length > 1000, "overlay should contain rendered pixels");
if (font.emojiPath && existsSync(font.emojiPath)) assert.equal(coverage(font.path, "👀", font.emojiPath).missing.length, 0);
const badPath = new URL("../package.json", import.meta.url).pathname;
assert.throws(() => validateFontFile(badPath), /unsupported font header/);
console.log(JSON.stringify({ ok: true, family: validated.family, width: Number(width.toFixed(2)), layout, coverage: rendered.coverage }));