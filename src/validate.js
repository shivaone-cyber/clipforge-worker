// Independent final-quality validation. Runs on the rendered MP4 only —
// it never touches the composition and never "fixes" anything; it fails loudly
// so a corrupted or black render is never delivered to Telegram.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function blackRatio(file, duration) {
  try {
    const { stderr } = await run("ffmpeg", [
      "-hide_banner", "-loglevel", "info", "-i", file,
      "-vf", "blackdetect=d=0.5:pic_th=0.98:pix_th=0.05", "-an", "-f", "null", "-",
    ], { maxBuffer: 1024 * 1024 * 16 });
    const total = [...String(stderr).matchAll(/black_duration:(\d+(?:\.\d+)?)/g)]
      .reduce((sum, m) => sum + Number(m[1]), 0);
    return duration > 0 ? Number((total / duration).toFixed(3)) : 0;
  } catch {
    return 0;
  }
}

export async function validateOutput({ output, outMeta, meta, expectSize, renderProof }) {
  const problems = [];
  if (expectSize && (outMeta.width !== expectSize.width || outMeta.height !== expectSize.height)) {
    problems.push(`dimensions ${outMeta.width}x${outMeta.height}`);
  }
  if (!outMeta.codec) problems.push("no video stream");
  if (!(outMeta.duration > 0)) problems.push("zero duration");
  const drift = meta.duration > 0 ? Math.abs(outMeta.duration - meta.duration) : 0;
  if (meta.duration > 0 && drift > Math.max(1.5, meta.duration * 0.05)) {
    problems.push(`duration drift ${drift.toFixed(2)}s`);
  }
  if (meta.has_audio && !outMeta.has_audio) problems.push("audio stream lost");
  const black = await blackRatio(output, outMeta.duration);
  if (black > 0.4) problems.push(`black frames ${(black * 100).toFixed(0)}%`);
  const typography = renderProof?.typography;
  if (typography && typography.measured !== true) problems.push("headline was not metric-measured");
  if (typography && Array.isArray(typography.missing_glyphs) && typography.missing_glyphs.length) {
    problems.push(`missing glyphs ${typography.missing_glyphs.join(",")}`);
  }
  if (typography && Number(typography.line_count) > 3) problems.push(`headline has ${typography.line_count} lines`);
  if (typography && (Number(typography.headline_gap_to_video) < 24 || Number(typography.headline_gap_to_video) > 55)) {
    problems.push(`headline gap ${typography.headline_gap_to_video}px`);
  }
  const composition = renderProof?.composition;
  if (composition) {
    if (composition.generated_footer !== false) problems.push("generated footer present");
    if (composition.lower_background_only !== true) problems.push("lower region is not background-only");
    if (composition.foreground_x !== 0 || composition.foreground_right !== expectSize?.width) problems.push("foreground has side gaps");
    if (!(Number(composition.video_top) < Number(composition.video_bottom))) problems.push("invalid foreground bounds");
    if (Number(composition.foreground_height) !== Number(composition.video_bottom) - Number(composition.video_top)) problems.push("foreground height mismatch");
    if (Number(composition.background_top_height) !== Number(composition.video_top)) problems.push("top background coverage mismatch");
    if (Number(composition.background_bottom_height) !== Number(expectSize?.height) - Number(composition.video_bottom)) problems.push("bottom background coverage mismatch");
    if (Number(composition.background_top_height) + Number(composition.foreground_height) + Number(composition.background_bottom_height) !== Number(expectSize?.height)) problems.push("background/foreground coverage has gap or overlap");
    if (!['white', 'black', 'blur'].includes(String(composition.background_style))) problems.push("invalid background style proof");
    if (composition.kick_strip_protected !== true) problems.push("KICK strip not protected");
    if (composition.crop_preference === "BOTTOM_FIRST" && Number(composition.crop_top) > 0 && Number(composition.crop_bottom) > 0) problems.push("bottom-first crop removed both top and bottom");
    if (Number(composition.protected_region_intersections) > 0) problems.push(`crop intersects ${composition.protected_region_intersections} protected regions`);
    if (composition.trim_scope !== "OUTER_BACKGROUND_ONLY") problems.push("invalid trim scope");
    if (composition.foreground_changed !== false) problems.push("foreground changed during outer trim");
    if (composition.kick_strip_changed !== false) problems.push("KICK strip changed during outer trim");
    if (Number(composition.requested_trim_percent) !== 35) problems.push("invalid requested outer trim percent");
    if (Number(composition.actual_trim_pixels) > Number(composition.requested_trim_pixels)) problems.push("outer trim exceeds requested amount");
    if (Number(composition.lower_background_height_after) !== Number(composition.lower_background_height_before) - Number(composition.actual_trim_pixels)) problems.push("lower background trim does not reconcile");
    if (Number(composition.final_canvas_height) !== Number(composition.base_canvas_height) - Number(composition.actual_trim_pixels)) problems.push("final canvas restored or incorrectly trimmed");
    if (Number(composition.actual_trim_pixels) > 0 && Number(composition.lower_background_height_after) < Number(composition.upper_background_height)) problems.push("lower background trimmed past balance point");
    if (Number(composition.actual_trim_pixels) === 0 && Number(composition.lower_background_height_before) > Number(composition.upper_background_height) * 1.1) problems.push("unbalanced lower background was not trimmed");
  }
  const replacement = renderProof?.hook_replacement;
  if (replacement?.state === "replaced" && replacement.applied_before_crop_scale !== true) {
    problems.push("old hook mask was not applied before crop/scale");
  }
  if (replacement?.state === "replaced" && (!replacement.source_mask || !replacement.transformed_mask)) {
    problems.push("old hook replacement proof incomplete");
  }
  if (replacement?.state === "not_generated" && typography) problems.push("generated headline present after replacement rejection");
  if (["replaced", "added_no_old_hook"].includes(replacement?.state) && !typography) problems.push("approved hook decision has no headline");
  const hookText = String(renderProof?.hook ?? "");
  if (hookText && Array.from(hookText).length > 55) problems.push("headline exceeds 55 characters");
  if (Number(renderProof?.hook_emoji_count ?? 0) > 2) problems.push("headline exceeds two emojis");
  if (renderProof?.ai_hook_skipped === true && (typography || hookText)) problems.push("AI-off generated a headline");
  const aiHookEnabled = renderProof?.ai_hook_enabled;
  const hookAction = renderProof?.hook_action;
  if (aiHookEnabled === false && (hookAction !== "PRESERVE_SOURCE" || renderProof?.gemini_hook_called !== false || renderProof?.old_hook_removed !== false || renderProof?.new_headline_rendered !== false || replacement?.source_mask)) {
    problems.push("AI-off did not preserve source");
  }
  if (aiHookEnabled === true && hookAction === "REPLACE_OLD_HOOK" && (renderProof?.old_hook_detected !== true || renderProof?.old_hook_removed !== true || renderProof?.new_headline_rendered !== true)) problems.push("AI replacement proof inconsistent");
  if (aiHookEnabled === true && hookAction === "ADD_NEW_HOOK" && (renderProof?.old_hook_removed !== false || renderProof?.new_headline_rendered !== true)) problems.push("AI add-hook proof inconsistent");
  if (aiHookEnabled === true && hookAction === "PRESERVE_SOURCE" && (renderProof?.old_hook_removed !== false || renderProof?.new_headline_rendered !== false)) problems.push("AI rejection did not preserve source");

  return {
    ok: problems.length === 0,
    width: outMeta.width,
    height: outMeta.height,
    duration: Number(outMeta.duration.toFixed(3)),
    source_duration: Number((meta.duration || 0).toFixed(3)),
    duration_drift: Number(drift.toFixed(3)),
    fps: Number((outMeta.fps || 0).toFixed(3)),
    source_fps: Number((meta.fps || 0).toFixed(3)),
    video_codec: outMeta.codec ?? null,
    has_audio: outMeta.has_audio === true,
    black_ratio: black,
    problems,
  };
}
