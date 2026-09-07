import { DomainError, ErrorCode } from "../types.js";
import type { SafeAdapterDefinition } from "./types.js";

const ADAPTER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export class StaticAdapterRegistry {
  readonly #definitions: ReadonlyMap<string, SafeAdapterDefinition>;
  readonly ids: readonly string[];

  constructor(definitions: readonly SafeAdapterDefinition[]) {
    const map = new Map<string, SafeAdapterDefinition>();
    for (const definition of definitions) {
      if (!ADAPTER_ID_RE.test(definition.id)) {
        throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Built-in adapter registry contains an invalid adapter id");
      }
      if (map.has(definition.id)) {
        throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Built-in adapter registry contains a duplicate adapter id");
      }
      map.set(definition.id, Object.freeze({ ...definition }));
    }
    this.ids = Object.freeze([...map.keys()].sort());
    this.#definitions = map;
    Object.freeze(this);
  }

  get(id: string): SafeAdapterDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Unknown built-in adapter id");
    }
    return definition;
  }
}
