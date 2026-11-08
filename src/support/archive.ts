import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";

/**
 * Write `files` (names relative to `dir`) into a gzipped tar at `outFile`.
 * Entries sit under one top folder (`folder/…`) so extracting doesn't
 * scatter files into the current directory.
 */
export async function writeArchive(
  outFile: string,
  dir: string,
  folder: string,
  files: string[],
): Promise<number> {
  // tar adds paths as given relative to cwd: stage them under `folder`, in
  // a directory of its own so `folder` can't clash with a staged file name
  // (e.g. `--report report.md`).
  const root = fs.mkdtempSync(path.join(dir, "stage-"));
  const stage = path.join(root, folder);
  fs.mkdirSync(stage, { recursive: true });
  for (const f of files) fs.renameSync(path.join(dir, f), path.join(stage, f));
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  await tar.c({ gzip: true, file: outFile, cwd: root, portable: true }, [folder]);
  return fs.statSync(outFile).size;
}
