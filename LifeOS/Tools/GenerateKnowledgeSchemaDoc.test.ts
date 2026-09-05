import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("GenerateKnowledgeSchemaDoc runtime root", () => {
  test("writes beneath LIFEOS_DIR instead of hardcoded ~/.claude", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-schema-root-"));
    roots.push(root);
    mkdirSync(join(root, "MEMORY", "KNOWLEDGE"), { recursive: true });
    const script = join(import.meta.dir, "..", "install", "LIFEOS", "TOOLS", "GenerateKnowledgeSchemaDoc.ts");
    const proc = Bun.spawnSync(["bun", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LIFEOS_DIR: root },
    });

    expect(proc.exitCode).toBe(0);
    expect(existsSync(join(root, "MEMORY", "KNOWLEDGE", "_schema.md"))).toBe(true);
  });
});
