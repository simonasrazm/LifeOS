import { homedir } from "node:os";
import { join } from "node:path";

export type LifeosHarness = "claude" | "codex";

/** Resolve the active harness without assuming CODEX_HOME has a conventional name. */
export function getHarnessKind(env: NodeJS.ProcessEnv = process.env): LifeosHarness {
  if (env.PAI_HARNESS === "codex" || env.CODEX_HOME) return "codex";
  return "claude";
}

export function getHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  if (getHarnessKind(env) === "codex") return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  return env.CLAUDE_HOME || join(env.HOME || homedir(), ".claude");
}

export function getLifeosDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIFEOS_DIR || join(getHarnessHome(env), "LIFEOS");
}
