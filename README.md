# ledgerlens

Photograph a receipt. Get an accounting CSV. Find the bill you already paid.

Runs entirely on your own machine. Tesseract OCR executes as WebAssembly inside
Node, so there is no Python, no native toolchain, no API key, and **no image is
ever uploaded anywhere**. After the first run — which downloads about 11 MB of
English language data — it works with the network off.

Built for the Hacktoberfest Open-Source AI Challenge, Week 2: **Side Hustle**.

## Why it exists

A small business or freelancer keeps a folder of receipt photos and no useful
record of them. The information is all there; nobody has time to type it in.
Cloud OCR services do the reading and bill per page, which for a shop doing
hundreds of small purchases is a real recurring cost — and they upload every
receipt to a server the owner does not control.

Financial receipts are about the most sensitive documents a household or shop
produces. Keeping them local is not a feature nobody notices; it is the reason
to run this at all.

## Quick start

```sh
git clone https://github.com/Emanuelmsjv/ledgerlens
cd ledgerlens
npm install

# Try it on the synthetic samples first.
npm run pipeline
```

To run it on your own receipts:

```sh
mkdir -p samples/real
# drop .jpg / .png photos in there
npm run ocr -- samples/real --out data/raw
npm run parse -- data/raw --out data/ledger.csv
npm run analyze
```

`samples/real/` is gitignored and always will be. Real receipts carry shop phone
numbers, GSTINs, and staff names with employee ids. None of that was consented
to publication, so none of it goes in the repository — see
[Privacy](#privacy) for how the test fixtures are handled.

## How it works

| script | what it does |
| :--- | :--- |
| `ocr.mjs` | images → text, with rotation recovery |
| `parse.mjs` | text → one CSV row per receipt, plus a self-check |
| `analyze.mjs` | flags duplicates, price jumps, outliers, bad arithmetic |
| `make-samples.mjs` | renders reproducible synthetic receipts with ffmpeg |
| `make-fixtures.mjs` | redacts real OCR output into safe test fixtures |

Output:

```
date,vendor,gstin,invoice,subtotal,tax,total,currency,item_count,items_sum,reconciliation,source
2026-10-11,DEMO STORES,,,,,,88.00,INR,2,88.0,ok,pic_3(receipt dimension 1).png
```

## Anomaly detection

Five checks, each aimed at something that actually happens and that a human
skimming a CSV misses:

| check | what it catches |
| :--- | :--- |
| `duplicate_invoice` | the same bill entered twice — a double payment |
| `invoice_reused` | one invoice number carrying different amounts, usually two bills merged |
| `vendor_price_jump` | the same product at a materially different price than before |
| `outlier_amount` | a total far outside what that vendor normally charges |
| `reconciliation_fail` | OCR dropped a line, so items do not add to the subtotal |

Outliers use **median and MAD**, not mean and standard deviation. One extreme
value inflates a standard deviation past its own detection; the test suite
asserts that a single 100,000 outlier among nine 100s is found and the rest are
not.

Nothing is auto-corrected. A tool that silently "fixed" a bookkeeping number
would be worse than useless.

## Accuracy on real receipts

Tested against eight real phone photos — four distinct bills, one photographed
more than once. The expected totals were read off the paper by eye.

| bill | ground truth | parsed | how it was found |
| :--- | ---: | ---: | :--- |
| Railway ticket | 180.00 | **180.00** | `Rs : 180.00` — no "total" word anywhere |
| Bakery bill | 593.00 | **593.00** | `NetAmount` — no space in the label |
| Grocery bill | 88.00 | **88.00** | `TOTAL`, over Cash/Tender/Balance decoys |
| Credit sale | 4600.00 | **4600.00** | `Balance Amount`, not `Your Saved Money` |

**4 of 4 distinct bills correct. One of the eight photos yielded no total and
reported `null` rather than guessing.**

### What real photos broke

The synthetic samples all had one clean `TOTAL` line. Thirty passing tests
proved almost nothing, and every significant bug appeared only once real
photographs went through:

- **Rotation.** Three of eight were shot sideways. A single pass returns
  near-garbage at low confidence, indistinguishable from a merely bad photo.
  `ocr.mjs` re-reads below 72 confidence at 90/180/270° and keeps the best.
- **Competing totals.** A receipt can carry several figures that all look
  final — `Total Amt 593.00`, `Total MRP 695.00 Savings 102.00`,
  `Your Saved Money Rs 200.00`. The first version scanned upward for `/total/`
  and returned **102.00 — the savings — as the receipt total**, with no error
  anywhere. That is the failure this project exists to avoid, and it is why
  totals are chosen by label priority and never guessed.
- **Mangled labels.** `NetAmount` has no space. `Ame: 593.00` is `Amt:` with
  the `t` read as `e`.
- **Wrapped items.** Thermal paper puts figures on the next line, and OCR keeps
  the rightmost `AMT` while losing the decimal point everywhere else.
- **Dropped separators.** `1510-2026` is `15-10-2026`.
- **Date-order heuristic.** Treating any day above 12 as month-first makes
  `13/10/2026` — the 13th of October — parse as month 13, fail, and return
  null for *every date on every receipt*.

## Honest limits

- **Item-level figures are unreliable on thermal paper.** `AMT` survives; `QTY`
  and `MRP` often do not. Item sums are therefore frequently flagged
  `mismatch`, which is the tool telling you not to trust them.
- **Folded or crumpled paper is not handled.** Three of the real photos were
  shot on patterned fabric, which adds noise and drops OCR confidence to 45–64.
  Those reads are reported as low confidence rather than presented as clean.
- **Handwriting is not supported.** The English model is print-only.
- **Tamil and other Indic scripts are not configured.** Real receipts here are
  bilingual and the Indic lines are largely ignored.
- **Perspective correction is not implemented.** Only 90° multiples are fixed.
- **No multi-page stitching.** A receipt photographed as overlapping strips is
  treated as separate documents.
- **No accuracy claim beyond the four bills above.** Four documents is not a
  benchmark, and I have not built one.

## Tests

```sh
npm test
```

69 checks, no framework, no model download, a few seconds:

- `test.mjs` — 30 checks over synthetic receipts, including GSTIN shape, three
  date formats, and negative cases that must report rather than guess
- `test-analyze.mjs` — 12 checks over the detectors, including that stable
  prices raise nothing and that one extreme value cannot hide itself
- `test-fixtures.mjs` — 27 checks over real-receipt OCR, locking in each bug
  above, plus privacy assertions on the fixtures themselves

## Privacy

The photos in `samples/real/` are gitignored and never committed or published.

`fixtures/` holds the OCR text from those photos with vendor identifiers
removed: GSTIN, phone numbers, long numeric identifiers, staff names, employee
ids, and station/branch/place names. `test-fixtures.mjs` asserts these stay
redacted, so a future change that leaks them fails CI rather than shipping.

The one place name left in place is Demotown, which is already public on the
author's DEV profile and in a sibling repository's name.

## Optional: straightening rotated photos

Rotation recovery uses ffmpeg. Without it everything still works — photos are
simply read upright, so a sideways receipt will read badly. Point
`FFMPEG_PATH` at an ffmpeg binary if it is not on `PATH`.

## Licence

CC BY-NC-SA 4.0. Tesseract is Apache-2.0 and runs under the LGPL; the language
data is fetched from the Tesseract project under its own terms.