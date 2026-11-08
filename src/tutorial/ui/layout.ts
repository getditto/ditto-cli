import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

/** Box-drawing characters: tables, plan trees, profile bars. */
const DRAWING = /[\u2500-\u257f]/;

/**
 * Word-wrap styled text to `width` columns; one array entry per screen line.
 * Each source line keeps its indentation, and wrapped rows get the same indent.
 * Drawn lines (tables, plan trees) are never wrapped — wrapping would break
 * them apart — so the panel cuts them off with "…" instead.
 */
export function wrapLines(blocks: readonly string[], width: number): string[] {
  const w = Math.max(1, width);
  return blocks.flatMap((block) =>
    block.split("\n").flatMap((line) => {
      const plain = stripVTControlCharacters(line);
      if (DRAWING.test(plain)) return [line];
      const indent = /^ */.exec(plain)?.[0].length ?? 0;
      if (indent === 0 || indent >= w - 4) {
        return wrapAnsi(line, w, { hard: true, trim: indent === 0 }).split("\n");
      }
      const pad = " ".repeat(indent);
      return wrapAnsi(line.replace(/^( *)/, ""), w - indent, { hard: true })
        .split("\n")
        .map((row) => pad + row);
    }),
  );
}

/**
 * Fit the lesson card into `rows`: when it's too tall, the middle gives way so
 * the task (the last lines) always stays visible.
 */
export function fitCard(
  body: readonly string[],
  task: readonly string[],
  rows: number,
  more: string,
): string[] {
  if (body.length + task.length <= rows) return [...body, ...task];
  const keep = rows - task.length - 1;
  if (keep < 1) return [...task.slice(0, Math.max(0, rows - 1)), more];
  return [...body.slice(0, keep), more, ...task];
}

/**
 * The `height` lines visible when scrolled `offset` lines up from the bottom.
 * Returns the clamped offset too (it can't scroll past the top).
 */
export function scrollWindow(
  lines: readonly string[],
  height: number,
  offset: number,
): { visible: string[]; offset: number; above: number; below: number } {
  const h = Math.max(0, height);
  const maxOffset = Math.max(0, lines.length - h);
  const o = Math.max(0, Math.min(offset, maxOffset));
  const end = lines.length - o;
  const start = Math.max(0, end - h);
  return { visible: lines.slice(start, end), offset: o, above: start, below: o };
}

/** The slice of a list to show so that `selected` stays in view. */
export function listWindow(count: number, height: number, selected: number): [number, number] {
  const h = Math.max(1, height);
  if (count <= h) return [0, count];
  const start = Math.max(0, Math.min(selected - Math.floor(h / 2), count - h));
  return [start, start + h];
}

/** `████░░░░ 4/27` */
export function progressBar(done: number, total: number, width: number): string {
  const w = Math.max(4, width);
  const filled = total > 0 ? Math.round((done / total) * w) : 0;
  return `${chalk.green("█".repeat(filled))}${chalk.dim("░".repeat(w - filled))} ${done}/${total}`;
}

/** Truncate styled text to `width` display columns (drops styling when cut). */
export function clip(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  const plain = stripVTControlCharacters(text);
  let out = "";
  for (const ch of plain) {
    if (stringWidth(`${out + ch}…`) > width) break;
    out += ch;
  }
  return `${out}…`;
}
