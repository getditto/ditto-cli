import chalk from "chalk";
import { Box, Text } from "ink";
import { useMemo } from "react";
import stringWidth from "string-width";
import { LEVELS, type Level } from "../lessons.js";
import { useTutorial } from "./context.js";
import { clip, listWindow, progressBar } from "./layout.js";

export const PROMPT = "learn> ";
export const CONTINUE = "     | ";

const LEVEL_LABEL: Record<Level, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

/** Top row: badge, lesson position and title, overall progress bar. */
export function Header({ width }: { width: number }) {
  const { runner } = useTutorial();
  const info = runner.info();
  const bar = progressBar(runner.completedCount, runner.lessons.length, Math.min(20, width >> 3));
  const title = clip(
    `${chalk.bold.cyan(`Lesson ${runner.current + 1}/${runner.lessons.length}`)} ${chalk.dim("·")} ${chalk.magenta(info.position)} ${chalk.dim("·")} ${chalk.bold(info.title)}${info.done ? chalk.green(" ✓") : ""}`,
    width - stringWidth(bar) - 14,
  );
  return (
    <Box justifyContent="space-between" height={1}>
      <Text wrap="truncate-end">
        {chalk.bgCyan.black(" Learn DQL ")} {title}
      </Text>
      <Text>{bar}</Text>
    </Box>
  );
}

/** Lines in a bordered panel; `lines` are already wrapped to fit. */
function Panel({ lines, rows, color }: { lines: readonly string[]; rows: number; color: string }) {
  return (
    <Box
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      flexDirection="column"
      height={rows + 2}
    >
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional lines, re-rendered wholesale
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
    </Box>
  );
}

/** The lesson: concept, SQL note, syntax, task (already fitted to the panel). */
export function LessonCard({ lines, rows }: { lines: readonly string[]; rows: number }) {
  return <Panel lines={lines} rows={rows} color="cyan" />;
}

/** Results and feedback (the visible slice of the scrolled log). */
export function OutputPanel({ lines, rows }: { lines: readonly string[]; rows: number }) {
  return (
    <Panel
      lines={lines.length > 0 ? lines : [chalk.dim("Results and feedback appear here.")]}
      rows={rows}
      color="gray"
    />
  );
}

type PickerRow = { kind: "level"; label: string } | { kind: "lesson"; index: number };

/** Ctrl+L: every lesson grouped by level, ✓ for completed, the selection highlighted. */
export function LessonPicker({
  selected,
  rows,
  width,
}: {
  selected: number;
  rows: number;
  width: number;
}) {
  const { runner } = useTutorial();
  const items = useMemo<PickerRow[]>(
    () =>
      LEVELS.flatMap((level) => [
        { kind: "level" as const, label: LEVEL_LABEL[level] },
        ...runner.lessons.flatMap((l, index) =>
          l.level === level ? [{ kind: "lesson" as const, index }] : [],
        ),
      ]),
    [runner],
  );
  const selectedRow = items.findIndex((r) => r.kind === "lesson" && r.index === selected);
  const [from, to] = listWindow(items.length, rows, selectedRow);
  return (
    <Box
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      flexDirection="column"
      height={rows + 2}
    >
      {items.slice(from, to).map((r) => {
        if (r.kind === "level") {
          return <Text key={`level-${r.label}`}>{chalk.bold.magenta(r.label)}</Text>;
        }
        const l = runner.lessons[r.index]!;
        const mark = runner.isCompleted(r.index) ? chalk.green("✓") : " ";
        const isNew = l.newIn ? chalk.blue("  new in 5.2") : "";
        const line = clip(
          ` ${mark} ${String(r.index + 1).padStart(2)}. ${l.title}${isNew}`,
          width - 1,
        );
        return (
          <Text key={`lesson-${r.index}`} inverse={r.index === selected}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

/** The lesson outline sidebar (left). */
export function OutlinePanel({
  lines,
  rows,
  width,
}: {
  lines: readonly string[];
  rows: number;
  width: number;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
      width={width}
      height={rows + 2}
      flexShrink={0}
    >
      {lines.slice(0, rows).map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional lines
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
    </Box>
  );
}

/** The right-hand inspector (help or data): a column that slides in from the right. */
export function HelpDrawer({
  title,
  lines,
  rows,
  width,
  scroll,
  more,
}: {
  title: string;
  lines: readonly string[];
  rows: number;
  width: number;
  scroll: number;
  /** More lines below: say PgDn scrolls. */
  more: boolean;
}) {
  const visible = lines.slice(scroll, scroll + rows - 1);
  return (
    <Box
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      flexDirection="column"
      width={width}
      height={rows + 2}
      flexShrink={0}
    >
      <Text wrap="truncate-end">
        {chalk.bold.bgMagenta.black(` ${title} `)} {chalk.dim(more ? "PgDn more" : "Esc closes")}
      </Text>
      {visible.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional lines
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
    </Box>
  );
}

/** The latest verdict, kept in view whatever the output panel shows. */
export function StatusLine({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional lines
        <Text key={i} wrap="truncate-end">
          {` ${l}`}
        </Text>
      ))}
    </>
  );
}

/** The prompt line, plus the last few lines of an unfinished statement. */
export function InputLine({
  done,
  hidden,
  line,
  empty,
  busy,
}: {
  /** Earlier lines to show (already capped). */
  done: readonly string[];
  /** Earlier lines not shown. */
  hidden: number;
  /** The current line, already scrolled to keep the cursor in view. */
  line: string;
  empty: boolean;
  busy: boolean;
}) {
  const continuing = done.length > 0 || hidden > 0;
  return (
    <>
      {hidden > 0 && (
        <Text wrap="truncate-end">
          {chalk.cyan(PROMPT)}
          {chalk.dim(`… ${hidden} earlier line${hidden === 1 ? "" : "s"}`)}
        </Text>
      )}
      {done.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: continuation lines are positional
        <Text key={i} wrap="truncate-end">
          {i === 0 && hidden === 0 ? chalk.cyan(PROMPT) : chalk.dim(CONTINUE)}
          {l}
        </Text>
      ))}
      <Text wrap="truncate-end">
        {continuing ? chalk.dim(CONTINUE) : chalk.cyan(PROMPT)}
        {busy && empty ? chalk.yellow("running…") : line}
      </Text>
    </>
  );
}

/** Bottom row: key hints, and the scroll position when the output overflows. */
export function Footer({
  mode,
  above,
  below,
  width,
}: {
  mode: "lesson" | "picker" | "help" | "data";
  above: number;
  below: number;
  width: number;
}) {
  const keys = {
    lesson: "Enter run · Tab hint · ^T data · ^L list · ? help · ^D quit",
    picker: "↑/↓ choose · Enter open · Esc close",
    help: "Enter run · ? or Esc close help · PgUp/Dn scroll help · ^D quit",
    data: "Enter run · ^T or Esc close data · PgUp/Dn scroll data · ^D quit",
  }[mode];
  const parts = [above > 0 ? `↑${above}` : "", below > 0 ? `↓${below}` : ""].filter(Boolean);
  const scroll = parts.length > 0 ? `${parts.join(" ")} PgUp/Dn` : "";
  return (
    <Box justifyContent="space-between" height={1}>
      <Text dimColor wrap="truncate-end">
        {clip(keys, width - stringWidth(scroll) - 2)}
      </Text>
      <Text dimColor>{scroll}</Text>
    </Box>
  );
}
