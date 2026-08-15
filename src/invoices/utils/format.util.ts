/**
 * Presentation helpers for the invoice. Everything here takes an already-rounded
 * rupee amount — no money arithmetic happens in this file.
 */

const IST = "Asia/Kolkata";

/** `30000` → `"30,000.00"`. The ₹ sign lives in the template, not the number. */
export function formatAmount(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

/** `"13 August 2026"`, in IST — the date a family in India would recognise. */
export function formatDate(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: IST,
  }).format(value);
}

/** `"18 Aug"` — the short form used inside line-item period descriptions. */
export function formatShortDate(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: IST,
  }).format(value);
}

/** `"9:00 am"` — the session start time on a settlement statement. */
export function formatTime(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: IST,
  }).format(value);
}

/** `"Aug – Oct 2026"` for the billing-period fact row. */
export function formatMonthRange(from: Date, to: Date): string {
  const month = (d: Date) =>
    new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: IST }).format(
      d,
    );
  const year = (d: Date) =>
    new Intl.DateTimeFormat("en-IN", { year: "numeric", timeZone: IST }).format(
      d,
    );

  if (year(from) === year(to)) {
    return month(from) === month(to)
      ? `${month(from)} ${year(to)}`
      : `${month(from)} – ${month(to)} ${year(to)}`;
  }
  return `${month(from)} ${year(from)} – ${month(to)} ${year(to)}`;
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

function underThousand(n: number): string {
  if (n === 0) return "";
  if (n < 20) return ONES[n];
  if (n < 100) {
    const rest = n % 10;
    return TENS[Math.floor(n / 10)] + (rest ? ` ${ONES[rest]}` : "");
  }
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} Hundred${rest ? ` and ${underThousand(rest)}` : ""}`;
}

/**
 * `30000` → `"Rupees Thirty Thousand only."`
 *
 * Indian grouping (crore / lakh / thousand), which `Intl` will not do — an
 * invoice that says "thirty million" to an Indian family reads as a foreign
 * document, and the words line exists precisely to be the unambiguous one.
 */
export function amountInWords(value: number): string {
  const rounded = Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
  const rupees = Math.floor(rounded);
  const paise = Math.round((rounded - rupees) * 100);

  if (rupees === 0 && paise === 0) return "Rupees Zero only.";

  const groups: Array<[number, string]> = [
    [10_000_000, "Crore"],
    [100_000, "Lakh"],
    [1_000, "Thousand"],
  ];

  let remaining = rupees;
  const parts: string[] = [];
  for (const [size, name] of groups) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      parts.push(
        `${amountInWords(count).replace(/^Rupees | only\.$/g, "")} ${name}`,
      );
      remaining %= size;
    }
  }
  if (remaining > 0) parts.push(underThousand(remaining));

  const rupeeWords = parts.join(" ").trim();
  const paiseWords = paise > 0 ? ` and ${underThousand(paise)} Paise` : "";
  return `Rupees ${rupeeWords || "Zero"}${paiseWords} only.`;
}
