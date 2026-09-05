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
    expect(args).toContain("gpt-5.5");
    expect(args).toContain('model_reasoning_effort="xhigh"');
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("claude");
  });

  test("recognizes and resolves a nonstandard Codex home", () => {
    const env = { HOME: "/tmp/home", CODEX_HOME: "/tmp/custom-harness" };
    expect(getHarnessKind(env)).toBe("codex");
    expect(getHarnessHome(env)).toBe("/tmp/custom-harness");
    expect(getLifeosDir(env)).toBe("/tmp/custom-harness/LIFEOS");
  });
});
