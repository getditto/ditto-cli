import { spawnSync } from "node:child_process";

export interface PageOptions {
  /** --no-pager flag. */
  disabled?: boolean;
  /** Default: process.stdout.isTTY. */
  isTTY?: boolean;
  /** Default: process.stdout.rows ?? 24. */
  termRows?: number;
  /** Default: process.env (DITTOSH_NO_PAGER, PAGER). */
  env?: NodeJS.ProcessEnv;
  /** Injected in tests. */
  spawn?: typeof spawnSync;
}

/**
 * Page long output through $PAGER (or `less -SRF`) when stdout is a TTY and
 * the text exceeds the terminal height. Returns true when the pager showed
 * the text (caller skips its own print); false → caller prints directly.
 * Opt-outs: --no-pager, DITTOSH_NO_PAGER=1/true/yes. Platforms without a
 * pager (Windows has no less) fall back to direct printing.
 */
export function pageIfLong(text: string, opts?: PageOptions): boolean {
  const env = opts?.env ?? process.env;
  if (opts?.disabled) return false;
  const noPager = env.DITTOSH_NO_PAGER?.toLowerCase();
  if (noPager === "1" || noPager === "true" || noPager === "yes") return false;
  if (!(opts?.isTTY ?? process.stdout.isTTY)) return false;
  // A 0-row terminal is degenerate (some ptys report 0x0) — treat as unknown.
  const rows = opts?.termRows ?? (process.stdout.rows || 24);
  if (text.split("\n").length <= rows) return false;

  const spawn = opts?.spawn ?? spawnSync;
  const pager = env.PAGER?.trim();
  // $PAGER may embed args ("less -S") → run it through the shell.
  const res = pager
    ? spawn(pager, { input: text, stdio: ["pipe", "inherit", "inherit"], shell: true })
    : spawn("less", ["-SRF"], { input: text, stdio: ["pipe", "inherit", "inherit"] });
  // Spawn failure (no less on this platform) → caller prints. A non-zero
  // pager exit still means the content was shown — don't double-print.
  return !res.error;
}
