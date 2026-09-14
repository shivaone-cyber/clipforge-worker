// Instagram Reel/post downloader. Swappable module: add tiktok.js / youtube.js
// with the same { kind, match, normalize, fetchVideo } shape and register them
// in index.js. This never bypasses logins, private accounts, rate limits or any
// other access control — if the post is not publicly available we fail with a
// clear reason instead.

import { ytDlpDownload } from "./ytdlp.js";

export const kind = "instagram_url";

const URL_RE = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i;

export function match(url) {
  return URL_RE.test(String(url || "").trim());
}

/** Strip tracking params / share suffixes down to a canonical post URL. */
export function normalize(url) {
  const m = URL_RE.exec(String(url || "").trim());
  if (!m) return null;
  const type = m[1].toLowerCase() === "reels" ? "reel" : m[1].toLowerCase();
  return `https://www.instagram.com/${type}/${m[2]}/`;
}

const LOGIN_WALL =
  "Instagram requires login for this Reel, so I can't access it from the link. Please upload the video file instead.";

export function classify(raw = "", { timedOut = false } = {}) {
  const s = String(raw).toLowerCase();
  if (timedOut) return "That Reel took too long to download. Try again, or upload the video file.";
  if (s.includes("enoent") || s.includes("yt-dlp produced no file") || s.includes("not recognized"))
    return "The downloader isn't available on this machine right now, so I couldn't fetch that Reel. Upload the video file instead.";
  if (s.includes("429") || s.includes("rate-limit") || s.includes("rate limit") || s.includes("too many requests"))
    return "Instagram is rate-limiting downloads right now. Wait a few minutes and try again.";
  if (
    s.includes("private") ||
    s.includes("login required") ||
    s.includes("requested content is not available") ||
    s.includes("empty media response") ||
    s.includes("cookies") ||
    s.includes("sign in")
  )
    return LOGIN_WALL;
  if (s.includes("age")) return "That Reel is age-restricted and can't be fetched.";
  if (s.includes("not available") || s.includes("unavailable")) return LOGIN_WALL;
  if (
    s.includes("404") ||
    s.includes("removed") ||
    s.includes("deleted")
  )
    return "That Reel is unavailable or has been deleted.";
  if (s.includes("max-filesize") || s.includes("larger than")) return "That Reel is too large to process.";
  if (s.includes("unsupported url")) return "That link isn't a supported Instagram Reel or post.";
  return "I couldn't download that Reel. Try again in a minute, or upload the video file instead.";
}


export async function fetchVideo(rawUrl, dest, onLog = () => {}) {
  const url = normalize(rawUrl);
  if (!url) {
    const msg = "That link isn't a valid Instagram Reel or post URL.";
    throw Object.assign(new Error(msg), { reason: "download", retryable: false, userMessage: msg });
  }

  onLog(`instagram: fetching ${url}`);
  try {
    const { bytes, version } = await ytDlpDownload({ url, dest, onLog });
    onLog(`instagram: downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB with yt-dlp ${version}`);
    return bytes;
  } catch (error) {
    const friendly = classify(`${error.stderr || ""}${error.message || ""}`, { timedOut: error.killed });
    // Internal detail is kept verbatim for the processing log; the user sees `friendly`.
    onLog(`instagram: FAILED ${(error.stderr || error.message || "").slice(0, 600)}`);
    throw Object.assign(new Error(friendly), {
      reason: "download",
      retryable: false,
      stderr: (error.stderr || "").slice(0, 1500),
      userMessage: friendly,
    });
  }
}
