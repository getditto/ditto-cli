import chalk from "chalk";
import { Command } from "commander";
import { rewriteDefaultSubcommand } from "./default-command.js";
import { registerDqlGroup } from "./groups/dql/index.js";
import { CLI_VERSION } from "./version.js";

const program = new Command();
program
  .name("ditto")
  .description("The Ditto CLI — run DQL, load sample datasets, install AI agent skills")
  .version(CLI_VERSION);

const dql = program.command("dql");
registerDqlGroup(dql);

program
  .parseAsync([...process.argv.slice(0, 2), ...rewriteDefaultSubcommand(process.argv.slice(2))])
  .catch((err) => {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  });
