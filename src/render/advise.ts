import chalk from "chalk";
import type { QueryAdvice } from "../query/advise.js";

/** Double-quote a statement for copy-paste into bash/zsh (escape the four "-specials). */
function shellQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

/**
 * Edge Studio's "Index advice" card, rendered for the terminal.
 * `applied` maps suggestion statement → outcome after --apply.
 */
export function renderAdvice(
  advice: QueryAdvice,
  applied?: Map<string, "created" | "failed">,
): string {
  const lines: string[] = [];
  lines.push(chalk.bold("Index advice"));
  if (advice.statement) {
    lines.push(chalk.dim(`  analyzed: ${advice.statement}`));
  }
  lines.push("");

  if (advice.suggestedIndexes.length === 0) {
    lines.push(
      chalk.green("  ✓ no index suggestions") +
        (advice.outcome ? chalk.dim(` — ${advice.outcome}`) : ""),
    );
    return lines.join("\n");
  }

  for (const s of advice.suggestedIndexes) {
    const status = applied?.get(s.statement);
    const badge =
      status === "created"
        ? chalk.green(" ✓ created")
        : status === "failed"
          ? chalk.red(" ✗ failed")
          : "";
    lines.push(
      `  ${chalk.cyan(s.collection)}${s.reason ? chalk.dim(` — ${s.reason}`) : ""}${badge}`,
    );
    lines.push(`    ${chalk.yellow(s.statement)}`);
  }
  if (!applied) {
    lines.push("");
    // The analyzed statement is known — print the literal command so it's copy-pasteable.
    const target = advice.statement ? shellQuote(advice.statement) : '"<statement>"';
    lines.push(
      chalk.dim(`  apply with: dittosh dql --advise --apply ${target} (prompts; -y skips)`),
    );
  }
  return lines.join("\n");
}
