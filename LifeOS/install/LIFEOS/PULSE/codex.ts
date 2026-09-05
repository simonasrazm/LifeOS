export function buildPulseCodexArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const model = env.LIFEOS_CODEX_MODEL || "gpt-5.5"
  const reasoningEffort = env.LIFEOS_CODEX_REASONING_EFFORT || "xhigh"
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--color", "never",
    "--model", model,
    "--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    "-",
  ]
}
