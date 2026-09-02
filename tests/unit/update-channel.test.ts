import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectChannel } from "../../src/update/channel.js";

describe("detectChannel", () => {
  it("homebrew: resolved path under the Cellar", () => {
    const c = detectChannel({
      argv1: "/opt/homebrew/bin/dittosh",
      brewPrefix: "/opt/homebrew",
      npmPrefix: "/usr/local",
    });
    // simulate realpath resolution to the Cellar
    expect(
      detectChannel({
        argv1: "/opt/homebrew/Cellar/dittosh/0.1.0/bin/dittosh",
        brewPrefix: "/opt/homebrew",
        npmPrefix: "/usr/local",
      }).channel,
    ).toBe("homebrew");
    void c;
  });

  it("npm: resolved path under the global node_modules", () => {
    const c = detectChannel({
      argv1: "/usr/local/lib/node_modules/@dittolive/cli/dist/cli.js",
      brewPrefix: "/opt/homebrew",
      npmPrefix: "/usr/local",
    });
    expect(c.channel).toBe("npm");
    expect(c.updateCommand).toBe("npm i -g @dittolive/cli@latest");
  });

  it("npx cache and project-local devDeps are NOT claimed as npm global", () => {
    const npx = detectChannel({
      argv1: "/home/u/.npm/_npx/abc123/node_modules/@dittolive/cli/dist/cli.js",
      brewPrefix: "/opt/homebrew",
      npmPrefix: "/usr/local",
    });
    expect(npx.channel).toBe("unknown"); // running it via npx ≠ installed globally
    const proj = detectChannel({
      argv1: "/work/myapp/node_modules/@dittolive/cli/dist/cli.js",
      brewPrefix: "/opt/homebrew",
      npmPrefix: "/usr/local",
    });
    expect(proj.channel).toBe("unknown");
  });

  it("dev checkout is unknown with no update command", () => {
    const c = detectChannel({
      argv1: path.resolve("src/cli/index.ts"),
      brewPrefix: "/opt/homebrew",
      npmPrefix: "/usr/local",
    });
    expect(c.channel).toBe("unknown");
    expect(c.updateCommand).toBeNull();
    expect(c.detail).toBe("dev checkout");
  });

  it("truly unknown paths are unknown", () => {
    const c = detectChannel({
      argv1: "/opt/custom/bin/dittosh",
      brewPrefix: "/opt/homebrew",
      npmPrefix: "/usr/local",
    });
    expect(c.channel).toBe("unknown");
    expect(c.updateCommand).toBeNull();
  });

  it("missing brew/npm binaries degrade gracefully", () => {
    const c = detectChannel({
      argv1: "/opt/custom/bin/dittosh",
      brewPrefix: undefined,
      npmPrefix: undefined,
    });
    expect(c.channel).toBe("unknown");
  });
});
