import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("InstallHooks", () => {
  test("supports Git-backed installs without persistent native backups", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-hooks-no-backup-"));
    const configRoot = join(root, ".claude");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(join(configRoot, "settings.json"), '{"custom":true}\n');
    try {
      const proc = Bun.spawnSync([
        "bun", join(import.meta.dir, "InstallHooks.ts"),
        "--config-root", configRoot,
        "--skill-root", join(import.meta.dir, ".."),
        "--no-native-backup",
        "--apply",
      ], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      expect(readdirSync(configRoot).some((name) => name.startsWith("settings.json.lifeos-backup-"))).toBe(false);
      expect(existsSync(join(configRoot, "hooks", "LoadContext.hook.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
