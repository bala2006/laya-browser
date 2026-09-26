/**
 * Hand-templated SVG bar charts for the benchmark results.
 *
 * No charting library: each chart is a small, clean, self-contained SVG string that renders
 * inline on GitHub. Colours: laya = teal (#0f766e), Playwright = indigo (#4338ca),
 * autopilot = amber (#b45309).
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const LAYA = "#0f766e";
const PW = "#4338ca";
const AUTO = "#b45309";
const GRID = "#e2e8f0";
const TEXT = "#1e293b";
const MUTED = "#64748b";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Grouped vertical bar chart.
 * @param title  chart title
 * @param labels category/task labels (x axis)
 * @param series [{ name, color, values }]  each value aligns with labels; null renders as N/A
 * @param opts   { unit, height, maxHint }
 */
function groupedBarChart(title, labels, series, opts = {}) {
  const unit = opts.unit ?? "";
  const W = Math.max(680, 90 + labels.length * (series.length * 26 + 34));
  const H = opts.height ?? 380;
  const padL = 56;
  const padR = 20;
  const padT = 52;
  const padB = 96;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const rawMax = Math.max(
    1,
    ...series.flatMap((s) => s.values.map((v) => (typeof v === "number" ? v : 0))),
  );
  const max = opts.maxHint ?? niceMax(rawMax);

  const groups = labels.length;
  const groupW = plotW / groups;
  const barGap = 4;
  const barW = Math.max(6, (groupW - 18 - barGap * (series.length - 1)) / series.length);

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Roboto,sans-serif">`,
  );
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(
    `<text x="${padL}" y="28" font-size="16" font-weight="700" fill="${TEXT}">${esc(title)}</text>`,
  );

  // Y grid + labels (5 steps).
  const steps = 5;
  for (let i = 0; i <= steps; i += 1) {
    const val = (max / steps) * i;
    const y = padT + plotH - (plotH * i) / steps;
    parts.push(`<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(
      `<text x="${padL - 8}" y="${y + 4}" font-size="10" text-anchor="end" fill="${MUTED}">${formatTick(val, unit)}</text>`,
    );
  }

  // Bars.
  labels.forEach((label, gi) => {
    const gx = padL + gi * groupW + 9;
    series.forEach((s, si) => {
      const v = s.values[gi];
      const x = gx + si * (barW + barGap);
      if (typeof v !== "number") {
        parts.push(
          `<text x="${x + barW / 2}" y="${padT + plotH - 4}" font-size="9" text-anchor="middle" fill="${MUTED}" transform="rotate(-90 ${x + barW / 2} ${padT + plotH - 4})">N/A</text>`,
        );
        return;
      }
      const h = max === 0 ? 0 : (plotH * v) / max;
      const y = padT + plotH - h;
      parts.push(`<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${s.color}" rx="2"/>`);
      parts.push(
        `<text x="${x + barW / 2}" y="${y - 3}" font-size="9" text-anchor="middle" fill="${TEXT}">${formatVal(v, unit)}</text>`,
      );
    });
    // X label (rotated for readability).
    const cx = padL + gi * groupW + groupW / 2;
    parts.push(
      `<text x="${cx}" y="${padT + plotH + 14}" font-size="10" text-anchor="end" fill="${TEXT}" transform="rotate(-35 ${cx} ${padT + plotH + 14})">${esc(label)}</text>`,
    );
  });

  // Legend.
  let lx = padL;
  const ly = H - 20;
  series.forEach((s) => {
    parts.push(`<rect x="${lx}" y="${ly - 9}" width="11" height="11" fill="${s.color}" rx="2"/>`);
    parts.push(`<text x="${lx + 16}" y="${ly}" font-size="11" fill="${TEXT}">${esc(s.name)}</text>`);
    lx += 30 + s.name.length * 7;
  });

  parts.push("</svg>");
  return parts.join("\n");
}

function niceMax(v) {
  if (v <= 1) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function formatTick(val, unit) {
  if (unit === "%") return Math.round(val) + "%";
  if (val >= 1000) return (val / 1000).toFixed(1) + "k";
  return Math.round(val).toString();
}

function formatVal(val, unit) {
  if (unit === "%") return Math.round(val) + "%";
  return Math.round(val).toString();
}

export { groupedBarChart };

/** Write all four charts from a compiled results object. Returns the file names written. */
export async function writeCharts(chartsDir, model) {
  await mkdir(chartsDir, { recursive: true });
  const files = [];

  // 1. Success rate by category (laya assist vs playwright assist), percentage.
  {
    const cats = model.categories;
    const svg = groupedBarChart(
      "Success rate by category (%)",
      cats.map((c) => c.category),
      [
        { name: "laya (Assist)", color: LAYA, values: cats.map((c) => pct(c.layaRate)) },
        { name: "Playwright", color: PW, values: cats.map((c) => pct(c.pwRate)) },
      ],
      { unit: "%", maxHint: 100 },
    );
    const f = "success-by-category.svg";
    await writeFile(path.join(chartsDir, f), svg);
    files.push(f);
  }

  // 2. Median latency laya vs playwright by task (ms).
  {
    const tasks = model.tasksBoth;
    const svg = groupedBarChart(
      "Median latency by task (ms, lower is better)",
      tasks.map((t) => t.id),
      [
        { name: "laya (Assist)", color: LAYA, values: tasks.map((t) => t.layaMs) },
        { name: "Playwright", color: PW, values: tasks.map((t) => t.pwMs) },
      ],
      { unit: "ms" },
    );
    const f = "latency-by-task.svg";
    await writeFile(path.join(chartsDir, f), svg);
    files.push(f);
  }

  // 3. Round-trips comparison (Assist laya vs Playwright vs laya Autopilot) for tasks with an
  //    autopilot variant.
  {
    const tasks = model.roundTripTasks;
    const svg = groupedBarChart(
      "Round-trips per task (tool calls, lower is better)",
      tasks.map((t) => t.id),
      [
        { name: "laya (Assist)", color: LAYA, values: tasks.map((t) => t.layaRt) },
        { name: "Playwright", color: PW, values: tasks.map((t) => t.pwRt) },
        { name: "laya (Autopilot)", color: AUTO, values: tasks.map((t) => t.autoRt) },
      ],
      { unit: "" },
    );
    const f = "round-trips.svg";
    await writeFile(path.join(chartsDir, f), svg);
    files.push(f);
  }

  // 4. Capability coverage: tool counts + attemptable task counts.
  {
    const cov = model.coverage;
    const svg = groupedBarChart(
      "Capability coverage",
      ["Tools exposed", "Task categories attempted", "Tasks passed"],
      [
        {
          name: "laya",
          color: LAYA,
          values: [cov.layaTools, cov.layaCategories, cov.layaPassed],
        },
        {
          name: "Playwright",
          color: PW,
          values: [cov.pwTools, cov.pwCategories, cov.pwPassed],
        },
      ],
      { unit: "" },
    );
    const f = "capability-coverage.svg";
    await writeFile(path.join(chartsDir, f), svg);
    files.push(f);
  }

  return files;
}

function pct(rate) {
  return rate === null || rate === undefined ? null : Math.round(rate * 100);
}
