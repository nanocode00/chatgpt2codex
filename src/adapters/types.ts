export type AdapterCapability = "read" | "verify" | "write" | "image" | "remote";

export interface OperatorProfileSet<T> {
  aliases: string[];
  profiles: Map<string, T>;
}

export interface OperatorProfileSpec<T> {
  envName: string;
  reservedAliases?: readonly string[];
  parseValue(value: unknown): T;
  configError(message: string): Error;
}

export interface SafeAdapterOperationMetadata {
  capabilities: readonly AdapterCapability[];
}

export interface SafeAdapterDefinition<TProfile = unknown> {
  id: string;
  description?: string;
  profiles?: OperatorProfileSpec<TProfile>;
  operations?: Readonly<Record<string, SafeAdapterOperationMetadata>>;
}
