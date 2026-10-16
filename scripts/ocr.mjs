// OCR receipt images to text, offline.
//
// Tesseract runs as WebAssembly inside Node: no native toolchain, and no image
// is ever sent anywhere. First run downloads ~11 MB of English language data.
//
// Real phone photos of receipts are very often shot sideways. A single
// orientation pass on a 90-degree receipt yields near-garbage at low confidence,
// which is indistinguishable from a genuinely bad photo. So this tries the
// natural orientation first and, if confidence is poor, re-OCRs the image
// rotated in 90-degree steps via ffmpeg and keeps the best result. The chosen
// rotation is recorded alongside the confidence so a poor read is visible as
// such rather than silently trusted.

import { createWorker } from "tesseract.js";
import { readdirSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"]);

const FFMPEG = process.env.FFMPEG_PATH
  || (existsSync("C:\\tools\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe")
    ? "C:\\tools\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe"
    : "ffmpeg");

// Below this confidence the image is probably rotated, not merely blurry.
const ROTATE_THRESHOLD = 72;

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

function hasFfmpeg() {
  const r = spawnSync(FFMPEG, ["-version"], { encoding: "utf8" });
  return r.status === 0;
}

// ffmpeg transpose: 1 = 90 deg clockwise, 2 = 90 deg counter-clockwise.
function rotate(src, degrees, outPath) {
  const vf = degrees === 90 ? "transpose=1" : degrees === 180 ? "transpose=1,transpose=1" : "transpose=2";
  const r = spawnSync(FFMPEG, [
    "-y", "-i", resolve(src).replace(/\\/g, "/"),
    "-vf", vf,
    resolve(outPath).replace(/\\/g, "/"),
  ], { encoding: "utf8" });
  return r.status === 0 ? outPath : null;
}

export function collectImages(dir) {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
    .map((f) => join(abs, f))
    .sort();
}

export async function ocrOne(worker, path, { tryRotate = true } = {}) {
  const tmp = join(tmpdir(), "ledgerlens-rot");
  let best = null;
  const attempts = tryRotate ? [0, 90, 180, 270] : [0];

  for (const deg of attempts) {
    let target = path;
    let cleanup = null;
    if (deg !== 0) {
      mkdirSync(tmp, { recursive: true });
      const rotated = join(tmp, `${basename(path)}.rot${deg}${extname(path) || ".png"}`);
      if (!rotate(path, deg, rotated)) continue;
      target = rotated;
      cleanup = rotated;
    }
    try {
      const t0 = Date.now();
      const { data } = await worker.recognize(target);
      const cand = {
        text: data.text,
        confidence: Number(data.confidence ?? 0),
        rotation: deg,
        ms: Date.now() - t0,
      };
      if (!best || cand.confidence > best.confidence) best = cand;
      // A confident upright read is the common case; stop early.
      if (deg === 0 && best.confidence >= 88) break;
    } finally {
      if (cleanup) { try { rmSync(cleanup, { force: true }); } catch { /* ignore */ } }
    }
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  return best;
}

async function main() {
  const targets = positionals(process.argv.slice(2));
  if (targets.length === 0) {
    console.error("usage: node scripts/ocr.mjs <dir-or-file> [--out data/raw] [--lang eng] [--no-rotate]");
    process.exitCode = 1;
    return;
  }

  const outDir = resolve(ROOT, argValue("--out", "data/raw"));
  const lang = argValue("--lang", "eng");
  const tryRotate = !process.argv.includes("--no-rotate");
  mkdirSync(outDir, { recursive: true });

  let files = [];
  for (const t of targets) {
    const abs = resolve(ROOT, t);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) files.push(...collectImages(abs));
    else if (IMAGE_EXT.has(extname(abs).toLowerCase())) files.push(abs);
  }
  if (files.length === 0) {
    console.error(`no images found for: ${targets.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const rotateAvailable = tryRotate && hasFfmpeg();
  if (tryRotate && !rotateAvailable) {
    console.error("note: ffmpeg not found, so rotated images will not be straightened. Set FFMPEG_PATH to enable it.");
  }

  console.error(`loading OCR worker (${lang}) - first run downloads language data...`);
  const worker = await createWorker(lang);

  const results = [];
  for (const f of files) {
    const r = await ocrOne(worker, f, { tryRotate: rotateAvailable });
    if (!r) { console.error(`  ${basename(f)}: could not be read`); continue; }
    const name = basename(f);
    results.push({ file: name, ...r });
    const txtPath = join(outDir, name.replace(/\.[^.]+$/, ".txt"));
    writeFileSync(txtPath, r.text, "utf8");
    const rot = r.rotation ? ` rot=${r.rotation}` : "        ";
    const warn = r.confidence < ROTATE_THRESHOLD ? "  LOW" : "     ";
    console.log(`  ${warn} ${r.confidence.toFixed(1).padStart(5)} conf${rot}  ${(r.ms / 1000).toFixed(1)}s  ${name}`);
  }

  writeFileSync(
    join(outDir, "index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
    "utf8"
  );
  await worker.terminate();

  const low = results.filter((r) => r.confidence < ROTATE_THRESHOLD).length;
  console.log(`\n${results.length} image(s) -> ${outDir.replace(ROOT + "\\", "")}`);
  if (low) console.log(`${low} below ${ROTATE_THRESHOLD} confidence - check those by hand before filing.`);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("ocr.mjs")) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}