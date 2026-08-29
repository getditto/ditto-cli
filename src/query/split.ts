/**
 * Split DQL text into individual statements.
 *
 * Statements are separated by `;` outside of string literals ('single',
 * "double") and quoted identifiers (`backtick`). `--` line comments and
 * `/* *​/` block comments are stripped. Empty results are dropped.
 *
 * The Ditto SDK accepts exactly one statement per `execute()` call, with no
 * trailing `;`.
 */
export function splitStatements(input: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed !== "") statements.push(trimmed);
    current = "";
  };

  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];

    // Line comment
    if (ch === "-" && next === "-") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // String / quoted identifier
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      current += ch;
      i++;
      while (i < input.length) {
        const c = input[i]!;
        current += c;
        if (c === quote) {
          // SQL-style doubled quote escape ('' / "" / ``)
          if (input[i + 1] === quote) {
            current += input[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ";") {
      push();
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  push();
  return statements;
}

/** True when the buffered REPL input looks like a complete, executable statement. */
export function isCompleteStatement(buffer: string): boolean {
  const trimmed = buffer.trim();
  if (!trimmed.endsWith(";")) return false;
  return splitStatements(trimmed).length > 0;
}
