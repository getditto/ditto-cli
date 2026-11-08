import chalk from "chalk";
import stringWidth from "string-width";
import { LEVELS, type Lesson, type Level } from "../lessons.js";
import { clip, listWindow, wrapLines } from "./layout.js";

/** The narrowest window that shows the sidebar by default. */
export const OUTLINE_MIN_SCREEN = 90;

/** Sidebar width: wider on big screens so lesson titles fit. */
export function outlineWidth(screenWidth: number): number {
  return Math.max(28, Math.min(36, Math.floor(screenWidth * 0.26)));
}

const LEVEL_LABEL: Record<Level, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

export interface OutlineInput {
  lessons: readonly Lesson[];
  current: number;
  isCompleted: (i: number) => boolean;
}

/**
 * The sidebar: every level with its progress; the current level expanded to
 * its lessons (✓ done, ▸ current). Fits `rows` lines of `width` columns,
 * scrolling the lesson list so the current lesson stays in view.
 */
export function outlineLines(
  { lessons, current, isCompleted }: OutlineInput,
  width: number,
  rows: number,
): string[] {
  const currentLevel = lessons[current]?.level;
  const right = (left: string, r: string) => {
    const l = clip(left, width - r.length - 1);
    const gap = Math.max(1, width - stringWidth(l) - r.length);
    return `${l}${" ".repeat(gap)}${chalk.dim(r)}`;
  };
  const done = lessons.filter((_, i) => isCompleted(i)).length;
  const head = [right(chalk.bold("Lessons"), `${done}/${lessons.length}`), ""];

  const levelRows: { level: Level; line: string }[] = LEVELS.map((level) => {
    const idx = lessons.flatMap((l, i) => (l.level === level ? [i] : []));
    const n = idx.filter(isCompleted).length;
    const open = level === currentLevel;
    const label = `${open ? "▾" : "▸"} ${LEVEL_LABEL[level]}`;
    return {
      level,
      line: right(open ? chalk.bold.magenta(label) : chalk.magenta(label), `${n}/${idx.length}`),
    };
  });

  const items = lessons.flatMap((l, i) => (l.level === currentLevel ? [i] : []));
  // Each lesson: "  ✓ 12 Title words" with the title wrapped under itself.
  const titleWidth = Math.max(6, width - 7);
  const itemLines: string[] = [];
  let currentLine = 0;
  for (const i of items) {
    const mark = i === current ? chalk.cyan("▸") : isCompleted(i) ? chalk.green("✓") : " ";
    const style = (t: string) => (i === current ? chalk.bold.cyan(t) : t);
    const titleRows = wrapLines([lessons[i]!.title], titleWidth);
    if (i === current) currentLine = itemLines.length;
    titleRows.forEach((row, r) => {
      const prefix = r === 0 ? `  ${mark} ${String(i + 1).padStart(2)} ` : "       ";
      itemLines.push(`${prefix}${style(row)}`);
    });
  }

  // Rows left for the open level's lessons, after the header and level rows.
  const room = Math.max(1, rows - head.length - levelRows.length);
  const [from, to] = listWindow(itemLines.length, room, currentLine);
  const shown = itemLines.slice(from, to);
  if (from > 0) shown[0] = chalk.dim("    …");
  if (to < itemLines.length) shown[shown.length - 1] = chalk.dim("    …");

  return [
    ...head,
    ...levelRows.flatMap((r) => (r.level === currentLevel ? [r.line, ...shown] : [r.line])),
  ];
}
