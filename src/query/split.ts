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
      const commentStart = i;
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      if (i >= input.length) {
        // Unterminated block comment: keep the text verbatim so the SDK can
        // report the syntax error instead of silently swallowing it.
        current += input.slice(commentStart);
        i = input.length;
      } else {
        i += 2;
      }
      continue;
    }
    // String / quoted identifier. DQL uses backslash escapes (\'), NOT SQL
    // doubled quotes ('' is a syntax error in DQL).
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      current += ch;
      i++;
      while (i < input.length) {
        const c = input[i]!;
        if (c === "\\" && quote !== "`") {
          current += c + (input[i + 1] ?? "");
          i += 2;
          continue;
        }
        current += c;
        if (c === quote) {
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
  return splitComplete(buffer).statements.length > 0;
}

/**
 * Split buffered input into complete statements (top-level `;` terminated)
 * and the raw remainder (partial statement and/or trailing comments).
 */
export function splitComplete(input: string): { statements: string[]; rest: string } {
  let lastTerminator = -1;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (ch === "-" && next === "-") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      if (i >= input.length) break; // unterminated block comment
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < input.length) {
        if (input[i] === "\\" && quote !== "`") {
          i += 2;
          continue;
        }
        if (input[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ";") lastTerminator = i;
    i++;
  }
  if (lastTerminator === -1) return { statements: [], rest: input };
  return {
    statements: splitStatements(input.slice(0, lastTerminator + 1)),
    rest: input.slice(lastTerminator + 1),
  };
}

/** True when the text contains nothing but whitespace and comments. */
export function isBlankOrComments(input: string): boolean {
  return splitStatements(input).length === 0;
}

/**
 * Strip string/identifier contents and comments so keyword detection isn't
 * fooled by them (`WHERE title = 'limit 5'`, `-- limit`). Quotes are kept as
 * empty markers, comments become spaces.
 */
export function stripLiteralsAndComments(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (ch === "-" && next === "-") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const i0 = i;
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      if (i >= input.length) {
        out += input.slice(i0); // unterminated — keep raw so the SDK reports it
        break;
      }
      i += 2;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch + ch; // empty literal marker
      i++;
      while (i < input.length) {
        if (input[i] === "\\" && quote !== "`") {
          i += 2;
          continue;
        }
        if (input[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** True when the text ends inside an unterminated string literal (DQL backslash-aware). */
export function endsInsideStringLiteral(input: string): boolean {
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "-" && input[i + 1] === "-") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      let closed = false;
      while (i < input.length) {
        if (input[i] === "\\" && quote !== "`") {
          i += 2;
          continue;
        }
        if (input[i] === quote) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return true;
      continue;
    }
    i++;
  }
  return false;
}

/** True when the statement has a LIMIT clause (string/comment-aware; `:param` binds count). */
export function hasLimitClause(statement: string): boolean {
  return /\blimit\s+(\d+|:\w+)/i.test(stripLiteralsAndComments(statement));
}
