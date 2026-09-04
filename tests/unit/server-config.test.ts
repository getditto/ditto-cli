import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeBaseUrl,
  readDotEnv,
  resolveApiVersion,
  resolveServerConfig,
  ServerConfigError,
} from "../../src/server/config.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

let dir: string;

beforeEach(() => {
  dir = tmpDataDir("dittosh-server-config-");
});

afterEach(() => {
  rmrf(dir);
});

function writeEnv(contents: string, cwd: string = dir) {
  fs.writeFileSync(path.join(cwd, ".env"), contents);
}

describe("readDotEnv", () => {
  it("returns {} when no .env exists", () => {
    expect(readDotEnv(dir)).toEqual({});
  });

  it("parses KEY=value pairs", () => {
    writeEnv("DITTOSH_SERVER_URL=https://x.example/app\nDITTOSH_SERVER_API_KEY=k3y\n");
    expect(readDotEnv(dir)).toEqual({
      DITTOSH_SERVER_URL: "https://x.example/app",
      DITTOSH_SERVER_API_KEY: "k3y",
    });
  });

  it("returns {} on malformed content instead of throwing", () => {
    writeEnv("NO EQUALS HERE BUT UNPARSEABLE \u0000 BYTES");
    expect(readDotEnv(dir)).toEqual({});
  });

  it("returns {} when .env is a directory", () => {
    fs.mkdirSync(path.join(dir, ".env"));
    expect(readDotEnv(dir)).toEqual({});
  });
});

describe("normalizeBaseUrl", () => {
  it("adds https:// to scheme-less endpoints", () => {
    expect(normalizeBaseUrl("abc.cloud.dittolive.app/app-id")).toBe(
      "https://abc.cloud.dittolive.app/app-id",
    );
  });

  it("keeps an explicit scheme and strips trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:8080/app-id/")).toBe("http://localhost:8080/app-id");
    expect(normalizeBaseUrl("https://x.example/app///")).toBe("https://x.example/app");
  });

  it("rejects garbage URLs", () => {
    expect(() => normalizeBaseUrl("ht tp://not a url")).toThrow(ServerConfigError);
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => normalizeBaseUrl("ftp://x.example/app")).toThrow(/only http\(s\)/);
  });
});

describe("resolveApiVersion", () => {
  it("defaults to v5", () => {
    expect(resolveApiVersion(undefined)).toBe("v5");
  });
  it("accepts v4", () => {
    expect(resolveApiVersion("v4")).toBe("v4");
  });
  it("rejects anything else", () => {
    expect(() => resolveApiVersion("v3")).toThrow(/--api-version must be v4 or v5/);
  });
});

describe("resolveServerConfig", () => {
  it("fails with exit 3 and guidance when the URL is missing", () => {
    try {
      resolveServerConfig({}, {}, dir);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ServerConfigError);
      expect((err as ServerConfigError).exitCode).toBe(3);
      expect((err as Error).message).toContain("DITTOSH_SERVER_URL");
    }
  });

  it("fails with exit 3 and guidance when the API key is missing", () => {
    try {
      resolveServerConfig({}, { DITTOSH_SERVER_URL: "x.example/app" }, dir);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("DITTOSH_SERVER_API_KEY");
      expect((err as ServerConfigError).exitCode).toBe(3);
    }
  });

  it("resolves from the shell environment", () => {
    const cfg = resolveServerConfig(
      {},
      { DITTOSH_SERVER_URL: "x.example/app", DITTOSH_SERVER_API_KEY: "key" },
      dir,
    );
    expect(cfg).toEqual({
      baseUrl: "https://x.example/app",
      apiKey: "key",
      apiVersion: "v5",
      sources: { url: "env", apiKey: "env" },
    });
  });

  it("resolves from a cwd .env when the shell has nothing", () => {
    writeEnv("DITTOSH_SERVER_URL=dotenv.example/app\nDITTOSH_SERVER_API_KEY=dotenv-key");
    const cfg = resolveServerConfig({}, {}, dir);
    expect(cfg.baseUrl).toBe("https://dotenv.example/app");
    expect(cfg.apiKey).toBe("dotenv-key");
    expect(cfg.sources).toEqual({ url: "dotenv", apiKey: "dotenv" });
  });

  it("shell env wins over .env", () => {
    writeEnv("DITTOSH_SERVER_URL=dotenv.example/app\nDITTOSH_SERVER_API_KEY=dotenv-key");
    const cfg = resolveServerConfig(
      {},
      { DITTOSH_SERVER_URL: "shell.example/app", DITTOSH_SERVER_API_KEY: "shell-key" },
      dir,
    );
    expect(cfg.baseUrl).toBe("https://shell.example/app");
    expect(cfg.apiKey).toBe("shell-key");
  });

  it("flags win over everything", () => {
    writeEnv("DITTOSH_SERVER_URL=dotenv.example/app\nDITTOSH_SERVER_API_KEY=dotenv-key");
    const cfg = resolveServerConfig(
      { url: "flag.example/app", apiKey: "flag-key", apiVersion: "v4" },
      { DITTOSH_SERVER_URL: "shell.example/app", DITTOSH_SERVER_API_KEY: "shell-key" },
      dir,
    );
    expect(cfg).toEqual({
      baseUrl: "https://flag.example/app",
      apiKey: "flag-key",
      apiVersion: "v4",
      sources: { url: "flag", apiKey: "flag" },
    });
  });

  it("supports the DITTO_CLOUD_URL / DITTO_API_KEY aliases", () => {
    const cfg = resolveServerConfig(
      {},
      { DITTO_CLOUD_URL: "alias.example/app", DITTO_API_KEY: "alias-key" },
      dir,
    );
    expect(cfg.baseUrl).toBe("https://alias.example/app");
    expect(cfg.apiKey).toBe("alias-key");
  });

  it("primary names win over aliases", () => {
    const cfg = resolveServerConfig(
      {},
      {
        DITTOSH_SERVER_URL: "primary.example/app",
        DITTO_CLOUD_URL: "alias.example/app",
        DITTOSH_SERVER_API_KEY: "primary-key",
        DITTO_API_KEY: "alias-key",
      },
      dir,
    );
    expect(cfg.baseUrl).toBe("https://primary.example/app");
    expect(cfg.apiKey).toBe("primary-key");
  });

  it("ignores blank/whitespace values and falls through", () => {
    writeEnv("DITTOSH_SERVER_URL=dotenv.example/app\nDITTOSH_SERVER_API_KEY=dotenv-key");
    const cfg = resolveServerConfig(
      { url: "   " },
      { DITTOSH_SERVER_URL: " ", DITTOSH_SERVER_API_KEY: "dotenv-key-shell" },
      dir,
    );
    expect(cfg.baseUrl).toBe("https://dotenv.example/app");
    expect(cfg.apiKey).toBe("dotenv-key-shell");
  });

  it("rejects a bad --api-version before any network use", () => {
    expect(() =>
      resolveServerConfig({ url: "x.example/app", apiKey: "k", apiVersion: "v9" }, {}, dir),
    ).toThrow(/--api-version must be v4 or v5/);
  });
});

describe("regression: URL hardening", () => {
  it("rejects URLs with embedded credentials (would leak into printed errors)", () => {
    expect(() => normalizeBaseUrl("https://user:pass@host.example/app")).toThrow(
      /credentials must not be embedded/,
    );
  });

  it("rejects URLs with query strings (paths would land inside the query)", () => {
    expect(() => normalizeBaseUrl("https://host.example/app?foo=bar")).toThrow(/query string/);
  });

  it("rejects URLs with fragments", () => {
    expect(() => normalizeBaseUrl("https://host.example/app#frag")).toThrow(
      /query string|fragment/,
    );
  });

  it("still accepts scheme-less host:port with a path", () => {
    expect(normalizeBaseUrl("localhost:8080/app-id")).toBe("https://localhost:8080/app-id");
  });
});

describe("regression: bad --api-version is a usage error", () => {
  it("throws ApiVersionError with exitCode 2", () => {
    try {
      resolveApiVersion("v9");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).name).toBe("ApiVersionError");
      expect((err as { exitCode: number }).exitCode).toBe(2);
    }
  });
});

describe("regression: .env present but unhelpful is called out", () => {
  it("missing-config error notes the .env file exists", () => {
    writeEnv("UNRELATED=value\n");
    try {
      resolveServerConfig({}, {}, dir);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain(".env exists in the current directory");
    }
  });

  it("no .env → no note", () => {
    try {
      resolveServerConfig({}, {}, dir);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(".env exists");
    }
  });
});

describe("regression: bare ? / # are stripped, not just rejected", () => {
  it("--url https://host/app? normalizes cleanly", () => {
    expect(normalizeBaseUrl("https://host.example/app?")).toBe("https://host.example/app");
  });
  it("--url https://host/app# normalizes cleanly", () => {
    expect(normalizeBaseUrl("https://host.example/app#")).toBe("https://host.example/app");
  });
});
