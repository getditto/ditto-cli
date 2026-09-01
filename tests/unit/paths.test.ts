import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDataDir, isBogusDataDir, resolveDataDir } from "../../src/config/paths.js";

describe("resolveDataDir precedence", () => {
  it("flag beats env beats default", () => {
    const env = { DITTO_DATA_DIR: "/env/dir" } as NodeJS.ProcessEnv;
    expect(resolveDataDir("/flag/dir", env)).toBe(path.resolve("/flag/dir"));
    expect(resolveDataDir(undefined, env)).toBe(path.resolve("/env/dir"));
    expect(resolveDataDir(undefined, {} as NodeJS.ProcessEnv)).toBe(defaultDataDir());
  });

  it("empty-string flag falls through to env", () => {
    // commander never passes "", but the contract is: undefined means "not provided"
    const env = { DITTO_DATA_DIR: "/env/dir" } as NodeJS.ProcessEnv;
    expect(resolveDataDir(undefined, env)).toBe(path.resolve("/env/dir"));
  });

  it("trims whitespace around the flag/env value", () => {
    expect(resolveDataDir(" /tmp/x ")).toBe(path.resolve("/tmp/x"));
    expect(resolveDataDir(undefined, { DITTO_DATA_DIR: " /tmp/y " } as NodeJS.ProcessEnv)).toBe(
      path.resolve("/tmp/y"),
    );
  });

  it("flags bogus data-dir values (-d --, -d -, -d=--)", () => {
    expect(isBogusDataDir("--")).toBe(true);
    expect(isBogusDataDir("-")).toBe(true);
    expect(isBogusDataDir("=--")).toBe(true);
    expect(isBogusDataDir("/tmp/x")).toBe(false);
    expect(isBogusDataDir(undefined)).toBe(false);
  });

  it("strips commander's short-option = artifact (-d=/tmp/x)", () => {
    expect(resolveDataDir("=/tmp/x")).toBe(path.resolve("/tmp/x"));
  });

  it("empty-string flag AND empty env fall through to default (never cwd)", () => {
    expect(resolveDataDir("", { DITTO_DATA_DIR: "" } as NodeJS.ProcessEnv)).toBe(defaultDataDir());
    expect(resolveDataDir("", {} as NodeJS.ProcessEnv)).toBe(defaultDataDir());
  });

  it("expands a leading tilde to the home directory", () => {
    expect(resolveDataDir("~/mydata", {} as NodeJS.ProcessEnv)).toBe(
      path.join(os.homedir(), "mydata"),
    );
    expect(resolveDataDir("~/deep/nested", {} as NodeJS.ProcessEnv)).toBe(
      path.join(os.homedir(), "deep/nested"),
    );
  });

  it("resolves relative paths against cwd", () => {
    expect(resolveDataDir("./rel", {} as NodeJS.ProcessEnv)).toBe(path.resolve("./rel"));
  });

  it("default is an absolute path containing 'ditto'", () => {
    const def = defaultDataDir();
    expect(path.isAbsolute(def)).toBe(true);
    expect(def.toLowerCase()).toContain("ditto");
    expect(def).not.toContain("~");
  });
});
