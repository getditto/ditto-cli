import { looksUnfinished } from "../lesson-eval.js";

/**
 * The lesson screen's input line: a small line editor with history and
 * multi-line continuation. Pure state transitions, so it is unit testable
 * without a terminal.
 */
export interface EditorState {
  /** Earlier lines of an unfinished statement (shown on `|` prompts). */
  done: string[];
  line: string;
  /** Cursor position within `line` (code-unit index). */
  cursor: number;
  history: string[];
  /** Index into history while browsing it; -1 when editing a fresh line. */
  hIndex: number;
  /** The line being edited before history browsing started. */
  draft: string;
}

export type EditAction =
  | { type: "insert"; text: string }
  | {
      type:
        | "left"
        | "right"
        | "home"
        | "end"
        | "backspace"
        | "delete"
        | "killLine"
        | "killWord"
        | "historyPrev"
        | "historyNext"
        | "clear";
    };

const HISTORY_MAX = 200;

export function emptyEditor(history: string[] = []): EditorState {
  return { done: [], line: "", cursor: 0, history, hIndex: -1, draft: "" };
}

export function isEditorEmpty(s: EditorState): boolean {
  return s.done.length === 0 && s.line === "";
}

function setLine(s: EditorState, line: string, cursor = line.length): EditorState {
  return { ...s, line, cursor: Math.max(0, Math.min(cursor, line.length)) };
}

export function edit(s: EditorState, a: EditAction): EditorState {
  const { line, cursor } = s;
  switch (a.type) {
    case "insert": {
      // Pasted newlines become spaces: the statement stays on the current line.
      const text = a.text.replace(/\r\n?|\n/g, " ").replace(/\t/g, "  ");
      return setLine(s, line.slice(0, cursor) + text + line.slice(cursor), cursor + text.length);
    }
    case "left":
      return setLine(s, line, cursor - 1);
    case "right":
      return setLine(s, line, cursor + 1);
    case "home":
      return setLine(s, line, 0);
    case "end":
      return setLine(s, line);
    case "backspace":
      if (cursor === 0) {
        // Join back onto the previous continuation line.
        if (s.done.length === 0) return s;
        const prev = s.done[s.done.length - 1]!;
        return { ...setLine(s, prev + line, prev.length), done: s.done.slice(0, -1) };
      }
      return setLine(s, line.slice(0, cursor - 1) + line.slice(cursor), cursor - 1);
    case "delete":
      return setLine(s, line.slice(0, cursor) + line.slice(cursor + 1), cursor);
    case "killLine":
      return setLine(s, line.slice(cursor), 0);
    case "killWord": {
      const before = line.slice(0, cursor).replace(/\S+\s*$/, "");
      return setLine(s, before + line.slice(cursor), before.length);
    }
    case "historyPrev": {
      if (s.history.length === 0) return s;
      const hIndex = s.hIndex === -1 ? s.history.length - 1 : Math.max(0, s.hIndex - 1);
      const draft = s.hIndex === -1 ? line : s.draft;
      return { ...setLine(s, s.history[hIndex]!), hIndex, draft };
    }
    case "historyNext": {
      if (s.hIndex === -1) return s;
      const hIndex = s.hIndex + 1;
      if (hIndex >= s.history.length) return { ...setLine(s, s.draft), hIndex: -1, draft: "" };
      return { ...setLine(s, s.history[hIndex]!), hIndex };
    }
    case "clear":
      return emptyEditor(s.history);
  }
}

export type SubmitResult =
  | { kind: "none"; state: EditorState }
  | { kind: "continue"; state: EditorState }
  | { kind: "command"; name: string; arg: string; state: EditorState }
  | { kind: "statement"; text: string; state: EditorState };

function remember(history: string[], entry: string): string[] {
  const flat = entry.replace(/\s*\n\s*/g, " ").trim();
  if (!flat || history[history.length - 1] === flat) return history;
  return [...history, flat].slice(-HISTORY_MAX);
}

/**
 * Enter: a dot-command, a statement to run, or — when the text looks
 * unfinished (open quote/bracket, trailing comma/operator/keyword) — a new
 * continuation line.
 */
export function submit(s: EditorState): SubmitResult {
  const text = [...s.done, s.line].join("\n");
  if (text.trim() === "") return { kind: "none", state: emptyEditor(s.history) };
  if (s.done.length === 0) {
    const m = /^\s*\.(\w+)\s*(.*)$/.exec(s.line);
    if (m) {
      return {
        kind: "command",
        name: m[1]!.toLowerCase(),
        arg: m[2]!.trim(),
        state: emptyEditor(remember(s.history, s.line)),
      };
    }
  }
  if (looksUnfinished(text)) {
    return { kind: "continue", state: { ...s, done: [...s.done, s.line], line: "", cursor: 0 } };
  }
  return { kind: "statement", text, state: emptyEditor(remember(s.history, text)) };
}
