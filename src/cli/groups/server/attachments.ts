import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { expandTilde } from "../../../config/paths.js";
import { note, validateOutPath } from "../dql/run.js";
import { addServerOpts, connect, type ServerDeps, stripEq, withServerErrors } from "./common.js";

/**
 * Attachment endpoints: POST /api/v4/attachments/upload (multipart) and
 * GET /api/v4/attachments/{id} (raw bytes). The HTTP API caps uploads at 1 MB
 * by default (raiseable via Ditto support).
 */

export function registerAttachmentCommands(server: Command, deps: ServerDeps = {}): void {
  const attachment = server
    .command("attachment")
    .description("Upload and download ATTACHMENT blobs")
    .addHelpText(
      "after",
      `
Attachments hold binary data referenced from documents via the ATTACHMENT
type. Upload returns an id you store in a document field.

Uploads are limited to 1 MB by the HTTP API by default.
`,
    );

  addServerOpts(
    attachment
      .command("upload")
      .description("Upload a file (POST /api/v4/attachments/upload, multipart)")
      .argument("<file>", "file to upload"),
  )
    .addHelpText(
      "after",
      `
Multipart form: one "file" part. Response: {"id": "<attachment-id>", "len": n}

Example:
  dittosh server attachment upload ./photo.png
`,
    )
    .action(
      withServerErrors(async (file: string, opts: { url?: string; apiKey?: string }) => {
        const filePath = path.resolve(expandTilde(file));
        let buf: Buffer;
        try {
          buf = fs.readFileSync(filePath);
        } catch (err) {
          console.error(
            chalk.red(`Cannot read file: ${file} (${(err as NodeJS.ErrnoException).message})`),
          );
          process.exitCode = 2;
          return;
        }
        const conn = connect(opts, deps);
        if (!conn) return;
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(buf)]), path.basename(filePath));
        note(`Uploading ${path.basename(filePath)} (${buf.length.toLocaleString()} bytes)…`);
        const res = await conn.client.uploadAttachment(form);
        console.log(JSON.stringify({ id: res.id, len: res.len }, null, 2));
      }),
    );

  addServerOpts(
    attachment
      .command("get")
      .description("Download an attachment (GET /api/v4/attachments/{id})")
      .argument("<id>", "attachment ID")
      .option("-o, --out <path>", "write to a file (default: raw bytes on stdout when piped)"),
  )
    .addHelpText(
      "after",
      `
Examples:
  dittosh server attachment get RUGMUxzHDRH1x94uH_QcrkzUhV5-j6oFd1c9eAFMxNZDmQ -o photo.png
  dittosh server attachment get <id> > photo.png        # piped: bytes on stdout
`,
    )
    .action(
      withServerErrors(
        async (id: string, opts: { url?: string; apiKey?: string; out?: string }) => {
          // -o is a short option — commander keeps "=" in `-o=x` artifacts.
          opts = { ...opts, out: stripEq(opts.out) };
          if (opts.out) {
            const outError = validateOutPath(opts.out);
            if (outError) {
              console.error(chalk.red(outError));
              process.exitCode = 2;
              return;
            }
          } else if (process.stdout.isTTY) {
            console.error(
              chalk.red("Refusing to write binary to the terminal — pass -o <path> or pipe stdout"),
            );
            process.exitCode = 2;
            return;
          }
          const conn = connect(opts, deps);
          if (!conn) return;
          const bytes = await conn.client.getAttachment(id);
          if (opts.out) {
            try {
              fs.writeFileSync(path.resolve(expandTilde(opts.out)), bytes);
            } catch (err) {
              console.error(
                chalk.red(`Cannot write ${opts.out}: ${(err as NodeJS.ErrnoException).message}`),
              );
              process.exitCode = 1;
              return;
            }
            console.log(`Wrote ${bytes.length.toLocaleString()} bytes to ${opts.out}`);
          } else {
            process.stdout.write(bytes);
          }
        },
      ),
    );
}
