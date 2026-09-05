import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectHarness as detectSourceHarness } from "./InstallEngine";
import { detectHarness as detectInstallHarness } from "../install/skills/LifeOS/Tools/InstallEngine";

const originalPath = process.env.PATH;
const originalConfigRoots = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
};
const homes: string[] = [];
const detectors = [detectSourceHarness, detectInstallHarness];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const [name, value] of Object.entries(originalConfigRoots)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

function clearConfigRootOverrides(): void {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
}

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lifeos-codex-detect-"));
  homes.push(home);
  mkdirSync(join(home, ".codex"));
  return home;
}

describe("detectHarness Codex support", () => {
  test("detects Codex from its config directory and executable", () => {
    clearConfigRootOverrides();
    const home = fakeHome();
    for (const detectHarness of detectors) {
      expect(detectHarness(home, (binary) => binary === "codex")).toEqual({
        name: "codex",
        configRoot: join(home, ".codex"),
        skillsDir: join(home, ".codex", "skills"),
        confidence: "detected",
      });
    }
  });

  test("reports directory-only Codex detection as assumed", () => {
    clearConfigRootOverrides();
    const home = fakeHome();
    for (const detectHarness of detectors) {
      expect(detectHarness(home, () => false)).toEqual({
        name: "codex",
        configRoot: join(home, ".codex"),
        skillsDir: join(home, ".codex", "skills"),
        confidence: "assumed",
      });
    }
  });

  test("preserves Claude Code and OpenCode detection", () => {
    clearConfigRootOverrides();
    for (const harness of [
      { name: "claude-code", directory: ".claude", binary: "claude", skills: ".claude/skills" },
      { name: "opencode", directory: ".config/opencode", binary: "opencode", skills: ".config/opencode/skills" },
    ] as const) {
      const home = mkdtempSync(join(tmpdir(), `lifeos-${harness.name}-detect-`));
      homes.push(home);
      mkdirSync(join(home, harness.directory), { recursive: true });

      for (const detectHarness of detectors) {
        expect(detectHarness(home, (binary) => binary === harness.binary)).toEqual({
          name: harness.name,
          configRoot: join(home, harness.directory),
          skillsDir: join(home, harness.skills),
          confidence: "detected",
        });
      }
    }
  });

  test("prefers a live Codex binary over stale Claude configuration", () => {
    clearConfigRootOverrides();
    const home = mkdtempSync(join(tmpdir(), "lifeos-stale-claude-detect-"));
    homes.push(home);
    mkdirSync(join(home, ".claude"));

    for (const detectHarness of detectors) {
      expect(detectHarness(home, (binary) => binary === "codex")).toEqual({
        name: "codex",
        configRoot: join(home, ".codex"),
        skillsDir: join(home, ".codex", "skills"),
        confidence: "detected",
      });
    }
  });
});
