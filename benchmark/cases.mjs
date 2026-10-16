// Benchmark cases: synthetic receipts with exactly known ground truth.
//
// Each case is rendered to an image, OCR'd and parsed, then compared against
// the values recorded here. Because the values were chosen when the case was
// written, this measures the parser end to end on documents whose correct
// answer is not in doubt.
//
// These deliberately include the layouts that broke the parser on real
// photographs: wrapped item lines, a "Total MRP" line below the real total, a
// savings line, a credit bill whose amount sits on a balance line, a ticket
// with no "total" word, and OCR-style label damage.
//
// The real photographs are measured separately by benchmark.mjs against values
// read off the paper by eye. Neither suite is large. Together they are a
// measurement, not a benchmark in any statistical sense.

export const CASES = [
  {
    file: "syn-gst-standard.png",
    vendor: "ANNAMAIYA PROVISION STORES",
    gstin: "33AABCA1234C1Z5",
    invoice: "2291",
    date: "2026-10-12",
    subtotal: 1331.5,
    tax: 119.84,
    total: 1451.34,
    items: [["Rice 5kg", 1, 420], ["Sunflower Oil 1L", 2, 276], ["Sugar 1kg", 1, 46.5], ["Tea Powder 250g", 1, 285], ["Toor Dal 1kg", 2, 304]],
    layout: "inline-items",
  },
  {
    // "Total MRP" sits BELOW the real total and the savings figure is last on
    // its line. The original parser returned the savings as the total.
    file: "syn-mrp-below.png",
    vendor: "SARASWATHI STATIONERY",
    gstin: "33AAECS4567D1ZK",
    invoice: "884",
    date: "2026-10-15",
    subtotal: 596,
    tax: 53.64,
    total: 649.64,
    items: [["A4 Notebook", 4, 196], ["Gel Pen", 10, 150], ["Stapler", 1, 250]],
    layout: "inline-items",
    extra: [["Total MRP : 703.00  Savings : 53.36"]],
  },
  {
    // Credit bill: the amount owed is on a balance line, and a "Saved Money"
    // line prints a smaller figure that looks final.
    file: "syn-credit-balance.png",
    vendor: "DEMO DEPARTMENT STORES",
    gstin: "33ZZQPX1234F1Z2",
    invoice: "538",
    date: "2026-10-12",
    subtotal: 4600,
    tax: 0,
    total: 4600,
    items: [["Particulars", 2, 4600]],
    layout: "inline-items",
    extra: [
      ["TOTAL : 4600.00"],
      ["Your Saved Money Rs. 200.00"],
      ["Balance Amount Rs. 4600.00"],
    ],
  },
  {
    // Ticket with no "total" word anywhere.
    file: "syn-ticket.png",
    vendor: "DEMO RAIL DEPOT",
    gstin: null,
    invoice: "000001",
    date: "2026-10-15",
    subtotal: null,
    tax: null,
    total: 180,
    items: [],
    layout: "ticket",
  },
  {
    // Wrapped items: name on one line, figures on the next.
    file: "syn-wrapped.png",
    vendor: "DEMO DEPARTMENTAL STORES",
    gstin: null,
    invoice: "26ZZZZ9999999",
    date: "2026-10-13",
    subtotal: 528,
    tax: 47.52,
    total: 575.52,
    items: [["Ponni Ellu Urundai", 1, 85], ["Crunch Biscuit", 1, 60], ["Chilli Chips", 1, 85], ["Festival Sweets", 1, 90], ["Sweet Bar", 2, 130], ["Soap Pack", 2, 143]],
    layout: "wrapped",
    damaged: true,
  },
  {
    // Cash bill where Tender and Balance sit near the real total.
    file: "syn-cash-tender.png",
    vendor: "DEMO STORES",
    gstin: "33AABCP9999A1Z2",
    invoice: "BILL2",
    date: "2026-10-11",
    subtotal: 88,
    tax: 0,
    total: 88,
    items: [["Tropicana Juice", 1, 30], ["Yoga Bar Chocla", 1, 58]],
    layout: "inline-items",
    extra: [
      ["Cash : 88.00"],
      ["Tender : 100.00"],
      ["Balance : 12.00"],
    ],
  },
  {
    // "NetAmount" printed without a space, and "Amt" misread the way OCR does.
    file: "syn-damaged-labels.png",
    vendor: "ROYAL SUPER MART",
    gstin: null,
    invoice: "7781",
    date: "2026-10-14",
    subtotal: 745.25,
    tax: 0,
    total: 745.25,
    items: [["Cooking Oil", 1, 420.25], ["Biscuits", 2, 165]],
    layout: "inline-items",
    damaged: true,
  },
];

// --- rendering ----------------------------------------------------------

const FFMPEG = process.env.FFMPEG_PATH || "C:\\tools\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe";
const FONT = "'C\\:/Windows/Fonts/arial.ttf'";

function money(n) {
  return n.toFixed(2);
}

export function linesFor(c) {
  const L = [];
  const damaged = c.damaged;
  L.push([c.vendor, 24]);
  if (!damaged) L.push(["GSTIN " + c.gstin, 15].filter(Boolean));
  L.push([`Invoice ${c.invoice}`, 15]);
  L.push([`Date ${c.date}`, 15]);
  L.push(["----------------------------", 14]);

  if (c.layout === "ticket") {
    L.push(["MALE(S) 1  180.00 = Rs 180.00", 15]);
    L.push(["Rs : 180.00", 20]);
    return L;
  }

  for (const [name, qty, amt] of c.items) {
    if (c.layout === "wrapped") {
      L.push([name, 15]);
      L.push([`1.00  ${money(qty * amt)}  ${money(amt)}  ${money(qty * amt)}`, 15]);
    } else {
      L.push([`${name}  x${qty}   ${money(amt * qty)}`, 15]);
    }
  }
  L.push(["----------------------------", 14]);
  L.push([`SUBTOTAL   ${money(c.subtotal)}`, 16]);
  if (c.tax > 0) {
    // Damage mode reproduces "CGST 9pct" read as "CGSTOpct".
    L.push([damaged ? "CGSTOpct   0.00" : "CGST 9pct   " + money(c.tax / 2), 15]);
    L.push([damaged ? "SGSTOpct   0.00" : "SGST 9pct   " + money(c.tax / 2), 15]);
  }
  if (damaged) {
    L.push(["Ame: " + money(c.total), 16]);
    L.push(["NetAmount: " + money(c.total), 20]);
  } else {
    L.push(["TOTAL       " + money(c.total), 20]);
  }
  for (const [x] of (c.extra ?? [])) L.push([x, 15]);
  return L;
}


