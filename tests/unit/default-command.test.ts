import { describe, expect, it } from "vitest";
import { rewriteDefaultSubcommand } from "../../src/cli/default-command.js";

describe("rewriteDefaultSubcommand", () => {
  it("routes `dql <statement>` to exec", () => {
    expect(rewriteDefaultSubcommand(["dql", "SELECT * FROM movies"])).toEqual([
      "dql",
      "exec",
      "SELECT * FROM movies",
    ]);
  });

  it("routes `dql <statement> <flags>` to exec preserving order", () => {
    expect(rewriteDefaultSubcommand(["dql", "SELECT 1", "--format", "json"])).toEqual([
      "dql",
      "exec",
      "SELECT 1",
      "--format",
      "json",
    ]);
  });

  it("bare `dql` becomes `dql exec` (REPL)", () => {
    expect(rewriteDefaultSubcommand(["dql"])).toEqual(["dql", "exec"]);
  });

  it("leaves known subcommands alone", () => {
    for (const sub of ["exec", "doctor", "collections", "indexes", "dataset"]) {
      expect(rewriteDefaultSubcommand(["dql", sub, "-d", "/tmp/x"])).toEqual(["dql", sub, "-d", "/tmp/x"]);
    }
  });

  it("leaves help/version flags alone", () => {
    expect(rewriteDefaultSubcommand(["dql", "--help"])).toEqual(["dql", "--help"]);
    expect(rewriteDefaultSubcommand(["dql", "-h"])).toEqual(["dql", "-h"]);
  });

  it("routes option-first invocations to exec", () => {
    expect(rewriteDefaultSubcommand(["dql", "-f", "script.dql"])).toEqual(["dql", "exec", "-f", "script.dql"]);
    expect(rewriteDefaultSubcommand(["dql", "--max-rows", "5"])).toEqual(["dql", "exec", "--max-rows", "5"]);
  });

  it("ignores other groups entirely", () => {
    expect(rewriteDefaultSubcommand(["skills", "add"])).toEqual(["skills", "add"]);
    expect(rewriteDefaultSubcommand([])).toEqual([]);
  });
});
