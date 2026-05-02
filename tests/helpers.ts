import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function makeTempVault(prefix = "pebble-test-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

export async function rmRf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
