import { PYTHON_SAFE_ADAPTER } from "../python/runtime-profiles.js";
import { SQLITE_SAFE_ADAPTER } from "../database/sqlite-profiles.js";
import { StaticAdapterRegistry } from "./registry.js";

export const BUILT_IN_ADAPTERS = Object.freeze([PYTHON_SAFE_ADAPTER, SQLITE_SAFE_ADAPTER] as const);
export const builtInAdapterRegistry = new StaticAdapterRegistry(BUILT_IN_ADAPTERS);
