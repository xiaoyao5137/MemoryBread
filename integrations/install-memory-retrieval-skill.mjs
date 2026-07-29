#!/usr/bin/env node

import { cp, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const INTEGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));
const TARGETS = {
  codex: {
    source: join(INTEGRATIONS_DIR, "codex", "memory-retrieval"),
    target: join(homedir(), ".agents", "skills", "memory-retrieval"),
  },
  "claude-code": {
    source: join(INTEGRATIONS_DIR, "claude-code", "memory-retrieval"),
    target: join(homedir(), ".claude", "skills", "memory-retrieval"),
  },
};

function printUsage() {
  process.stdout.write(`Install the MemoryBread memory-retrieval skill.

Usage:
  node integrations/install-memory-retrieval-skill.mjs <codex|claude-code|both> [--dry-run] [--force]

Options:
  --dry-run  Show source and destination paths without writing files.
  --force    Move an existing skill to a timestamped backup before installing.
  --help     Show this help.
`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function backupPath(target) {
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  return `${target}.backup-${timestamp}`;
}

async function install(name, { dryRun, force }) {
  const { source, target } = TARGETS[name];
  if (!await exists(source)) throw new Error(`Skill source not found: ${source}`);

  if (dryRun) {
    process.stdout.write(`[dry-run] ${name}: ${source} -> ${target}\n`);
    return;
  }

  if (await exists(target)) {
    if (!force) {
      throw new Error(
        `Skill already exists at ${target}. Re-run with --force to create a backup and replace it.`,
      );
    }
    const backup = backupPath(target);
    await rename(target, backup);
    process.stdout.write(`Backed up existing ${name} skill to ${backup}\n`);
  }

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, errorOnExist: true });
  process.stdout.write(`Installed 记忆检索 for ${name}: ${target}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const platform = args.find((arg) => !arg.startsWith("-"));
  if (!["codex", "claude-code", "both"].includes(platform)) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const options = {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  };
  const names = platform === "both" ? ["codex", "claude-code"] : [platform];
  for (const name of names) await install(name, options);
}

main().catch((error) => {
  process.stderr.write(`Installation failed: ${error.message}\n`);
  process.exitCode = 1;
});
