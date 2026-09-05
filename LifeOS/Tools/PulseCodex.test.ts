import { describe, expect, test } from "bun:test";

import { buildPulseCodexArgs } from "../install/LIFEOS/PULSE/codex";

describe("Pulse Codex invocation", () => {
  test("keeps generic background policy neutral by default", () => {
    const args = buildPulseCodexArgs({});
    expect(args).not.toContain("--model");
    expect(args).not.toContain("model_reasoning_effort");
    expect(args.at(-1)).toBe("-");
  });

  test("accepts explicit Codex policy overrides", () => {
    const args = buildPulseCodexArgs({
      LIFEOS_CODEX_MODEL: "custom-model",
      LIFEOS_CODEX_REASONING_EFFORT: "high",
    });
    expect(args).toContain("custom-model");
    expect(args).toContain('model_reasoning_effort="high"');
  });
});
