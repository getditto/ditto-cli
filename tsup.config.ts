import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// The SDK has no runtime version export — stamp its installed version at build time.
const sdkPkg = JSON.parse(
  readFileSync(new URL("./node_modules/@dittolive/ditto/package.json", import.meta.url), "utf8"),
) as { version: string };

// `RELEASE=true npm run build` stamps a release build (env credentials ignored).
const release = process.env.RELEASE === "true";

// Release builds swap the committed token-chunks stub for the generated,
// gitignored build/token-chunks.ts (run `npm run stamp:token` first).
const stampPath = fileURLToPath(new URL("./build/token-chunks.ts", import.meta.url));
if (release) {
  if (!existsSync(stampPath)) {
    throw new Error("RELEASE build needs a stamped token — run `npm run stamp:token` first.");
  }
  if (!readFileSync(stampPath, "utf8").includes("STAMPED = true")) {
    throw new Error("build/token-chunks.ts is not stamped — re-run `npm run stamp:token`.");
  }
}

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  platform: "node",
  banner: {
    // Shebang must stay on line 1; the shim lets bundled CJS deps
    // (e.g. commander) call require() inside the ESM bundle.
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  // Bundle all JS deps; only the Ditto SDK stays external (native .node binaries).
  noExternal: ["commander", "chalk", "env-paths", "tar", "@inquirer/prompts"],
  external: ["@dittolive/ditto"],
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
    __DITTO_SDK_VERSION__: JSON.stringify(sdkPkg.version),
    RELEASE: JSON.stringify(release ? "true" : "false"),
  },
  esbuildPlugins: release
    ? [
        {
          name: "stamped-token",
          setup(build) {
            build.onResolve({ filter: /token-chunks\.stub\.js$/ }, () => ({ path: stampPath }));
          },
        },
      ]
    : [],
  clean: true,
  sourcemap: false,
  minify: false,
});
