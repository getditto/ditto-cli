import path from "node:path";
import { renderCsv } from "./csv.js";
import { renderTable } from "./table.js";

export type OutputFormat = "table" | "json" | "csv";

export class FormatError extends Error {
  readonly exitCode = 2;
  constructor(flag: string) {
    super(`--format must be one of table, json, csv — got "${flag}"`);
    this.name = "FormatError";
  }
}

/** Validate an explicit --format flag (usage error) or fall back to TTY/piped default. */
export function resolveFormat(
  flag: string | undefined,
  isTTY: boolean = process.stdout.isTTY,
): OutputFormat {
  if (flag === undefined) return isTTY ? "table" : "json";
  if (flag === "table" || flag === "json" || flag === "csv") return flag;
  throw new FormatError(flag);
}

export function renderRows(rows: Record<string, unknown>[], format: OutputFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(rows, null, 2);
    case "csv":
      return renderCsv(rows);
    case "table":
      return renderTable(rows);
  }
}

/** Format for a `-o` file: validated explicit format wins, else infer from extension. */
export function formatForOutFile(outPath: string, explicit?: string): OutputFormat {
  if (explicit) return resolveFormat(explicit);
  const ext = path.extname(outPath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".csv") return "csv";
  return "table";
}
