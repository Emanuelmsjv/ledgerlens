// Turn raw OCR text into one structured accounting row per receipt.
//
// Written against real OCR output from real phone photos, not against how a
// receipt is supposed to look. What OCR actually produces, and what this file
// therefore has to survive:
//
//   "NetAmount: 593.00"   no space, so /net amount/ never matches
//   "Ame: 593.00"        "Amt" misread with t -> e
//   "Total MRP : 695.00 Savings: 102.00"   sits BELOW the real total, and 102
//                                            is the savings, not the amount
//   "Your Saved Money Rs. 200.00"          another number that looks final
//   "Rs : 180.00"         a train ticket with no "total" word anywhere
//   "1510-2026"           the dash between day and month dropped
//   "ae 100 10000 8500 85.00"   item name on one line, figures on the next,
//                              with decimals lost from everything but AMT
//
// Two rules govern everything below. Anything unresolved is reported null
// rather than guessed, because a wrong number in a bookkeeping file is worse
// than a blank one. And the item figures are summed and compared against the
// printed subtotal, so a dropped line is visible instead of silently filed.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// GSTIN is 15 characters: 2-digit state code, a 10-character PAN (5 letters,
// 4 digits, 1 letter), then 3 alphanumerics. An earlier pattern required a
// literal Z at position 13 and therefore never matched anything.
const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3})\b/;

// "Invoice" must be tried before "INV", with a word boundary, or the pattern
// matches the "INV" inside "Invoice" and captures "oice" as the number.
const INVOICE_RE = /\b(?:INVOICE|BILL|RECEIPT|TAXINVOICE|INV)\b[\s#:.-]*([A-Z0-9][A-Z0-9/-]{2,})/i;

// Column headers and other furniture that must not be read as an item.
const NON_ITEM = /^(product|particulars|item|items|description|qty|mrp|rate|amt|amount|sl|s\.?no|total|bill|invoice|date|gstin|cash|counter|cashier|paymode|pay\s*mode|net|balance|wallet|round\s*off|savings?|discount|thank|visit)/i;

// A total-looking line that is not the amount owed. "Total MRP" is the price
// before discount, "Saved Money" is the discount, "Round Off" is noise.
const NOT_TOTAL = /\b(mrp|saving|saved|discount|round\s*off|roundoff|tender|change|received|cash\s*in)\b/i;

// Keys here must match the keys read back in findDate: "d", "mo", "y".
const DATE_PATTERNS = [
  { re: /\b(\d{4})[-/.](\d{2})[-/.](\d{2})\b/, order: ["y", "mo", "d"] },
  { re: /\b(\d{1,2})[/](\d{1,2})[/](\d{4})\b/, order: ["d", "mo", "y"] },
  { re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/, order: ["d", "mo", "y"] },
  { re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/, order: ["d", "mo", "y"] },
  // OCR frequently drops the separator: "1510-2026" for "15-10-2026".
  { re: /\b(\d{2})(\d{2})[-/.](\d{4})\b/, order: ["d", "mo", "y"] },
];

const AMOUNT_RE = /\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2}/g;

function norm(s) {
  return String(s ?? "")
    .replace(/[|]/g, "I")
    .replace(/[^\S\n]+/g, " ")
    .replace(/^[^\w(]+|[^\w)]+$/g, (m) => (m.length > 2 ? " " : m))
    .trim();
}

function amountsOn(line) {
  return (line.match(AMOUNT_RE) ?? []).map((a) => Number(a.replace(/,/g, "")));
}

/** The first amount appearing at or after `from` in the line. */
function amountAfter(line, from) {
  const tail = line.slice(from);
  const m = tail.match(/\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2}/);
  return m ? Number(m[0].replace(/,/g, "")) : null;
}

// --- totals -------------------------------------------------------------

// Ordered by how strongly the label implies "this is what you pay".
const TOTAL_LABELS = [
  { name: "net_amount", re: /\b(net\s*amount|netamount|net\s*amt|amount\s*payable|amount\s*due|grand\s*total)\b/i },
  { name: "balance", re: /\b(balance\s*amount|balance\s*due|amount\s*due)\b/i },
  { name: "total_amount", re: /\b(total\s*amt|total\s*amount|totalamt|totalamount)\b/i },
  { name: "total", re: /\btotal\b/i },
  { name: "amt", re: /\b(a\?m\w*|a\?t|a\?e)\b/i },
  // No trailing \d here: the label must not swallow the first digit of the
  // amount, or "Rs : 180.00" reads as 80.00.
  { name: "rs", re: /\brs\b\s*[.:]?/i },
  { name: "amount", re: /\bamount\b/i },
];

export function findTotal(lines) {
  for (const label of TOTAL_LABELS) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (NOT_TOTAL.test(line)) continue;
      const m = line.match(label.re);
      if (!m) continue;
      // "Total Qty" and "Total Items" are counts, not money.
      if (/\btotal\s*(qty|quantity|items?|no)\b/i.test(line)) continue;
      const amt = amountAfter(line, m.index + m[0].length);
      if (amt != null) return { total: amt, via: label.name };
    }
  }
  return { total: null, via: null };
}

function findSubtotal(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/\bsub\s*total\b/i.test(lines[i])) continue;
    const a = amountsOn(lines[i]);
    if (a.length) return a[a.length - 1];
  }
  return null;
}

function findTax(lines) {
  let sum = 0;
  let seen = false;
  for (const line of lines) {
    if (/\b(igst|cgst|sgst|vat|gst|tax)\b/i.test(line) && !NOT_TOTAL.test(line)) {
      const a = amountsOn(line);
      if (a.length) { sum += a[a.length - 1]; seen = true; }
    }
  }
  return seen ? Number(sum.toFixed(2)) : null;
}

// --- items --------------------------------------------------------------

function isNameLine(line, allowDigits = false) {
  if (!line || NON_ITEM.test(line)) return false;
  if (!allowDigits && /\d/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const real = words.filter((w) => /[A-Za-z]{3,}/.test(w));
  // A wrapped line ("Rice 5kg") needs a second real word to tell it from OCR
  // debris. A same-line item already has figures and fewer words to work with,
  // so one real word is enough - otherwise "Rice" and "Sugar" are lost.
  return allowDigits ? real.length >= 1 : real.length >= 2;
}

function isFigureLine(line) {
  return amountsOn(line).length >= 2 && !/[A-Za-z]{4,}/.test(line);
}

// Lines that carry a number but are not a purchased item.
// "gst" is matched without a word boundary on purpose: OCR renders
// "CGST 9pct" as "CGSTOpct", where \bcgst\b cannot match because the O that
// replaced the 9 sits between C and G with no boundary.
const NOT_ITEM_LINE = /(gst|vat|tax|discount|saving|saved|balance|tender|cash|change|round\s*off|sub\s*total|grand|net|amount|wallet|paymode|points?|bill|thank|welcome)/i;

export function itemLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Layout A: the name and its figures share one line, as on a tidy till
    // roll - "Rice 5kg  x1   420.00".
    if (isNameLine(line, true) && amountsOn(line).length >= 1 && !NOT_ITEM_LINE.test(line)) {
      const figs = amountsOn(line);
      out.push(makeItem(line, figs));
      continue;
    }

    // Layout B: the name sits on its own line and the figures on the next,
    // which is what thermal paper does once it runs out of width -
    // "DEMO ELLU URUNDAI 2" / "1.00 100.00 85.00 85.00".
    if (isNameLine(line)) {
      const next = lines[i + 1];
      if (next && isFigureLine(next)) {
        const figs = amountsOn(next);
        out.push({ ...makeItem(line, figs), name: line.replace(/\s+/g, " ").trim() });
        i++;
      }
    }
  }
  return out;
}

function makeItem(line, figs) {
  // AMT is the rightmost figure. Qty, where present, is the first.
  const amount = figs[figs.length - 1];
  // Quantity is written "x2" on a till roll and as its own figure on thermal
  // paper, so look for the marker before falling back to the first column.
  const marker = line.match(/\bx\s*(\d+(?:\.\d+)?)\b/i);
  const qty = marker ? Number(marker[1]) : (figs.length >= 3 ? figs[0] : null);
  // Cut the name at the last figure rather than stripping digits, so "Rice 5kg"
  // keeps its weight and only the "x1" multiplier is dropped.
  const last = /(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\s*$/;
  const m = line.match(last);
  let name = m ? line.slice(0, m.index) : line;
  name = name.replace(/\s*\bx\s*\d+\s*$/i, "")
             .replace(/[^\w\s.%()-]/g, " ")
             .replace(/\s{2,}/g, " ")
             .trim();
  return { name, qty, amount, unit: qty && qty > 0 ? Number((amount / qty).toFixed(2)) : null };
}

// --- header fields ------------------------------------------------------

// Document type headers, which look like a short all-caps name but name the
// document rather than the business.
const DOC_TYPE = /\b(credit\s*bill|cash\s*bill|tax\s*invoice|wallet\s*bill|crt\s*bill|invoice|bill\s*receipt|quotation|delivery\s*challan)\b/i;

function findVendor(lines) {
  const candidates = [];
  for (const line of lines.slice(0, 20)) {
    if (!line || /\d/.test(line)) continue;
    if (/^(gstin|invoice|date|bill|receipt|tax|ph\b|phone|tel|mobile|address|cashier|counter|biller|paymode)/i.test(line)) continue;
    if (DOC_TYPE.test(line)) continue;
    // "PARTICULARS MRP PRICE QTY AMT" is a column header, not a shop name.
    if (NON_ITEM.test(line)) continue;
    // Debris from a patterned background: "wf??? pdt Grsg UHDIDAT How!"
    if (/[?!*#=|~^]/.test(line)) continue;
    const words = line.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
    if (words.length < 2) continue;
    const real = words.filter((w) => w.replace(/[^A-Za-z]/g, "").length >= 3);
    if (real.length < 2) continue;
    const avgWord = words.reduce((a, w) => a + w.replace(/[^A-Za-z]/g, "").length, 0) / words.length;
    if (avgWord < 4.5) continue;
    const letters = line.replace(/[^A-Za-z]/g, "");
    const upper = letters.length ? (letters.match(/[A-Z]/g) ?? []).length / letters.length : 0;
    candidates.push({ line, upper });
  }
  if (!candidates.length) return null;
  // A shop prints its name at the top of its own receipt, so the earliest
  // acceptable line wins. Ranking by capitalisation instead picks
  // "Inclusive of All Taxes" over "Demo Department Stores".
  return candidates[0].line;
}

function findDate(lines) {
  for (const line of lines) {
    for (const { re, order } of DATE_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const g = { d: m[1], mo: m[2], y: m[3] };
      let d = Number(g[order[0]]);
      let mo = Number(g[order[1]]);
      const y = Number(g[order[2]]) < 100 ? Number(g[order[2]]) + 2000 : Number(g[order[2]]);
      const valid = (dd, mm) => mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
      // Try day-first, which is the norm in India, and only swap when that
      // reading is impossible. Swapping on "day > 12" is wrong: 13/10 is the
      // 13th of October, not the 10th of month 13.
      let swapped = false;
      if (!valid(d, mo)) {
        if (valid(mo, d)) { const t = d; d = mo; mo = t; swapped = true; }
        else continue;
      }
      return {
        value: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        swapped,
      };
    }
  }
  return { value: null, swapped: false };
}

// --- entry point --------------------------------------------------------

export function parseReceiptText(text, sourceFile = null) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map(norm)
    .filter((l) => l && /[A-Za-z0-9]{2,}/.test(l));

  const joined = lines.join(" ");
  const gstinMatch = joined.match(GSTIN_RE);
  const gstin = gstinMatch && gstinMatch[1].length === 15 ? gstinMatch[1] : null;
  const invMatch = joined.match(INVOICE_RE);
  const invoice = invMatch ? invMatch[1].replace(/^INV[-/]?/i, "").trim() : null;

  const date = findDate(lines);
  const items = itemLines(lines);
  const { total, via } = findTotal(lines);
  const subtotal = findSubtotal(lines);
  const tax = findTax(lines);
  const vendor = findVendor(lines);

  const itemSum = Number(items.reduce((a, i) => a + (i.amount ?? 0), 0).toFixed(2));

  // Compare item sum against whichever printed figure we can trust. Retail
  // receipts disagree about whether the total includes tax, so accept either.
  let reconciliation = "unknown";
  const target = subtotal ?? total;
  if (target != null && items.length) {
    const gap = Math.abs(itemSum - target);
    const rel = target === 0 ? 1 : gap / target;
    reconciliation = rel < 0.02 ? "ok" : "mismatch";
  }

  const warnings = [];
  if (!vendor) warnings.push("vendor not found");
  if (!date.value) warnings.push("date not found");
  if (total == null) warnings.push("total not found");
  if (via) warnings.push(`total read from "${via}"`);
  if (reconciliation === "mismatch") warnings.push(`items sum to ${itemSum} but the bill reads ${target}`);
  if (date.swapped) warnings.push("day and month looked swapped and were normalised");

  return {
    source: sourceFile,
    vendor,
    gstin,
    invoice,
    date: date.value,
    subtotal,
    tax,
    total,
    total_via: via,
    currency: "INR",
    item_count: items.length,
    items_sum: itemSum,
    reconciliation,
    ocr_warnings: warnings,
    items,
  };
}

// --- CSV ----------------------------------------------------------------

export const CSV_COLUMNS = [
  "date", "vendor", "gstin", "invoice", "subtotal", "tax", "total",
  "currency", "item_count", "items_sum", "reconciliation", "source",
];

export function toCsv(rows) {
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(",")]
    .concat(rows.map((r) => CSV_COLUMNS.map((c) => esc(r[c])).join(",")))
    .join("\n") + "\n";
}

// --- CLI ----------------------------------------------------------------

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

function main() {
  const targets = positionals(process.argv.slice(2));
  if (targets.length === 0) {
    console.error("usage: node scripts/parse.mjs <dir-of-txt> [--out data/ledger.csv]");
    process.exitCode = 1;
    return;
  }
  const outPath = resolve(ROOT, argValue("--out", "data/ledger.csv"));

  const files = [];
  for (const t of targets) {
    const d = resolve(ROOT, t);
    if (!existsSync(d)) continue;
    if (statSync(d).isDirectory()) {
      for (const f of readdirSync(d).filter((f) => f.endsWith(".txt")).sort()) files.push(join(d, f));
    } else files.push(d);
  }
  if (files.length === 0) {
    console.error("no .txt files found");
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const f of files) {
    const row = parseReceiptText(readFileSync(f, "utf8"), basename(f).replace(/\.txt$/, ".png"));
    rows.push(row);
    const bad = row.reconciliation === "mismatch" || row.total == null;
    console.log(`  ${bad ? "!" : " "} ${String(row.vendor ?? "(unknown)").slice(0, 30).padEnd(32)} ${String(row.date ?? "----------").padEnd(11)} ${row.total == null ? "  ----  " : row.total.toFixed(2).padStart(9)}  ${row.reconciliation}${row.total_via ? `  via ${row.total_via}` : ""}`);
    for (const w of row.ocr_warnings) if (w.startsWith("total read")) continue;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, toCsv(rows), "utf8");
  writeFileSync(
    outPath.replace(/\.csv$/, ".json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2),
    "utf8"
  );
  const ok = rows.filter((r) => r.total != null).length;
  console.log(`\n${rows.length} receipt(s), ${ok} with a resolved total -> ${outPath.replace(ROOT + "\\", "")}`);
}

// endsWith("parse.mjs") would also match debug-parse.mjs, so compare the
// basename exactly.
if (process.argv[1] && basename(process.argv[1]) === "parse.mjs") main();