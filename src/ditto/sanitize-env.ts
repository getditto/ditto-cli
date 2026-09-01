/**
 * The Ditto SDK's native tracing layer panics (abort, exit 134) when NO_COLOR
 * is present in the environment (verified on @dittolive/ditto 5.1.0 — an
 * upstream bug). NO_COLOR color behavior is applied by the CLI entry hook
 * (chalk.level = 0), so scrubbing it before the SDK loads loses nothing.
 *
 * Must run before `@dittolive/ditto` is evaluated — see the dynamic import in
 * session.ts.
 */
export function scrubEnvForSdk(): void {
  if ("NO_COLOR" in process.env) {
    delete process.env.NO_COLOR;
  }
}
