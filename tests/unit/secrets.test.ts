import { describe, expect, it } from "vitest";
import {
  buildSecretSource,
  chain,
  envSource,
  keychainSource,
} from "../../src/secrets/source.js";
import type { KeychainBackend } from "../../src/secrets/keychain.js";

function fakeBackend(
  store: Record<string, string>,
  available = true,
): KeychainBackend {
  return {
    name: "fake",
    available: () => available,
    get: (_s, k) => store[k] ?? null,
    set: (_s, k, v) => {
      store[k] = v;
    },
    unset: (_s, k) => {
      delete store[k];
    },
  };
}

describe("SecretSource", () => {
  it("envSource returns null for missing keys and value otherwise", () => {
    const e = envSource({ FOO: "bar" } as NodeJS.ProcessEnv);
    expect(e.get("FOO")).toBe("bar");
    expect(e.get("MISSING")).toBeNull();
  });

  it("envSource treats empty strings as missing", () => {
    const e = envSource({ FOO: "" } as NodeJS.ProcessEnv);
    expect(e.get("FOO")).toBeNull();
  });

  it("keychainSource returns null when backend is unavailable", () => {
    const k = keychainSource(fakeBackend({ FOO: "bar" }, false));
    expect(k.get("FOO")).toBeNull();
  });

  it("keychainSource returns the stored value when available", () => {
    const k = keychainSource(fakeBackend({ FOO: "bar" }));
    expect(k.get("FOO")).toBe("bar");
    expect(k.get("MISSING")).toBeNull();
  });

  it("chain falls through to the next source on null", () => {
    const c = chain(
      keychainSource(fakeBackend({})),
      envSource({ FOO: "from-env" } as NodeJS.ProcessEnv),
    );
    expect(c.get("FOO")).toBe("from-env");
  });

  it("chain prefers earlier sources", () => {
    const c = chain(
      keychainSource(fakeBackend({ FOO: "from-keychain" })),
      envSource({ FOO: "from-env" } as NodeJS.ProcessEnv),
    );
    expect(c.get("FOO")).toBe("from-keychain");
  });

  it("buildSecretSource('env') ignores the keychain", () => {
    const src = buildSecretSource(
      { PEBBLE_SECRETS_SOURCE: "env", FOO: "from-env" } as NodeJS.ProcessEnv,
      fakeBackend({ FOO: "from-keychain" }),
    );
    expect(src.get("FOO")).toBe("from-env");
  });

  it("buildSecretSource('keychain') uses the keychain only", () => {
    const src = buildSecretSource(
      { PEBBLE_SECRETS_SOURCE: "keychain", FOO: "from-env" } as NodeJS.ProcessEnv,
      fakeBackend({ FOO: "from-keychain" }),
    );
    expect(src.get("FOO")).toBe("from-keychain");
  });

  it("buildSecretSource('auto') tries keychain first, env fallback", () => {
    const backend = fakeBackend({});
    const src = buildSecretSource(
      { PEBBLE_SECRETS_SOURCE: "auto", FOO: "from-env" } as NodeJS.ProcessEnv,
      backend,
    );
    expect(src.get("FOO")).toBe("from-env");

    const src2 = buildSecretSource(
      { PEBBLE_SECRETS_SOURCE: "auto", FOO: "from-env" } as NodeJS.ProcessEnv,
      fakeBackend({ FOO: "from-keychain" }),
    );
    expect(src2.get("FOO")).toBe("from-keychain");
  });

  it("default mode (no env var) is env-only", () => {
    const src = buildSecretSource(
      { FOO: "from-env" } as NodeJS.ProcessEnv,
      fakeBackend({ FOO: "from-keychain" }),
    );
    expect(src.get("FOO")).toBe("from-env");
  });
});
