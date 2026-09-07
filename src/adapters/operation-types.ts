import type { ToolContext } from "../types.js";

export type SafeAdapterOperationCapability = "read" | "verify" | "write" | "image" | "remote";

export interface SafeAdapterCatalogField {
  name: string;
  type: "string" | "integer" | "boolean" | "object";
  required: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
}

export interface SafeAdapterOperationContext {
  ctx: ToolContext;
  projectId: string;
  projectRoot: string;
}

export interface SafeAdapterOperationDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  adapterId: string;
  description: string;
  capability: SafeAdapterOperationCapability;
  input: readonly SafeAdapterCatalogField[];
  validateInput(argumentsValue: Record<string, unknown>): TInput;
  handler(context: SafeAdapterOperationContext, input: TInput): Promise<unknown> | unknown;
}

export interface SafeAdapterCatalogOperation {
  id: string;
  adapter: string;
  capability: SafeAdapterOperationCapability;
  description: string;
  input: readonly SafeAdapterCatalogField[];
}
