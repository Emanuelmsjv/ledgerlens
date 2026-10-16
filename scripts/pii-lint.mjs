// Privacy lint: prove the committed fixtures carry nothing identifying.
//
// The fixtures are OCR output from real receipts, so the risk is that redaction
// missed something. Rather than trusting a hand-check, this asserts a property:
//
//   applying scripts/make-fixtures.mjs's redact() to a committed fixture must
//   change nothing
//
// If a fixture is already redacted, it is a fixed point of redaction. If any
// identifier survived, the rule that should have caught it will fire on the
// second pass and the file will differ. That makes the check self-verifying:
// it does not need to know what the identifiers were.
//
// It also scans every tracked text file for terms from redaction-terms.txt, the
// gitignored blocklist. That half only runs where the list exists - on the
// machine that produced the fixtures - because the list is deliberately not in
// the repository. The fixed-point check runs everywhere, including CI.
//
//   node scripts/pii-lint.mjs          check, exit 1 on any finding
//   node scripts/pii-lint.mjs --fix    rewrite fixtures/ in place

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { redact, localTerms, PLACEHOLDER } from "./make-fixtures.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "fixtures");
const FIX = process.argv.includes("--fix");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok    ${n}`); };
const bad = (n, detail) => { fail++; console.error(`  FAIL  ${n}${detail ? `\n          ${detail}` : ""}`); };

const terms = localTerms();
const fixtureFiles = readdirSync(FIXTURES).filter((f) => f.endsWith(".txt")).sort();

// --- 1. fixed-point: redaction must not change a committed fixture ---------
console.log(`fixed-point check on ${fixtureFiles.length} fixture(s):`);
for (const f of fixtureFiles) {
  const path = join(FIXTURES, f);
  const text = readFileSync(path, "utf8");
  const again = redact(text, terms);
  if (again === text) { ok(`${f} is fully redacted`); continue; }

  // Name the offending lines so a failure is actionable.
  const before = text.split(/\r?\n/), after = again.split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] !== after[i]) lines.push(`line ${i + 1}: ${JSON.stringify(before[i])} -> ${JSON.stringify(after[i])}`);
  }
  bad(`${f} still contains redactable data`, lines.slice(0, 6).join("\n          "));
  if (FIX) { writeFileSync(path, again, "utf8"); console.log(`          fixed ${f}`); }
}

// --- 2. shapes redact() does not cover ------------------------------------
console.log("\nshape checks on fixtures:");
{
  const all = fixtureFiles.map((f) => readFileSync(join(FIXTURES, f), "utf8")).join("\n");
  const SHAPES = {
    "an email address": /[\w.+-]+@[\w-]+\.[\w.]+/,
    "a 10-digit phone number": /\b[6-9]\d{9}\b/,
    "an employee id": /\(\s*ID\s*:\s*\d+\s*\)/,
    "an unredacted GSTIN": /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}\b(?!)/,
    "a name after a staff label": /\b(Cus|Customer|Biller|Cashier)\s*:\s*[A-Z][a-z]+/,
    "a pincode other than the placeholder": new RegExp(`\\b[1-9]\\d{5}\\b(?!\\s*$)(?<!${PLACEHOLDER.pincode})`),
  };
  for (const [name, re] of Object.entries(SHAPES)) {
    if (name === "an unredacted GSTIN") {
      // Every GSTIN-shaped token must be the placeholder exactly.
      const found = [...new Set(all.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}\b/g) ?? [])];
      const strangers = found.filter((g) => g !== PLACEHOLDER.gstin);
      strangers.length ? bad(`${name} (${strangers.join(", ")})`) : ok("only the placeholder GSTIN appears");
      continue;
    }
    if (name === "a pincode other than the placeholder") {
      const found = [...new Set(all.match(/\b[1-9]\d{5}\b/g) ?? [])].filter((p) => p !== PLACEHOLDER.pincode);
      found.length ? bad(`${name} (${found.join(", ")})`) : ok("no stray pincode");
      continue;
    }
    re.test(all) ? bad(`found ${name}`) : ok(`no ${name}`);
  }
}

// --- 3. blocklist terms anywhere in tracked files --------------------------
console.log("\nblocklist scan over tracked files:");
if (!terms.length) {
  console.log("  skip  redaction-terms.txt is not on this machine (it is gitignored by design)");
} else {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split(/\r?\n/).filter(Boolean);
  const hits = [];
  for (const f of tracked) {
    if (f === "redaction-terms.txt") continue;
    let text;
    try { text = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
    for (const term of terms) {
      const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const m = text.match(re);
      if (m) hits.push(`${relative(ROOT, f)}: ${term} x${m.length}`);
    }
  }
  if (hits.length) {
    bad(`${hits.length} blocklisted term(s) appear in tracked files`, hits.slice(0, 15).join("\n          "));
  } else {
    ok(`no blocklisted term in ${tracked.length} tracked file(s)`);
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exitCode = 1;
