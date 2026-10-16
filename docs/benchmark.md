# Benchmark

Run it yourself:

```sh
node scripts/benchmark.mjs          # both suites, needs ffmpeg
node scripts/benchmark.mjs --no-ocr # real suite only, instant
```

Two suites, reported separately and **never averaged together**, because each
has a weakness the other does not.

| | synthetic | real |
| :--- | --- | --- |
| cases | 7 | 8 photos, 4 distinct bills |
| ground truth | fixed when the case was written | read off the paper by eye |
| totals correct | **7 / 7** | **7 / 8** |
| abstained (reported nothing) | 0 | 1 |
| **wrong** | **0** | **0** |
| coverage | 100% | 88% |
| wrong-rate of produced totals | **0%** | **0%** |

**Headline: 14 of 15 documents, and no wrong number anywhere.**

### Why the headline is not "accuracy"

The number that matters is **wrong-rate of produced totals**, and it is zero on
both suites. In a bookkeeping file a blank cell is a nuisance; a confidently
wrong figure is a false expense that gets filed, reconciled against a bank
statement and never questioned. Coverage is the secondary metric, and the one
abstention below is the system working: on the photograph it could not read, it
said nothing rather than guessing.

## Field-level, synthetic

| field | correct |
| :--- | :---: |
| total | 7 / 7 |
| subtotal | 7 / 7 |
| date | 7 / 7 |
| invoice | 7 / 7 |
| vendor | 7 / 7 |
| **gstin** | **3 / 4** (4th rejected as malformed) |

### The one failure, and why it is the system working

```
field gstin: want "33ZZQPX1234F1Z2" got null
```

OCR read `33ZZQPX1234F1Z2` as `332ZQPX1234F122`, turning `Z` into `2` twice. The
second `Z` sits inside the five-letter PAN run, so the result no longer matches
the GSTIN shape and **the parser rejected it and returned `null`.**

That is the intended behaviour. A less careful parser passes the string through
and files `332ZQPX1234F122` as the tax registration number on a real invoice.
Returning nothing and flagging it for a human is worth a missed extraction.

So the honest reading is: **GSTIN coverage is 3/4 and every GSTIN this tool
outputs is well-formed.** Correctness of the characters is bounded by OCR.

### What I did not do about it

The obvious improvement is the GSTIN spec's mod-36 check digit, which would have
caught this exact case and could recover the character. I implemented it and
then deleted it, because **I had no trustworthy ground truth to validate it
against** — the one real GSTIN available was itself read from an OCR'd image, so
using it to check a checksum is circular. Four variants of the algorithm
disagreed with it, which suggested the input was suspect rather than the code.

Shipping an unvalidated validator would mean silently nulling GSTINs that are
perfectly good, which is the exact failure mode this project exists to prevent.
So it stays unimplemented, and GSTIN validation is not claimed as a feature.

## What the two suites do not agree about

The synthetic suite is not evidence about real documents, and pretending
otherwise would be the easiest lie in this project. I rendered those receipts:
one font, no folds, no glare, no patterned background, no creases. Real
photographs score 79â€“90 on OCR confidence because of where they were taken.

Conversely, 8 photographs is not a benchmark in any statistical sense. Four
distinct bills is a smoke test with real teeth, not a sample.

## Per-case detail, synthetic

| case | layout being exercised | OCR | result |
| :--- | :--- | ---: | :--- |
| `syn-gst-standard` | inline items, clean labels | 82 | correct |
| `syn-mrp-below` | `Total MRP` printed below the real total, savings figure last on its line | 79 | correct |
| `syn-credit-balance` | amount on a balance line, `Your Saved Money` decoy | 88 | correct |
| `syn-ticket` | no "total" word anywhere | 86 | correct |
| `syn-wrapped` | item name on one line, figures on the next | 90 | correct |
| `syn-cash-tender` | `Cash`, `Tender`, `Balance` all near the real total | 86 | correct |
| `syn-damaged-labels` | `NetAmount` unspaced, `Amt` misread as `Ame`, `CGST` misread as `CGSTO` | 90 | correct, except GSTIN |

Each layout exists because it broke something on a real photograph first.

## Reproducing

The synthetic suite renders with ffmpeg, so it depends on ffmpeg and on the
font it resolves. A different font changes the OCR noise and can change the
numbers. The real suite depends only on the committed fixtures and is fully
deterministic.

