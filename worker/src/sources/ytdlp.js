// Shared yt-dlp runner. Platform modules (instagram/tiktok/youtube) reuse this,
// so adding a platform never touches the rendering engine.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const MAX_FILESIZE = "190M";
const TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 240_000);

function isAccessControlledFailure(error) {
  const detail = `${error?.stderr || ""}\n${error?.stdout || ""}\n${error?.message || ""}`.toLowerCase();
  return [
    "private", "login required", "requested content is not available",
    "empty media response", "cookies", "sign in", "authentication",
  ].some((marker) => detail.includes(marker));
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function ytDlpVersion() {
  try {
    const { stdout } = await run("yt-dlp", ["--version"], { timeout: 20_000 });
    return stdout.trim();
  } catch {
    return "unavailable";
  }
}

/**
 * Download a publicly accessible video to `dest`.
 * Never uses cookies, logins, or private-account access.
 * Returns { bytes, stderr, version }.
 */
export async function ytDlpDownload({ url, dest, extraArgs = [], onLog = () => {} }) {
  const work = await mkdtemp(join(tmpdir(), "clipforge-dl-"));
  const version = await ytDlpVersion();
  onLog(`yt-dlp ${version}`);

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--no-cache-dir",
    "--ignore-config",
    "--restrict-filenames",
    "--retries",
    "1",
    "--fragment-retries",
    "3",
    "--socket-timeout",
    "30",
    "--max-filesize",
    MAX_FILESIZE,
    "--user-agent",
    UA,
    "-f",
    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "-o",
    join(work, "src.%(ext)s"),
    ...extraArgs,
    url,
  ];

  try {
    const { stdout, stderr } = await run("yt-dlp", args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const tail = `${stdout || ""}\n${stderr || ""}`.trim().slice(-1500);
    if (tail) onLog(`yt-dlp output: ${tail.slice(-400)}`);

    const files = (await readdir(work)).filter((f) => !f.endsWith(".part"));
    if (files.length === 0) {
      throw Object.assign(new Error("yt-dlp produced no file"), { stderr: tail, code: "empty" });
    }
    // Prefer the merged mp4; otherwise take the largest artefact.
    let pick = files.find((f) => f.endsWith(".mp4"));
    if (!pick) {
      const sized = await Promise.all(
        files.map(async (f) => ({ f, size: (await stat(join(work, f))).size })),
      );
      sized.sort((a, b) => b.size - a.size);
      pick = sized[0].f;
    }
    await rename(join(work, pick), dest);
    const { size } = await stat(dest);
    return { bytes: size, stderr: tail, version };
  } catch (error) {
    const stderr = `${error.stderr || ""}`;
    const detail = `${stderr}\n${error.stdout || ""}\n${error.message || ""}`;
    throw Object.assign(new Error(error.message || "download failed"), {
      stderr: detail.slice(0, 2000),
      killed: error.killed === true || error.signal === "SIGTERM",
      accessControlled: isAccessControlledFailure(error),
      version,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
