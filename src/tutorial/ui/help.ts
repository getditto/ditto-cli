import chalk from "chalk";
import { wrapLines } from "./layout.js";

/** Drawer width: an inspector-style column beside the lesson (wider for the data view). */
export function drawerWidth(screenWidth: number, mode: "help" | "data" = "help"): number {
  if (mode === "data") return Math.max(34, Math.min(52, Math.floor(screenWidth * 0.45)));
  return Math.max(30, Math.min(40, Math.floor(screenWidth * 0.38)));
}

const KEYS: [string, string][] = [
  ["Enter", "run the statement"],
  ["Tab", "hint"],
  ["^T", "data: the collections' fields"],
  ["^N / ^P", "next / previous lesson"],
  ["^L", "lesson list"],
  ["^O", "whole lesson (short window)"],
  ["^B", "show / hide the outline"],
  ["PgUp/PgDn", "scroll results"],
  ["↑ / ↓", "earlier statements"],
  ["Esc", "clear input · close help"],
  ["?", "show / hide this help"],
  ["^D", "quit (progress is saved)"],
];

const COMMANDS: [string, string][] = [
  [".hint", "a nudge toward the answer"],
  [".answer", "one correct statement"],
  [".next .back", "move between lessons"],
  [".goto <n>", "jump to lesson n"],
  [".level <name>", "beginner, intermediate, advanced"],
  [".lessons", "lesson list"],
  [".schema", "the collections' fields (^T)"],
  [".reset", "restore the practice data"],
  [".break", "drop an unfinished statement"],
  [".exit", "quit"],
];

const ABOUT = [
  "Each lesson explains one idea and sets a **Task**. Type a statement that does it: you see the result, then ✓ or ✗ on the line above the prompt.",
  "Any statement that does the task passes — the check looks at what it returns or changes, not its wording.",
  "Enter runs; a trailing `;` is optional. A `|` prompt means the statement looks unfinished (an open quote or bracket, or a trailing comma, operator, or keyword like `WHERE`) — keep typing.",
  "Lessons use their own practice store, separate from your `dittosh dql` data. Writes are safe; `.reset` restores it.",
  "Collection and field names are case-sensitive: `products`, not `Products`. Keywords like `SELECT` work in any case.",
  "Progress is saved as you go.",
];

/** `**bold**` / `` `code` `` in the help prose. */
function style(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => chalk.bold(t))
    .replace(/`([^`]+)`/g, (_, t: string) => chalk.cyan(t));
}

function table(rows: [string, string][], width: number): string[] {
  const keyWidth = Math.min(14, Math.max(...rows.map(([k]) => k.length)));
  return rows.flatMap(([k, v]) => {
    const pad = " ".repeat(keyWidth + 2);
    const wrapped = wrapLines([v], Math.max(8, width - keyWidth - 2));
    return wrapped.map((line, i) =>
      i === 0 ? `${chalk.cyan(k.padEnd(keyWidth))}  ${line}` : pad + line,
    );
  });
}

/** The drawer's lines, wrapped to its inner `width`. */
export function helpLines(width: number): string[] {
  const h = (t: string) => chalk.bold.magenta(t);
  return [
    h("Keys"),
    ...table(KEYS, width),
    "",
    h("Commands"),
    ...table(COMMANDS, width),
    "",
    h("How it works"),
    ...ABOUT.flatMap((p, i) => [...(i > 0 ? [""] : []), ...wrapLines([style(p)], width)]),
  ];
}
