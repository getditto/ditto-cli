import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { CLI_VERSION } from "../../src/cli/version.js";

describe("CLI_VERSION", () => {
  it("matches package.json in dev (tsx) mode", () => {
    expect(CLI_VERSION).toBe(pkg.version);
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
