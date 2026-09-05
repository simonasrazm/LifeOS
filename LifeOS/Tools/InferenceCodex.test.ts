import { describe, expect, test } from "bun:test";

import { buildCodexInferenceArgs } from "../install/LIFEOS/TOOLS/Inference";
import { getHarnessKind, getHarnessHome, getLifeosDir } from "../install/LIFEOS/TOOLS/lib/runtime-paths";

describe("Inference Codex invocation", () => {
  test("uses noninteractive ephemeral read-only Codex execution", () => {
    const args = buildCodexInferenceArgs({ systemPrompt: "system", userPrompt: "user" });
    expect(args.slice(0, 7)).toEqual([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--color",
    ]);
    expect(args).toContain("developer_instructions=\"system\"");
    expect(args).not.toContain("--model");
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("claude");
  });

  test("accepts background policy from the integration environment", () => {
    const previousModel = process.env.LIFEOS_CODEX_MODEL;
    const previousEffort = process.env.LIFEOS_CODEX_REASONING_EFFORT;
    process.env.LIFEOS_CODEX_MODEL = "integration-model";
    process.env.LIFEOS_CODEX_REASONING_EFFORT = "high";
    try {
      const args = buildCodexInferenceArgs({ systemPrompt: "system", userPrompt: "user" });
      expect(args).toContain("integration-model");
      expect(args).toContain('model_reasoning_effort="high"');
    } finally {
      if (previousModel === undefined) delete process.env.LIFEOS_CODEX_MODEL;
      else process.env.LIFEOS_CODEX_MODEL = previousModel;
      if (previousEffort === undefined) delete process.env.LIFEOS_CODEX_REASONING_EFFORT;
      else process.env.LIFEOS_CODEX_REASONING_EFFORT = previousEffort;
    }
  });

  test("recognizes and resolves a nonstandard Codex home", () => {
    const env = { HOME: "/tmp/home", CODEX_HOME: "/tmp/custom-harness" };
    expect(getHarnessKind(env)).toBe("codex");
    expect(getHarnessHome(env)).toBe("/tmp/custom-harness");
    expect(getLifeosDir(env)).toBe("/tmp/custom-harness/LIFEOS");
  });
});
