import { describe, expect, test } from "bun:test";

import { buildPulseCodexArgs } from "../install/LIFEOS/PULSE/codex";

describe("Pulse Codex invocation", () => {
  test("pins Sami's default background model and reasoning effort", () => {
    const args = buildPulseCodexArgs({});
    expect(args).toContain("gpt-5.5");
    expect(args).toContain('model_reasoning_effort="xhigh"');
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
