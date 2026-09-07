import { DomainError, ErrorCode } from "../types.js";
import type { SafeAdapterCatalogOperation, SafeAdapterOperationDefinition } from "./operation-types.js";

const OPERATION_ID_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9_-]{0,63}$/;

export class SafeAdapterOperationRegistry {
  readonly #definitions: ReadonlyMap<string, SafeAdapterOperationDefinition>;
  readonly ids: readonly string[];

  constructor(definitions: readonly SafeAdapterOperationDefinition[]) {
    const map = new Map<string, SafeAdapterOperationDefinition>();
    for (const definition of definitions) {
      if (!OPERATION_ID_RE.test(definition.id)) {
        throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Safe adapter operation registry contains an invalid operation id");
      }
      const [adapterId] = definition.id.split(".");
      if (adapterId !== definition.adapterId) {
        throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Safe adapter operation registry contains an adapter id mismatch");
      }
      if ((definition.capability as string) === "control") {
        throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Control capability is not supported by adapter_gateway");
      }
      if (map.has(definition.id)) {
        throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Safe adapter operation registry contains a duplicate operation id");
      }
      const frozenInput = Object.freeze(definition.input.map((field) => Object.freeze({ ...field })));
      map.set(definition.id, Object.freeze({ ...definition, input: frozenInput }));
    }
    this.ids = Object.freeze([...map.keys()].sort());
    this.#definitions = map;
    Object.freeze(this);
  }

  get(id: string): SafeAdapterOperationDefinition {
    if (!OPERATION_ID_RE.test(id)) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Safe adapter operation id is invalid");
    }
    const definition = this.#definitions.get(id);
    if (!definition) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Unknown safe adapter operation");
    }
    return definition;
  }

  catalog(): { version: 1; operations: SafeAdapterCatalogOperation[] } {
    return {
      version: 1,
      operations: this.ids.map((id) => {
        const definition = this.#definitions.get(id)!;
        return {
          id: definition.id,
          adapter: definition.adapterId,
          capability: definition.capability,
          description: definition.description,
          input: definition.input,
        };
      }),
    };
  }
}
