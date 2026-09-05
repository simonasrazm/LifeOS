import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CodexHooks,
  codexHooksFromLifeOS,
  mergeCodexHooksDocument,
  mergeManagedAgentsBlock,
  rewriteCodexPath,
} from "./InstallCodex";

describe("InstallCodex native adapter", () => {
  test("install payload mirrors the canonical installer exactly", () => {
    expect(readFileSync(join(import.meta.dir, "../install/skills/LifeOS/Tools/InstallCodex.ts"), "utf-8"))
      .toBe(readFileSync(join(import.meta.dir, "InstallCodex.ts"), "utf-8"));
  });

  test("adds missing USER schema to a populated external tree without overwriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-codex-user-upgrade-"));
    const configRoot = join(root, ".codex");
    const configDir = join(root, "data");
    const userDir = join(configDir, "USER");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "CONTACTS.md"), "principal-owned\n");

    try {
      const proc = Bun.spawnSync([
        "bun", join(import.meta.dir, "InstallCodex.ts"),
        "--config-root", configRoot,
        "--config-dir", configDir,
        "--skill-root", join(import.meta.dir, ".."),
        "--apply",
      ], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      expect(readFileSync(join(userDir, "CONTACTS.md"), "utf-8")).toBe("principal-owned\n");
      expect(existsSync(join(userDir, "CONFIG", "OPERATIONAL_RULES.md"))).toBe(true);
      expect(existsSync(join(userDir, "DIGITAL_ASSISTANT", "DA_IDENTITY.md"))).toBe(true);
      expect(existsSync(join(userDir, "TELOS", "LIFEOS_STATE.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
  test("maps supported events and reports unsupported events", () => {
    const source = {
      SessionStart: [{ hooks: [{ type: "command", command: "$HOME/.claude/hooks/LoadContext.hook.ts" }] }],
      PreToolUse: [{ matcher: "Bash|Write|Edit|MultiEdit|AskUserQuestion", hooks: [{ type: "command", command: "~/.claude/hooks/Guard.hook.ts" }] }],
      ConfigChange: [{ hooks: [{ type: "command", command: "$HOME/.claude/hooks/Config.hook.ts" }] }],
    };

    const result = codexHooksFromLifeOS(source);

    expect(Object.keys(result.hooks)).toEqual(["SessionStart", "PreToolUse"]);
    expect(result.unsupportedEvents).toEqual(["ConfigChange"]);
    expect(result.hooks.SessionStart[0].hooks[0].command).toContain("$CODEX_HOME/hooks/LoadContext.hook.ts");
    expect(result.hooks.SessionStart[0].hooks[0].command).toContain('CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"');
    expect(result.hooks.SessionStart[0].hooks[0].command).toContain("LIFEOS_DIR=\"$CODEX_HOME/LIFEOS\"");
    expect(result.hooks.PreToolUse[0].matcher).toBe("exec_command|apply_patch|request_user_input");
  });

  test("converts HTTP handlers to supported fail-open command handlers", () => {
    const result = codexHooksFromLifeOS({
      PreToolUse: [{ matcher: "Skill", hooks: [{ type: "http", url: "http://localhost:31337/hooks/skill-guard" }] }],
    });

    const hook = result.hooks.PreToolUse[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toContain("curl -sS -m 2");
    expect(hook.command).toContain("http://localhost:31337/hooks/skill-guard");
    expect(hook.command).toEndWith("|| true'");
  });

  test("normalizes existing Claude matchers while preserving custom fields", () => {
    const result = mergeCodexHooksDocument({
      custom: { owner: "user" },
      hooks: {
        PreToolUse: [{
          matcher: "Bash|Write|Agent|Skill",
          customGroup: true,
          hooks: [{ type: "http", url: "http://localhost:31337/hooks/skill-guard", timeout: 7 }],
        }, {
          matcher: "Edit",
          hooks: [{ type: "command", command: "$HOME/.claude/hooks/SecurityPipeline.hook.ts" }],
        }, {
          matcher: "MultiEdit",
          hooks: [{ type: "command", command: "$HOME/.claude/hooks/SecurityPipeline.hook.ts" }],
        }],
      },
    }, {});

    expect(result.custom).toEqual({ owner: "user" });
    const group = (result.hooks as CodexHooks).PreToolUse[0];
    expect(group.matcher).toBe("exec_command|apply_patch|spawn_agent|skill");
    expect(group.customGroup).toBe(true);
    expect(group.hooks[0].type).toBe("command");
    expect(group.hooks[0].timeout).toBe(7);
    const applyGroups = (result.hooks as CodexHooks).PreToolUse.filter((candidate) => candidate.matcher === "apply_patch");
    expect(applyGroups).toHaveLength(1);
    expect(applyGroups[0].hooks).toHaveLength(1);
  });

  test("preserves custom AGENTS text and updates one managed block", () => {
    const existing = [
      "custom-before",
      "<!-- LifeOS managed: start -->",
      "old managed text",
      "<!-- LifeOS managed: end -->",
      "custom-after",
      "",
    ].join("\n");
    const next = mergeManagedAgentsBlock(existing, "new managed text\n");

    expect(next).toContain("custom-before");
    expect(next).toContain("custom-after");
    expect(next).not.toContain("old managed text");
    expect(next.match(/<!-- LifeOS managed: start -->/g)).toHaveLength(1);
    expect(mergeManagedAgentsBlock(next, "new managed text\n")).toBe(next);
  });

  test("rewrites only harness-owned paths", () => {
    expect(rewriteCodexPath("$HOME/.claude/hooks/A.ts ~/.claude/LIFEOS/B.ts")).toBe(
      "$CODEX_HOME/hooks/A.ts $CODEX_HOME/LIFEOS/B.ts",
    );
    expect(rewriteCodexPath("/workspace/.claude-example/file")).toBe("/workspace/.claude-example/file");
  });

  test("preserves custom hook fields and unknown handler types", () => {
    const result = mergeCodexHooksDocument({
      custom: { owner: "user" },
      hooks: {
        SessionStart: [{ customGroup: true, hooks: [{ type: "future_handler", payload: "keep" }] }],
      },
    }, {});

    expect(result.custom).toEqual({ owner: "user" });
    expect((result.hooks as Record<string, unknown>).SessionStart).toEqual([
      { customGroup: true, hooks: [{ type: "future_handler", payload: "keep" }] },
    ]);
  });
});
