// Regression tests built from real receipt photos.
//
// The expected totals were read off the photographed paper by eye, not produced
// by this code. Every fixture is the OCR output of a real phone photo, with
// vendor names, GSTIN, phone numbers, staff names, employee ids and locations
// redacted by scripts/make-fixtures.mjs. The photos themselves are not in the
// repository.
//
// These tests exist because the synthetic samples could not catch anything that
// mattered. Each case below is a specific way real documents broke the parser.

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReceiptText } from "./parse.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "fixtures");

let pass = 0, fail = 0;
function ok(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${name} = ${a}`); }
  else { fail++; console.error(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`); }
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".txt"));
const parse = (name) => parseReceiptText(readFileSync(join(DIR, name), "utf8"), name.replace(/\.txt$/, ".png"));
const has = (frag) => files.find((f) => f.includes(frag));

console.log("fixtures present:", files.length, files.map((f) => f.split("(")[0]).join(", "));

// --- the totals, as read off the paper ---------------------------------
const EXPECTED = [
  ["pic_1(receipt dimension 1)", 180.0],   // railway ticket, no "total" word
  ["pic_1(receipt dimension 2)", 180.0],
  ["pic_2(receipt dimension 1)", 593.0],   // NetAmount, wrapped items
  ["pic_2(receipt dimension 2)", 593.0],
  ["pic_2(receipt dimension 3)", 593.0],
  ["pic_3(receipt dimension 1)", 88.0],    // competes with Cash/Tender/Balance
  ["pic_4(receipt dimension 1)", 4600.0],  // balance on a credit bill
];

for (const [frag, expected] of EXPECTED) {
  const f = has(frag);
  if (!f) { console.error(`  FAIL  missing fixture for ${frag}`); fail++; continue; }
  ok(`total of ${frag}`, parse(f).total, expected);
}

// pic_3 dimension 2 is a second photo of the same bill that OCR could not read
// a total from. It must report nothing rather than invent one.
{
  const f = has("pic_3(receipt dimension 2)");
  ok("unreadable photo reports no total", parse(f).total, null);
}

// --- the specific failures real documents caused -----------------------
{
  const f = has("pic_4");
  const r = parse(f);
  // "CREDIT BILL" and "PARTICULARS MRP PRICE QTY AMT" both look like a shop
  // name; neither is. The real vendor is mixed-case, so a capitalisation rule
  // picks the wrong one.
  ok("vendor is the shop, not the document type", r.vendor, "DEMO Stores");
  // "Your Saved Money Rs. 200.00" is not the amount owed.
  ok("total is not the savings", r.total, 4600.0);
  ok("total came from the balance line", r.total_via, "balance");
  // GSTIN survives as a 15-character shape after redaction.
  ok("gstin is the redacted placeholder", r.gstin, "33AAAAA0000A0Z0");
}
{
  const f = has("pic_3(receipt dimension 1)");
  const r = parse(f);
  ok("vendor on a noisy-background bill", r.vendor, "DEMO STORES");
  // Cash 88.00, Tender 100.00, Balance 12.00 all sit near the real total.
  ok("total is not the tender", r.total, 88.0);
  ok("total is not the balance", r.total, 88.0);
  ok("items reconcile on this one", r.reconciliation, "ok");
}

{
  const f = has("pic_1(receipt dimension 1)");
  const r = parse(f);
  // "Rs : 180.00" - a label pattern that ended in \d swallowed the leading 1
  // and returned 80.00.
  ok("railway ticket amount is 180", r.total, 180.0);
  // "1510-2026" is "15-10-2026" with the separator dropped.
  ok("date recovered from a dropped separator", r.date, "2026-10-15");
}

{
  const f = has("pic_2(receipt dimension 3)");
  const r = parse(f);
  // "NetAmount" has no space, so a /net amount/ pattern never matched.
  ok("NetAmount label is matched", r.total_via, "net_amount");
  ok("net amount value", r.total, 593.0);
  // Items are wrapped onto separate lines and the figures are largely mangled,
  // so the honest outcome is a flagged mismatch, not a confident wrong sum.
  ok("wrapped items do not silently reconcile", r.reconciliation, "mismatch");
  ok("the mismatch is reported as a warning", r.ocr_warnings.some((w) => /items sum to/.test(w)), true);
}

// --- privacy: fixtures must carry nothing identifying --------------------
console.log("\nprivacy check on committed fixtures:");
{
  const all = files.map((f) => readFileSync(join(DIR, f), "utf8")).join("\n");
  // Every GSTIN must be the redaction placeholder. Checking the shape would be
  // useless because the placeholder is itself a valid GSTIN shape.
  const gstins = [...new Set(all.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}\b/g) ?? [])];
  ok("only the placeholder GSTIN appears", gstins, ["33AAAAA0000A0Z0"]);

  // Shape-based privacy checks - do not hardcode real place names.
  const FORBIDDEN = {
    "a 10-digit phone": /\b[6-9]\d{9}\b/,
    "an employee id": /\(\s*ID\s*:\s*\d+\s*\)/,
    "a staff name after a label": /\b(Cus|Customer|Biller|Cashier)\s*:\s*[A-Z][a-z]+/,
  };
for (const [name, re] of Object.entries(FORBIDDEN)) {
    ok(`no ${name}`, re.test(all), false);
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exitCode = 1;