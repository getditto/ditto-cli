import chalk from "chalk";
import stringWidth from "string-width";
import { cellText, collectColumns } from "./columns.js";
import { sanitizeCell } from "./sanitize.js";

/** Display width (accounts for CJK wide chars and emoji; strips ANSI codes). */
function visibleLength(s: string): number {
  return stringWidth(s);
}

export interface TableOptions {
  /**
   * Max total table width (terminal columns). Undefined = never truncate
   * (files/pipes get full-fidelity tables). When set, cells are hard-capped
   * at CELL_CAP and columns shrink to fit, ellipsizing with "…".
   */
  maxWidth?: number;
}

/** Hard per-cell cap when fitting to a terminal — long text (plots, JSON) stays glanceable. */
const CELL_CAP = 60;
/** Narrowest a column may shrink to when fitting the terminal width. */
const MIN_COL_WIDTH = 6;

type CellKind = "null" | "number" | "text";

function kindOf(value: unknown): CellKind {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "bigint") return "number";
  return "text";
}

/** Truncate to `w` display columns, ending with "…" when anything was cut. */
function ellipsize(s: string, w: number): string {
  if (visibleLength(s) <= w) return s;
  if (w <= 1) return "…".slice(0, Math.max(w, 0));
  const target = w - 1;
  let out = "";
  let width = 0;
  for (const ch of s) {
    const cw = visibleLength(ch);
    if (width + cw > target) break;
    out += ch;
    width += cw;
  }
  return `${out}…`;
}

/**
 * Render rows as an ASCII table: `_id` column first, then the union of all
 * other keys in first-seen order. Numbers right-align; nulls are dimmed.
 * Pass maxWidth (terminal columns) to fit the table to the terminal.
 */
export function renderTable(rows: Record<string, unknown>[], opts?: TableOptions): string {
  if (rows.length === 0) return "(no rows)";

  const cols = collectColumns(rows);
  // Sanitize keys BEFORE measuring — control chars measure 0 wide but render
  // as markers (⏎/⇥), which would make repeat counts go negative (crash).
  const header = cols.map((c) => sanitizeCell(c));
  const fitting = opts?.maxWidth !== undefined;

  const data = rows.map((row) =>
    cols.map((c) => {
      const raw = sanitizeCell(cellText(row[c]));
      return {
        kind: kindOf(row[c]),
        text: fitting ? ellipsize(raw, CELL_CAP) : raw,
      };
    }),
  );

  // Loop, not spread — Math.max(...spread) overflows the call stack past ~150k rows.
  const widths = header.map((h, i) => {
    let w = visibleLength(h);
    for (const r of data) {
      const rw = visibleLength(r[i]!.text);
      if (rw > w) w = rw;
    }
    return w;
  });

  // Fit to the terminal: shrink the widest column one char at a time until
  // the table fits or every column is at the floor (too many columns to fit
  // is accepted — the alternative is dropping data silently).
  if (fitting) {
    const maxWidth = opts!.maxWidth!;
    const total = () => widths.reduce((a, b) => a + b, 0) + 3 * widths.length + 1;
    for (;;) {
      if (total() <= maxWidth) break;
      let widest = -1;
      for (let i = 0; i < widths.length; i++) {
        if (widths[i]! > MIN_COL_WIDTH && (widest === -1 || widths[i]! > widths[widest]!)) {
          widest = i;
        }
      }
      if (widest === -1) break;
      widths[widest]!--;
    }
    for (const r of data) {
      for (let i = 0; i < r.length; i++) {
        r[i]!.text = ellipsize(r[i]!.text, widths[i]!);
      }
    }
  }

  const line = (left: string, mid: string, right: string) =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
  const renderRow = (cells: { kind: CellKind; text: string }[]) =>
    "│ " +
    cells
      .map((c, i) => {
        // Math.max: a cell wider than its column can only happen pre-fit
        // (headers are ellipsized below) — never let repeat() go negative.
        const gap = Math.max(0, (widths[i] ?? 0) - visibleLength(c.text));
        const padded = c.kind === "number" ? " ".repeat(gap) + c.text : c.text + " ".repeat(gap);
        return c.kind === "null" ? chalk.dim(padded) : padded;
      })
      .join(" │ ") +
    " │";

  const out: string[] = [];
  out.push(line("┌", "┬", "┐"));
  out.push(
    renderRow(
      header.map((h, i) => ({
        kind: "text" as const,
        text: chalk.bold(fitting ? ellipsize(h, widths[i]!) : h),
      })),
    ),
  );
  out.push(line("├", "┼", "┤"));
  for (const r of data) out.push(renderRow(r));
  out.push(line("└", "┴", "┘"));
  out.push(`${rows.length} row${rows.length === 1 ? "" : "s"}`);
  return out.join("\n");
}
