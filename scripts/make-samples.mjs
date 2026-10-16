// Generates a small set of synthetic receipts for testing, including two that
// are deliberately anomalous: one duplicate and one with a price jump.
// Synthetic data only - nothing here is a real transaction, and the vendor
// names, streets and town are invented rather than taken from anywhere.

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG = process.env.FFMPEG_PATH || "C:\\tools\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe";
const FONT = "'C\\:/Windows/Fonts/arial.ttf'";

const RECEIPTS = [
  {
    file: "receipt-01.png",
    lines: [
      ["ANNAMAIYA PROVISION STORES", 26],
      ["42 Model Street  Demotown", 15],
      ["GSTIN 33AABCA1234C1Z5", 15],
      ["Invoice INV-2291", 15],
      ["Date 2026-10-12", 15],
      ["----------------------------", 15],
      ["Rice 5kg  x1   420.00", 15],
      ["Sunflower Oil 1L  x2   276.00", 15],
      ["Sugar 1kg  x1    46.50", 15],
      ["Tea Powder 250g  x1   285.00", 15],
      ["Toor Dal 1kg  x2   304.00", 15],
      ["----------------------------", 15],
      ["SUBTOTAL   1331.50", 16],
      ["CGST 9pct      59.92", 15],
      ["SGST 9pct      59.92", 15],
      ["TOTAL       1451.34", 20],
    ],
  },
  {
    file: "receipt-02.png",
    lines: [
      ["ANNAMAIYA PROVISION STORES", 26],
      ["GSTIN 33AABCA1234C1Z5", 15],
      ["Invoice INV-2304", 15],
      ["Date 2026-10-14", 15],
      ["----------------------------", 15],
      ["Rice 5kg  x1   440.00", 15],
      ["Idli Mix 1kg  x1  88.00", 15],
      ["----------------------------", 15],
      ["SUBTOTAL    528.00", 16],
      ["CGST 9pct     23.76", 15],
      ["SGST 9pct     23.76", 15],
      ["TOTAL        575.52", 20],
    ],
  },
  {
    // Deliberate anomaly: same GSTIN, same invoice, same total as receipt-01.
    file: "receipt-03-duplicate.png",
    lines: [
      ["ANNAMAIYA PROVISION STORES", 26],
      ["42 Model Street  Demotown", 15],
      ["GSTIN 33AABCA1234C1Z5", 15],
      ["Invoice INV-2291", 15],
      ["Date 2026-10-12", 15],
      ["----------------------------", 15],
      ["Rice 5kg  x1   420.00", 15],
      ["Sunflower Oil 1L  x2   276.00", 15],
      ["Sugar 1kg  x1    46.50", 15],
      ["Tea Powder 250g  x1   285.00", 15],
      ["Toor Dal 1kg  x2   304.00", 15],
      ["----------------------------", 15],
      ["SUBTOTAL   1331.50", 16],
      ["CGST 9pct      59.92", 15],
      ["SGST 9pct      59.92", 15],
      ["TOTAL       1451.34", 20],
    ],
  },
  {
    file: "receipt-04-stationery.png",
    lines: [
      ["SARASWATHI STATIONERY", 26],
      ["Market Street  Demotown", 15],
      ["GSTIN 33AAECS4567D1ZK", 15],
      ["Invoice ST-884", 15],
      ["Date 2026-10-15", 15],
      ["----------------------------", 15],
      ["A4 Notebook  x4    196.00", 15],
      ["Gel Pen  x10     150.00", 15],
      ["Stapler  x1       250.00", 15],
      ["----------------------------", 15],
      ["SUBTOTAL    596.00", 16],
      ["CGST 9pct     26.82", 15],
      ["SGST 9pct     26.82", 15],
      ["TOTAL        649.64", 20],
    ],
  },
];

function render(receipt, outPng) {
  const tmp = join(tmpdir(), "ledgerlens-txt");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const filters = [];
  let y = 40;
  for (const [i, [text, size]] of receipt.lines.entries()) {
    const f = join(tmp, `l${i}.txt`);
    writeFileSync(f, text, "utf8");
    const ff = "'" + f.replace(/\\/g, "/").replace(/:/g, "\\:") + "'";
    filters.push(`drawtext=fontfile=${FONT}:textfile=${ff}:x=40:y=${y}:fontsize=${size}:fontcolor=black`);
    y += Math.round(size * 1.9);
  }
  const height = y + 40;
  const r = spawnSync(FFMPEG, [
    "-y", "-f", "lavfi", "-i", `color=c=white:s=640x${height}`,
    "-vf", filters.join(","), "-frames:v", "1",
    resolve(outPng).replace(/\\/g, "/"),
  ], { encoding: "utf8" });
  rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${receipt.file}: ${(r.stderr ?? "").slice(-400)}`);
}

export function makeAll(dir = join(ROOT, "samples")) {
  mkdirSync(dir, { recursive: true });
  for (const r of RECEIPTS) render(r, join(dir, r.file));
  return RECEIPTS.map((r) => r.file);
}

if (process.argv[1]?.endsWith("make-samples.mjs")) {
  const files = makeAll();
  for (const f of files) console.log(`  ${f}`);
  console.log(`${files.length} sample receipts generated`);
}