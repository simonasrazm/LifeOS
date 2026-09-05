#!/usr/bin/env bun
/**
 * InstallCodex — native Codex adapter for the LifeOS bare-skill payload.
 *
 * Composes the existing additive core/USER deployment tools, then installs the
 * Codex-owned surfaces: AGENTS.md, hooks.json, config.toml, and hook scripts.
 * Dry-run is the default. Existing user text and hook entries are preserved;
 * the adapter owns only its marked AGENTS block and files absent at install.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { copyMissing, detectDevTree } from "./InstallEngine";
import { atomicWriteText } from "./lib/atomic-write";

const MANAGED_START = "<!-- LifeOS managed: start -->";
const MANAGED_END = "<!-- LifeOS managed: end -->";
const LEGACY_PAI_START = "<!-- PAI managed instructions: start -->";
const LEGACY_PAI_END = "<!-- PAI managed instructions: end -->";

const SUPPORTED_EVENTS = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "SessionStart",
  "SubagentStart",
  "SessionEnd",
]);

const MATCHER_MAP: Record<string, string> = {
  Bash: "exec_command",
  Write: "apply_patch",
  Edit: "apply_patch",
  MultiEdit: "apply_patch",
  Read: "exec_command",
  Skill: "skill",
  Agent: "spawn_agent",
  AskUserQuestion: "request_user_input",
  WebFetch: "web__run",
  WebSearch: "web__run",
  ToolSearch: "tool_search",
};

export interface CodexHook {
  type?: string;
  command?: string;
  url?: string;
  [key: string]: unknown;
}

export interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHook[];
  [key: string]: unknown;
}

export type CodexHooks = Record<string, CodexHookGroup[]>;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function rewriteCodexPath(value: string): string {
  return value
    .replace(/\$HOME\/\.claude(?=\/|$)/g, "$HOME/.codex")
    .replace(/\$\{HOME\}\/\.claude(?=\/|$)/g, "$HOME/.codex")
    .replace(/~\/\.claude(?=\/|$)/g, "$HOME/.codex");
}

function mapMatcher(matcher: string | undefined): string | undefined {
  if (!matcher) return matcher;
  const mapped = matcher
    .split("|")
    .map((part) => MATCHER_MAP[part] ?? part)
    .filter((part, index, all) => all.indexOf(part) === index);
  return mapped.join("|");
}

function convertHook(hook: CodexHook): CodexHook | undefined {
  if (hook.type === "http" && typeof hook.url === "string" && hook.url) {
    const request = `curl -sS -m 2 -X POST ${shellQuote(hook.url)} -H ${shellQuote("Content-Type: application/json")} --data-binary @- || true`;
    const converted: CodexHook = {
      ...hook,
      type: "command",
      command: `bash -lc ${shellQuote(request)}`,
    };
    delete converted.url;
    return converted;
  }
  if ((hook.type === undefined || hook.type === "command") && typeof hook.command === "string") {
    return { ...hook, type: "command", command: rewriteCodexPath(hook.command) };
  }
  if (hook.type === "mcp_tool") return { ...hook };
  return undefined;
}

/** Finite conversion of the lifecycle surface Codex currently supports. */
export function codexHooksFromLifeOS(source: unknown): {
  hooks: CodexHooks;
  unsupportedEvents: string[];
  unsupportedHandlers: number;
} {
  const input = typeof source === "object" && source !== null ? source as Record<string, unknown> : {};
  const hooks: CodexHooks = {};
  const unsupportedEvents: string[] = [];
  let unsupportedHandlers = 0;

  for (const [event, groupsValue] of Object.entries(input)) {
    if (!SUPPORTED_EVENTS.has(event)) {
      unsupportedEvents.push(event);
      continue;
    }
    if (!Array.isArray(groupsValue)) continue;
    const groups: CodexHookGroup[] = [];
    for (const groupValue of groupsValue) {
      if (typeof groupValue !== "object" || groupValue === null) continue;
      const group = groupValue as Record<string, unknown>;
      const sourceHooks = Array.isArray(group.hooks) ? group.hooks : [];
      const converted: CodexHook[] = [];
      for (const hookValue of sourceHooks) {
        if (typeof hookValue !== "object" || hookValue === null) continue;
        const hook = convertHook(hookValue as CodexHook);
        if (hook) converted.push(hook);
        else unsupportedHandlers++;
      }
      if (converted.length > 0) {
        groups.push({ ...group, matcher: mapMatcher(typeof group.matcher === "string" ? group.matcher : undefined), hooks: converted });
      }
    }
    if (groups.length > 0) hooks[event] = groups;
  }

  return { hooks, unsupportedEvents: unsupportedEvents.sort(), unsupportedHandlers };
}

function hookIdentity(hook: CodexHook): string {
  if (hook.type === "command") return `command:${String(hook.command).replace(/\s+/g, " ").trim()}`;
  if (hook.type === "mcp_tool") return `mcp:${JSON.stringify(hook)}`;
  return JSON.stringify(hook);
}

function mergeNativeHooks(existing: CodexHooks, incoming: CodexHooks): CodexHooks {
  const merged: CodexHooks = JSON.parse(JSON.stringify(existing));
  for (const [event, groups] of Object.entries(incoming)) {
    if (!merged[event]) merged[event] = [];
    for (const group of groups) {
      const matcher = group.matcher ?? "";
      let target = merged[event].find((candidate) => (candidate.matcher ?? "") === matcher);
      if (!target) {
        target = { ...group, hooks: [] };
        merged[event].push(target);
      }
      const present = new Set(target.hooks.map(hookIdentity));
      for (const hook of group.hooks) {
        const identity = hookIdentity(hook);
        if (!present.has(identity)) {
          target.hooks.push(hook);
          present.add(identity);
        }
      }
    }
  }
  return merged;
}

function replaceMarkedBlock(existing: string, startMarker: string, endMarker: string, replacement: string): string {
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) return existing;
  const after = end + endMarker.length;
  return `${existing.slice(0, start)}${replacement}${existing.slice(after).replace(/^\n+/, "")}`;
}

export function mergeManagedAgentsBlock(existing: string, managedBody: string): string {
  const block = `${MANAGED_START}\n${managedBody.trim()}\n${MANAGED_END}\n`;
  if (existing.includes(MANAGED_START) && existing.includes(MANAGED_END)) {
    return replaceMarkedBlock(existing, MANAGED_START, MANAGED_END, block);
  }

  // The legacy PAI block is installer-owned, so replace it during v5→v7
  // migration while preserving every byte outside that marked region.
  const withoutLegacy = replaceMarkedBlock(existing, LEGACY_PAI_START, LEGACY_PAI_END, "");
  return withoutLegacy.trim()
    ? `${block}\n${withoutLegacy.trimStart()}`
    : block;
}

function managedAgentsBody(skillRoot: string): string {
  const template = readFileSync(join(skillRoot, "install", "CLAUDE.template.md"), "utf-8");
  const preamble = [
    "# LifeOS — Codex startup",
    "",
    "Before any work, read `$CODEX_HOME/LIFEOS/LIFEOS_SYSTEM_PROMPT.md` and follow it.",
    "Lifecycle verification marker: `LIFEOS_CODEX_NATIVE_V7`.",
    "Resolve all `LIFEOS/` paths below relative to `$CODEX_HOME`.",
    "",
  ].join("\n");
  return rewriteCodexPath(`${preamble}${template}`)
    .replace(/\bCLAUDE\.md\b/g, "AGENTS.md")
    .replace(/Claude Code/g, "Codex");
}

function upsertHooksFeature(content: string): string {
  const lines = content.split(/\r?\n/);
  const table = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
  if (table < 0) return `${content.trimEnd()}\n\n[features]\nhooks = true\n`;
  let end = lines.length;
  for (let i = table + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
    if (/^\s*hooks\s*=/.test(lines[i])) {
      lines[i] = "hooks = true";
      return `${lines.join("\n").trimEnd()}\n`;
    }
  }
  lines.splice(end, 0, "hooks = true");
  return `${lines.join("\n").trimEnd()}\n`;
}

function runTool(tool: string, args: string[]): unknown {
  const proc = Bun.spawnSync(["bun", tool, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString().trim();
  if (proc.exitCode !== 0) throw new Error(`${tool} exited ${proc.exitCode}: ${proc.stderr.toString().trim() || stdout}`);
  return stdout ? JSON.parse(stdout) : {};
}

function parseArgs(argv: string[]): {
  configRoot: string;
  configDir: string;
  skillRoot: string;
  apply: boolean;
  allowDev: boolean;
} {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : undefined;
  };
  const home = process.env.HOME || homedir();
  return {
    configRoot: value("--config-root") || process.env.CODEX_HOME || join(home, ".codex"),
    configDir: value("--config-dir") || process.env.LIFEOS_CONFIG_DIR || join(home, ".config", "LIFEOS"),
    skillRoot: value("--skill-root") || join(import.meta.dir, ".."),
    apply: argv.includes("--apply"),
    allowDev: argv.includes("--allow-dev"),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (detectDevTree(args.configRoot) && !args.allowDev) {
    console.log(JSON.stringify({ ok: false, refused: "dev-tree", configRoot: args.configRoot }, null, 2));
    process.exit(2);
  }

  const payloadHooksPath = join(args.skillRoot, "install", "hooks", "hooks.json");
  const templatePath = join(args.skillRoot, "install", "CLAUDE.template.md");
  if (!existsSync(payloadHooksPath) || !existsSync(templatePath)) {
    console.log(JSON.stringify({ ok: false, error: "LifeOS install payload is incomplete", payloadHooksPath, templatePath }, null, 2));
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(payloadHooksPath, "utf-8"));
  const converted = codexHooksFromLifeOS(payload.hooks);
  const report: Record<string, unknown> = {
    ok: true,
    dryRun: !args.apply,
    configRoot: args.configRoot,
    configDir: args.configDir,
    userTarget: join(args.configDir, "USER"),
    managedTargets: ["LIFEOS/", "skills/", "hooks/", "hooks.json", "AGENTS.md", "config.toml"],
    unsupportedEvents: converted.unsupportedEvents,
    unsupportedHandlers: converted.unsupportedHandlers,
  };
  if (!args.apply) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  mkdirSync(args.configRoot, { recursive: true });
  const common = ["--config-root", args.configRoot, "--skill-root", args.skillRoot, "--apply"];
  if (args.allowDev) common.push("--allow-dev");
  report.deployCore = runTool(join(import.meta.dir, "DeployCore.ts"), common);

  if (!existsSync(join(args.configDir, "USER"))) {
    report.scaffoldUser = runTool(join(import.meta.dir, "ScaffoldUser.ts"), [...common, "--config-dir", args.configDir]);
  } else {
    report.scaffoldUser = { skipped: true, reason: "external USER already exists" };
  }
  report.linkUser = runTool(join(import.meta.dir, "LinkUser.ts"), ["--config-root", args.configRoot, "--config-dir", args.configDir, "--apply", ...(args.allowDev ? ["--allow-dev"] : [])]);

  const hooksCopy = copyMissing(join(args.skillRoot, "install", "hooks"), join(args.configRoot, "hooks"));
  if (hooksCopy.failures.length > 0) throw new Error(hooksCopy.failures.join("\n"));
  report.hooksCopied = hooksCopy.copied;

  const hooksPath = join(args.configRoot, "hooks.json");
  let existingHooks: CodexHooks = {};
  if (existsSync(hooksPath)) {
    const parsed = JSON.parse(readFileSync(hooksPath, "utf-8"));
    // Normalize legacy HTTP/path entries in-place, but never discard existing
    // events merely because the current LifeOS payload does not emit them.
    const normalized = codexHooksFromLifeOS(parsed.hooks);
    existingHooks = normalized.hooks;
    for (const event of normalized.unsupportedEvents) {
      if (Array.isArray(parsed.hooks?.[event])) existingHooks[event] = parsed.hooks[event];
    }
  }
  atomicWriteText(hooksPath, `${JSON.stringify({ hooks: mergeNativeHooks(existingHooks, converted.hooks) }, null, 2)}\n`);

  const agentsPath = join(args.configRoot, "AGENTS.md");
  const existingAgents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf-8") : "";
  atomicWriteText(agentsPath, mergeManagedAgentsBlock(existingAgents, managedAgentsBody(args.skillRoot)));

  const configPath = join(args.configRoot, "config.toml");
  const existingConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  atomicWriteText(configPath, upsertHooksFeature(existingConfig));

  report.written = true;
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) main();
