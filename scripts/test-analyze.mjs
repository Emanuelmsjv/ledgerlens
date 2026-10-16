import { detect } from "./analyze.mjs";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.error(`  FAIL  ${name} ${extra}`); }
}
const kinds = (rows) => detect(rows).findings.map((f) => f.kind);

// --- duplicate ----------------------------------------------------------
{
  const rows = [
    { vendor: "A", gstin: "33AABCA1234C1Z5", invoice: "1", date: "2026-01-01", total: 100, subtotal: 100, items_sum: 100, reconciliation: "ok", source: "a1.png", items: [] },
    { vendor: "A", gstin: "33AABCA1234C1Z5", invoice: "1", date: "2026-01-01", total: 100, subtotal: 100, items_sum: 100, reconciliation: "ok", source: "a2.png", items: [] },
  ];
  ok("duplicate_invoice detected", kinds(rows).includes("duplicate_invoice"));
  ok("severity is high", detect(rows).findings[0]?.severity === "high");
}

// identical invoice, different amount -> reused, not duplicate
{
  const rows = [
    { vendor: "A", invoice: "9", date: "2026-01-01", total: 100, subtotal: 100, items_sum: 100, reconciliation: "ok", source: "b1.png", items: [] },
    { vendor: "A", invoice: "9", date: "2026-01-02", total: 250, subtotal: 250, items_sum: 250, reconciliation: "ok", source: "b2.png", items: [] },
  ];
  ok("invoice_reused detected", kinds(rows).includes("invoice_reused"));
}

// --- price jump ---------------------------------------------------------
{
  const mk = (amt, date, src) => ({
    vendor: "Store", invoice: date, date, total: amt, subtotal: amt, items_sum: amt,
    reconciliation: "ok", source: src,
    items: [{ name: "Rice 5kg", qty: 1, amount: amt }],
  });
  const rows = [
    mk(400, "2026-01-01", "c1.png"),
    mk(410, "2026-01-02", "c2.png"),
    mk(405, "2026-01-03", "c3.png"),
    mk(900, "2026-01-04", "c4.png"), // >25% jump
  ];
  ok("vendor_price_jump detected", kinds(rows).includes("vendor_price_jump"));
  const f = detect(rows).findings.find((x) => x.kind === "vendor_price_jump");
  ok("jump names the item", f?.item === "Rice 5kg");
}

// a stable price must NOT fire
{
  const mk = (amt, date, src) => ({
    vendor: "Store", invoice: date, date, total: amt, subtotal: amt, items_sum: amt,
    reconciliation: "ok", source: src, items: [{ name: "Rice 5kg", qty: 1, amount: amt }],
  });
  const rows = ["400", "402", "399", "401", "403"].map((a, i) => mk(Number(a), `2026-01-0${i + 1}`, `d${i}.png`));
  ok("stable prices raise nothing", kinds(rows).length === 0, JSON.stringify(kinds(rows)));
}

// --- outlier ------------------------------------------------------------
{
  const rows = [100, 105, 98, 102, 101, 99, 104, 5000].map((t, i) => ({
    vendor: "V", invoice: String(i), date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    total: t, subtotal: t, items_sum: t, reconciliation: "ok", source: `e${i}.png`, items: [],
  }));
  ok("outlier_amount detected", kinds(rows).includes("outlier_amount"));
}

// MAD, not mean: one huge value must not hide itself
{
  const rows = [100, 100, 100, 100, 100, 100, 100, 100, 100000].map((t, i) => ({
    vendor: "V", invoice: String(i), date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    total: t, subtotal: t, items_sum: t, reconciliation: "ok", source: `f${i}.png`, items: [],
  }));
  const f = detect(rows).findings.find((x) => x.kind === "outlier_amount");
  ok("robust detector still finds the extreme", Boolean(f));
  ok("it flags the big one, not the rest", f?.rows?.[0] === 8, `rows=${JSON.stringify(f?.rows)}`);
}

// --- reconciliation -----------------------------------------------------
{
  const rows = [{
    vendor: "V", invoice: "1", date: "2026-01-01", total: 500, subtotal: 500, items_sum: 460,
    reconciliation: "mismatch", source: "g.png", items: [],
  }];
  ok("reconciliation_fail detected", kinds(rows).includes("reconciliation_fail"));
}

// --- empty / degenerate -------------------------------------------------
{
  ok("empty ledger is safe", detect([]).findings.length === 0);
  ok("rows missing fields do not throw", detect([{ source: "h.png" }]).findings.length >= 0);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exitCode = 1;