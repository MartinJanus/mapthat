import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { PlaceMention } from "../places/caption";

export type DiagnosticRecord = Readonly<Record<string, string | number>>;
export type DiagnosticLogger = (record: DiagnosticRecord) => void;
const context = new AsyncLocalStorage<DiagnosticRecord>();

export function withDiagnosticContext<T>(
  fields: DiagnosticRecord,
  action: () => T,
): T {
  return context.run({ ...context.getStore(), ...fields }, action);
}

export function createDiagnosticLogger(
  sink: DiagnosticLogger = () => {},
): DiagnosticLogger {
  return (record) => sink({ ...context.getStore(), ...record });
}

export function placeReference(mention: PlaceMention) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        mention.name,
        mention.city,
        mention.country,
        mention.addressHint,
      ]),
    )
    .digest("hex")
    .slice(0, 12);
}
