import {
  detectKeychainBackend,
  KEYCHAIN_SERVICE,
  type KeychainBackend,
} from "./keychain.js";

/**
 * SecretSource resolves env-var-style keys to values. The first source that
 * returns a non-null value wins. Used by `loadConfig()` so Pebble can read
 * `PEBBLE_INGEST_SECRET` / API keys from the OS keychain when the user has
 * opted in via `PEBBLE_SECRETS_SOURCE`.
 */
export interface SecretSource {
  name: string;
  get(key: string): string | null;
}

export function envSource(env: NodeJS.ProcessEnv): SecretSource {
  return {
    name: "env",
    get: (k) => {
      const v = env[k];
      return v && v.length ? v : null;
    },
  };
}

export function keychainSource(backend: KeychainBackend): SecretSource {
  return {
    name: `keychain:${backend.name}`,
    get: (k) =>
      backend.available() ? backend.get(KEYCHAIN_SERVICE, k) : null,
  };
}

export function chain(...sources: SecretSource[]): SecretSource {
  return {
    name: sources.map((s) => s.name).join("→"),
    get(k) {
      for (const s of sources) {
        const v = s.get(k);
        if (v != null && v.length) return v;
      }
      return null;
    },
  };
}

/**
 * Build the SecretSource implied by `PEBBLE_SECRETS_SOURCE`:
 *   - "env" (default): only .env / process.env
 *   - "keychain": keychain only — fails closed if backend unavailable
 *   - "auto": keychain first, env fallback (recommended for opt-in users)
 */
export function buildSecretSource(
  env: NodeJS.ProcessEnv,
  backend: KeychainBackend = detectKeychainBackend(),
): SecretSource {
  const mode = (env.PEBBLE_SECRETS_SOURCE ?? "env").toLowerCase();
  const e = envSource(env);
  if (mode === "env") return e;
  if (mode === "keychain") return keychainSource(backend);
  if (mode === "auto") return chain(keychainSource(backend), e);
  return e;
}
