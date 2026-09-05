#!/usr/bin/env bun
/**
 * InstallCodex — native Codex adapter for the LifeOS bare-skill payload.
 *
 * Composes the existing additive core/USER deployment tools, then installs the
 * Codex-owned surfaces: AGENTS.md, hooks.json, config.toml, and hook scripts.
 * Dry-run is the default. Existing user text and custom hook entries are
 * preserved; the adapter replaces only its marked AGENTS block, registrations,
 * and hook payload files.
 */

import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { detectDevTree } from "./InstallEngine";
import { atomicWriteText } from "./lib/atomic-write";

const MANAGED_START = "<!-- LifeOS managed: start -->";
const MANAGED_END = "<!-- LifeOS managed: end -->";
const LEGACY_PAI_START = "<!-- PAI managed instructions: start -->";
const LEGACY_PAI_END = "<!-- PAI managed instructions: end -->";
const RUNTIME_STATE = new Set(["USER", "MEMORY", "node_modules", ".git"]);

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

function wrapCodexCommand(command: string, lifeosDir = "$CODEX_HOME/LIFEOS"): string {
  const lifeosExport = lifeosDir === "$CODEX_HOME/LIFEOS"
    ? 'export LIFEOS_DIR="$CODEX_HOME/LIFEOS"'
    : `export LIFEOS_DIR=${shellQuote(lifeosDir)}`;
  const script = [
    'export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"',
    'export PAI_HARNESS=codex',
    lifeosExport,
    'export CLAUDE_PLUGIN_ROOT="$CODEX_HOME"',
    command,
  ].join('; ');
  return `bash -lc ${shellQuote(script)}`;
}

export function rewriteCodexPath(value: string): string {
  return value
    .replace(/\$HOME\/\.claude(?=\/|$)/g, "$CODEX_HOME")
    .replace(/\$\{HOME\}\/\.claude(?=\/|$)/g, "$CODEX_HOME")
    .replace(/~\/\.claude(?=\/|$)/g, "$CODEX_HOME");
}

function mapMatcher(matcher: string | undefined): string | undefined {
  if (!matcher) return matcher;
  const mapped = matcher
    .split("|")
    .map((part) => MATCHER_MAP[part] ?? part)
    .filter((part, index, all) => all.indexOf(part) === index);
  return mapped.join("|");
}

function convertHook(hook: CodexHook, lifeosDir?: string): CodexHook | undefined {
  if (hook.type === "http" && typeof hook.url === "string" && hook.url) {
    const request = `curl -sS -m 2 -X POST ${shellQuote(hook.url)} -H ${shellQuote("Content-Type: application/json")} --data-binary @- || true`;
    const converted: CodexHook = {
      ...hook,
      type: "command",
      command: wrapCodexCommand(request, lifeosDir),
    };
    delete converted.url;
    return converted;
  }
  if ((hook.type === undefined || hook.type === "command") && typeof hook.command === "string") {
    return { ...hook, type: "command", command: wrapCodexCommand(rewriteCodexPath(hook.command), lifeosDir) };
  }
  if (hook.type === "mcp_tool") return { ...hook };
  return undefined;
}

/** Finite conversion of the lifecycle surface Codex currently supports. */
export function codexHooksFromLifeOS(source: unknown, lifeosDir?: string): {
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
        const hook = convertHook(hookValue as CodexHook, lifeosDir);
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

/** Normalize only the one handler form Codex rejects; preserve everything else. */
export function normalizeExistingCodexHooks(source: unknown): CodexHooks {
  const input = typeof source === "object" && source !== null ? source as Record<string, unknown> : {};
  const normalized: CodexHooks = {};
  for (const [event, groupsValue] of Object.entries(input)) {
    if (!Array.isArray(groupsValue)) continue;
    normalized[event] = groupsValue.map((groupValue) => {
      const group = typeof groupValue === "object" && groupValue !== null ? groupValue as Record<string, unknown> : {};
      const hooks = Array.isArray(group.hooks)
        ? group.hooks.map((hookValue) => {
            if (typeof hookValue !== "object" || hookValue === null) return hookValue as CodexHook;
            const hook = hookValue as CodexHook;
            return hook.type === "http" ? (convertHook(hook) ?? { ...hook }) : { ...hook };
          })
        : [];
      return {
        ...group,
        matcher: mapMatcher(typeof group.matcher === "string" ? group.matcher : undefined),
        hooks,
      } as CodexHookGroup;
    });
  }
  return normalized;
}

export function mergeCodexHooksDocument(document: unknown, incoming: CodexHooks): Record<string, unknown> {
  const existing = typeof document === "object" && document !== null
    ? JSON.parse(JSON.stringify(document)) as Record<string, unknown>
    : {};
  const normalized = normalizeExistingCodexHooks(existing.hooks);
  if (Object.keys(incoming).length > 0) {
    // Reinstallation replaces this adapter's prior registrations instead of
    // accumulating quote/layout variants. Custom registrations are untouched.
    for (const [event, groups] of Object.entries(normalized)) {
      normalized[event] = groups.map((group) => ({
        ...group,
        hooks: group.hooks.filter((hook) => {
          const command = typeof hook.command === "string" ? hook.command : "";
          return !command.includes("PAI_HARNESS=codex")
            && !command.includes("localhost:31337/hooks/skill-guard")
            && !command.includes("localhost:31337/hooks/agent-guard");
        }),
      })).filter((group) => group.hooks.length > 0);
      if (normalized[event].length === 0) delete normalized[event];
    }
  }
  const consolidated = mergeNativeHooks({}, normalized);
  return { ...existing, hooks: mergeNativeHooks(consolidated, incoming) };
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

function managedAgentsBody(skillRoot: string, lifeosDir: string, configRoot: string): string {
  const template = readFileSync(join(skillRoot, "install", "CLAUDE.template.md"), "utf-8");
  const routedLifeosDir = resolve(lifeosDir) === resolve(join(configRoot, "LIFEOS"))
    ? "${CODEX_HOME:-$HOME/.codex}/LIFEOS"
    : lifeosDir;
  const preamble = [
    "# LifeOS — Codex startup",
    "",
    "Resolve Codex home as `${CODEX_HOME:-$HOME/.codex}`; never pass an unset `$CODEX_HOME` to shell commands.",
    `The canonical LifeOS runtime is \`${routedLifeosDir}\`; it may be shared by multiple harness adapters.`,
    `Before any work, read \`${routedLifeosDir}/LIFEOS_SYSTEM_PROMPT.md\` and follow it.`,
    `Resolve all \`LIFEOS/\` paths below relative to \`${routedLifeosDir}\`.`,
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

function overlayRuntime(skillRoot: string, lifeosDir: string): number {
  const sourceRoot = join(skillRoot, "install", "LIFEOS");
  let overlaid = 0;
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (RUNTIME_STATE.has(entry.name)) continue;
    cpSync(join(sourceRoot, entry.name), join(lifeosDir, entry.name), {
      recursive: true,
      force: true,
    });
    overlaid++;
  }
  return overlaid;
}

function prepareLifeosLink(configRoot: string, lifeosDir: string, apply: boolean): { action: string; adapterPath: string; target: string } {
  const adapterPath = join(configRoot, "LIFEOS");
  const normalizedAdapter = resolve(adapterPath);
  const normalizedTarget = resolve(lifeosDir);
  if (!isAbsolute(lifeosDir) || normalizedTarget === "/") {
    throw new Error(`unsafe LifeOS root: ${lifeosDir}`);
  }
  if (normalizedAdapter === normalizedTarget) {
    return { action: "adapter-local", adapterPath, target: normalizedTarget };
  }
  if (existsSync(adapterPath)) {
    if (realpathSync(adapterPath) !== normalizedTarget) {
      throw new Error(`${adapterPath} does not resolve to configured LifeOS root ${normalizedTarget}`);
    }
    return { action: "already-linked", adapterPath, target: normalizedTarget };
  }
  if (apply) {
    mkdirSync(normalizedTarget, { recursive: true });
    symlinkSync(normalizedTarget, adapterPath, "dir");
  }
  return { action: apply ? "linked" : "would-link", adapterPath, target: normalizedTarget };
}

function parseArgs(argv: string[]): {
  configRoot: string;
  configDir: string;
  skillRoot: string;
  lifeosDir: string;
  apply: boolean;
  allowDev: boolean;
  nativeBackup: boolean;
} {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : undefined;
  };
  const home = process.env.HOME || homedir();
  const configRoot = value("--config-root") || process.env.CODEX_HOME || join(home, ".codex");
  return {
    configRoot,
    configDir: value("--config-dir") || process.env.LIFEOS_CONFIG_DIR || join(home, ".config", "LIFEOS"),
    skillRoot: value("--skill-root") || join(import.meta.dir, ".."),
    lifeosDir: value("--lifeos-dir") || join(configRoot, "LIFEOS"),
    apply: argv.includes("--apply"),
    allowDev: argv.includes("--allow-dev"),
    nativeBackup: !argv.includes("--no-native-backup"),
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
  const systemPromptSource = join(args.skillRoot, "install", "LIFEOS", "LIFEOS_SYSTEM_PROMPT.md");
  const versionSource = join(args.skillRoot, "install", "LIFEOS", "VERSION");
  if (!existsSync(payloadHooksPath) || !existsSync(templatePath) || !existsSync(systemPromptSource) || !existsSync(versionSource)) {
    console.log(JSON.stringify({ ok: false, error: "LifeOS install payload is incomplete", payloadHooksPath, templatePath, systemPromptSource, versionSource }, null, 2));
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(payloadHooksPath, "utf-8"));
  const converted = codexHooksFromLifeOS(payload.hooks, args.lifeosDir);
  if (args.apply) mkdirSync(args.configRoot, { recursive: true });
  const runtimeLink = prepareLifeosLink(args.configRoot, args.lifeosDir, args.apply);
  const report: Record<string, unknown> = {
    ok: true,
    dryRun: !args.apply,
    configRoot: args.configRoot,
    configDir: args.configDir,
    lifeosDir: args.lifeosDir,
    runtimeLink,
    userTarget: join(args.configDir, "USER"),
    managedTargets: ["LIFEOS", "skills/", "hooks/", "hooks.json", "AGENTS.md", "config.toml", ".pai-adapter.json"],
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

  // Runtime code and doctrine are release-owned. DeployCore creates missing
  // files; this overlay makes upgrades real while USER, MEMORY, and installed
  // dependencies remain untouched in the neutral root.
  report.runtimeEntriesOverlayApplied = overlayRuntime(args.skillRoot, args.lifeosDir);

  // ScaffoldUser is additive: copyMissing never overwrites existing USER data.
  // Always run it so an older populated USER tree receives newly-required
  // schema paths during upgrades instead of remaining permanently incomplete.
  report.scaffoldUser = runTool(join(import.meta.dir, "ScaffoldUser.ts"), [...common, "--config-dir", args.configDir]);
  report.linkUser = runTool(join(import.meta.dir, "LinkUser.ts"), ["--config-root", args.configRoot, "--config-dir", args.configDir, "--apply", ...(args.allowDev ? ["--allow-dev"] : [])]);

  // Hook sources are adapter-owned payload, not user state. Overlay them so an
  // upgrade actually activates fixes while leaving non-payload custom files.
  cpSync(join(args.skillRoot, "install", "hooks"), join(args.configRoot, "hooks"), {
    recursive: true,
    force: true,
  });
  report.hooksOverlayApplied = true;

  if (args.nativeBackup) {
    const backupDir = join(args.configRoot, ".lifeos-backups", `codex-${Date.now()}`);
    mkdirSync(backupDir, { recursive: true });
    for (const name of ["hooks.json", "AGENTS.md", "config.toml"]) {
      const source = join(args.configRoot, name);
      if (existsSync(source)) copyFileSync(source, join(backupDir, name));
    }
    report.nativeBackup = backupDir;
  } else {
    report.nativeBackup = { skipped: true, reason: "--no-native-backup" };
  }

  const hooksPath = join(args.configRoot, "hooks.json");
  let hooksDocument: Record<string, unknown> = {};
  if (existsSync(hooksPath)) {
    hooksDocument = JSON.parse(readFileSync(hooksPath, "utf-8"));
  }
  atomicWriteText(hooksPath, `${JSON.stringify(mergeCodexHooksDocument(hooksDocument, converted.hooks), null, 2)}\n`);

  const agentsPath = join(args.configRoot, "AGENTS.md");
  const existingAgents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf-8") : "";
  atomicWriteText(agentsPath, mergeManagedAgentsBlock(existingAgents, managedAgentsBody(args.skillRoot, args.lifeosDir, args.configRoot)));

  const configPath = join(args.configRoot, "config.toml");
  const existingConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  atomicWriteText(configPath, upsertHooksFeature(existingConfig));

  const version = readFileSync(versionSource, "utf-8").trim();
  atomicWriteText(join(args.configRoot, ".pai-adapter.json"), `${JSON.stringify({
    schemaVersion: 1,
    harness: "codex",
    paiVersion: version,
    lifeosVersion: version,
    paiDir: args.lifeosDir,
    lifeosDir: args.lifeosDir,
    harnessHome: args.configRoot,
    managedFiles: ["config.toml", "hooks.json", "AGENTS.md", "LIFEOS"],
    updatedAt: new Date().toISOString(),
    validation: { status: "valid", checkedAt: new Date().toISOString(), issues: [] },
  }, null, 2)}\n`);

  report.written = true;
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) main();
