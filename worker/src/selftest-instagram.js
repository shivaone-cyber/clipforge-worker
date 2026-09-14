// Worker self-test: node src/selftest-instagram.js <public-reel-url>
// Reports URL validation, downloader status, file path, duration, resolution
// and a final success/failure reason. Does not touch the cloud or the queue.

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probe } from "./analyze.js";
import * as instagram from "./sources/instagram.js";
import { ytDlpVersion } from "./sources/ytdlp.js";

const url = process.argv[2] || process.env.TEST_INSTAGRAM_URL;

function line(label, value) {
  console.log(`${label.padEnd(20)} ${value}`);
}

async function main() {
  console.log("ClipForge — Instagram downloader self-test\n");
  line("yt-dlp", await ytDlpVersion());

  if (!url) {
    line("URL validation", "FAIL — no URL given");
    console.log("\nUsage: npm run test:instagram -- https://www.instagram.com/reel/XXXXXXXXX/");
    process.exit(1);
  }

  const normalized = instagram.match(url) ? instagram.normalize(url) : null;
  line("input URL", url);
  line("URL validation", normalized ? `OK → ${normalized}` : "FAIL — not a supported Instagram URL");
  if (!normalized) {
    console.log("\nRESULT: FAILURE — unsupported URL");
    process.exit(1);
  }

  const dir = await mkdtemp(join(tmpdir(), "clipforge-selftest-"));
  const dest = join(dir, "input.mp4");
  const keep = process.argv.includes("--keep");

  try {
    const started = Date.now();
    await instagram.fetchVideo(normalized, dest, (m) => console.log(`  · ${m}`));
    const { size } = await stat(dest);
    line("downloader", `OK in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    line("file path", dest);
    line("file size", `${(size / 1024 / 1024).toFixed(2)} MB`);

    const meta = await probe(dest);
    line("duration", `${meta.duration.toFixed(2)}s`);
    line("resolution", `${meta.width}x${meta.height}`);
    line("codec / audio", `${meta.codec} / ${meta.has_audio ? "yes" : "no"}`);
    console.log("\nRESULT: SUCCESS — file is ready for the normal render pipeline");
    if (keep) console.log(`(kept at ${dest})`);
  } catch (error) {
    line("downloader", "FAIL");
    line("user message", error.userMessage || error.message);
    if (error.stderr) console.log(`\n--- downloader log ---\n${error.stderr}\n----------------------`);
    console.log("\nRESULT: FAILURE — " + (error.userMessage || error.message));
    process.exitCode = 1;
  } finally {
    if (!keep) await rm(dir, { recursive: true, force: true });
  }
}

main();
