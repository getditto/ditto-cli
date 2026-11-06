/** Install the actual release artifact outside the checkout, including its native SDK. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { digest, formula, releaseVersion } from "./release.js";

export async function smoke(mode: string, tag: string, native = true): Promise<void> {
  const version = releaseVersion(tag);
  const archive = path.resolve(`build/release/dittolive-cli-${version}.tgz`);
  const checksum = digest(fs.readFileSync(archive));
  assert.equal(
    fs.readFileSync("build/release/SHA256SUMS", "utf8"),
    `${checksum}  ${path.basename(archive)}\n`,
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dittosh-release-test-"));
  const env = {
    ...process.env,
    DITTOSH_NO_UPDATE_CHECK: "1",
    DITTOSH_CONFIG_DIR: path.join(temp, "config"),
    DITTOSH_DATA_DIR: path.join(temp, "store"),
    npm_config_prefix: temp,
  };
  // Published builds must work with no development credentials available.
  for (const key of [
    "OFFLINE_TOKEN",
    "DATABASE_ID",
    "DITTO_APP_ID",
    "DQL_OFFLINE_LICENSE",
    "NO_COLOR",
  ])
    delete env[key as keyof typeof env];
  try {
    if (mode === "npm") {
      await execa(
        "npm",
        [
          "install",
          "--global",
          "--prefix",
          temp,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          archive,
        ],
        { env },
      );
      const cli = path.join(temp, process.platform === "win32" ? "dittosh.cmd" : "bin/dittosh");
      const run = (args: string[]) => execa(cli, args, { env, cwd: temp });
      assert.equal((await run(["--version"])).stdout, version);
      const info = JSON.parse((await run(["version", "--format", "json"])).stdout);
      assert.equal(info.channel, "npm global");
      assert.notEqual(info.token_expires, "unavailable");
      if (native) {
        await run(["dql", "INSERT INTO release_smoke DOCUMENTS ({'_id': 'ok', 'answer': 1})"]);
        assert.equal(
          JSON.parse((await run(["dql", "SELECT answer FROM release_smoke"])).stdout)[0].answer,
          1,
        );
      }
      console.log(
        `npm install and ${native ? "offline DQL" : "version"} passed on ${process.platform}/${process.arch}`,
      );
    } else if (mode === "homebrew") {
      assert(native, "Homebrew smoke testing requires a real release license");
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        fs.createReadStream(archive).pipe(response);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const tap = "getditto/release-smoke";
      const name = `${tap}/dittosh`;
      let tapped = false;
      let installed = false;
      try {
        const source = path.join(temp, "tap");
        fs.mkdirSync(path.join(source, "Formula"), { recursive: true });
        fs.writeFileSync(
          path.join(source, "Formula/dittosh.rb"),
          formula(version, checksum, `http://127.0.0.1:${port}/${path.basename(archive)}`),
        );
        await execa("git", ["init", "-b", "main", source]);
        await execa("git", ["-C", source, "add", "."]);
        await execa("git", [
          "-C",
          source,
          "-c",
          "user.name=Release test",
          "-c",
          "user.email=release-test@example.invalid",
          "commit",
          "-m",
          "Test formula",
        ]);
        await execa("brew", ["tap", tap, source], { env });
        tapped = true;
        await execa("brew", ["install", "--formula", name], { env, stdio: "inherit" });
        installed = true;
        await execa("brew", ["test", name], { env, stdio: "inherit" });
        const prefix = (await execa("brew", ["--prefix", name], { env })).stdout;
        const info = JSON.parse(
          (await execa(path.join(prefix, "bin/dittosh"), ["version", "--format", "json"], { env }))
            .stdout,
        );
        assert.match(info.channel, /^homebrew /);
        console.log(
          `Homebrew install, offline DQL, and channel detection passed on ${process.platform}/${process.arch}`,
        );
      } finally {
        if (installed) await execa("brew", ["uninstall", "--formula", name], { env });
        if (tapped) await execa("brew", ["untap", tap], { env });
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } else throw new Error("Expected npm or homebrew smoke mode");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  smoke(
    process.argv[2] ?? "",
    process.argv[3] ?? "",
    !process.argv.includes("--without-native"),
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
