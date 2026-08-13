import { readFileSync } from "fs";
import { join } from "path";
import { renderTemplate } from "./utils/template.util";
import {
  amountInWords,
  formatAmount,
  formatMonthRange,
} from "./utils/format.util";

describe("invoice template engine", () => {
  it("interpolates, escapes, and leaves nothing unresolved", () => {
    const out = renderTemplate("<p>{{a.b}}</p>", {
      a: { b: `Tom & "Jo" <x>` },
    });
    expect(out).toBe("<p>Tom &amp; &quot;Jo&quot; &lt;x&gt;</p>");
  });

  it("repeats a section per array item and can see the outer scope", () => {
    const out = renderTemplate("{{#rows}}[{{n}}-{{tag}}]{{/rows}}", {
      tag: "x",
      rows: [{ n: 1 }, { n: 2 }],
    });
    expect(out).toBe("[1-x][2-x]");
  });

  it("renders a truthy non-array section once and drops falsy ones", () => {
    expect(renderTemplate("{{#p}}yes{{/p}}", { p: true })).toBe("yes");
    expect(renderTemplate("{{#p}}yes{{/p}}", { p: false })).toBe("");
    expect(renderTemplate("{{#p}}yes{{/p}}", { p: [] })).toBe("");
    expect(renderTemplate("{{^p}}no{{/p}}", { p: false })).toBe("no");
  });

  it("renders {{.}} for plain-string lists, as the terms block relies on", () => {
    expect(
      renderTemplate("{{#t}}<li>{{.}}</li>{{/t}}", { t: ["a", "b"] }),
    ).toBe("<li>a</li><li>b</li>");
  });

  it("leaves no placeholder unresolved in the real invoice template", () => {
    const template = readFileSync(
      join(__dirname, "templates", "invoice.template.html"),
      "utf8",
    );

    const html = renderTemplate(template, {
      invoiceNumber: "KL-2026-0001",
      paid: true,
      billedTo: { name: "Priya Sharma", lines: ["Parent / Guardian of Aarav"] },
      facts: [{ label: "Invoice date", value: "13 August 2026" }],
      engagement: [{ label: "Student", value: "Aarav · Grade 3" }],
      hasEngagement: true,
      items: [
        {
          name: "Support",
          description: "d",
          qty: "1",
          rate: "1.00",
          amount: "1.00",
        },
      ],
      totals: [{ label: "Subtotal", amount: "1.00" }],
      grandTotal: { label: "Total paid", amount: "1.00" },
      amountInWords: "Rupees One only.",
      company: {
        name: "Keel",
        tagline: "t",
        addressLine: "a",
        contactLine: "c",
        supportEmail: "e@keel.co.in",
      },
      payment: {
        accountName: "Keel",
        bank: "b",
        accountNo: "1",
        ifsc: "I",
        upi: "u",
        reference: "KL-2026-0001",
      },
      terms: ["One term"],
    });

    expect(html.match(/\{\{[^}]*\}\}/g)).toBeNull();
    expect(html).toContain("Priya Sharma");
    expect(html).toContain("KL-2026-0001");
    // The paid badge is a section — it must appear only when the flag is set.
    expect(html).toContain("status-paid");
  });

  it("omits the paid badge and the engagement strip when they do not apply", () => {
    const template = readFileSync(
      join(__dirname, "templates", "invoice.template.html"),
      "utf8",
    );
    const html = renderTemplate(template, {
      paid: false,
      hasEngagement: false,
      engagement: [],
      billedTo: { name: "x", lines: [] },
      facts: [],
      items: [],
      totals: [],
      grandTotal: { label: "Total due", amount: "0.00" },
      company: {},
      payment: {},
      terms: [],
    });

    expect(html).not.toContain('class="status-paid"');
    expect(html).not.toContain('class="layout engagement"');
  });
});

describe("amountInWords", () => {
  it.each([
    [0, "Rupees Zero only."],
    [5, "Rupees Five only."],
    [249, "Rupees Two Hundred and Forty Nine only."],
    [30000, "Rupees Thirty Thousand only."],
    [100000, "Rupees One Lakh only."],
    [
      1234567,
      "Rupees Twelve Lakh Thirty Four Thousand Five Hundred and Sixty Seven only.",
    ],
    [10000000, "Rupees One Crore only."],
  ])("renders %s in the Indian system", (value, expected) => {
    expect(amountInWords(value as number)).toBe(expected);
  });

  it("includes paise when the amount is not whole", () => {
    expect(amountInWords(12711.86)).toBe(
      "Rupees Twelve Thousand Seven Hundred and Eleven and Eighty Six Paise only.",
    );
  });
});

describe("formatting", () => {
  it("groups rupees the Indian way and always shows paise", () => {
    expect(formatAmount(1234567.5)).toBe("12,34,567.50");
    expect(formatAmount(1000)).toBe("1,000.00");
  });

  it("collapses a month range within one year", () => {
    const from = new Date("2026-08-18T00:00:00+05:30");
    const to = new Date("2026-10-17T00:00:00+05:30");
    expect(formatMonthRange(from, to)).toBe("Aug – Oct 2026");
    expect(formatMonthRange(from, from)).toBe("Aug 2026");
  });

  it("keeps both years when the range crosses one", () => {
    expect(
      formatMonthRange(
        new Date("2026-11-01T00:00:00+05:30"),
        new Date("2027-01-31T00:00:00+05:30"),
      ),
    ).toBe("Nov 2026 – Jan 2027");
  });
});
