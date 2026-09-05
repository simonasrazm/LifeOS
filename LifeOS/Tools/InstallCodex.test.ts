import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  test("shared core tools do not import harness-owned hook libraries", () => {
    const toolsRoot = join(import.meta.dir, "../install/LIFEOS/TOOLS");
    const sources = readdirSync(toolsRoot)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(toolsRoot, name), "utf-8"))
      .join("\n");
    expect(sources).not.toContain("../../hooks/lib/");
    for (const dependency of [
      "containment-zones.ts", "identity.ts", "isa-utils.ts", "learning-utils.ts",
      "paths.ts", "system-file-guard-core.ts", "work-config.ts", "work-events.ts",
    ]) {
      expect(existsSync(join(toolsRoot, "lib", dependency))).toBe(true);
    }
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
        "--no-native-backup",
        "--apply",
      ], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      expect(readFileSync(join(userDir, "CONTACTS.md"), "utf-8")).toBe("principal-owned\n");
      expect(existsSync(join(userDir, "CONFIG", "OPERATIONAL_RULES.md"))).toBe(true);
      expect(existsSync(join(userDir, "DIGITAL_ASSISTANT", "DA_IDENTITY.md"))).toBe(true);
      expect(existsSync(join(userDir, "TELOS", "LIFEOS_STATE.json"))).toBe(true);
      expect(existsSync(join(configRoot, ".lifeos-backups"))).toBe(false);

      const agents = readFileSync(join(configRoot, "AGENTS.md"), "utf-8");
      expect(agents).toContain("${CODEX_HOME:-$HOME/.codex}/LIFEOS/LIFEOS_SYSTEM_PROMPT.md");
      expect(agents).not.toContain("read `$CODEX_HOME/LIFEOS/LIFEOS_SYSTEM_PROMPT.md`");

      const installedHook = join(configRoot, "hooks", "LoadContext.hook.ts");
      const installedSystemPrompt = join(configRoot, "LIFEOS", "LIFEOS_SYSTEM_PROMPT.md");
      const installedTranscriptParser = join(configRoot, "LIFEOS", "TOOLS", "TranscriptParser.ts");
      writeFileSync(installedHook, "stale adapter hook\n");
      writeFileSync(installedSystemPrompt, "stale system prompt\n");
      writeFileSync(installedTranscriptParser, "stale runtime tool\n");
      writeFileSync(join(configRoot, "hooks", "Custom.hook.ts"), "principal-owned\n");
      const reinstall = Bun.spawnSync([
        "bun", join(import.meta.dir, "InstallCodex.ts"),
        "--config-root", configRoot,
        "--config-dir", configDir,
        "--skill-root", join(import.meta.dir, ".."),
        "--no-native-backup",
        "--apply",
      ], { stdout: "pipe", stderr: "pipe" });
      expect(reinstall.exitCode).toBe(0);
      expect(readFileSync(installedHook, "utf-8")).toBe(
        readFileSync(join(import.meta.dir, "../install/hooks/LoadContext.hook.ts"), "utf-8"),
      );
      expect(readFileSync(installedSystemPrompt, "utf-8")).toBe(
        readFileSync(join(import.meta.dir, "../install/LIFEOS/LIFEOS_SYSTEM_PROMPT.md"), "utf-8"),
      );
      expect(readFileSync(installedTranscriptParser, "utf-8")).toBe(
        readFileSync(join(import.meta.dir, "../install/LIFEOS/TOOLS/TranscriptParser.ts"), "utf-8"),
      );
      expect(readFileSync(join(configRoot, "hooks", "Custom.hook.ts"), "utf-8")).toBe("principal-owned\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("keeps harness state local while routing core state through an external neutral root", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-codex-neutral-root-"));
    const configRoot = join(root, ".codex");
    const configDir = join(root, "data");
    const lifeosDir = join(root, ".pai");
    mkdirSync(join(configDir, "USER"), { recursive: true });

    try {
      const proc = Bun.spawnSync([
        "bun", join(import.meta.dir, "InstallCodex.ts"),
        "--config-root", configRoot,
        "--config-dir", configDir,
        "--lifeos-dir", lifeosDir,
        "--skill-root", join(import.meta.dir, ".."),
        "--no-native-backup",
        "--apply",
      ], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      expect(realpathSync(join(configRoot, "LIFEOS"))).toBe(realpathSync(lifeosDir));
      expect(realpathSync(join(lifeosDir, "USER"))).toBe(realpathSync(join(configDir, "USER")));
      expect(readFileSync(join(configRoot, "AGENTS.md"), "utf-8")).toContain(`${lifeosDir}/LIFEOS_SYSTEM_PROMPT.md`);
      expect(readFileSync(join(configRoot, "hooks.json"), "utf-8")).toContain(lifeosDir);
      const manifest = JSON.parse(readFileSync(join(configRoot, ".pai-adapter.json"), "utf-8"));
      expect(manifest.paiDir).toBe(lifeosDir);
      expect(manifest.lifeosVersion).toBe("7.40.4");
      const coreImport = Bun.spawnSync([
        "bun", "-e",
        `const m = await import(${JSON.stringify(join(lifeosDir, "TOOLS", "TranscriptParser.ts"))}); if (typeof m.parseTranscript !== "function") process.exit(1);`,
      ], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LIFEOS_DIR: lifeosDir, LIFEOS_CONFIG_DIR: configDir },
      });
      if (coreImport.exitCode !== 0) console.error(coreImport.stderr.toString());
      expect(coreImport.exitCode).toBe(0);
      expect(existsSync(join(root, ".claude"))).toBe(false);
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
    expect(hook.command).toContain("PAI_HARNESS=codex");
    expect(hook.command).toContain("|| true");
  });

  test("replaces prior adapter registrations without touching custom hooks", () => {
    const incoming = codexHooksFromLifeOS({
      PreToolUse: [{ matcher: "Skill", hooks: [{ type: "http", url: "http://localhost:31337/hooks/skill-guard" }] }],
    }).hooks;
    const result = mergeCodexHooksDocument({
      hooks: {
        PreToolUse: [{ matcher: "skill", hooks: [
          { type: "command", command: "bash -lc 'export PAI_HARNESS=codex; old-wrapper'" },
          { type: "command", command: "custom-hook --keep" },
        ] }],
      },
    }, incoming);
    const hooks = (result.hooks as CodexHooks).PreToolUse[0].hooks;
    expect(hooks.filter((hook) => hook.command?.includes("PAI_HARNESS=codex"))).toHaveLength(1);
    expect(hooks.some((hook) => hook.command === "custom-hook --keep")).toBe(true);
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
