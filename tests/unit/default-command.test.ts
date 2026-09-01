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
      expect(rewriteDefaultSubcommand(["dql", sub, "-d", "/tmp/x"])).toEqual([
        "dql",
        sub,
        "-d",
        "/tmp/x",
      ]);
    }
  });

  it("leaves help/version flags alone", () => {
    expect(rewriteDefaultSubcommand(["dql", "--help"])).toEqual(["dql", "--help"]);
    expect(rewriteDefaultSubcommand(["dql", "-h"])).toEqual(["dql", "-h"]);
  });

  it("routes option-first invocations to exec", () => {
    expect(rewriteDefaultSubcommand(["dql", "-f", "script.dql"])).toEqual([
      "dql",
      "exec",
      "-f",
      "script.dql",
    ]);
    expect(rewriteDefaultSubcommand(["dql", "--max-rows", "5"])).toEqual([
      "dql",
      "exec",
      "--max-rows",
      "5",
    ]);
  });

  it("ignores other groups entirely", () => {
    expect(rewriteDefaultSubcommand(["skills", "add"])).toEqual(["skills", "add"]);
    expect(rewriteDefaultSubcommand([])).toEqual([]);
  });

  it("relocates flags past the dataset LEAF (dql -d X dataset list)", () => {
    expect(rewriteDefaultSubcommand(["dql", "-d", "/tmp/x", "dataset", "list"])).toEqual([
      "dql",
      "dataset",
      "list",
      "-d",
      "/tmp/x",
    ]);
    expect(rewriteDefaultSubcommand(["dql", "--yes", "dataset", "reset", "movies"])).toEqual([
      "dql",
      "dataset",
      "reset",
      "--yes",
      "movies",
    ]);
  });

  it("dql -- <stmt> doesn't duplicate the statement", () => {
    expect(rewriteDefaultSubcommand(["dql", "--", "SELECT 1"])).toEqual([
      "dql",
      "exec",
      "--",
      "SELECT 1",
    ]);
    expect(rewriteDefaultSubcommand(["dql", "-d", "/tmp/x", "--", "SELECT 1"])).toEqual([
      "dql",
      "exec",
      "-d",
      "/tmp/x",
      "--",
      "SELECT 1",
    ]);
  });

  it("--execute=<stmt with spaces> and --args={… with spaces} stay self-contained flags", () => {
    expect(
      rewriteDefaultSubcommand(["dql", "--execute=SELECT * FROM movies LIMIT 1", "-d", "/tmp/x"]),
    ).toEqual(["dql", "exec", "--execute=SELECT * FROM movies LIMIT 1", "-d", "/tmp/x"]);
    expect(rewriteDefaultSubcommand(["dql", '--args={"n": 1}', "SELECT 1"])).toEqual([
      "dql",
      "exec",
      '--args={"n": 1}',
      "SELECT 1",
    ]);
  });

  it("relocates flags between the dataset group and its leaf", () => {
    expect(rewriteDefaultSubcommand(["dql", "dataset", "--format", "csv", "list"])).toEqual([
      "dql",
      "dataset",
      "list",
      "--format",
      "csv",
    ]);
    expect(
      rewriteDefaultSubcommand([
        "dql",
        "dataset",
        "-d",
        "/tmp/x",
        "run",
        "q",
        "--dataset",
        "movies",
      ]),
    ).toEqual(["dql", "dataset", "run", "-d", "/tmp/x", "q", "--dataset", "movies"]);
    // leaf right after the group with no flags between → untouched
    expect(rewriteDefaultSubcommand(["dql", "dataset", "list"])).toEqual([
      "dql",
      "dataset",
      "list",
    ]);
  });

  it("help topic ignores relocated flags (dql -d X help exec)", () => {
    expect(rewriteDefaultSubcommand(["dql", "-d", "/tmp/x", "help", "exec"])).toEqual([
      "dql",
      "help",
      "exec",
    ]);
  });

  it("does not crash on prototype-chain names (ditto constructor)", () => {
    expect(rewriteDefaultSubcommand(["constructor"])).toEqual(["constructor"]);
    expect(rewriteDefaultSubcommand(["toString"])).toEqual(["toString"]);
  });

  it("flag-looking typos go to commander as unknown options (not swallowed as statements)", () => {
    // --explian (typo) has no whitespace → flag-like → commander errors properly
    expect(rewriteDefaultSubcommand(["dql", "--explian", "SELECT 1"])).toEqual([
      "dql",
      "exec",
      "--explian",
      "SELECT 1",
    ]);
    // global flags after the group get hoisted to the front
    expect(rewriteDefaultSubcommand(["dql", "--quiet", "SELECT 1"])).toEqual([
      "--quiet",
      "dql",
      "exec",
      "SELECT 1",
    ]);
    expect(rewriteDefaultSubcommand(["dql", "SELECT 1", "--no-color"])).toEqual([
      "--no-color",
      "dql",
      "exec",
      "SELECT 1",
    ]);
  });

  it("inserts -- before statement text that starts with a dash", () => {
    expect(rewriteDefaultSubcommand(["dql", "-- report\nSELECT 1"])).toEqual([
      "dql",
      "exec",
      "--",
      "-- report\nSELECT 1",
    ]);
    // flags after the statement stay flags (separator goes after them)
    expect(rewriteDefaultSubcommand(["dql", "-- report\nSELECT 1", "-d", "/tmp/x"])).toEqual([
      "dql",
      "exec",
      "-d",
      "/tmp/x",
      "--",
      "-- report\nSELECT 1",
    ]);
    // real exec flags are NOT separated
    expect(rewriteDefaultSubcommand(["dql", "-f", "x.dql"])).toEqual([
      "dql",
      "exec",
      "-f",
      "x.dql",
    ]);
    expect(rewriteDefaultSubcommand(["dql", "--format", "json"])).toEqual([
      "dql",
      "exec",
      "--format",
      "json",
    ]);
  });

  it("exec flags BEFORE a subcommand do not swallow it (dql -d /tmp/x doctor)", () => {
    expect(rewriteDefaultSubcommand(["dql", "-d", "/tmp/x", "doctor"])).toEqual([
      "dql",
      "doctor",
      "-d",
      "/tmp/x",
    ]);
    expect(rewriteDefaultSubcommand(["dql", "-d", "/tmp/x", "dataset", "list"])).toEqual([
      "dql",
      "dataset",
      "list",
      "-d",
      "/tmp/x",
    ]);
    expect(rewriteDefaultSubcommand(["dql", "exec", "SELECT 1"])).toEqual([
      "dql",
      "exec",
      "SELECT 1",
    ]);
    // and a statement after flags still routes to exec with flags intact
    expect(rewriteDefaultSubcommand(["dql", "-d", "/tmp/x", "SELECT * FROM movies"])).toEqual([
      "dql",
      "exec",
      "-d",
      "/tmp/x",
      "SELECT * FROM movies",
    ]);
    expect(rewriteDefaultSubcommand(["dql", "--format", "json", "SELECT 1"])).toEqual([
      "dql",
      "exec",
      "--format",
      "json",
      "SELECT 1",
    ]);
    // dql --help still shows group help
    expect(rewriteDefaultSubcommand(["dql", "--help"])).toEqual(["dql", "--help"]);
  });

  it("handles global flags before the group", () => {
    expect(rewriteDefaultSubcommand(["--no-color", "--quiet", "dql", "SELECT 1"])).toEqual([
      "--no-color",
      "--quiet",
      "dql",
      "exec",
      "SELECT 1",
    ]);
    expect(rewriteDefaultSubcommand(["--quiet", "dql", "doctor"])).toEqual([
      "--quiet",
      "dql",
      "doctor",
    ]);
    // unknown tokens before the group → no rewrite (safe pass-through)
    expect(rewriteDefaultSubcommand(["--verbose", "dql", "SELECT 1"])).toEqual([
      "--verbose",
      "dql",
      "SELECT 1",
    ]);
  });
});
