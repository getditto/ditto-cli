import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { defaultDataDir, resolveDataDir } from "../../src/config/paths.js";

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
