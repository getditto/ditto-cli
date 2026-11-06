import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  digest,
  distTag,
  formula,
  inspectArchive,
  PACKAGE,
  registry,
  releaseVersion,
  validateRelease,
  verifyPublished,
} from "../../scripts/release.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-contract-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "releases"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: PACKAGE, version: "1.2.3" }),
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.3" } } }),
  );
  fs.writeFileSync(
    path.join(root, "releases/v1.2.3.md"),
    "# dittosh v1.2.3\n\nThis release adds offline query diagnostics and packaged installations for macOS and Linux.\n",
  );
  return root;
}

describe("release identity and reviewed notes", () => {
  it.each(["v1.2.3", "v1.2.3-rc.1"])("accepts %s", (tag) =>
    expect(releaseVersion(tag)).toBe(tag.slice(1)),
  );
  it.each([
    "main",
    "1.2.3",
    "v01.2.3",
    "v1.2",
    "v1.2.3+build",
    "v1.2.3;echo bad",
    "v1.2.3\nother",
    "v1.2.3-01",
  ])("rejects %s", (tag) => expect(() => releaseVersion(tag)).toThrow());
  it("validates matching package/lock/tag and authored notes", () =>
    expect(validateRelease("v1.2.3", fixture())).toBe("1.2.3"));
  it("rejects package mismatches before publication", () =>
    expect(() => validateRelease("v1.2.4", fixture())).toThrow(/versions must match/));
  it("rejects root lock metadata drift", () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.2" } } }),
    );
    expect(() => validateRelease("v1.2.3", root)).toThrow(/versions must match/);
  });
  it("rejects missing or placeholder notes", () => {
    const root = fixture();
    const notes = path.join(root, "releases/v1.2.3.md");
    fs.appendFileSync(notes, "\nTODO: write notes\n");
    expect(() => validateRelease("v1.2.3", root)).toThrow(/reviewed release notes/);
    fs.unlinkSync(notes);
    expect(() => validateRelease("v1.2.3", root)).toThrow();
  });
});

describe("release promotion and partial-publish recovery", () => {
  it("treats only registry 404 as an unpublished version", async () => {
    const missing = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
    const denied = (() => Promise.resolve(new Response("", { status: 403 }))) as typeof fetch;
    const unavailable = (() => Promise.resolve(new Response("", { status: 503 }))) as typeof fetch;
    expect(await registry("1.2.3", missing)).toBeNull();
    await expect(registry("1.2.3", denied)).rejects.toThrow("403");
    await expect(registry("1.2.3", unavailable)).rejects.toThrow("503");
  });
  it("keeps prereleases off latest", () => expect(distTag("1.3.0-rc.1", "1.2.3")).toBe("next"));
  it("does not move latest backwards on an old tag retry", () =>
    expect(distTag("1.2.3", "1.3.0")).toBe("previous"));
  it("promotes new stable releases", () => {
    expect(distTag("1.3.0", "1.2.3")).toBe("latest");
    expect(distTag("1.2.3", null)).toBe("latest");
  });
  it("accepts only existing packages from the exact tagged commit", () => {
    const pkg = {
      name: PACKAGE,
      version: "1.2.3",
      gitHead: "abc123",
      dist: { tarball: "https://registry.npmjs.org/test.tgz", integrity: "sha512-test" },
    };
    expect(() => verifyPublished(pkg, "1.2.3", "abc123")).not.toThrow();
    expect(() => verifyPublished(pkg, "1.2.3", "def456")).toThrow(/never overwrite/);
    expect(() => verifyPublished({ ...pkg, gitHead: undefined }, "1.2.3", "abc123")).toThrow();
    expect(() => verifyPublished({ ...pkg, name: "wrong-package" }, "1.2.3", "abc123")).toThrow();
  });
});

describe("Homebrew release formula", () => {
  it("uses the exact immutable artifact and supports both macOS and Linux", () => {
    const hash = digest(Buffer.from("release"));
    const source = formula("1.2.3", hash);
    expect(source).toContain('url "https://registry.npmjs.org/@dittolive/cli/-/cli-1.2.3.tgz"');
    expect(source).toContain(`sha256 "${hash}"`);
    expect(source).toContain('depends_on "node@24"');
    expect(source).toContain("on_macos do\n    depends_on arch: :arm64");
    expect(source).toContain("std_npm_args");
    expect(source).toContain("#{HOMEBREW_PREFIX}/bin:$PATH");
    expect(source).toContain("SELECT answer FROM release_smoke");
    expect(source).not.toContain("depends_on :macos");
  });
  it("rejects injected Ruby and malformed source checksums", () => {
    expect(() => formula("1.2.3", "invalid")).toThrow();
    expect(() => formula('1.2.3"', "a".repeat(64))).toThrow();
    expect(() => formula("1.2.3", "a".repeat(64), 'https://example.com/"bad')).toThrow();
  });
});

describe("published archive recovery", () => {
  it("rejects an archive from another commit or missing the built CLI", async () => {
    const root = fixture();
    const pkg = path.join(root, "package");
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: PACKAGE, version: "1.2.3", gitHead: "abc" }),
    );
    fs.writeFileSync(path.join(pkg, "dist/cli.js"), "// built CLI\n");
    const archive = path.join(root, "test.tgz");
    await tar.c({ cwd: root, file: archive, gzip: true }, ["package"]);
    await expect(inspectArchive(archive, "1.2.3", "abc")).resolves.toBeUndefined();
    await expect(inspectArchive(archive, "1.2.3", "different")).rejects.toThrow(/identity/);
    fs.unlinkSync(path.join(pkg, "dist/cli.js"));
    await tar.c({ cwd: root, file: archive, gzip: true }, ["package"]);
    await expect(inspectArchive(archive, "1.2.3", "abc")).rejects.toThrow(/built CLI/);
  });
});
