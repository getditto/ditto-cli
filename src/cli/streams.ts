/**
 * Batch/multi-write flows keep the event loop alive across stream writes —
 * when a reader dies early (`| head -1`), the next write throws EPIPE with
 * an uncaught node-internals dump. Guard BOTH stdout and stderr, tracked
 * SEPARATELY: a dead stderr costs the notes; a dead stdout ends results —
 * the batch loop only breaks on the latter.
 */
let outBroken = false;
let errBroken = false;

/** EPIPE → mark the affected stream broken + exit 0 quietly (unless a failure code is already set); anything else rethrows. */
export function handleStreamError(stream: "stdout" | "stderr") {
  return (err: NodeJS.ErrnoException): void => {
    if (err.code === "EPIPE") {
      if (stream === "stdout") outBroken = true;
      else errBroken = true;
      // Don't clobber an already-set failure code.
      if (process.exitCode === undefined) process.exitCode = 0;
      return;
    }
    throw err;
  };
}

/** Stable handler references (removeListener needs the same identity). */
export const onStdoutError = handleStreamError("stdout");
export const onStderrError = handleStreamError("stderr");

export function installStdoutGuard(): void {
  process.stdout.on("error", onStdoutError);
  process.stderr.on("error", onStderrError);
}

/** True once stdout has EPIPEd — batch loops check this to stop early. */
export function stdoutBroken(): boolean {
  return outBroken;
}

/** True once stderr has EPIPEd. */
export function stderrBroken(): boolean {
  return errBroken;
}

/** Test-only: reset the broken flags. */
export function resetStreamsForTests(): void {
  outBroken = false;
  errBroken = false;
}
