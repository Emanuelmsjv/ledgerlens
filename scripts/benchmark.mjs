// Benchmark runner.
//
// Two suites, because each has a weakness the other does not.
//
//   synthetic  - 7 receipts whose correct values were fixed when the case was
//                written. Measurable and repeatable, but they are rendered by
//                me, so they flatter the parser: clean layout, one font, no
//                folds, no glare, no patterned background.
//
//   real       - 4 real bills, ground truth read off the paper by eye. Honest
//                about messy input, but far too small to be a benchmark.
//
// Reported separately and never averaged together. The headline number is not
// "accuracy", it is the rate at which a total was produced and was wrong,
// because a wrong total in a bookkeeping file is the failure that matters. The
// synthetic suite cannot produce a wrong answer by accident, so it measures
// coverage; the real suite is the one that can embarrass us.
//
// Usage: node scripts/benchmark.mjs [--no-ocr]

import { spawnSync } from "node:child_process";
import { createWorker } from "tesseract.js";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { CASES, linesFor } from "../benchmark/cases.mjs";
import { parseReceiptText } from "./parse.mjs";
import { ocrOne } from "./ocr.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG = process.env.FFMPEG_PATH || "C:\\tools\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe";
const FONT = "'C\\:/Windows/Fonts/arial.ttf'";
const TMP = join(tmpdir(), "ledgerlens-bench");

const money = (n) => (n == null || n === "" ? "" : Number(n).toFixed(2));

function render(lines, outPng) {
  const txtDir = join(TMP, "txt");
  rmSync(txtDir, { recursive: true, force: true });
  mkdirSync(txtDir, { recursive: true });
  const filters = [];
  let y = 36;
  for (const [i, [text, size]] of lines.entries()) {
    const f = join(txtDir, `l${i}.txt`);
    writeFileSync(f, text, "utf8");
    const ff = "'" + f.replace(/\\/g, "/").replace(/:/g, "\\:") + "'";
    filters.push(`drawtext=fontfile=${FONT}:textfile=${ff}:x=36:y=${y}:fontsize=${size}:fontcolor=black`);
    y += Math.round(size * 1.9);
  }
  const r = spawnSync(FFMPEG, [
    "-y", "-f", "lavfi", "-i", `color=c=white:s=660x${y + 36}`,
    "-vf", filters.join(","), "-frames:v", "1", resolve(outPng).replace(/\\/g, "/"),
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr ?? "").slice(-300)}`);
}

function compare(c, got) {
  const fields = [];
  const push = (k, want, have) => fields.push({ field: k, want, have, ok: want === null ? have === null || have === "" : String(want) === String(have) });
  push("total", money(c.total), got.total == null ? null : money(got.total));
  push("subtotal", c.subtotal == null ? null : money(c.subtotal), got.subtotal == null ? null : money(got.subtotal));
  push("date", c.date, got.date);
  if (c.invoice) push("invoice", c.invoice, got.invoice);
  if (c.gstin) push("gstin", c.gstin, got.gstin);
  // Vendor: OCR noise and rendering damage make an exact match too strict, so
  // compare on the significant words only.
  const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9 ]/g, "").split(/\s+/).filter((w) => w.length >= 4);
  const wantW = norm(c.vendor), gotW = new Set(norm(got.vendor));
  const vendorHit = wantW.length > 0 && wantW.every((w) => gotW.has(w));
  fields.push({ field: "vendor", want: c.vendor, have: got.vendor, ok: vendorHit });

  const totalField = fields.find((f) => f.field === "total");
  let status;
  if (totalField.ok) status = "correct";
  else if (totalField.have === null) status = "abstained";
  else status = "WRONG";
  return { fields, status };
}

async function runSynthetic(worker) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const rows = [];
  for (const c of CASES) {
    const img = join(TMP, c.file);
    render(linesFor(c), img);
    const o = await ocrOne(worker, img, { tryRotate: true });
    const parsed = parseReceiptText(o.text, c.file);
    const cmp = compare(c, parsed);
    rows.push({ file: c.file, layout: c.layout, status: cmp.status, ocr: o.confidence, rotation: o.rotation, fields: cmp.fields, parsed, ocrText: o.text });
  }
  return rows;
}

function runReal() {
  const dir = join(ROOT, "fixtures");
  if (!existsSync(dir)) return null;
  const GROUND = {
    "pic_1(receipt dimension 1).txt": { total: 180, date: "2026-10-15" },
    "pic_1(receipt dimension 2).txt": { total: 180, date: "2026-10-15" },
    "pic_2(receipt dimension 1).txt": { total: 593, date: "2026-10-13" },
    "pic_2(receipt dimension 2).txt": { total: 593, date: "2026-10-13" },
    "pic_2(receipt dimension 3).txt": { total: 593, date: "2026-10-13" },
    "pic_3(receipt dimension 1).txt": { total: 88, date: "2026-10-11" },
    "pic_3(receipt dimension 2).txt": { total: null, date: null },
    "pic_4(receipt dimension 1).txt": { total: 4600, date: "2026-10-12" },
  };
  const rows = [];
  for (const [file, truth] of Object.entries(GROUND)) {
    const p = join(dir, file);
    if (!existsSync(p)) continue;
    const parsed = parseReceiptText(readFileSync(p, "utf8"), file.replace(/\.txt$/, ".jpg"));
    const status = truth.total === null
      ? (parsed.total === null ? "abstained" : "WRONG")
      : (parsed.total === truth.total ? "correct" : "WRONG");
    rows.push({
      file,
      status,
      wantTotal: truth.total,
      gotTotal: parsed.total,
      gotDate: parsed.date,
      wantDate: truth.date,
      via: parsed.total_via,
    });
  }
  return rows;
}

function summarise(rows, label) {
  const n = rows.length;
  const correct = rows.filter((r) => r.status === "correct").length;
  const abstained = rows.filter((r) => r.status === "abstained").length;
  const wrong = rows.filter((r) => r.status === "WRONG").length;
  const produced = correct + wrong;
  const fieldTotals = {};
  for (const r of rows) {
    for (const f of (r.fields ?? [])) {
      fieldTotals[f.field] ??= { ok: 0, n: 0 };
      fieldTotals[f.field].n++;
      if (f.ok) fieldTotals[f.field].ok++;
    }
  }
  return {
    label, n, correct, abstained, wrong,
    produced,
    wrongRateOfProduced: produced ? Number((wrong / produced).toFixed(3)) : null,
    coverage: Number((produced / n).toFixed(3)),
    fields: fieldTotals,
  };
}

async function main() {
  const noOcr = process.argv.includes("--no-ocr");
  let synthetic = null;
  let synSummary = null;

  if (!noOcr) {
    console.log("loading OCR worker...");
    const worker = await createWorker("eng");
    console.log("running synthetic suite (render -> OCR -> parse)...");
    synthetic = await runSynthetic(worker);
    await worker.terminate();
synSummary = summarise(synthetic, "synthetic (ground truth fixed at case definition)");
    for (const r of synthetic) {
      const bad = r.fields.filter((f) => !f.ok);
      const mark = r.status === "correct" ? "ok   " : r.status === "abstained" ? "none " : "WRONG";
      console.log(`  ${mark}  ${r.file.padEnd(28)} ocr ${r.ocr.toFixed(0).padStart(3)}  ${r.status}`);
      for (const f of bad) {
        console.log(`          field ${f.field}: want ${JSON.stringify(f.want)} got ${JSON.stringify(f.have)}`);
      }
      if (process.argv.includes("--dump")) {
        for (const l of r.ocrText.split(/\r?\n/).slice(0, 6)) console.log(`          | ${l}`);
      }
    }
  }

  const real = runReal();
  const realSummary = real ? summarise(real, "real (ground truth read off paper)") : null;

  const out = { generatedAt: new Date().toISOString(), synthetic: synthetic?.map((r) => ({ file: r.file, layout: r.layout, status: r.status, ocr: r.confidence ?? r.ocr })), real, summaries: { synthetic: synSummary, real: realSummary } };
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  writeFileSync(join(ROOT, "docs/benchmark.json"), JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log("\n=== SYNTHETIC (7 cases, truth fixed when written) ===");
  if (synSummary) {
    const s = synSummary;
    console.log(`  correct ${s.correct}/${s.n}   abstained ${s.abstained}   WRONG ${s.wrong}`);
    console.log(`  coverage ${(s.coverage * 100).toFixed(0)}%   wrong-rate-of-produced ${s.wrongRateOfProduced === null ? "n/a" : (s.wrongRateOfProduced * 100).toFixed(0) + "%"}`);
    for (const [k, v] of Object.entries(s.fields)) console.log(`    ${k.padEnd(10)} ${v.ok}/${v.n}`);
  }

  if (realSummary) {
    console.log("\n=== REAL (8 photos, 4 distinct bills, truth read off paper) ===");
    const s = realSummary;
    console.log(`  correct ${s.correct}/${s.n}   abstained ${s.abstained}   WRONG ${s.wrong}`);
    console.log(`  coverage ${(s.coverage * 100).toFixed(0)}%   wrong-rate-of-produced ${s.wrongRateOfProduced === null ? "n/a" : (s.wrongRateOfProduced * 100).toFixed(0) + "%"}`);
    for (const r of real) console.log(`    ${r.status.padEnd(9)} ${r.file.padEnd(34)} want ${money(r.wantTotal) ?? "(none)"}  got ${money(r.gotTotal) ?? "(none)"}`);
  }

  console.log("\nwrote docs/benchmark.json");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });


