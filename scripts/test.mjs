import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReceiptText, toCsv } from "./parse.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok    ${name} = ${a}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}`);
    console.error(`          expected ${e}`);
    console.error(`          actual   ${a}`);
  }
}

console.log("OCR text fixture (real Tesseract output from samples/receipt-01.png):");
// A committed snapshot, not data/raw. That directory is gitignored, so reading
// it made the suite fail on every fresh clone - and a failing first check is
// what kept CI red and the workflow's privacy gate from ever running.
const fixturePath = join(ROOT, "test/inputs/receipt-01.txt");
check("fixture exists", existsSync(fixturePath), true);
if (!existsSync(fixturePath)) {
  console.error(`          missing ${relative(ROOT, fixturePath)} - see test/inputs/README.md`);
  console.error(`${pass}/${pass + fail} checks passed`);
  process.exit(1);
}
const real = parseReceiptText(readFileSync(fixturePath, "utf8"), "receipt-01.png");

console.log("\nfields recovered from real OCR:");
check("vendor", real.vendor, "ANNAMAIYA PROVISION STORES");
check("gstin", real.gstin, "33AABCA1234C1Z5");
check("invoice", real.invoice, "2291");
check("date", real.date, "2026-10-12");
check("subtotal", real.subtotal, 1331.5);
check("total", real.total, 1451.34);
check("item count", real.item_count, 5);
check("items sum", real.items_sum, 1331.5);
check("reconciliation", real.reconciliation, "ok");

console.log("\nitem lines:");
for (const it of real.items) {
  console.log(`        ${it.name.padEnd(22)} x${String(it.qty ?? "-").padEnd(3)} ${it.amount.toFixed(2)}`);
}
check("first item name", real.items[0].name, "Rice 5kg");
check("first item qty", real.items[0].qty, 1);
check("last item amount", real.items[5 - 1].amount, 304);

// --- negative tests: the parser must not invent data ---------------------

console.log("\nnegative cases (must report, not guess):");

const empty = parseReceiptText("", "empty.png");
check("empty input -> no total", empty.total, null);
check("empty input -> warning", empty.ocr_warnings.includes("total not found"), true);

const noDate = parseReceiptText("SHOP\nTOTAL 100.00", "nodate.png");
check("missing date -> null", noDate.date, null);
check("missing date -> warning", noDate.ocr_warnings.includes("date not found"), true);

const tampered = parseReceiptText(
  `ANNAMAIYA PROVISION STORES
GSTIN 33AABCA1234C1Z5
Date 2026-10-12
Rice 5kg x1 420.00
Sugar 1kg x1 46.50
SUBTOTAL 1331.50
TOTAL 1451.34`,
  "tampered.png"
);
check("dropped line -> mismatch", tampered.reconciliation, "mismatch");
check("mismatch is reported", tampered.ocr_warnings.some((w) => /items sum to/.test(w)), true);

console.log("\nGSTIN shape (15 chars, state+PAN+3):");
for (const [gstin, valid, why] of [
  ["33AABCA1234C1Z5", true, "Tamil Nadu state code, 15 chars"],
  ["27AAPFU0939F1ZV", true, "Maharashtra state code, 15 chars"],
  ["29ABCDE1234F1Z5", true, "Karnataka state code, 15 chars"],
  ["29ABCDE1234F1Z", false, "14 chars - one short"],
  ["AABCA1234C1Z500", false, "no state code"],
  ["29ABC1E1234F1Z5", false, "PAN letter run is 4 not 5"],
]) {
  const r = parseReceiptText(`SHOP\nGSTIN ${gstin}\nTOTAL 10.00`, "g.png");
  check(`gstin ${gstin} (${why})`, r.gstin !== null, valid);
}

console.log("\ndate formats:");
for (const [line, expected] of [
  ["Date 2026-10-12", "2026-10-12"],
  ["Date 12/10/2026", "2026-10-12"],
  ["Date 12-10-26", "2026-10-12"],
]) {
  const r = parseReceiptText(`SHOP\n${line}\nTOTAL 10.00`, "d.png");
  check(`"${line}"`, r.date, expected);
}

console.log("\nCSV output:");
const csv = toCsv([real]);
check("header", csv.split("\n")[0],
  "date,vendor,gstin,invoice,subtotal,tax,total,currency,item_count,items_sum,reconciliation,source");
check("one data row", csv.trim().split("\n").length, 2);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.error(`${fail} FAILURE(S)`);
  process.exitCode = 1;
}