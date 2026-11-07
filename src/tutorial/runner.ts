import chalk from "chalk";
import type { QueryExecutor } from "../ditto/session.js";
import { extractProfile } from "../profile/parse.js";
import { classify, extractRows } from "../query/execute.js";
import { renderExplain } from "../render/explain.js";
import { renderProfile } from "../render/profile.js";
import { renderTable } from "../render/table.js";
import {
  firstLessonOf,
  LESSONS,
  LEVELS,
  type Lesson,
  type Level,
  RESET_STATEMENTS,
  SEED_ORDERS,
  SEED_PRODUCTS,
  SEED_SUPPLIERS,
} from "./lessons.js";
import {
  type CollectionSchema,
  caseMismatch,
  collectionsIn,
  inferSchema,
  schemaLines,
} from "./schema.js";

/** Practice collections and every field name in them, for case-mismatch hints. */
const KNOWN_NAMES = {
  collections: ["products", "suppliers", "orders"],
  fields: [
    ...new Set(
      inferSchema([...SEED_PRODUCTS, ...SEED_SUPPLIERS, ...SEED_ORDERS] as never).flatMap((f) =>
        f.path.split(/\.|\[\]\.?/).filter(Boolean),
      ),
    ),
  ],
};

/** Documents read per collection for the schema view. */
const SCHEMA_SAMPLE = 200;

export interface RunnerIO {
  print: (text: string) => void;
  /** Terminal width for tables and rules; undefined = unbounded. */
  width: () => number | undefined;
  /**
   * Set by a UI that draws the lesson card itself: called (after the lesson's
   * setup) instead of printing the card, and the welcome banner is skipped.
   */
  onLesson?: () => void;
  /** Also called with each verdict line (✓ / ✗ / query error), for a status bar. */
  onVerdict?: (text: string) => void;
}

export interface Progress {
  lesson: number;
  completed: number[];
}

export interface LessonRunnerOptions {
  lessons?: readonly Lesson[];
  io: RunnerIO;
  progress?: Progress;
  saveProgress?: (p: Progress) => void;
}

const LEVEL_LABEL: Record<Level, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

const MAX_RULE = 78;

/** `code` → cyan, **bold** → bold. */
export function highlight(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => chalk.bold(t))
    .replace(/`([^`]+)`/g, (_, t: string) => chalk.cyan(t));
}

/**
 * Drives the interactive lessons. UI-free except for `io.print`, so it is unit
 * testable with a fake session; tutorial-repl.ts wires it to node:repl.
 */
export class LessonRunner {
  readonly lessons: readonly Lesson[];
  private index: number;
  private readonly completed: Set<number>;
  private readonly io: RunnerIO;
  private readonly save: (p: Progress) => void;

  constructor(
    private readonly session: QueryExecutor,
    opts: LessonRunnerOptions,
  ) {
    this.lessons = opts.lessons ?? LESSONS;
    this.io = opts.io;
    this.save = opts.saveProgress ?? (() => {});
    const saved = opts.progress;
    this.index =
      saved && saved.lesson >= 0 && saved.lesson < this.lessons.length ? saved.lesson : 0;
    this.completed = new Set(
      (saved?.completed ?? []).filter((i) => i >= 0 && i < this.lessons.length),
    );
  }

  get current(): number {
    return this.index;
  }

  get completedCount(): number {
    return this.completed.size;
  }

  private rule(): string {
    return chalk.dim("─".repeat(Math.min(this.io.width() ?? MAX_RULE, MAX_RULE)));
  }

  private persist(): void {
    this.save({ lesson: this.index, completed: [...this.completed].sort((a, b) => a - b) });
  }

  private async rows(statement: string): Promise<Record<string, unknown>[]> {
    return extractRows(await this.session.execute(statement));
  }

  /** Restore the practice data. */
  async resetData(): Promise<void> {
    for (const s of RESET_STATEMENTS) await this.session.execute(s);
  }

  /** Welcome banner + data reset + the current lesson. */
  async start(opts: { level?: Level } = {}): Promise<void> {
    await this.resetData();
    if (opts.level) this.index = firstLessonOf(opts.level, this.lessons);
    if (this.io.onLesson) {
      await this.show();
      return;
    }
    const counts = LEVELS.map(
      (l) => `${LEVEL_LABEL[l]} ${this.lessons.filter((x) => x.level === l).length}`,
    ).join(" · ");
    this.io.print(
      [
        chalk.bold("Learn DQL — interactive lessons"),
        chalk.dim(`${this.lessons.length} lessons: ${counts}`),
        "Type DQL at the learn> prompt and press Enter to run it — a trailing ; is optional.",
        `New here? Type ${chalk.cyan(".help")} for how the lessons work and the commands.`,
        ...(this.index > 0 && !opts.level
          ? [chalk.dim(`Resuming at lesson ${this.index + 1} — .goto 1 starts over.`)]
          : []),
      ].join("\n"),
    );
    await this.show();
  }

  /** Run the lesson's setup and print its card. */
  async show(): Promise<void> {
    const lesson = this.lessons[this.index];
    if (!lesson) return;
    for (const s of lesson.setup ?? []) await this.session.execute(s);
    if (this.io.onLesson) {
      this.io.onLesson();
      return;
    }
    const { position } = this.info();
    const out = [
      "",
      this.rule(),
      `${chalk.bold.cyan(`Lesson ${this.index + 1}/${this.lessons.length}`)} ${chalk.dim("·")} ${chalk.magenta(position)} ${chalk.dim("·")} ${chalk.bold(lesson.title)}${this.completed.has(this.index) ? chalk.green("  ✓") : ""}`,
      this.rule(),
      ...this.cardBody(),
      this.dataTip(".schema"),
      chalk.dim(
        `Press ${chalk.reset("Enter")} to run it · stuck? ${chalk.reset(".hint")} or ${chalk.reset(".answer")} · ${chalk.reset(".help")} explains how this works`,
      ),
    ];
    this.io.print(out.join("\n"));
  }

  /** Where the current lesson sits: "Beginner 3/8", plus its title and completion. */
  info(): { title: string; level: Level; position: string; done: boolean } {
    const lesson = this.lessons[this.index]!;
    const levelLessons = this.lessons.filter((l) => l.level === lesson.level);
    return {
      title: lesson.title,
      level: lesson.level,
      position: `${LEVEL_LABEL[lesson.level]} ${levelLessons.indexOf(lesson) + 1}/${levelLessons.length}`,
      done: this.completed.has(this.index),
    };
  }

  /** The collections the current lesson works with (from its sample answer). */
  collections(): string[] {
    const lesson = this.lessons[this.index];
    return lesson ? collectionsIn(lesson.answer) : [];
  }

  /** "Collections: products, suppliers · <key> shows their fields" */
  dataTip(key: string): string {
    const names = this.collections();
    if (names.length === 0) return chalk.dim(`${key} shows the collections' fields`);
    const label = names.length === 1 ? "Collection" : "Collections";
    return chalk.dim(
      `${label}: ${names.map((n) => chalk.cyan(n)).join(", ")} · ${chalk.reset(key)} shows ${names.length === 1 ? "its" : "their"} fields`,
    );
  }

  /** The live schema of the current lesson's collections. */
  async schema(): Promise<CollectionSchema[]> {
    const out: CollectionSchema[] = [];
    for (const collection of this.collections()) {
      const rows = await this.rows(`SELECT * FROM ${collection} LIMIT ${SCHEMA_SAMPLE + 1}`);
      const docs = rows.slice(0, SCHEMA_SAMPLE);
      out.push({
        collection,
        documents: docs.length,
        more: rows.length > SCHEMA_SAMPLE,
        fields: inferSchema(docs),
      });
    }
    return out;
  }

  /** `.schema` in the plain shell. */
  async printSchema(): Promise<void> {
    const width = Math.min(this.io.width() ?? MAX_RULE, MAX_RULE);
    this.io.print(
      [
        ...schemaLines(await this.schema(), width),
        chalk.dim(
          `Names are case-sensitive: ${chalk.cyan("products")} and ${chalk.cyan("Products")} are different collections.`,
        ),
      ].join("\n"),
    );
  }

  isCompleted(i: number): boolean {
    return this.completed.has(i);
  }

  /**
   * The lesson card's body (concept, SQL note, syntax, task) as styled lines.
   * `unwrap` joins the source's hard-wrapped paragraphs so a UI can re-wrap them;
   * blank lines and indented lines (examples) stay as they are.
   */
  cardBody(opts: { unwrap?: boolean } = {}): string[] {
    const lesson = this.lessons[this.index];
    if (!lesson) return [];
    const t = (s: string) => highlight(opts.unwrap ? s.replace(/(?<!\n)\n(?![\n ])/g, " ") : s);
    const out = [t(lesson.concept)];
    if (lesson.newIn) out.push("", `${chalk.bgBlue.white(" New in SDK 5.2 ")} ${t(lesson.newIn)}`);
    if (lesson.sql) out.push("", `${chalk.dim("If you know SQL:")} ${t(lesson.sql)}`);
    out.push("", chalk.dim("Syntax"), ...lesson.syntax.map((s) => `  ${chalk.cyan(s)}`));
    out.push("", `${chalk.bold.yellow("Task:")} ${t(lesson.task)}`);
    return out;
  }

  /** Run a submitted statement, show its result, and check it against the lesson. */
  async submit(statement: string): Promise<boolean> {
    const lesson = this.lessons[this.index];
    let rows: Record<string, unknown>[];
    try {
      rows = await this.rows(statement);
    } catch (err) {
      const verdict = chalk.red(`Query error: ${(err as Error).message}`);
      this.io.print(`${verdict}\n${chalk.dim("Check the syntax — .hint can help.")}`);
      this.io.onVerdict?.(verdict);
      return false;
    }
    const kind = classify(statement);
    this.io.print(this.renderResult(kind, statement, rows));
    if (!lesson) return false;

    let result: Awaited<ReturnType<Lesson["check"]>>;
    try {
      result = await lesson.check({ statement, kind, rows, query: (s) => this.rows(s) });
    } catch (err) {
      result = { pass: false, reason: `Couldn't check that: ${(err as Error).message}` };
    }
    if (!result.pass) {
      // A wrong-case name runs fine but finds nothing; say so instead.
      const reason = caseMismatch(statement, KNOWN_NAMES) ?? result.reason;
      this.verdict(`${chalk.yellow("✗ Not quite.")} ${highlight(reason)}`);
      return false;
    }
    this.completed.add(this.index);
    this.verdict(`${chalk.green.bold("✓ Correct!")} ${highlight(lesson.success)}`);
    await this.advance();
    return true;
  }

  private verdict(text: string): void {
    this.io.print(text);
    this.io.onVerdict?.(text);
  }

  private renderResult(
    kind: ReturnType<typeof classify>,
    statement: string,
    rows: Record<string, unknown>[],
  ): string {
    if (kind === "explain") return renderExplain(rows[0]);
    if (kind === "profile") {
      const { rows: data, profile } = extractProfile(rows);
      const table =
        data.length > 0 ? `${renderTable(data, { maxWidth: this.io.width() })}\n\n` : "";
      return profile ? table + renderProfile(profile, statement) : table || "(no rows)";
    }
    if (rows.length === 0 && kind !== "select") return chalk.dim("OK");
    return renderTable(rows, { maxWidth: this.io.width() });
  }

  private async advance(): Promise<void> {
    if (this.index + 1 >= this.lessons.length) {
      this.persist();
      this.io.print(this.finishedMessage());
      return;
    }
    const prevLevel = this.lessons[this.index]?.level;
    this.index++;
    this.persist();
    const level = this.lessons[this.index]?.level;
    if (level && level !== prevLevel) {
      this.io.print(`\n${chalk.bold.magenta(`★ On to ${LEVEL_LABEL[level]}!`)}`);
    }
    await this.show();
  }

  private finishedMessage(): string {
    const all = this.completed.size === this.lessons.length;
    return [
      "",
      chalk.bold.green(
        all
          ? `★ You finished all ${this.lessons.length} lessons!`
          : `★ That was the last lesson (${this.completed.size}/${this.lessons.length} completed — .lessons shows the rest).`,
      ),
      "Next steps:",
      `  ${chalk.cyan("dittosh dql")}               your own data in the interactive shell (try ${chalk.cyan(".metrics")})`,
      `  ${chalk.cyan("dittosh dql dataset list")}  sample datasets to practice on`,
      `  ${chalk.cyan("dittosh tutorial")}          a written walkthrough of the whole CLI`,
    ].join("\n");
  }

  hint(): void {
    const lesson = this.lessons[this.index];
    if (lesson) this.io.print(`${chalk.yellow("Hint:")} ${highlight(lesson.hint)}`);
  }

  answer(): void {
    const lesson = this.lessons[this.index];
    if (!lesson) return;
    this.io.print(
      `${chalk.yellow("One answer:")} ${chalk.cyan(lesson.answer)}\n${chalk.dim("Type it (or your own version) and press Enter to continue.")}`,
    );
  }

  async next(): Promise<void> {
    if (this.index + 1 >= this.lessons.length) {
      this.io.print(chalk.dim("This is the last lesson."));
      return;
    }
    this.index++;
    this.persist();
    await this.show();
  }

  async back(): Promise<void> {
    if (this.index === 0) {
      this.io.print(chalk.dim("This is the first lesson."));
      return;
    }
    this.index--;
    this.persist();
    await this.show();
  }

  /** Jump to a 1-based lesson number. */
  async goto(arg: string | undefined): Promise<void> {
    const n = Number(arg?.trim());
    if (!Number.isInteger(n) || n < 1 || n > this.lessons.length) {
      this.io.print(chalk.red(`usage: .goto <1-${this.lessons.length}>`));
      return;
    }
    this.index = n - 1;
    this.persist();
    await this.show();
  }

  async level(arg: string | undefined): Promise<void> {
    const name = arg?.trim().toLowerCase() as Level;
    if (!LEVELS.includes(name)) {
      this.io.print(chalk.red(`usage: .level ${LEVELS.join("|")}`));
      return;
    }
    this.index = firstLessonOf(name, this.lessons);
    this.persist();
    await this.show();
  }

  list(): void {
    const out: string[] = [];
    for (const level of LEVELS) {
      out.push(chalk.bold.magenta(LEVEL_LABEL[level]));
      this.lessons.forEach((l, i) => {
        if (l.level !== level) return;
        const mark = this.completed.has(i) ? chalk.green("✓") : " ";
        const here = i === this.index ? chalk.cyan(" ← you are here") : "";
        out.push(`  ${mark} ${String(i + 1).padStart(2)}. ${l.title}${here}`);
      });
    }
    out.push(
      chalk.dim(`${this.completed.size}/${this.lessons.length} completed · .goto <n> to jump`),
    );
    this.io.print(out.join("\n"));
  }

  async reset(): Promise<void> {
    await this.resetData();
    this.io.print(chalk.dim("Practice data restored."));
    await this.show();
  }
}

/** The `.help` guide: how the lessons work, then the commands. */
export function lessonHelp(): string {
  const h = (t: string) => chalk.bold.magenta(t);
  const c = (t: string) => chalk.cyan(t);
  return [
    h("How the lessons work"),
    "  Each lesson explains one DQL idea, shows the syntax, and gives you a Task.",
    "  Type a statement that does the task. You see its result, then",
    `  ${chalk.green("✓ Correct!")} moves you on, or ${chalk.yellow("✗ Not quite.")} says what to change.`,
    "  The check looks at what your statement returns or changes, not its exact",
    "  wording — any statement that does the task passes.",
    "",
    h("Typing statements"),
    `  Press ${c("Enter")} to run. A trailing ${c(";")} is optional.`,
    `  A ${c("|")} prompt means the statement looks unfinished — an open quote or`,
    `  bracket, or it ends on a comma, an operator, or a word like ${c("WHERE")}.`,
    "  Keep typing to spread a statement over several lines, or",
    `  ${c(".break")} to throw it away. ${c("↑")}/${c("↓")} recall earlier input.`,
    "",
    h("The practice store"),
    `  Lessons run against their own store (collections ${c("products")}, ${c("suppliers")},`,
    `  ${c("orders")}), separate from your ${c("dittosh dql")} data. Writes are safe to try.`,
    `  ${c(".reset")} restores the starting data if you change something by mistake.`,
    `  Collection and field names are case-sensitive (${c("products")}, not ${c("Products")});`,
    "  keywords like SELECT aren't.",
    "",
    h("Levels and progress"),
    "  Beginner → Intermediate → Advanced. Skipping around is fine.",
    `  Progress is saved as you go; ${c(".exit")} and come back later to resume.`,
    "",
    h("Commands"),
    `  ${c(".hint")}             a nudge toward the answer`,
    `  ${c(".answer")}           show one correct statement`,
    `  ${c(".next")} / ${c(".back")}     move between lessons`,
    `  ${c(".lessons")}          list every lesson by level, with your progress`,
    `  ${c(".level <name>")}     jump to beginner, intermediate, or advanced`,
    `  ${c(".goto <n>")}         jump to lesson n`,
    `  ${c(".schema")}           the fields of this lesson's collections`,
    `  ${c(".reset")}            restore the practice data and show the lesson again`,
    `  ${c(".break")}            discard an unfinished statement (the | prompt)`,
    `  ${c(".help")}             this guide`,
    `  ${c(".exit")}             leave (progress is saved; Ctrl+D also works)`,
  ].join("\n");
}
