import path from "node:path";
import { renderCsv } from "./csv.js";
import { renderHtml } from "./html.js";
import { renderMarkdown } from "./markdown.js";
import { renderTable } from "./table.js";
import { renderVertical } from "./vertical.js";

export type OutputFormat = "table" | "json" | "csv" | "markdown" | "html" | "vertical";

const ALL_FORMATS: OutputFormat[] = ["table", "json", "csv", "markdown", "html", "vertical"];

export class FormatError extends Error {
  readonly exitCode = 2;
  constructor(flag: string) {
    super(`--format must be one of ${ALL_FORMATS.join(", ")} — got "${flag}"`);
    this.name = "FormatError";
  }
}

/** Validate an explicit --format flag (usage error) or fall back to TTY/piped default. */
export function resolveFormat(
  flag: string | undefined,
  isTTY: boolean = process.stdout.isTTY,
): OutputFormat {
  if (flag === undefined) return isTTY ? "table" : "json";
  if ((ALL_FORMATS as string[]).includes(flag)) return flag as OutputFormat;
  throw new FormatError(flag);
}

export interface RenderOptions {
  /** Terminal columns, for table fitting. Undefined = never truncate (files/pipes). */
  maxWidth?: number;
}

export function renderRows(
  rows: Record<string, unknown>[],
  format: OutputFormat,
  opts?: RenderOptions,
): string {
  switch (format) {
    case "json":
      return JSON.stringify(rows, null, 2);
    case "csv":
      return renderCsv(rows);
    case "markdown":
      return renderMarkdown(rows);
    case "html":
      return renderHtml(rows);
    case "vertical":
      return renderVertical(rows);
    case "table":
      return renderTable(rows, { maxWidth: opts?.maxWidth });
  }
}

/** Format for a `-o` file: validated explicit format wins, else infer from extension. */
export function formatForOutFile(outPath: string, explicit?: string): OutputFormat {
  if (explicit) return resolveFormat(explicit);
  const ext = path.extname(outPath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".csv") return "csv";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".html" || ext === ".htm") return "html";
  return "table";
}
