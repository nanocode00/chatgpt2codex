import type { RuntimeInstanceRecord } from "./instances.js";
import {
  isProcessAlive,
  listRuntimeInstances,
  runtimeProcessMatchesRecord,
} from "./instances.js";
import { requestWindowsReloadControl } from "./windows-reload.js";

export interface RuntimeCatalogReloadFailure {
  instance: string;
  pid: number;
  error: string;
}

export interface RuntimeCatalogReloadSummary {
  supported: boolean;
  restartRequired: boolean;
  reloaded: string[];
  notRunning: string[];
  failed: RuntimeCatalogReloadFailure[];
}

interface RuntimeReloadDeps {
  platform?: NodeJS.Platform;
  listInstances?: typeof listRuntimeInstances;
  processAlive?: typeof isProcessAlive;
  processMatches?: typeof runtimeProcessMatchesRecord;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  stateDir?: string;
  windowsRequest?: typeof requestWindowsReloadControl;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function signalRuntimeCatalogReload(
  record: RuntimeInstanceRecord,
  deps: RuntimeReloadDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux" && platform !== "win32") {
    throw new Error("c2c reload requires Linux/WSL or Windows");
  }
  const alive = deps.processAlive ?? isProcessAlive;
  if (!alive(record.pid)) throw new Error("instance is not running: " + record.name);
  const matches = deps.processMatches ?? runtimeProcessMatchesRecord;
  if (!(await matches(record))) {
    throw new Error("refusing reload because the recorded pid could not be verified as this c2c instance");
  }
  if (platform === "win32") {
    if (!deps.stateDir) throw new Error("Windows reload requires the instance state directory");
    await (deps.windowsRequest ?? requestWindowsReloadControl)(deps.stateDir, record);
    return;
  }
  (deps.signal ?? process.kill)(record.pid, "SIGHUP");
}

export async function reloadRunningRuntimeCatalogs(
  stateDir: string,
  deps: RuntimeReloadDeps = {},
): Promise<RuntimeCatalogReloadSummary> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux" && platform !== "win32") {
    return {
      supported: false,
      restartRequired: true,
      reloaded: [],
      notRunning: [],
      failed: [],
    };
  }

  const list = deps.listInstances ?? listRuntimeInstances;
  const alive = deps.processAlive ?? isProcessAlive;
  const records = await list(stateDir);
  const summary: RuntimeCatalogReloadSummary = {
    supported: true,
    restartRequired: false,
    reloaded: [],
    notRunning: [],
    failed: [],
  };

  for (const record of records) {
    if (!alive(record.pid)) {
      summary.notRunning.push(record.name);
      continue;
    }
    try {
      await signalRuntimeCatalogReload(record, { ...deps, platform, stateDir, processAlive: alive });
      summary.reloaded.push(record.name);
    } catch (error) {
      summary.failed.push({
        instance: record.name,
        pid: record.pid,
        error: errorMessage(error),
      });
    }
  }

  return summary;
}
