// Reproduces the FIRST version of findTotal, exactly as it was written, and runs
// it against the real OCR text. This turns "I believe the original code would
// have returned the savings" into a measurement.
//
// The original scanned upward for /total/i and took the last number on the line.
// That is the whole bug: on a real bill, "Total MRP : 695.00 Savings : 102.00"
// sits below the real total, so it returns 102.00 - the discount - and raises no
// error anywhere.
//
// Nothing here ships. It exists so the number in the write-up is not a guess.

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findTotal } from "./parse.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "fixtures");

/** Verbatim logic of the original findTotal, plus the original MONEY_RE. */
function originalFindTotal(lines) {
  for (const re of [/\btotal\b/i, /\bgrand total\b/i, /\bamount payable\b/i]) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!re.test(lines[i])) continue;
      const amounts = lines[i].match(/\d+\.\d{2}/g);
      if (amounts && amounts.length) return Number(amounts[amounts.length - 1]);
    }
  }
  return null;
}

const GROUND_TRUTH = {
  "pic_1(receipt dimension 1).txt": 180,
  "pic_2(receipt dimension 1).txt": 593,
  "pic_2(receipt dimension 3).txt": 593,
  "pic_3(receipt dimension 1).txt": 88,
  "pic_4(receipt dimension 1).txt": 4600,
};

console.log("Original findTotal vs the shipped one, on real receipt OCR\n");
console.log("  file                                   truth   original   shipped");

let origWrong = 0, origRight = 0, origNull = 0, shipWrong = 0, shipRight = 0, shipNull = 0;
const rows = [];

for (const [file, truth] of Object.entries(GROUND_TRUTH)) {
  const p = join(DIR, file);
  if (!readdirSync(DIR).includes(file)) continue;
  const lines = readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean);

  const orig = originalFindTotal(lines);
  const ship = findTotal(lines).total;

  const oStat = orig === null ? "abstain" : orig === truth ? "right" : "WRONG";
  const sStat = ship === null ? "abstain" : ship === truth ? "right" : "WRONG";
  if (oStat === "WRONG") origWrong++; else if (oStat === "right") origRight++; else origNull++;
  if (sStat === "WRONG") shipWrong++; else if (sStat === "right") shipRight++; else shipNull++;

  const fmt = (n) => (n == null ? "  ----  " : n.toFixed(2).padStart(7));
  console.log(`  ${file.slice(0, 36).padEnd(36)}  ${String(truth).padStart(5)}   ${fmt(orig)} ${oStat === "WRONG" ? "!" : " "}  ${fmt(ship)} ${sStat === "WRONG" ? "!" : " "}`);
  rows.push({ file, truth, original: orig, originalStatus: oStat, shipped: ship, shippedStatus: sStat });
}

console.log("");
console.log(`  original : ${origRight} right, ${origWrong} WRONG, ${origNull} abstained`);
console.log(`  shipped  : ${shipRight} right, ${shipWrong} WRONG, ${shipNull} abstained`);
console.log("");
console.log("  A 'WRONG' here is a plausible, confident number that is not the amount owed.");

// Machine-readable, so the write-up can quote it rather than restate it.
writeFileSafe(join(ROOT, "docs/total-selection-compare.json"), JSON.stringify({
  note: "Original findTotal logic versus the shipped one, measured on real receipt OCR. Ground truth read off the paper.",
  rows,
  original: { right: origRight, wrong: origWrong, abstained: origNull },
  shipped: { right: shipRight, wrong: shipWrong, abstained: shipNull },
}, null, 2) + "\n");
console.log("\n  wrote docs/total-selection-compare.json");

function writeFileSafe(path, content) {
  try {
    const { writeFileSync } = require("node:fs");
    writeFileSync(path, content, "utf8");
  } catch {
    // ESM has no require; fall back.
    import("node:fs").then((fs) => fs.writeFileSync(path, content, "utf8"));
  }
}