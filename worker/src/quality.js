// Quality normalisation + professional colour grade.
// Everything here is a *pixel* treatment applied to the foreground stream only.
// It never changes geometry (crop/scale/overlay positions are decided in
// render.js and stay byte-identical across White / Black / Blur).

const ENHANCE = String(process.env.QUALITY_ENHANCE ?? "true").toLowerCase() !== "false";

/**
 * Is the source soft/noisy enough that a controlled denoise actually helps?
 * Low bits-per-pixel (heavily re-compressed reposts) or sub-720p sources.
 */
export function needsDenoise(meta) {
  const pixels = Math.max(1, (meta.width || 0) * (meta.height || 0) * (meta.fps || 30));
  const bpp = (meta.bitrate || 0) / pixels;
  return bpp > 0 ? bpp < 0.055 : Math.min(meta.width || 0, meta.height || 0) <= 720;
}

/**
 * Filters appended to the foreground AFTER crop+scale, BEFORE the colour grade.
 * Mild by design: no halos, no fake detail, no aggressive AI-style enhancement.
 */
export function enhancementFilters(meta) {
  if (!ENHANCE) return [];
  const filters = [];
  if (needsDenoise(meta)) filters.push("hqdn3d=1.5:1.2:4:4");
  // Luma-only, low amount — detail recovery after scaling, not sharpening.
  filters.push("unsharp=5:5:0.42:5:5:0.0");
  return filters;
}

/**
 * Professional grade: balanced exposure, controlled highlights/shadows,
 * natural saturation + a touch of vibrance. Skin tones are deliberately left
 * alone (no hue rotation, no channel mixing).
 */
export function professionalGrade(i = 1) {
  const k = Math.max(0, Math.min(1.4, i));
  const lo = (0.24 - 0.03 * k).toFixed(3);
  const hi = (0.76 + 0.03 * k).toFixed(3);
  return [
    `curves=master='0/0 0.25/${lo} 0.75/${hi} 1/1'`,
    `eq=contrast=${(1 + 0.06 * k).toFixed(3)}:saturation=${(1 + 0.07 * k).toFixed(3)}:brightness=${(0.008 * k).toFixed(4)}:gamma=${(1 - 0.015 * k).toFixed(3)}`,
].join(",");
}

/** Output encoder settings: high-quality H.264 + synchronised AAC. */
export function encoderArgs(meta, { hasAudio }) {
  const fps = Number(meta.fps);
  // Preserve the source frame rate; normalise only absurd/unknown values.
  const rate = Number.isFinite(fps) && fps >= 20 && fps <= 61 ? Number(fps.toFixed(3)) : 30;
  const args = [];
  if (hasAudio) {
    args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-af", "aresample=async=1:first_pts=0");
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", process.env.X264_PRESET || "medium",
    "-crf", process.env.X264_CRF || "18",
    "-profile:v", "high",
    "-level", "4.2",
    "-maxrate", "12M",
    "-bufsize", "24M",
    "-pix_fmt", "yuv420p",
    "-r", String(rate),
    "-movflags", "+faststart",
  );
  return { args, fps: rate };
}
