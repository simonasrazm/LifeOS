import { describe, expect, test } from "bun:test";

import { buildCodexInferenceArgs } from "../install/LIFEOS/TOOLS/Inference";

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
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("claude");
  });
});
