#!/usr/bin/env node
// Install (or update) the whiteboard skills globally, so "put the agents on my
// board" works from any directory, not just the repo.
//
// The project-local skills in <repo>/.claude/skills/wb-* use repo-relative
// paths (`cd whiteboard-agents`, `whiteboard-agents/INTERACTIONS.md`); this
// script rewrites them to absolute paths (derived from this file's location,
// so moving the repo and re-running fixes everything) and writes the result to
// ~/.claude/skills/. Re-run after editing a skill: unchanged copies are
// detected and skipped. Inside the repo, the project-local skills still win.
//
//   node bin/install-skills.js               install / update
//   node bin/install-skills.js --uninstall   remove the installed copies
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = ["wb-board", "wb-agent", "wb-orchestrate"];
const MARKER = "installed by whiteboard-agents/bin/install-skills.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..");
const SRC_DIR = path.join(REPO_ROOT, ".claude", "skills");
const DEST_DIR = path.join(os.homedir(), ".claude", "skills");

function globalize(md, name) {
  const note = [
    `<!-- ${MARKER} -->`,
    `<!-- source: ${path.join(SRC_DIR, name, "SKILL.md")} — edit there and re-run; this copy is overwritten -->`,
    "",
  ].join("\n");
  const body = md
    .replaceAll("`.claude/skills/", "`" + DEST_DIR + "/") // brains read the global copy
    .replaceAll("whiteboard-agents/", PKG_ROOT + "/")
    .replaceAll("cd whiteboard-agents", "cd " + PKG_ROOT);
  // keep the frontmatter first; the provenance note goes right after it
  const m = /^---\n[\s\S]*?\n---\n/.exec(body);
  if (!m) throw new Error(`${name}: SKILL.md has no frontmatter`);
  return body.slice(0, m[0].length) + note + body.slice(m[0].length);
}

const uninstall = process.argv.includes("--uninstall");
let changed = 0;

for (const name of SKILLS) {
  const destDir = path.join(DEST_DIR, name);
  const destFile = path.join(destDir, "SKILL.md");

  if (uninstall) {
    const current = fs.existsSync(destFile) ? fs.readFileSync(destFile, "utf8") : null;
    if (current === null) {
      console.log(`${name}: not installed`);
    } else if (!current.includes(MARKER)) {
      console.log(`${name}: ${destFile} was not installed by this script — leaving it alone`);
    } else {
      fs.rmSync(destDir, { recursive: true });
      console.log(`${name}: removed`);
      changed++;
    }
    continue;
  }

  const srcFile = path.join(SRC_DIR, name, "SKILL.md");
  if (!fs.existsSync(srcFile)) {
    console.error(`${name}: missing source ${srcFile}`);
    process.exitCode = 1;
    continue;
  }
  const next = globalize(fs.readFileSync(srcFile, "utf8"), name);
  const current = fs.existsSync(destFile) ? fs.readFileSync(destFile, "utf8") : null;
  if (current === next) {
    console.log(`${name}: up to date`);
    continue;
  }
  if (current !== null && !current.includes(MARKER)) {
    console.error(`${name}: ${destFile} exists but was not installed by this script — refusing to overwrite`);
    process.exitCode = 1;
    continue;
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(destFile, next);
  console.log(`${name}: ${current === null ? "installed" : "updated"} → ${destFile}`);
  changed++;
}

if (!uninstall && changed) {
  console.log("\nGlobal skills point at " + PKG_ROOT);
  console.log("New Claude Code sessions pick them up; project-local skills still win inside the repo.");
}
