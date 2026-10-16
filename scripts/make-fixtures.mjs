// Build redacted OCR-text fixtures from real receipt photos.
//
// The photos themselves are never committed: they carry shop phone numbers, a
// GSTIN, a biller's name with an employee id, the shop's name and its street.
// This script reads the OCR output, strips identifying data, and writes a
// fixture that still exercises the exact parsing bugs the real photos exposed -
// mangled labels, competing totals, wrapped item lines, dropped date
// separators, background debris.
//
// Redaction strategy, in order of preference:
//
//   1. Shape rules. Anything whose *form* gives it away - a GSTIN, a phone
//      number, a pincode, a street name, a business name built on a trade word
//      like STORES or BAKERY - is replaced by structure alone. These run on
//      every fixture and need no list.
//   2. A local blocklist, redaction-terms.txt, for terms no shape rule can
//      catch: a brand word embedded in a product name, for instance. The list
//      is gitignored, because committing the words it hides would defeat it.
//
// Every shape rule is idempotent: running it over its own output changes
// nothing. scripts/pii-lint.mjs relies on that to check the committed fixtures
// are already clean.
//
// Run it only when the real samples change. The committed fixtures are what the
// test suite reads.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.argv[2] || "data/raw";
const OUT = join(ROOT, "fixtures");

// Fixed stand-ins. Shape-matched so the parser sees the same kind of token it
// would on an unredacted fixture, and self-identical so redaction is a
// fixed point.
export const PLACEHOLDER = {
  gstin: "33AAAAA0000A0Z0",
  phone: "9000000000",
  longNumber: "900000000000",
  pincode: "600000",
  name: "DEMO",
};

// Horizontal whitespace: spaces and tabs, never a newline. Rules that walk
// across words must use this rather than \s, or they swallow the line break and
// collapse a wrapped fixture's layout onto one line.
const H = "[^\\S\\n]";

// Words that mark a line as a business name rather than a document label.
// Matched case-insensitively and deliberately not anchored to the line start:
// thermal paper wraps, so "DEMO DEPARTMENTAL" and "STORES (Branch)" are
// two lines of one name.
//
// Alternatives are explicit rather than DEP\w*: with the /i flag that pattern
// matches "Department" as DEP + "artment" and eats the trade word itself.
const TRADE_WORD =
  "STORES|STORE|DEPARTMENTAL|DEPARTMENT|BAKERY|TRADERS|TRADING|AGENCIES|AGENCY|" +
  "ENTERPRISES|EMPORIUM|MART|SUPERMARKET|PROVISION|PROVISIONS|TEXTILES|" +
  "JEWELLERS|JEWELRY|PHARMACY|CENTRE|CENTER|BAZAAR|BAZAR|KENDRA|BHAVAN|NIVAS";

// Street types. The specific name in front of one of these is what identifies
// the address; the type word itself is generic. "PASS" is deliberately absent:
// it matches inside "DEMO ROAD" and would produce "DEMO DEMO ROAD".
const STREET_WORD = "ROAD|STREET|LANE|NAGAR|COLONY|CROSS|AVENUE|BYPASS|EXTENSION";

const SUBSTITUTIONS = [
  // A GSTIN keeps its 15-character shape and loses the identity. This rule
  // must run before the loose fallback, and is case-insensitive to catch OCR
  // misread case.
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}\b/gi, PLACEHOLDER.gstin],

  // Loose GSTIN fallback: OCR damage (lowercase, pipes, stray chars) often
  // mangles a real GSTIN. Any token starting with 33 and containing mostly
  // alphanumerics/pipes that looks GSTIN-like is replaced. The length is a
  // loose bound rather than exact to tolerate damage.
  [/\b33[A-Z0-9a-z|]{13,}\b/g, PLACEHOLDER.gstin],
  // Indian mobile numbers, then any remaining long numeric identifier.
  [/\b[6-9]\d{9}\b/g, PLACEHOLDER.phone],
  [/\b\d{10,13}\b/g, PLACEHOLDER.longNumber],
  // Pincodes. Runs after the long-number rule so a 12-digit id is not partly
  // eaten, and anchored with \b so it cannot bite a fragment of a longer token
  // such as the digits inside "26DEMO0000000".
  [/\b[1-9]\d{5}\b/g, PLACEHOLDER.pincode],

  // A business name: whatever sits in front of a trade word becomes a stand-in.
  // "DEMO DEPARTMENTAL STORES" -> "DEMO DEPARTMENTAL STORES";
  // "NATIONAL STORES" -> "DEMO STORES". The trade word is kept so the line
  // still reads like a vendor line to the parser.
  // Every rule below is line-bounded: it uses H (horizontal whitespace) rather
  // than \s, because \s matches a newline and would let a rule walk from a
  // vendor line into the next line and collapse the fixture's layout.
  [
    new RegExp(
      `\\b[A-Za-z][\\w'&.-]*(?:${H}+[A-Za-z][\\w'&.-]*)*${H}+(?=(?:${TRADE_WORD})\\b)`,
      "gi"
    ),
    PLACEHOLDER.name + " ",
  ],

  // A street name: whatever sits in front of a street type becomes a stand-in.
  // "DEMO ROAD" -> "DEMO ROAD", "demo main road" -> "DEMO road".
  [
    new RegExp(      `\\b[A-Za-z][\\w'.-]*(?:${H}+[A-Za-z][\\w'.-]*)*${H}+(?=(?:${STREET_WORD})\\b)`, "gi"),
    PLACEHOLDER.name + " ",
  ],

  // Phone labels regardless of whether the number pattern matched.
  [new RegExp(`\\b(Ph|Phone|Tel|Mobile|Gpay)\\b${H}*:?${H}*\\S+`, "gi"), "$1 : [redacted]"],
  // Staff and customer names. A person's name beside a branch and an employee
  // id identifies someone, and none of this was consented to publication.
  [
    new RegExp(`\\b(Cus|Customer|Biller|Cashier|Received${H}+by|Served${H}+by)\\b${H}*:?${H}*[A-Za-z][\\w.'-]*`, "gi"),
    (m) => m.split(":")[0].replace(new RegExp(`${H}*:?${H}*$`), "") + " : [redacted]",
  ],
  // Employee ids printed beside the name.
  [new RegExp(`\\(${H}*ID${H}*:${H}*\\d+${H}*\\)`, "gi"), "(ID : [redacted])"],

  // A town following a street word or a colon, by shape rather than by a list.
  // Naming the specific towns in this file would publish exactly what it is
  // there to hide: that a particular station, depot or road is on the receipt.
  [
    new RegExp(`\\b(City|District|Place|Station|Depot|Region)\\b${H}*:${H}*[A-Za-z][\\w-]*`, "gi"),
    (m) => m.split(":")[0].trim() + ": [place]",
  ],
  // A journey shown as "<code> - <NAME>  <code> - <NAME>".
  [/\b\d{1,3}-[A-Z]{3,}\b/g, "[stop]"],
];

/**
 * Strip identifying data from OCR text. Pure, synchronous, and idempotent.
 * @param {string} text raw OCR output
 * @param {string[]} localTerms extra literal terms, matched case-insensitively
 * @returns {string}
 */
export function redact(text, localTerms = []) {
  let out = text;
  for (const [re, to] of SUBSTITUTIONS) out = out.replace(re, to);
  for (const term of localTerms) {
    if (!term) continue;
    out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), PLACEHOLDER.name);
  }
  return out;
}

/** Read redaction-terms.txt, one term per line, if it is present. */
export function localTerms() {
  const local = join(ROOT, "redaction-terms.txt");
  if (!existsSync(local)) return [];
  return readFileSync(local, "utf8").split(/\r?\n/).map((t) => t.trim()).filter((t) => t && !t.startsWith("#"));
}

function main() {
  const dir = resolve(ROOT, SRC);
  if (!existsSync(dir)) {
    console.error(`no OCR output at ${SRC}. Run: npm run ocr -- samples/real --out ${SRC}`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT, { recursive: true });

  const terms = localTerms();
  if (!terms.length) {
    console.error("warning: no redaction-terms.txt. Shape rules only, which will miss brand words.");
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
  const written = [];
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    const clean = redact(raw, terms);
    // Drop blank runs so the fixture stays small and readable.
    const lines = clean.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, " ").trimEnd());
    const compact = [];
    for (const l of lines) {
      if (!l.trim() && compact.at(-1) === "") continue;
      compact.push(l);
    }
    writeFileSync(join(OUT, f), compact.join("\n") + "\n", "utf8");
    written.push({ file: f, lines: compact.length });
  }

  const manifest = {
    note: "Redacted OCR output from real receipt photos. The photos are not in this repository; they contain identifiable business data.",
    redacted: [
      "business names",
      "street and place names",
      "pincodes",
      "GSTIN",
      "phone numbers",
      "staff and customer names and ids",
      "long numeric identifiers",
    ],
    methods: {
      shape: "form-based rules in scripts/make-fixtures.mjs, no list required",
      list: "redaction-terms.txt, gitignored, for brand words no shape rule catches",
    },
    fixtures: written,
  };
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  for (const w of written) console.log(`  ${w.file.padEnd(36)} ${w.lines} lines`);
  console.log(`\n${written.length} redacted fixture(s) -> fixtures/`);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("make-fixtures.mjs")) main();
