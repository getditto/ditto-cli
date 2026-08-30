/**
 * `ditto <group> <stmt>` really means `ditto <group> exec <stmt>`.
 *
 * Commander can't put a default action on a command that also has
 * subcommands without same-named options on the parent swallowing the
 * child's flags (observed: `-d`/`--format` consumed by `dql` instead of
 * `dql dataset run`), so we rewrite argv instead.
 */

/** group → default subcommand. */
const DEFAULT_SUBCOMMANDS: Record<string, { exec: string; known: Set<string> }> = {
  dql: {
    exec: "exec",
    known: new Set(["exec", "doctor", "collections", "indexes", "dataset", "help"]),
  },
};

/** Rewrite user args (already sliced to drop node/script). */
export function rewriteDefaultSubcommand(args: string[]): string[] {
  const [group, next, ...rest] = args;
  if (group === undefined) return args;
  const spec = DEFAULT_SUBCOMMANDS[group];
  if (!spec) return args;
  if (next === undefined) return [group, spec.exec]; // bare `ditto dql` → REPL
  if (spec.known.has(next) || next === "-h" || next === "--help" || next === "-V" || next === "--version") {
    return args;
  }
  return [group, spec.exec, next, ...rest];
}
