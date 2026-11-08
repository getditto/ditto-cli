import chalk from "chalk";
import {
  Box,
  type Key,
  render,
  Text,
  useApp,
  useCursor,
  useInput,
  usePaste,
  useWindowSize,
} from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { splitInput } from "../lesson-eval.js";
import type { Level } from "../lessons.js";
import type { LessonRunner, RunnerIO } from "../runner.js";
import { type CollectionSchema, schemaLines } from "../schema.js";
import {
  CONTINUE,
  Footer,
  Header,
  HelpDrawer,
  InputLine,
  LessonCard,
  LessonPicker,
  OutlinePanel,
  OutputPanel,
  PROMPT,
  StatusLine,
} from "./components.js";
import { TutorialProvider, useTutorial, useTutorialSnapshot } from "./context.js";
import {
  type EditAction,
  type EditorState,
  edit,
  emptyEditor,
  isEditorEmpty,
  submit,
  viewport,
} from "./editor.js";
import { drawerWidth, helpLines } from "./help.js";
import { clip, fitCard, scrollWindow, wrapLines } from "./layout.js";
import { MIN_COLUMNS, MIN_ROWS } from "./limits.js";
import { OUTLINE_MIN_SCREEN, outlineLines, outlineWidth } from "./outline.js";
import { createUiStore, type UiStore } from "./store.js";

/** Continuation lines shown above the prompt; earlier ones collapse into "…". */
const MAX_CONTINUATION_ROWS = 4;
/** Below the card, the output panel keeps at least this many rows. */
const MIN_OUTPUT_ROWS = 5;
/** Narrowest lesson column beside the help drawer. */
const MIN_MAIN_WIDTH = 44;

/** Animate a width toward `target` in a few quick steps (the drawer slide). */
function useSlide(target: number): number {
  const [current, setCurrent] = useState(target);
  useEffect(() => {
    if (current === target) return;
    const timer = setTimeout(() => {
      setCurrent((c) => {
        const step = Math.max(4, Math.ceil(Math.abs(target - c) / 2));
        return c < target ? Math.min(target, c + step) : Math.max(target, c - step);
      });
    }, 16);
    return () => clearTimeout(timer);
  }, [current, target]);
  return current;
}

/**
 * The full-screen lesson view: header, lesson card, output, input, key bar.
 * Reads the runner and store from <TutorialProvider>.
 */
export function LessonScreen() {
  const { runner, store } = useTutorial();
  const { log, lessonVersion, status } = useTutorialSnapshot();
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const { setCursorPosition } = useCursor();

  // A ref mirrors the editor so several keys arriving in one chunk all apply.
  const [editor, setEditor] = useState<EditorState>(() => emptyEditor());
  const editorRef = useRef(editor);
  const update = (fn: (s: EditorState) => EditorState) => {
    editorRef.current = fn(editorRef.current);
    setEditor(editorRef.current);
  };
  const [busy, setBusy] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [picker, setPicker] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  /** The right-hand drawer: help (?) or the data view (Ctrl+T). */
  const [panel, setPanel] = useState<"help" | "data" | null>(null);
  const helpOpen = panel !== null;
  const [helpScroll, setHelpScroll] = useState(0);
  const [schemas, setSchemas] = useState<CollectionSchema[] | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  /** null = automatic (shown when the window is wide enough); Ctrl+B overrides. */
  const [outlinePref, setOutlinePref] = useState<boolean | null>(null);

  // ── layout ──────────────────────────────────────────────────────────────
  // Below the minimum (the window shrank after start) a placeholder is drawn
  // instead; these clamps only keep the layout maths sane meanwhile.
  const tooSmall = columns < MIN_COLUMNS || rows < MIN_ROWS;
  const width = Math.max(MIN_COLUMNS, columns);
  const height = Math.max(MIN_ROWS, rows);
  // Left: the lesson outline (when there's room). Right: the help drawer,
  // which slides in; in a narrow window it takes the whole width instead of
  // squeezing the lesson below a readable size.
  const panelWidth = drawerWidth(width, panel === "data" ? "data" : "help");
  const drawerTarget = helpOpen ? (width - panelWidth >= MIN_MAIN_WIDTH ? panelWidth : width) : 0;
  const drawer = useSlide(drawerTarget);
  const showMain = width - drawer >= MIN_MAIN_WIDTH;
  const outlineWanted = outlinePref ?? width >= OUTLINE_MIN_SCREEN;
  const sidebarWidth = outlineWidth(width);
  const showOutline = outlineWanted && showMain && width - drawer - sidebarWidth >= MIN_MAIN_WIDTH;
  const mainWidth = Math.max(MIN_MAIN_WIDTH, width - drawer - (showOutline ? sidebarWidth : 0));
  const inner = mainWidth - 4; // border + one column of padding on each side
  store.setWidth(inner);
  // biome-ignore lint/correctness/useExhaustiveDependencies: lessonVersion marks a lesson change
  const card = useMemo(() => {
    const lines = runner.cardBody({ unwrap: true });
    // The task and the data tip stay visible however short the window is.
    return {
      body: wrapLines(lines.slice(0, -1), inner),
      task: wrapLines([...lines.slice(-1), runner.dataTip("Ctrl+T")], inner),
    };
  }, [runner, inner, lessonVersion]);
  const cardHeight = card.body.length + card.task.length;
  // A long multi-line statement shows only its last few lines, so the
  // lesson and results always keep their space.
  const maxDone = Math.max(0, Math.min(MAX_CONTINUATION_ROWS, height - 16));
  const doneShown = maxDone === 0 ? [] : editor.done.slice(-maxDone);
  const doneHidden = editor.done.length - doneShown.length;
  const inputRows = doneShown.length + (doneHidden > 0 ? 1 : 0) + 1;
  const statusLines = useMemo(() => {
    if (!status) return [];
    const rows = wrapLines([status], width - 2);
    return rows.length > 2 ? [rows[0]!, clip(rows.slice(1).join(" "), width - 2)] : rows;
  }, [status, width]);
  const body = height - 2 - inputRows - statusLines.length; // minus header, footer, status
  const minOutput = expanded ? 1 : MIN_OUTPUT_ROWS;
  const cardRows = Math.max(1, Math.min(cardHeight, body - 4 - minOutput));
  const cardLines = fitCard(
    card.body,
    card.task,
    cardRows,
    chalk.dim(
      expanded ? "… (the window is too short for the whole lesson)" : "… ^O shows the whole lesson",
    ),
  );
  const outputRows = Math.max(1, body - (cardRows + 2) - 2);
  const outputLines = useMemo(() => wrapLines(log, inner), [log, inner]);
  const helpWidth = Math.max(10, (drawerTarget || drawer) - 4);
  const help = useMemo(() => {
    if (panel !== "data") return helpLines(helpWidth);
    if (schemaError) return [chalk.red(schemaError)];
    if (!schemas) return [chalk.dim("Reading the collections…")];
    return [
      ...schemaLines(schemas, helpWidth),
      "",
      ...wrapLines(
        [
          chalk.dim(
            `Names are case-sensitive: ${chalk.cyan("products")} and ${chalk.cyan("Products")} are different collections.`,
          ),
        ],
        helpWidth,
      ),
    ];
  }, [helpWidth, panel, schemas, schemaError]);

  // The data view reads the live collections: on opening, on a lesson change,
  // and after each statement (an INSERT shows up straight away).
  // biome-ignore lint/correctness/useExhaustiveDependencies: lessonVersion/log mark data changes
  useEffect(() => {
    if (panel !== "data") return;
    let live = true;
    const read = runner.schema();
    store.track(read);
    read
      .then((s) => {
        if (!live) return;
        setSchemas(s);
        setSchemaError(null);
      })
      .catch((err: unknown) => {
        if (live) setSchemaError(`Couldn't read the data: ${(err as Error).message}`);
      });
    return () => {
      live = false;
    };
  }, [panel, runner, lessonVersion, log]);
  const helpRows = body - 2;
  // biome-ignore lint/correctness/useExhaustiveDependencies: lessonVersion/log mark progress changes
  const outline = useMemo(
    () =>
      showOutline
        ? outlineLines(
            {
              lessons: runner.lessons,
              current: runner.current,
              isCompleted: (i) => runner.isCompleted(i),
            },
            sidebarWidth - 4,
            body - 2,
          )
        : [],
    [showOutline, runner, body, lessonVersion, log, sidebarWidth],
  );
  const helpMax = Math.max(0, help.length - (helpRows - 1));

  // The panel holds only the latest action's output, so new output opens at
  // its top (a long table or the guide reads from the start). PgUp/PgDn hold
  // until the next output arrives.
  const seenLog = useRef(log);
  if (log !== seenLog.current) {
    seenLog.current = log;
    const top = Math.max(0, outputLines.length - outputRows);
    if (scroll !== top) setScroll(top);
  }
  const out = scrollWindow(outputLines, outputRows, scroll);
  const page = Math.max(1, outputRows - 1);

  // ── actions ─────────────────────────────────────────────────────────────
  // busyRef answers "is something running?" synchronously (state lags a render).
  const busyRef = useRef(false);
  const run = (task: () => unknown) => {
    busyRef.current = true;
    setBusy(true);
    const work = Promise.resolve()
      .then(task)
      .catch((err: unknown) =>
        store.print(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`)),
      )
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
    // Quitting waits for this before the session closes (runLessonScreen).
    store.track(work);
  };
  /**
   * Each action starts with an empty results panel. Hints, answers, and help
   * keep the ✓/✗ status (it's still about the current task); statements and
   * lesson changes clear it.
   */
  const fresh = (opts: { keepStatus?: boolean } = {}) => {
    store.clear();
    if (!opts.keepStatus) store.setStatus(null);
  };
  /** Open, switch, or close the right-hand drawer. */
  const togglePanel = (which: "help" | "data", open = panel !== which) => {
    setPanel(open ? which : null);
    if (open) setHelpScroll(0);
  };
  const toggleHelp = (open?: boolean) => togglePanel("help", open);
  const hint = () => {
    fresh({ keepStatus: true });
    runner.hint();
  };
  const move = (task: () => Promise<void>) => {
    fresh();
    run(task);
  };

  const command = (name: string, arg: string) => {
    switch (name) {
      case "hint":
        return hint();
      case "answer":
        fresh({ keepStatus: true });
        return runner.answer();
      case "next":
        return move(() => runner.next());
      case "back":
        return move(() => runner.back());
      case "goto":
        return move(() => runner.goto(arg));
      case "level":
        return move(() => runner.level(arg));
      case "reset":
        return move(() => runner.reset());
      case "lessons":
        toggleHelp(false);
        return setPicker(runner.current);
      case "help":
        return toggleHelp(true);
      case "schema":
      case "data":
        return togglePanel("data", true);
      case "break":
      case "clear":
        return;
      case "exit":
      case "quit":
        return exit();
      default:
        fresh({ keepStatus: true });
        store.print(chalk.yellow(`Unknown command .${name} — type .help for the list.`));
    }
  };

  const onEnter = () => {
    const r = submit(editorRef.current);
    update(() => r.state);
    if (r.kind === "command") command(r.name, r.arg);
    else if (r.kind === "statement") {
      fresh();
      store.print(`${chalk.cyan(PROMPT)}${r.text.replace(/\n/g, `\n${CONTINUE}`)}`);
      run(async () => {
        for (const s of splitInput(r.text)) await runner.submit(s);
      });
    }
  };

  const onPickerKey = (input: string, key: Key, sel: number) => {
    const last = runner.lessons.length - 1;
    if (key.escape || input === "q" || (key.ctrl && input === "l")) setPicker(null);
    else if (key.upArrow) setPicker(Math.max(0, sel - 1));
    else if (key.downArrow) setPicker(Math.min(last, sel + 1));
    else if (key.pageUp) setPicker(Math.max(0, sel - 10));
    else if (key.pageDown) setPicker(Math.min(last, sel + 10));
    else if (key.home) setPicker(0);
    else if (key.end) setPicker(last);
    else if (key.return) {
      setPicker(null);
      move(() => runner.goto(String(sel + 1)));
    }
  };

  useInput((input, key) => {
    if (picker !== null) return onPickerKey(input, key, picker);
    const empty = isEditorEmpty(editorRef.current);
    const apply = (a: EditAction) => update((s) => edit(s, a));
    if (key.ctrl && input === "c") return empty ? exit() : apply({ type: "clear" });
    if (key.ctrl && input === "d") return empty ? exit() : apply({ type: "delete" });
    if (key.return) return busy ? undefined : onEnter();
    if (key.tab) return hint();
    const helpPage = Math.max(1, helpRows - 3);
    if (helpOpen && key.pageUp) return setHelpScroll((s) => Math.max(0, s - helpPage));
    if (helpOpen && key.pageDown) return setHelpScroll((s) => Math.min(helpMax, s + helpPage));
    if (key.pageUp) {
      const top = Math.max(0, outputLines.length - outputRows);
      return setScroll((s) => Math.min(top, s + page));
    }
    if (key.pageDown) return setScroll((s) => Math.max(0, s - page));
    if (key.escape) return helpOpen ? toggleHelp(false) : apply({ type: "clear" });
    if (key.upArrow) return apply({ type: "historyPrev" });
    if (key.downArrow) return apply({ type: "historyNext" });
    if (key.leftArrow) return apply({ type: "left" });
    if (key.rightArrow) return apply({ type: "right" });
    if (key.home) return apply({ type: "home" });
    if (key.end) return apply({ type: "end" });
    if (key.backspace) return apply({ type: "backspace" });
    if (key.delete) return apply({ type: "delete" });
    if (key.ctrl) {
      if (input === "a") return apply({ type: "home" });
      if (input === "e") return apply({ type: "end" });
      if (input === "u") return apply({ type: "killLine" });
      if (input === "w") return apply({ type: "killWord" });
      if (busy) return;
      if (input === "n") return move(() => runner.next());
      if (input === "p") return move(() => runner.back());
      if (input === "l") {
        toggleHelp(false);
        return setPicker(runner.current);
      }
      if (input === "o") return setExpanded((x) => !x);
      if (input === "t") return togglePanel("data");
      if (input === "b") return setOutlinePref(!outlineWanted);
      return;
    }
    if (key.meta) return;
    if (input === "?" && empty) return toggleHelp();
    // Text and Enter in one chunk (fast typing, or a paste without bracketed
    // paste): type the text, then press Enter.
    // Every line is kept: each newline presses Enter, and once a statement is
    // running the rest stays in the editor for the next Enter.
    const parts = input.split(/\r\n|\r|\n/);
    for (const [i, part] of parts.entries()) {
      if (part) apply({ type: "insert", text: part });
      if (i === parts.length - 1) break;
      if (busyRef.current) apply({ type: "insert", text: " " });
      else onEnter();
    }
  });
  usePaste((text) => update((s) => edit(s, { type: "insert", text })), {
    isActive: picker === null,
  });

  // The real terminal cursor sits at the insertion point; long lines scroll
  // sideways so it stays in view.
  const promptWidth = stringWidth(PROMPT);
  const view = viewport(editor.line, editor.cursor, width - promptWidth);
  const cursorX = promptWidth + view.cursorCol;
  const cursorY = height - 2;
  setCursorPosition(picker === null && !busy && !tooSmall ? { x: cursorX, y: cursorY } : undefined);

  if (tooSmall) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Text wrap="wrap">
          {chalk.bold("Learn DQL")} — the window is too small. Make it at least {MIN_COLUMNS}×
          {MIN_ROWS} (now {columns}×{rows}), or press Ctrl+D to quit; progress is saved.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header width={width} />
      {picker === null ? (
        <Box flexDirection="row" height={body}>
          {showOutline && <OutlinePanel lines={outline} rows={body - 2} width={sidebarWidth} />}
          {showMain && (
            <Box flexDirection="column" width={mainWidth}>
              <LessonCard lines={cardLines} rows={cardRows} />
              <OutputPanel lines={out.visible} rows={outputRows} />
            </Box>
          )}
          {drawer > 0 && (
            <HelpDrawer
              title={panel === "data" ? "Data" : "Help"}
              lines={help}
              rows={helpRows}
              width={showMain ? drawer : width}
              scroll={Math.min(helpScroll, helpMax)}
              more={helpScroll < helpMax}
            />
          )}
        </Box>
      ) : (
        <LessonPicker selected={picker} rows={body - 2} width={width - 4} />
      )}
      <StatusLine lines={statusLines} />
      <InputLine
        done={doneShown}
        hidden={doneHidden}
        line={view.text}
        empty={isEditorEmpty(editor)}
        busy={busy}
      />
      <Footer
        mode={picker !== null ? "picker" : (panel ?? "lesson")}
        above={picker === null && !helpOpen ? out.above : 0}
        below={picker === null && !helpOpen ? out.below : 0}
        width={width}
      />
    </Box>
  );
}

/** Runner IO for the screen: prints go to the store's log; the screen draws the card. */
export function screenIO(store: UiStore, runner: () => LessonRunner): RunnerIO {
  return {
    print: store.print,
    width: store.width,
    onVerdict: store.setStatus,
    onLesson: () => {
      const r = runner();
      store.lessonChanged();
      store.print(chalk.dim(`── Lesson ${r.current + 1}: ${r.info().title} ──`));
    },
  };
}

/**
 * Full-screen lessons in the alternate screen buffer (like `less` or `vim`):
 * the terminal's contents come back on exit. Resolves when the user quits.
 */
export async function runLessonScreen(
  makeRunner: (io: RunnerIO) => LessonRunner,
  opts: { level?: Level } = {},
): Promise<LessonRunner> {
  const store = createUiStore({ width: Math.max(MIN_COLUMNS, process.stdout.columns ?? 80) - 4 });
  const runner: LessonRunner = makeRunner(screenIO(store, () => runner));
  await runner.start(opts);
  const instance = render(
    <TutorialProvider runner={runner} store={store}>
      <LessonScreen />
    </TutorialProvider>,
    { alternateScreen: true, exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  // Let a statement or lesson change that was running finish before the
  // caller closes the session.
  await store.idle();
  return runner;
}
