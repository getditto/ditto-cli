import path from "node:path";
import { renderCsv } from "./csv.js";
import { renderTable } from "./table.js";

export type OutputFormat = "table" | "json" | "csv";

/** Resolve the effective output format: explicit flag, else TTY=table / piped=json. */
export function resolveFormat(flag?: string, isTTY: boolean = process.stdout.isTTY): OutputFormat {
  if (flag === "table" || flag === "json" || flag === "csv") return flag;
  return isTTY ? "table" : "json";
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

/** Format for a `-o` file: explicit format wins, else infer from extension. */
export function formatForOutFile(outPath: string, explicit?: OutputFormat): OutputFormat {
  if (explicit) return explicit;
  const ext = path.extname(outPath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".csv") return "csv";
  return "table";
}
