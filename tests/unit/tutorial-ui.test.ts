import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { type Instance, render } from "ink";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryExecutor } from "../../src/ditto/session.js";
import { LESSONS, SEED_PRODUCTS } from "../../src/tutorial/lessons.js";
import { LessonRunner } from "../../src/tutorial/runner.js";
import { LessonScreen, screenIO } from "../../src/tutorial/ui/app.js";
import { TutorialProvider, useTutorial } from "../../src/tutorial/ui/context.js";
import {
  type EditorState,
  edit,
  emptyEditor,
  isEditorEmpty,
  submit,
  viewport,
} from "../../src/tutorial/ui/editor.js";
import { drawerWidth, helpLines } from "../../src/tutorial/ui/help.js";
import {
  clip,
  fitCard,
  listWindow,
  progressBar,
  scrollWindow,
  wrapLines,
} from "../../src/tutorial/ui/layout.js";
import { outlineLines, outlineWidth } from "../../src/tutorial/ui/outline.js";
import { createUiStore } from "../../src/tutorial/ui/store.js";

const strip = (s: string | undefined) => stripVTControlCharacters(s ?? "");

// ─── editor ────────────────────────────────────────────────────────────────

describe("lesson screen editor", () => {
  const type = (s: EditorState, text: string) => edit(s, { type: "insert", text });

  it("edits a line: insert, cursor moves, delete, kill", () => {
    let s = type(emptyEditor(), "SELEC FROM");
    s = edit(s, { type: "home" });
    s = edit(s, { type: "right" });
    for (let i = 0; i < 4; i++) s = edit(s, { type: "right" });
    s = type(s, "T *");
    expect(s.line).toBe("SELECT * FROM");
    s = edit(s, { type: "end" });
    s = edit(s, { type: "backspace" });
    expect(s.line).toBe("SELECT * FRO");
    s = edit(s, { type: "home" });
    s = edit(s, { type: "delete" });
    expect(s.line).toBe("ELECT * FRO");
    s = edit(s, { type: "left" }); // clamps at 0
    expect(s.cursor).toBe(0);
    s = edit(s, { type: "end" });
    s = edit(s, { type: "killWord" });
    expect(s.line).toBe("ELECT * ");
    s = edit(s, { type: "killLine" });
    expect(s.line).toBe("");
    expect(isEditorEmpty(s)).toBe(true);
    expect(edit(s, { type: "backspace" })).toBe(s); // nothing to join
  });

  it("viewport scrolls long lines so the cursor stays in view", () => {
    expect(viewport("short", 2, 20)).toEqual({ text: "short", cursorCol: 2 });
    const line = "abcdefghijklmnopqrstuvwxyz";
    const end = viewport(line, line.length, 10);
    expect(end.text.startsWith("…")).toBe(true);
    // 8 characters, then the cursor in the 9th column.
    expect(end.text.length).toBe(8);
    expect(end.cursorCol).toBe(8);
    const start = viewport(line, 0, 10);
    expect(start).toEqual({ text: "abcdefgh…", cursorCol: 0 });
    const mid = viewport(line, 13, 10);
    expect(mid.text.startsWith("…") && mid.text.endsWith("…")).toBe(true);
    expect(mid.text[mid.cursorCol]).toBe(line[13]);
  });

  it("pasted newlines and tabs become spaces", () => {
    expect(type(emptyEditor(), "SELECT *\nFROM\tproducts").line).toBe("SELECT * FROM  products");
    expect(type(emptyEditor(), "SELECT 1\x04\x1b").line).toBe("SELECT 1");
  });

  it("Enter: statement, continuation, command, or nothing", () => {
    expect(submit(type(emptyEditor(), "   ")).kind).toBe("none");

    const r = submit(type(emptyEditor(), "SELECT * FROM products"));
    expect(r).toMatchObject({ kind: "statement", text: "SELECT * FROM products" });
    expect(r.state.history).toEqual(["SELECT * FROM products"]);

    const cont = submit(type(emptyEditor(), "SELECT name,"));
    expect(cont.kind).toBe("continue");
    expect(cont.state.done).toEqual(["SELECT name,"]);
    // Backspace at the start of a continuation line joins it back.
    const joined = edit(cont.state, { type: "backspace" });
    expect(joined.done).toEqual([]);
    expect(joined.line).toBe("SELECT name,");
    const done = submit(type(cont.state, "price FROM products"));
    expect(done).toMatchObject({ kind: "statement", text: "SELECT name,\nprice FROM products" });
    expect(done.state.history).toEqual(["SELECT name, price FROM products"]);

    expect(submit(type(emptyEditor(), " .goto  5 "))).toMatchObject({
      kind: "command",
      name: "goto",
      arg: "5",
    });
    // A leading dot on a continuation line is DQL, not a command.
    expect(submit(type(cont.state, ".x")).kind).toBe("statement");
  });

  it("history: ↑ recalls, ↓ returns to the draft, duplicates collapse", () => {
    let s = emptyEditor(["SELECT 1", "SELECT 2"]);
    expect(edit(s, { type: "historyNext" })).toBe(s);
    s = type(s, "draft");
    s = edit(s, { type: "historyPrev" });
    expect(s.line).toBe("SELECT 2");
    s = edit(s, { type: "historyPrev" });
    s = edit(s, { type: "historyPrev" }); // clamps at the oldest
    expect(s.line).toBe("SELECT 1");
    s = edit(s, { type: "historyNext" });
    expect(s.line).toBe("SELECT 2");
    s = edit(s, { type: "historyNext" });
    expect(s.line).toBe("draft");
    expect(edit(emptyEditor(), { type: "historyPrev" }).line).toBe("");
    expect(submit(type(emptyEditor(["SELECT 1"]), "SELECT 1")).state.history).toEqual(["SELECT 1"]);
    expect(edit(type(emptyEditor(["x"]), "y"), { type: "clear" })).toEqual(emptyEditor(["x"]));
  });
});

// ─── layout ────────────────────────────────────────────────────────────────

describe("lesson card unwrapping", () => {
  it("joins hard-wrapped lines but keeps blank lines and indented examples", () => {
    const lesson = { ...LESSONS[0]!, concept: "one\ntwo\n\n  { x: 1 }\n\nthree\nfour" };
    const store = createUiStore();
    const runner = new LessonRunner(
      { execute: async () => ({ items: [] }) as never },
      {
        lessons: [lesson],
        io: screenIO(store, () => runner),
      },
    );
    expect(strip(runner.cardBody({ unwrap: true })[0])).toBe("one two\n\n  { x: 1 }\n\nthree four");
  });
});

describe("lesson screen layout helpers", () => {
  it("wrapLines word-wraps and keeps indentation on wrapped rows", () => {
    expect(wrapLines(["one two three four"], 9)).toEqual(["one two", "three", "four"]);
    expect(wrapLines(["  alpha beta gamma"], 10)).toEqual(["  alpha", "  beta", "  gamma"]);
    expect(wrapLines(["a\nb"], 10)).toEqual(["a", "b"]);
    // Drawn lines (tables) are never wrapped; the panel cuts them off.
    expect(wrapLines(["│ a long table row │"], 5)).toEqual(["│ a long table row │"]);
  });

  it("fitCard keeps the task when the card is too tall", () => {
    const body = ["c1", "c2", "c3", "c4"];
    expect(fitCard(body, ["T"], 9, "…")).toEqual([...body, "T"]);
    expect(fitCard(body, ["T"], 4, "…")).toEqual(["c1", "c2", "…", "T"]);
    expect(fitCard(body, ["T1", "T2"], 2, "…")).toEqual(["T1", "…"]);
  });

  it("scrollWindow shows the bottom by default and clamps the offset", () => {
    const lines = ["1", "2", "3", "4", "5"];
    expect(scrollWindow(lines, 2, 0)).toEqual({
      visible: ["4", "5"],
      offset: 0,
      above: 3,
      below: 0,
    });
    expect(scrollWindow(lines, 2, 1).visible).toEqual(["3", "4"]);
    expect(scrollWindow(lines, 2, 99)).toMatchObject({ visible: ["1", "2"], offset: 3, below: 3 });
    expect(scrollWindow(lines, 10, 5)).toMatchObject({ visible: lines, above: 0, below: 0 });
  });

  it("listWindow keeps the selection in view", () => {
    expect(listWindow(5, 10, 3)).toEqual([0, 5]);
    expect(listWindow(30, 10, 0)).toEqual([0, 10]);
    expect(listWindow(30, 10, 15)).toEqual([10, 20]);
    expect(listWindow(30, 10, 29)).toEqual([20, 30]);
  });

  it("progressBar and clip", () => {
    expect(strip(progressBar(1, 2, 4))).toBe("██░░ 1/2");
    expect(strip(progressBar(0, 0, 4))).toBe("░░░░ 0/0");
    expect(clip("short", 10)).toBe("short");
    expect(clip("\x1b[1mlonger text\x1b[22m", 6)).toBe("longe…");
  });
});

describe("help drawer and outline content", () => {
  it("helpLines has the keys, commands, and how-it-works sections, wrapped to width", () => {
    const lines = helpLines(30).map(strip);
    expect(lines).toContain("Keys");
    expect(lines).toContain("Commands");
    expect(lines).toContain("How it works");
    expect(lines.some((l) => l.startsWith("Enter"))).toBe(true);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
    expect(drawerWidth(80)).toBe(30);
    expect(drawerWidth(200)).toBe(40);
  });

  it("outlineLines expands the current level and windows long lists", () => {
    const input = { lessons: LESSONS, current: 12, isCompleted: (i: number) => i < 3 };
    const all = outlineLines(input, 26, 40).map(strip);
    expect(all[0]).toMatch(/^Lessons\s+3\/27$/);
    expect(all).toContainEqual(expect.stringMatching(/^▸ Beginner\s+3\/8$/));
    expect(all).toContainEqual(expect.stringMatching(/^▾ Intermediate\s+0\/10$/));
    expect(all.some((l) => l.includes("▸ 13"))).toBe(true);
    // Long titles wrap under themselves instead of being cut off.
    const advanced = outlineLines({ ...input, current: 20 }, 26, 40).map(strip);
    const at = advanced.findIndex((l) => l.includes("21 Conditions"));
    expect(advanced[at + 1]).toMatch(/^ {7}\S/);
    expect(advanced.join("\n")).toContain("SATISFIES");
    // Too short for all ten intermediate lessons: the list scrolls with "…".
    const short = outlineLines(input, 26, 9).map(strip);
    expect(short.filter((l) => l.trim() === "…").length).toBeGreaterThan(0);
    expect(short.some((l) => l.includes("▸ 13"))).toBe(true);
    expect(outlineWidth(80)).toBe(28);
    expect(outlineWidth(200)).toBe(36);
  });
});

// ─── store + provider ──────────────────────────────────────────────────────

describe("lesson screen store and provider", () => {
  it("store: capped log, total count, lesson version, width, unsubscribe", () => {
    const store = createUiStore({ maxEntries: 2, width: 50 });
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.print("a");
    store.print("b");
    store.print("c");
    store.lessonChanged();
    store.setStatus("✓");
    store.setStatus("✓"); // unchanged: no emit
    expect(store.snapshot()).toEqual({
      log: ["b", "c"],
      lessonVersion: 1,
      printed: 3,
      status: "✓",
    });
    expect(calls).toBe(5);
    store.clear();
    store.clear(); // already empty: no emit
    expect(store.snapshot().log).toEqual([]);
    expect(calls).toBe(6);
    off();
    store.print("d");
    expect(calls).toBe(6);
    expect(store.width()).toBe(50);
    store.setWidth(70);
    expect(store.width()).toBe(70);
  });

  it("track/idle: idle waits for every tracked piece of work, failures included", async () => {
    const store = createUiStore();
    await store.idle(); // nothing tracked
    let done = 0;
    let release: () => void = () => {};
    store.track(
      new Promise<void>((r) => {
        release = r;
      }).then(() => done++),
    );
    store.track(Promise.reject(new Error("ignored")));
    const idle = store.idle().then(() => done * 10);
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(0);
    release();
    expect(await idle).toBe(10);
  });

  it("useTutorial outside the provider throws", async () => {
    function Orphan() {
      useTutorial();
      return null;
    }
    const { app } = mount(createElement(Orphan));
    await expect(app.waitUntilExit()).rejects.toThrow("inside <TutorialProvider>");
  });
});

// ─── the screen ────────────────────────────────────────────────────────────

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** A fake 100×30 TTY: Ink renders frames into `lastFrame`, keys go in via `stdin.write`. */
class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  frame = "";
  write = (s: string, cb?: () => void) => {
    // Cursor show/hide/move writes aren't frames.
    if (strip(s).trim() !== "" || !s.includes("\x1b")) this.frame = s;
    cb?.();
    return true;
  };
}
class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write(data: string) {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  }
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}
const mounted: Instance[] = [];
function mount(tree: ReactElement, rows = 30, columns = 100) {
  const stdout = new FakeStdout();
  stdout.rows = rows;
  stdout.columns = columns;
  const stdin = new FakeStdin();
  const app = render(tree, {
    stdout: stdout as never,
    stderr: new FakeStdout() as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  mounted.push(app);
  return { app, stdin, lastFrame: () => stdout.frame };
}

/** The screen over a fake store: SELECTs on products return the seed rows. */
async function mountScreen(rows = 30, columns = 100) {
  const executed: string[] = [];
  const session: QueryExecutor = {
    execute: async (s: string) => {
      executed.push(s);
      if (/^SELEKT/i.test(s)) throw new Error("syntax error near SELEKT");
      const rows = /FROM products/i.test(s) && /^SELECT/i.test(s) ? SEED_PRODUCTS : [];
      return { items: rows.map((value) => ({ value })) } as never;
    },
  };
  const store = createUiStore({ width: 96 });
  const runner: LessonRunner = new LessonRunner(session, { io: screenIO(store, () => runner) });
  await runner.start();
  const { app, stdin, lastFrame } = mount(
    createElement(TutorialProvider, { runner, store }, createElement(LessonScreen)),
    rows,
    columns,
  );
  const screen = () => strip(lastFrame());
  const press = async (keys: string, ms?: number) => {
    stdin.write(keys);
    await tick(ms);
  };
  await tick();
  return { app, runner, store, screen, press, executed };
}

describe("LessonScreen", () => {
  afterEach(() => {
    for (const app of mounted.splice(0)) app.unmount();
  });

  it("draws the header, the lesson card, the output panel, and the key bar", async () => {
    const { screen } = await mountScreen();
    const s = screen();
    expect(s).toContain("Learn DQL");
    expect(s).toContain(`Lesson 1/${LESSONS.length}`);
    expect(s).toContain("Beginner 1/8");
    expect(s).toContain("Task: Show every document in the products collection.");
    expect(s).toContain("── Lesson 1: Documents and collections ──");
    expect(s).toContain("learn>");
    expect(s).toContain("Enter run · Tab hint");
  });

  it("Enter runs the statement, checks it, and moves to the next lesson", async () => {
    const { screen, press, runner } = await mountScreen();
    for (const ch of "SELECT * FROM products") await press(ch, 1);
    await press("\r", 80);
    const s = screen();
    expect(s).toContain("learn> SELECT * FROM products");
    // The verdict stays in view on the status line, above the prompt.
    expect(s).toMatch(/✓ Correct!.*\n.*learn>/);
    expect(runner.current).toBe(1);
    expect(s).toContain("Lesson 2/");
  });

  it("text and Enter in one chunk still run", async () => {
    const { screen, press } = await mountScreen();
    await press("SELEKT 1\r", 80);
    expect(screen()).toMatch(/Query error.*\n(.*\n)?learn>/);
    // The next statement clears the old verdict.
    await press("SELECT 1\r", 80);
    expect(/\n(.*)\nlearn>/.exec(screen())?.[1]).not.toContain("Query error");
  });

  it("an unfinished statement continues on a | line", async () => {
    const { screen, press, runner } = await mountScreen();
    await press("SELECT *,");
    await press("\r");
    expect(screen()).toMatch(/learn> SELECT \*,\n\s+\|/);
    await press("\x7f"); // backspace joins the lines again
    expect(screen()).toContain("learn> SELECT *,");
    await press("\x1b"); // Esc clears
    await press("SELECT *");
    await press("\r");
    await press(" FROM products");
    await press("\r", 80);
    expect(runner.current).toBe(1);
  });

  it("Tab hints, ? shows the guide, dot-commands work, unknown ones are reported", async () => {
    const { screen, press, runner } = await mountScreen();
    await press("\t");
    expect(screen()).toContain("Hint:");
    await press("?", 120);
    expect(screen()).toContain("Help");
    await press("?", 120); // toggles closed
    await press(".answer\r");
    expect(screen()).toContain("One answer:");
    await press(".bogus\r");
    expect(screen()).toContain("Unknown command .bogus");
    await press(".goto 3\r", 60);
    expect(runner.current).toBe(2);
    await press(".back\r", 60);
    await press(".next\r", 60);
    await press(".level advanced\r", 60);
    expect(runner.info().level).toBe("advanced");
    await press(".reset\r", 60);
    expect(screen()).toContain("Practice data restored.");
    await press(".help\r");
    await press(".break\r");
    expect(screen()).toContain("learn>");
  });

  it("Ctrl+O toggles the whole lesson in a short window", async () => {
    const { screen, press } = await mountScreen(22);
    await press(".goto 21\r", 60); // a long lesson with a 5.2 note
    expect(screen()).toContain("^O shows the whole lesson");
    expect(screen()).toContain("Task:");
    await press("\x0f");
    expect(screen()).not.toContain("^O shows the whole lesson");
    expect(screen()).toContain("Task:");
    await press("\x0f");
    expect(screen()).toContain("^O shows the whole lesson");
  });

  it("each action starts with an empty results panel", async () => {
    const { screen, press, store } = await mountScreen();
    await press(".answer\r");
    expect(screen()).toContain("One answer:");
    await press("SELECT name FROM products\r", 80);
    let s = screen();
    expect(s).not.toContain("One answer:");
    expect(s).toContain("learn> SELECT name FROM products");
    expect(s).toMatch(/✓ Correct!/); // lesson 1 only checks the names
    // A hint replaces the results but keeps the verdict on the status line.
    await press("\t");
    s = screen();
    expect(s).not.toContain("learn> SELECT name FROM products");
    expect(s).toContain("Hint:");
    expect(store.snapshot().status).toContain("Correct");
    // Moving to another lesson clears both.
    await press("\x0e", 60);
    expect(screen()).not.toContain("Hint:");
    expect(store.snapshot().status).toBeNull();
    expect(store.snapshot().log).toHaveLength(1); // just the lesson divider
  });

  it("quitting while a statement runs: the work is tracked so the caller can wait", async () => {
    const { press, store, app, runner } = await mountScreen();
    await press("SELECT * FROM products\r", 0);
    await press("\x04", 0); // Ctrl+D right away
    await app.waitUntilExit();
    await store.idle();
    expect(runner.current).toBe(1); // the check and lesson change completed
  });

  it("long input scrolls sideways; many continuation lines collapse", async () => {
    const { screen, press } = await mountScreen(24, 70);
    await press(`SELECT ${"name, ".repeat(20)}price FROM products`);
    let s = screen();
    expect(s).toMatch(/learn> …[^\n]*price FROM products/);
    await press("\x1b"); // clear
    for (let i = 0; i < 8; i++) {
      await press(`f${i},`);
      await press("\r");
    }
    s = screen();
    expect(s).toMatch(/… \d+ earlier lines/);
    expect(s).toContain("f7,");
    expect(s).not.toContain("f0,");
    expect(s).toContain("Task:"); // the lesson still has room
  });

  it("a chunk with several lines keeps all of them", async () => {
    const { screen, press, runner } = await mountScreen();
    await press("SELECT *\rFROM products\rSELECT 1", 80);
    expect(runner.current).toBe(1); // "SELECT *" + "FROM products" ran as one statement
    expect(screen()).toContain("learn> SELECT 1"); // the rest waits in the editor
  });

  it("PgUp stops at the top, so PgDn responds straight away", async () => {
    const { screen, press } = await mountScreen(24);
    await press("SELECT * FROM products\r", 80);
    for (let i = 0; i < 6; i++) await press("\x1b[6~", 5); // to the bottom
    for (let i = 0; i < 10; i++) await press("\x1b[5~", 5); // far past the top
    const atTop = screen();
    await press("\x1b[6~");
    expect(screen()).not.toBe(atTop);
  });

  it("a window shrunk below the minimum shows a placeholder", async () => {
    const { screen } = await mountScreen(12, 50);
    const s = screen();
    expect(s).toContain("the window is too small");
    expect(s).toContain("now 50×12");
    expect(s).not.toContain("Task:");
  });

  it("Ctrl+N / Ctrl+P move between lessons", async () => {
    const { press, runner } = await mountScreen();
    await press("\x0e", 60);
    expect(runner.current).toBe(1);
    await press("\x10", 60);
    expect(runner.current).toBe(0);
  });

  it("Ctrl+L opens the lesson picker; arrows and Enter jump to a lesson", async () => {
    const { screen, press, runner } = await mountScreen();
    await press("\x0c");
    let s = screen();
    expect(s).toContain("Intermediate");
    expect(s).toContain("↑/↓ choose · Enter open · Esc close");
    await press("\x1b[B");
    await press("\x1b[B");
    await press("\x1b[A");
    await press("\r", 60);
    expect(runner.current).toBe(1);
    await press(".lessons\r");
    await press("\x1b[F"); // End
    await press("\x1b[H"); // Home
    await press("\x1b[6~"); // PgDn
    await press("\x1b[5~"); // PgUp
    await press("\x1b", 60); // Esc closes without moving
    s = screen();
    expect(s).toContain("learn>");
    expect(runner.current).toBe(1);
  });

  it("line editing keys and history", async () => {
    const { screen, press } = await mountScreen();
    await press("SELECT 1");
    await press("\r", 60);
    await press("\x1b[A"); // ↑ recalls
    expect(screen()).toContain("learn> SELECT 1");
    await press("\x1b[B"); // ↓ back to empty
    await press("abc");
    await press("\x1b[D"); // ←
    await press("\x1b[C"); // →
    await press("\x01"); // Ctrl+A
    await press("\x05"); // Ctrl+E
    await press("\x17"); // Ctrl+W
    expect(screen()).not.toContain("learn> abc");
    await press("xyz");
    await press("\x1b[H"); // Home
    await press("\x1b[3~"); // Delete
    await press("\x04"); // Ctrl+D with text = delete
    await press("\x1b[F"); // End
    expect(screen()).toContain("learn> z");
    await press("\x03"); // Ctrl+C with text clears; empty Ctrl+C would quit
    expect(screen()).toMatch(/learn>\s*\n/);
    await press("abc");
    await press("\x15"); // Ctrl+U
    expect(screen()).toMatch(/learn>\s*\n/);
  });

  it("PgUp / PgDn scroll long output, which opens at its top", async () => {
    const { screen, press } = await mountScreen(24);
    await press("SELECT * FROM products\r", 80);
    expect(screen()).toContain("learn> SELECT * FROM products");
    expect(screen()).toMatch(/↓\d+ PgUp\/Dn/);
    for (let i = 0; i < 6; i++) await press("\x1b[6~", 5);
    expect(screen()).not.toMatch(/↓\d+/);
    expect(screen()).toContain("6 rows");
    await press("\x1b[5~");
    expect(screen()).toMatch(/↓\d+/);
  });

  it("? slides the help drawer in on the right; PgUp/PgDn scroll it; Esc closes", async () => {
    const { screen, press, store } = await mountScreen(24);
    await press("?", 150);
    let s = screen();
    expect(s).toMatch(/│ Task:.*│\s*│ \S/); // lesson stays on the left, drawer beside it
    expect(s).toContain(" Help ");
    expect(s).toContain("PgDn more");
    expect(s).toContain("? or Esc close help");
    expect(store.snapshot().log.join("")).not.toContain("Keys"); // not in the results
    for (let i = 0; i < 8; i++) await press("\x1b[6~", 5);
    s = screen();
    expect(s).toContain("Progress is saved as you go.");
    expect(s).toContain("Esc closes");
    await press("\x1b[5~");
    // Typing still goes to the prompt while the drawer is open.
    await press("SEL");
    expect(screen()).toContain("learn> SEL");
    await press("\x1b", 150); // Esc closes the drawer first…
    expect(screen()).not.toContain(" Help ");
    expect(screen()).toContain("learn> SEL");
    await press("\x1b"); // …then clears the input
    expect(screen()).not.toContain("learn> SEL");
    await press(".help\r", 150);
    expect(screen()).toContain(" Help ");
    await press("\x0c"); // the lesson list closes it
    await press("\x1b", 150);
    expect(screen()).not.toContain(" Help ");
  });

  it("Ctrl+T opens the data view with the lesson's collections; .schema too", async () => {
    const { screen, press } = await mountScreen(30, 110);
    expect(screen()).toContain("Collection: products · Ctrl+T shows its fields");
    expect(screen()).toContain("^T data");
    await press("\x14", 200);
    const s = screen();
    expect(s).toContain(" Data ");
    expect(s).toMatch(/products\s+6 documents/);
    expect(s).toContain("details.origin");
    expect(s).toContain("^T or Esc close data");
    await press("?", 150); // switches the drawer to help
    expect(screen()).toContain(" Help ");
    expect(screen()).not.toContain(" Data ");
    await press("\x1b", 150);
    expect(screen()).not.toContain(" Help ");
    await press(".schema\r", 200);
    expect(screen()).toContain(" Data ");
    await press("\x14", 150); // Ctrl+T again closes it
    expect(screen()).not.toContain(" Data ");
  });

  it("the data view shows an error if the collections can't be read", async () => {
    const { screen, press, runner } = await mountScreen(30, 110);
    runner.schema = async () => {
      throw new Error("store closed");
    };
    await press("\x14", 200);
    expect(screen()).toContain("Couldn't read the data: store closed");
  });

  it("the outline sidebar lists the current level's lessons; Ctrl+B toggles it", async () => {
    const { screen, press } = await mountScreen(30, 110);
    let s = screen();
    expect(s).toMatch(/Lessons\s+0\/27/);
    expect(s).toMatch(/▾ Beginner\s+0\/8/);
    expect(s).toContain("▸  1 Documents");
    expect(s).toMatch(/▸ Advanced\s+0\/9/);
    await press("SELECT * FROM products\r", 80);
    s = screen();
    expect(s).toContain("✓  1 Documents");
    expect(s).toMatch(/Lessons\s+1\/27/);
    await press(".goto 20\r", 60);
    expect(screen()).toMatch(/▾ Advanced\s+0\/9/);
    await press("\x02");
    expect(screen()).not.toContain("Lessons ");
    await press("\x02");
    expect(screen()).toContain("Lessons ");
  });

  it("in a narrow window the outline hides and help takes the full width", async () => {
    const { screen, press } = await mountScreen(24, 70);
    expect(screen()).not.toContain("Lessons ");
    await press("?", 200);
    const s = screen();
    expect(s).toContain(" Help ");
    expect(s).not.toContain("Task:");
    await press("\x02"); // Ctrl+B can't fit the outline beside full-width help
    expect(screen()).not.toContain("Lessons ");
  });

  it(".exit, Ctrl+C, and Ctrl+D on an empty line quit", async () => {
    for (const key of [".exit\r", "\x03", "\x04"]) {
      const { app, press } = await mountScreen();
      await press(key);
      await expect(app.waitUntilExit()).resolves.toBeUndefined();
    }
  });
});
