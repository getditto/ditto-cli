/**
 * `ditto dql <stmt>` really means `ditto dql exec <stmt>`.
 *
 * Commander can't put a default action on a command that also has
 * subcommands without same-named options on the parent swallowing the
 * child's flags (observed: `-d`/`--format` consumed by `dql` instead of
 * `dql dataset run`), so we rewrite argv instead.
 *
 * Algorithm (every step regression-tested in tests/unit/default-command.test.ts
 * AND fed through commander in tests/unit/cli-dql.test.ts):
 *  1. Hoist global boolean flags (--no-color/--quiet) to the front.
 *  2. If the first token after the group is a known subcommand or
 *     help/version → untouched.
 *  3. Otherwise scan exec's flags (with their values) to find the first bare
 *     token, which decides subcommand-vs-statement:
 *     - known subcommand → relocate preceding flags AFTER it (after the leaf
 *       for nested groups like `dataset`: `dql -d X dataset list` →
 *       `dql dataset list -d X`)
 *     - flag-like token (dash-leading, no whitespace) → pass through so
 *       commander reports "unknown option" (typo quality)
 *     - statement text (incl. dash-leading text with whitespace, e.g. a
 *       `--` SQL comment) → route to exec with the statement AFTER a `--`
 *       separator at the very end (flags stay flags before it)
 */

/** group → default subcommand + recognized subcommands. */
const DEFAULT_SUBCOMMANDS: Record<string, { exec: string; known: Set<string> }> = {
  dql: {
    exec: "exec",
    known: new Set(["exec", "doctor", "collections", "indexes", "dataset", "help"]),
  },
};

/** Leaf subcommands of `dataset` (flags relocate past the leaf). */
const DATASET_LEAVES = new Set(["list", "show", "load", "run", "reset"]);

/** Global flags that may precede or follow the group token (boolean, no values). */
const GLOBAL_FLAGS = new Set(["--no-color", "--quiet"]);

/** exec's value-taking flags (consume the next token); everything else is boolean or --flag=value. */
const EXEC_VALUE_FLAGS = new Set([
  "-f",
  "--file",
  "-e",
  "--execute",
  "-p",
  "--param",
  "--args",
  "-d",
  "--data-dir",
  "-o",
  "--out",
  "--format",
  "--max-rows",
]);

/** A self-contained `--flag=value` token (value may contain whitespace/quotes). */
const INLINE_VALUE = /^--?[a-zA-Z][\w-]*=/;

export function rewriteDefaultSubcommand(args: string[]): string[] {
  const globals = args.filter((a) => GLOBAL_FLAGS.has(a));
  const rest0 = args.filter((a) => !GLOBAL_FLAGS.has(a));

  const group = rest0[0];
  if (group === undefined || !Object.hasOwn(DEFAULT_SUBCOMMANDS, group)) return args;
  const spec = DEFAULT_SUBCOMMANDS[group]!;
  const tokens = rest0.slice(1);

  if (tokens.length === 0) return [...globals, group, spec.exec]; // bare group → REPL

  const first = tokens[0]!;
  if (
    spec.known.has(first) ||
    first === "-h" ||
    first === "--help" ||
    first === "-V" ||
    first === "--version"
  ) {
    // `dql dataset <flags> <leaf>`: relocate flags sitting between the group
    // and its leaf (the group itself defines no options).
    if (first === "dataset" && tokens.length > 1) {
      const leafIdx = tokens.findIndex((t, i) => i > 0 && DATASET_LEAVES.has(t));
      if (leafIdx > 1) {
        const leaf = tokens[leafIdx]!;
        const between = tokens.slice(1, leafIdx);
        if (between.some((t) => t.startsWith("-"))) {
          return [...globals, group, first, leaf, ...between, ...tokens.slice(leafIdx + 1)];
        }
      }
    }
    return args;
  }

  // Scan for the first BARE token (not a flag or a flag's value).
  let bare: string | undefined;
  let bareIdx = -1;
  let hadSeparator = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--") {
      bare = tokens[i + 1];
      bareIdx = i + 1; // the statement AFTER the separator
      hadSeparator = true;
      break;
    }
    if (EXEC_VALUE_FLAGS.has(t)) {
      i++; // skip its value (even if it happens to match a subcommand name — a file/dir named `doctor` is legitimate)
      continue;
    }
    if (INLINE_VALUE.test(t)) continue; // self-contained --flag=value
    if (t.startsWith("-") && !/\s/.test(t)) continue; // boolean flag
    // dash-leading text WITH whitespace is statement text (e.g. `-- comment`)
    bare = t;
    bareIdx = i;
    break;
  }

  if (bare === undefined) return [...globals, group, spec.exec, ...tokens]; // flags only → exec

  if (spec.known.has(bare)) {
    // `help` takes a topic positional — other flags are meaningless; drop them.
    if (bare === "help") return [...globals, group, bare, ...tokens.slice(bareIdx + 1)];
    const before = tokens.slice(0, bareIdx);
    const after = tokens.slice(bareIdx + 1);
    // Nested group (dataset): relocate flags past the LEAF subcommand. The
    // flags may sit before OR between group and leaf (dataset -d X list).
    if (bare === "dataset") {
      const leafIdx = after.findIndex((t) => DATASET_LEAVES.has(t));
      if (leafIdx >= 0) {
        const leaf = after[leafIdx]!;
        const mid = after.slice(0, leafIdx); // flags between group and leaf
        return [...globals, group, bare, leaf, ...before, ...mid, ...after.slice(leafIdx + 1)];
      }
    }
    return [...globals, group, bare, ...before, ...after];
  }

  // Flag-like unknown token → let commander produce "unknown option".
  if (bare.startsWith("-") && !/\s/.test(bare)) {
    return [...globals, group, spec.exec, ...tokens];
  }

  // Statement: flags keep their positions; a dash-leading statement goes last
  // (after a `--` separator, which must follow ALL flags — everything after
  // `--` is positional).
  const before = tokens.slice(0, bareIdx);
  const after = tokens.slice(bareIdx + 1);
  if (bare.startsWith("-")) {
    const sep = hadSeparator ? [] : ["--"];
    return [...globals, group, spec.exec, ...before, ...after, ...sep, bare];
  }
  return [...globals, group, spec.exec, ...before, bare, ...after];
}
