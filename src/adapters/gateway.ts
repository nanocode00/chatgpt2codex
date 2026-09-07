import { DomainError, ErrorCode } from "../types.js";

const ARGUMENT_BYTES_MAX = 64 * 1024;
const ARGUMENT_DEPTH_MAX = 8;
const ARGUMENT_KEYS_MAX = 64;
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function invalid(message: string): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, message);
}

export function validateGatewayArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("adapter_gateway arguments must be a JSON object");
  const rootPrototype = Object.getPrototypeOf(value);
  if (rootPrototype !== Object.prototype && rootPrototype !== null) invalid("adapter_gateway arguments must be a plain JSON object");
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid("adapter_gateway arguments must contain only JSON values");
  }
  if (Buffer.byteLength(serialized!, "utf8") > ARGUMENT_BYTES_MAX) invalid("adapter_gateway arguments exceed the 64 KiB limit");

  let keys = 0;
  const visit = (node: unknown, depth: number): void => {
    if (depth > ARGUMENT_DEPTH_MAX) invalid("adapter_gateway arguments exceed the nesting depth limit");
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) invalid("adapter_gateway arguments must contain only finite JSON numbers");
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") invalid("adapter_gateway arguments must contain only JSON values");
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) invalid("adapter_gateway arguments must contain only plain JSON objects");
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      keys++;
      if (keys > ARGUMENT_KEYS_MAX) invalid("adapter_gateway arguments exceed the total key limit");
      if (BLOCKED_KEYS.has(key)) invalid("adapter_gateway arguments contain a prohibited key");
      visit(child, depth + 1);
    }
  };
  visit(value, 1);
  return value as Record<string, unknown>;
}
