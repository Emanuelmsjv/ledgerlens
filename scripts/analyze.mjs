// Anomaly detection over a parsed ledger.
//
// Five checks, each aimed at something that actually happens to a small
// business and that a human skimming a CSV will miss:
//
//   duplicate_invoice   - the same bill entered twice. The classic double
//                         payment, usually a re-scan or a duplicate scan.
//   invoice_reused      - one invoice number carrying different amounts, which
//                         usually means the OCR merged two bills or misread a
//                         digit.
//   vendor_price_jump   - the same product from the same vendor at a materially
//                         different price than earlier.
//   outlier_amount      - a total far outside what that vendor normally charges,
//                         using median + MAD so one outlier cannot mask itself.
//   reconciliation_fail - OCR lost a line, so items do not add to the subtotal.
//
// Nothing is auto-corrected. This reports; a human decides. A tool that
// silently "fixed" a bookkeeping number would be worse than useless.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PRICE_JUMP_PCT = 0.25;  // 25% move on a previously-seen unit price
const OUTLIER_SCALE = 3.5;    // MAD-based; deliberately not a z-score, which
                              // one extreme value can inflate past its own
                              // detection.

const num = (v) => (v == null || v === "" ? null : Number(v));

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Normalise so "Rice 5kg" and "rice  5 KG" compare equal. */
export function normItem(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function detect(rows) {
  const findings = [];
  const norm = rows.map((r) => ({
    ...r,
    total: num(r.total),
    subtotal: num(r.subtotal),
    items_sum: num(r.items_sum),
  }));

  const src = (i) => norm[i]?.source ?? `#${i}`;

  // 1 + 2. Duplicate and reused invoice numbers --------------------------
  const byInvoice = new Map();
  for (const [i, r] of norm.entries()) {
    if (!r.vendor || !r.invoice) continue;
    const key = `${r.vendor}\\u0000${r.invoice}`.toLowerCase();
    if (!byInvoice.has(key)) byInvoice.set(key, []);
    byInvoice.get(key).push(i);
  }
  for (const [, idx] of byInvoice) {
    if (idx.length < 2) continue;
    const amounts = [...new Set(idx.map((i) => norm[i].total))];
    const sameAmount = amounts.length === 1;
    findings.push({
      kind: sameAmount ? "duplicate_invoice" : "invoice_reused",
      severity: sameAmount ? "high" : "medium",
      rows: idx,
      sources: idx.map(src),
      message: sameAmount
        ? `Invoice ${norm[idx[0]].invoice} from ${norm[idx[0]].vendor} appears ${idx.length} times at an identical ${norm[idx[0]].total}. Likely a double scan or a double payment.`
        : `Invoice ${norm[idx[0]].invoice} from ${norm[idx[0]].vendor} is reused with differing amounts (${amounts.join(", ")}). One of these is probably a different bill or a misread digit.`,
    });
  }

  // 3. Per-item price movement at one vendor ------------------------------
  const prices = new Map(); // `${vendor}|${item}` -> [{unit,row,date}]
  for (const [i, r] of norm.entries()) {
    for (const it of r.items ?? []) {
      if (!it.amount) continue;
      const unit = it.qty ? it.amount / it.qty : it.amount;
      const key = `${(r.vendor ?? "").toLowerCase()}|${normItem(it.name)}`;
      if (!prices.has(key)) prices.set(key, []);
      prices.get(key).push({ unit, row: i, date: r.date, qty: it.qty, name: it.name });
    }
  }
  for (const [key, hist] of prices) {
    if (hist.length < 2) continue;
    const sorted = [...hist].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    // Compare each reading against the median of everything seen before it.
    for (let k = 1; k < sorted.length; k++) {
      const prior = sorted.slice(0, k).map((h) => h.unit);
      const base = median(prior);
      const cur = sorted[k];
      if (base == null || base === 0) continue;
      const change = (cur.unit - base) / base;
      if (Math.abs(change) >= PRICE_JUMP_PCT) {
        findings.push({
          kind: "vendor_price_jump",
          severity: Math.abs(change) >= 0.5 ? "high" : "medium",
          rows: [cur.row],
          sources: [src(cur.row)],
          item: cur.name,
          message: `"${cur.name}" moved from a typical ${base.toFixed(2)} to ${cur.unit.toFixed(2)} at ${norm[cur.row].vendor} on ${cur.date} (${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%).`,
        });
      }
    }
  }

  // 4. Outlier totals per vendor ------------------------------------------
  const totalsByVendor = new Map();
  for (const [i, r] of norm.entries()) {
    if (r.total == null) continue;
    const k = (r.vendor ?? "").toLowerCase();
    if (!totalsByVendor.has(k)) totalsByVendor.set(k, []);
    totalsByVendor.get(k).push({ total: r.total, row: i });
  }
  for (const [k, list] of totalsByVendor) {
    if (list.length < 4) continue; // needs a baseline to be meaningful
    const vals = list.map((l) => l.total);
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med))) || 1e-9;
    for (const l of list) {
      const score = Math.abs(l.total - med) / (1.4826 * mad);
      if (score >= OUTLIER_SCALE) {
        findings.push({
          kind: "outlier_amount",
          severity: score >= 5 ? "high" : "low",
          rows: [l.row],
          sources: [src(l.row)],
          score: Number(score.toFixed(2)),
          message: `${norm[l.row].vendor}: total ${l.total.toFixed(2)} on ${norm[l.row].date} is far from this vendor's usual ${med.toFixed(2)} (robust score ${score.toFixed(1)}).`,
        });
      }
    }
  }

  // 5. Rows whose own arithmetic does not work ---------------------------
  for (const [i, r] of norm.entries()) {
    if (r.reconciliation === "mismatch") {
      findings.push({
        kind: "reconciliation_fail",
        severity: "high",
        rows: [i],
        sources: [src(i)],
        message: `${r.source}: items sum to ${r.items_sum} but the subtotal reads ${r.subtotal}. OCR most likely dropped a line. Check this receipt by hand before filing it.`,
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { findings, rows: norm };
}

// --- CLI ---------------------------------------------------------------

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const src = resolve(ROOT, argValue("--in", "data/ledger.json"));
  if (!existsSync(src)) {
    console.error(`no ledger at ${src}. Run: npm run parse`);
    process.exitCode = 1;
    return;
  }
  const { rows } = JSON.parse(readFileSync(src, "utf8"));
  const { findings } = detect(rows);

  const counts = findings.reduce((a, f) => ((a[f.kind] = (a[f.kind] ?? 0) + 1), a), {});
  console.log(`  ledger   : ${src.replace(ROOT + "\\", "")}`);
  console.log(`  receipts : ${rows.length}`);
  console.log(`  findings : ${findings.length}`);
  console.log("");

  if (!findings.length) {
    console.log("  Nothing anomalous found.");
  } else {
    for (const f of findings) {
      console.log(`  [${f.severity.toUpperCase()}] ${f.kind}`);
      console.log(`      ${f.message}`);
      if (f.sources.length > 1) console.log(`      rows: ${f.sources.join(", ")}`);
    }
  }

  const out = resolve(ROOT, argValue("--out", "data/anomalies.json"));
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), counts, findings }, null, 2), "utf8");
  console.log(`\n  -> ${out.replace(ROOT + "\\", "")}`);
}

// Only run the CLI when invoked directly; importing this file for its tests
// must not print a report or write files.
const isMain = process.argv[1] && resolve(process.argv[1]).endsWith("analyze.mjs");
if (isMain) main();