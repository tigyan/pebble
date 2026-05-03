import { spawnSync } from "node:child_process";

/**
 * OS keychain backend. Implementations shell out to platform tools:
 *   - macOS: `security` (built in)
 *   - Linux: `secret-tool` (libsecret; usually packaged as `libsecret-tools`)
 *
 * Service name is fixed to "pebble" so all values cluster under one entry
 * type. Account is the env-var key (e.g. PEBBLE_INGEST_SECRET).
 *
 * Failure mode: if the backend is unavailable (CLI missing, locked
 * keychain, dbus session down on Linux), `available()` returns false and
 * `get()` returns `null`. Callers fall back to .env / process.env.
 *
 * Privacy: secret values are passed via argv on macOS (no other safe
 * option for `security` non-interactively) and via stdin on Linux. They
 * are NEVER logged.
 */
export interface KeychainBackend {
  name: string;
  available(): boolean;
  get(service: string, account: string): string | null;
  set(service: string, account: string, secret: string): void;
  unset(service: string, account: string): void;
}

export const KEYCHAIN_SERVICE = "pebble";

export function detectKeychainBackend(): KeychainBackend {
  if (process.platform === "darwin") return new MacOSKeychain();
  if (process.platform === "linux") return new SecretToolKeychain();
  return new UnsupportedKeychain(process.platform);
}

class MacOSKeychain implements KeychainBackend {
  name = "macos-security";
  available(): boolean {
    const r = spawnSync("security", ["-h"], { stdio: "ignore" });
    return r.status === 0 || r.status === 1; // -h prints help and exits 1 on some versions
  }
  get(service: string, account: string): string | null {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) return null;
    return r.stdout.replace(/\n$/, "");
  }
  set(service: string, account: string, secret: string): void {
    const r = spawnSync(
      "security",
      ["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (r.status !== 0) {
      throw new Error(
        `security add-generic-password failed (${r.status}): ${r.stderr?.toString().trim()}`,
      );
    }
  }
  unset(service: string, account: string): void {
    const r = spawnSync("security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      account,
    ]);
    if (r.status !== 0 && r.status !== 44) {
      // 44 == errSecItemNotFound — treat as no-op.
      throw new Error(
        `security delete-generic-password failed (${r.status}): ${r.stderr?.toString().trim()}`,
      );
    }
  }
}

class SecretToolKeychain implements KeychainBackend {
  name = "linux-secret-tool";
  available(): boolean {
    const r = spawnSync("secret-tool", ["--help"], { stdio: "ignore" });
    return r.status === 0;
  }
  get(service: string, account: string): string | null {
    const r = spawnSync(
      "secret-tool",
      ["lookup", "service", service, "account", account],
      { encoding: "utf8" },
    );
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.replace(/\n$/, "");
  }
  set(service: string, account: string, secret: string): void {
    const r = spawnSync(
      "secret-tool",
      [
        "store",
        "--label",
        `pebble: ${account}`,
        "service",
        service,
        "account",
        account,
      ],
      { input: secret, encoding: "utf8" },
    );
    if (r.status !== 0) {
      throw new Error(`secret-tool store failed (${r.status}): ${r.stderr?.trim()}`);
    }
  }
  unset(service: string, account: string): void {
    const r = spawnSync("secret-tool", [
      "clear",
      "service",
      service,
      "account",
      account,
    ]);
    if (r.status !== 0) {
      throw new Error(`secret-tool clear failed (${r.status}): ${r.stderr?.toString().trim()}`);
    }
  }
}

class UnsupportedKeychain implements KeychainBackend {
  name: string;
  constructor(platform: string) {
    this.name = `unsupported-${platform}`;
  }
  available(): boolean {
    return false;
  }
  get(): string | null {
    return null;
  }
  set(): void {
    throw new Error(`OS keychain not supported on ${process.platform}`);
  }
  unset(): void {
    throw new Error(`OS keychain not supported on ${process.platform}`);
  }
}
