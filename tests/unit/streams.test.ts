import { beforeEach, describe, expect, it } from "vitest";
import {
  handleStreamError,
  installStdoutGuard,
  onStderrError,
  onStdoutError,
  resetStreamsForTests,
  stderrBroken,
  stdoutBroken,
} from "../../src/cli/streams.js";

describe("stdout guard", () => {
  beforeEach(() => {
    resetStreamsForTests();
    process.exitCode = undefined;
  });

  it("EPIPE marks broken + exit 0 (quiet — the consumer chose to stop reading)", () => {
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    handleStreamError("stdout")(err);
    expect(stdoutBroken()).toBe(true);
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });

  it("installStdoutGuard registers on BOTH stdout and stderr (and removes them after)", () => {
    const outBefore = process.stdout.listenerCount("error");
    const errBefore = process.stderr.listenerCount("error");
    installStdoutGuard();
    expect(process.stdout.listenerCount("error")).toBe(outBefore + 1);
    expect(process.stderr.listenerCount("error")).toBe(errBefore + 1);
    // don't leak listeners into later tests in this worker
    process.stdout.removeListener("error", onStdoutError);
    process.stderr.removeListener("error", onStderrError);
    expect(process.stdout.listenerCount("error")).toBe(outBefore);
    expect(process.stderr.listenerCount("error")).toBe(errBefore);
  });

  it("stderr EPIPE does NOT break the stdout batch loop (round-14 regression)", () => {
    handleStreamError("stderr")(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(stderrBroken()).toBe(true);
    expect(stdoutBroken()).toBe(false);
  });

  it("stdout EPIPE breaks the loop", () => {
    handleStreamError("stdout")(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(stdoutBroken()).toBe(true);
  });

  it("EPIPE does not clobber an already-set failure exit code", () => {
    process.exitCode = 1;
    handleStreamError("stdout")(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("non-EPIPE errors rethrow", () => {
    const err = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    expect(() => handleStreamError("stdout")(err)).toThrow("disk full");
  });
});
