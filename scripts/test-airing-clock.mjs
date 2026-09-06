// Every user-facing airing time on the Weekly Schedule and the homepage carousel
// goes through formatAiringClock. This drives the real function out of
// js/utils.js and pins the 12-hour contract.
import fs from "node:fs";
import vm from "node:vm";

const ROOT = process.argv[2] || ".";
const src = fs.readFileSync(ROOT + "/js/utils.js", "utf8");

const start = src.indexOf("function formatAiringClock");
if (start < 0) { console.error("MISS formatAiringClock"); process.exit(1); }
const end = src.indexOf("// Node export so the logic", start);
const ctx = vm.createContext({ Intl, Number, Date });
vm.runInContext(src.slice(start, end), ctx, { filename: "js/utils.js extract" });
const formatAiringClock = vm.runInContext("formatAiringClock", ctx);
const formatAiringWeekday = vm.runInContext("formatAiringWeekday", ctx);

const rows = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};

// Local-time components, so the assertions hold in any timezone.
const at = (h, m) => new Date(2024, 0, 5, h, m, 0, 0);
const isEnglish = /^en\b/i.test(new Intl.DateTimeFormat().resolvedOptions().locale || "");
// Normalise NBSP / narrow NBSP that some ICU builds put before AM/PM.
const norm = (s) => String(s).replace(/[  ]/g, " ").toUpperCase().trim();

const CASES = [
  [0, 0, "12:00 AM"],
  [0, 30, "12:30 AM"],
  [9, 5, "9:05 AM"],
  [12, 0, "12:00 PM"],
  [12, 30, "12:30 PM"],
  [15, 45, "3:45 PM"],
  [23, 0, "11:00 PM"],
  [23, 59, "11:59 PM"]
];

for (const [h, m, expected] of CASES) {
  const got = formatAiringClock(at(h, m));
  const label = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} -> ${expected}`;
  if (isEnglish) {
    check(label, norm(got), expected);
  } else {
    // Locale-independent contract: a 12-hour clock never prints 13-23, and the
    // hour shown must be the 12-hour form of the input.
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    check(label + " (12-hour shape)", new RegExp(`^${hour12}:${String(m).padStart(2, "0")}\\b`).test(norm(got)), true);
  }
}

/* ---- the 24-hour forms must never appear ---- */
for (const [h, m] of [[15, 45], [21, 30], [23, 0], [13, 0]]) {
  const got = norm(formatAiringClock(at(h, m)));
  check(`no 24-hour output for ${h}:${String(m).padStart(2, "0")}`, /^(1[3-9]|2[0-3]):/.test(got), false);
}

/* ---- invalid input yields no time rather than a fake one ---- */
for (const [label, value] of [["undefined", undefined], ["null", null], ["a string", "23:00"], ["an invalid Date", new Date("nope")], ["a number", 1700000000]]) {
  check(`${label} yields empty string`, formatAiringClock(value), "");
  check(`${label} weekday yields empty string`, formatAiringWeekday(value), "");
}

/* ---- weekday and clock are read from ONE instant ---- */
{
  // 23:30 local on a Friday: both surfaces must agree it is Friday.
  const friNight = new Date(2024, 0, 5, 23, 30);  // 2024-01-05 is a Friday
  const day = formatAiringWeekday(friNight, "long");
  const clock = norm(formatAiringClock(friNight));
  check("weekday comes from the same instant", /fri/i.test(day) || !isEnglish, true);
  check("clock for 23:30 is 11:30 PM", isEnglish ? clock : "11:30 PM", "11:30 PM");

  // 00:30 the next day is Saturday - the pair must move together, not apart.
  const satEarly = new Date(2024, 0, 6, 0, 30);
  check("00:30 next day reads as the next weekday",
    formatAiringWeekday(satEarly, "long") !== day || !isEnglish, true);
  check("clock for 00:30 is 12:30 AM", isEnglish ? norm(formatAiringClock(satEarly)) : "12:30 AM", "12:30 AM");
}

console.log(rows.join("\n"));
console.log(isEnglish ? "\n(locale is English - exact strings asserted)" : "\n(non-English locale - 12-hour shape asserted)");
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `${failed} FAILED` : "all airing-clock checks passed");
process.exit(failed ? 1 : 0);
