import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { SecretSource } from "../../src/secrets/source.js";

const stubSecrets: SecretSource = {
  get: (key) =>
    key === "PEBBLE_INGEST_SECRET" ? "x".repeat(32) : null,
};

describe("loadConfig vault path expansion", () => {
  it("expands a leading ~/ to the home directory", () => {
    const cfg = loadConfig(
      { PEBBLE_VAULT_PATH: "~/SomeVault" } as NodeJS.ProcessEnv,
      stubSecrets,
    );
    expect(cfg.vaultPath).toBe(path.join(os.homedir(), "SomeVault"));
    expect(cfg.dbPath).toBe(
      path.join(os.homedir(), "SomeVault", "_System", "pebble.sqlite"),
    );
  });

  it("expands a bare ~ to the home directory", () => {
    const cfg = loadConfig(
      { PEBBLE_VAULT_PATH: "~" } as NodeJS.ProcessEnv,
      stubSecrets,
    );
    expect(cfg.vaultPath).toBe(os.homedir());
  });

  it("leaves absolute paths untouched", () => {
    const cfg = loadConfig(
      { PEBBLE_VAULT_PATH: "/tmp/vault" } as NodeJS.ProcessEnv,
      stubSecrets,
    );
    expect(cfg.vaultPath).toBe("/tmp/vault");
  });

  it("does not expand ~ that's not at the start", () => {
    const cfg = loadConfig(
      { PEBBLE_VAULT_PATH: "/tmp/~vault" } as NodeJS.ProcessEnv,
      stubSecrets,
    );
    expect(cfg.vaultPath).toBe("/tmp/~vault");
  });

  it("expands ~/ in PEBBLE_DB_PATH override too", () => {
    const cfg = loadConfig(
      {
        PEBBLE_VAULT_PATH: "/tmp/vault",
        PEBBLE_DB_PATH: "~/pebble.sqlite",
      } as NodeJS.ProcessEnv,
      stubSecrets,
    );
    expect(cfg.dbPath).toBe(path.join(os.homedir(), "pebble.sqlite"));
  });
});
