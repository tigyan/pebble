import type { IngestPayload, IngestionAdapter } from "../types/index.js";
import { IngestPayloadSchema } from "../types/index.js";
import { shortcutsAdapter } from "./shortcuts.js";
import { bluebubblesAdapter } from "./bluebubbles.js";
import { pebbleBridgeAdapter } from "./pebble-bridge.js";
import { sendblueAdapter } from "./sendblue.js";
import { manualAdapter } from "./manual.js";

export const ADAPTERS: IngestionAdapter[] = [
  pebbleBridgeAdapter,
  bluebubblesAdapter,
  sendblueAdapter,
  shortcutsAdapter,
  manualAdapter, // catch-all, MUST be last
];

/** Pick the first adapter whose .matches() returns true. */
export function pickAdapter(
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): IngestionAdapter {
  for (const a of ADAPTERS) {
    if (a.matches(headers, body)) return a;
  }
  // Should not happen — manualAdapter matches everything — but keep TS happy.
  return manualAdapter;
}

export function normalize(
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): { adapter: string; payload: IngestPayload } {
  const adapter = pickAdapter(headers, body);
  const payload = IngestPayloadSchema.parse(adapter.normalize(body));
  return { adapter: adapter.name, payload };
}
