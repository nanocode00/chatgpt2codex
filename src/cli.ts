#!/usr/bin/env node
/**
 * chatgpt2codex CLI entrypoint.
 *
 * Minimal hand-rolled argv parsing (no commander dependency) for the three
 * MVP subcommands defined in PRD §5:
 *
 *   chatgpt2codex serve  --workspace <path>
 *   chatgpt2codex init   --workspace <path>
 *   chatgpt2codex doctor
 */

import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config, LeasePreset, ProjectRegistryEntry, ToolContext } from "./types.js";
import { findProject, scanWorkspace } from "./workspace/registry.js";
import { makeLease } from "./workspace/project-select.js";
import { Store } from "./state/store.js";
import { Ledger } from "./state/ledger.js";
import { createServer } from "./server/mcp-server.js";
import { createHttpServer, defaultHttpServerConfig } from "./server/http.js";
import { generateOwnerToken, hasOwnerToken, storeOwnerToken } from "./auth/owner-token.js";
import { JsonOAuthStore } from "./auth/oauth-store.js";
import { checkIntakeAvailability } from "./assets/image-intake.js";
import { controlAllowlist, isAppAllowed, isControlEnabled, isSensitiveApp } from "./control/policy.js";
import { startExecutor } from "./control/executor.js";
import { approveAction, isKilled, listActions, rejectAction, setKill, toSummary } from "./control/queue.js";
import { preflightPermissions } from "./control/mac-input.js";
import { clampMinutes, clearAuto, readAuto, setAuto, type AutoActionKind } from "./control/auto.js";
import {
  isProcessAlive,
  listRuntimeInstances,
  normalizeInstanceName,
  readRuntimeInstance,
  removeRuntimeInstance,
  writeRuntimeInstance,
} from "./runtime/instances.js";
import {
  getRuntimeSecret,
  listRuntimeSecrets,
  loadRuntimeEnvironment,
  readRuntimeConfig,
  removeRuntimeSecret,
  resolveRuntimeSettingsWithLegacy,
  setRuntimeConfigValue,
  setRuntimeSecret,
  settingsFromEnvironment,
  unsetRuntimeConfigValue,
  writeRuntimeConfig,
  type TunnelMode,
} from "./runtime/config.js";

const execFileAsync = promisify(execFile);

interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string | boolean>;
  /** Non-flag arguments after the command, e.g. `control approve <actionId>`. */
  positional: string[];
}

function printHelp(): void {
  console.log([
    "c2c — ChatGPT To Codex local coding runtime",
    "",
    "Usage:",
    "  c2c <command> [options]",
    "",
    "Runtime:",
    "  start       Start an HTTP c2c instance in the background",
    "  stop        Stop an instance",
    "  restart     Restart an instance",
    "  status      Show one or all running instances",
    "  health      Check whether an instance is alive and responding",
    "  serve       Run the MCP server in the foreground",
    "",
    "Setup / diagnostics:",
    "  init        Initialize workspace state and owner token",
    "  doctor      Check runtime dependencies and configuration",
    "  config      Show or update persistent non-secret runtime settings",
    "  secret      Manage persistent runtime secrets",
    "  owner-token Manage the HTTP owner token",
    "  control     Manage local desktop-control approvals",
    "",
    "Common options:",
    "  --instance <name>   Runtime instance name (default: default)",
    "  --workspace <path>  Workspace root",
    "  --port <port>       HTTP port; start auto-selects one when not otherwise configured",
    "  --tunnel <mode>     none or cloudflare",
    "  --help              Show this help",
    "",
    "Examples:",
    "  c2c start --workspace ~/workspace",
    "  c2c start --instance proj2 --workspace ~/proj2-3",
    "  c2c status",
    "  c2c health --instance proj2",
    "",
    "The long command name 'chatgpt2codex' is also supported.",
  ].join("\n"));
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

/** Default state dir per PRD §10: `~/.local/share/chatgpt2codex/`. */
function defaultStateDir(): string {
  return path.join(os.homedir(), ".local", "share", "chatgpt2codex");
}

function defaultConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.join(xdg, "chatgpt2codex") : path.join(os.homedir(), ".config", "chatgpt2codex");
}

function defaultConfig(workspaceRoot: string, stateDir: string, instanceName = "default"): Config {
  return {
    workspaceRoot,
    stateDir,
    instanceName,
    maxReadBytes: 10 * 1024 * 1024,
    maxPatchBytes: 10 * 1024 * 1024,
    defaultCommandTimeoutSec: 30,
    defaultLeaseTtlMs: 30 * 60 * 1000,
  };
}

async function buildToolContext(workspace: string, instance = "default"): Promise<ToolContext> {
  const workspaceRoot = path.resolve(workspace);
  const stateDir = defaultStateDir();

  const store = new Store(stateDir, normalizeInstanceName(instance));
  const ledger = new Ledger(stateDir);

  const registry = await scanWorkspace(workspaceRoot);
  await store.saveProjects(registry);

  const config = defaultConfig(workspaceRoot, stateDir, normalizeInstanceName(instance));

  return {
    workspaceRoot,
    stateDir,
    registry,
    ledger: { append: (event) => ledger.append(event) },
    store: {
      loadProjects: () => store.loadProjects(),
      saveProjects: (p) => store.saveProjects(p),
      getSession: () => store.getSession(),
      setSession: (s) => store.setSession(s),
    },
    config,
  };
}

function parseLeasePreset(value: string | boolean | undefined): LeasePreset {
  if (
    value === "read-only" ||
    value === "tests-only" ||
    value === "full-write" ||
    value === "image-only" ||
    value === "control"
  ) {
    return value;
  }
  return "full-write";
}

async function applyStartupProjectSelection(ctx: ToolContext, flags: Record<string, string | boolean>): Promise<void> {
  const activeProject = typeof flags["active-project"] === "string" ? flags["active-project"] : undefined;
  const activeProjectRoot =
    typeof flags["active-project-root"] === "string" ? path.resolve(flags["active-project-root"]) : undefined;
  if (!activeProject && !activeProjectRoot) return;

  const entries = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
  let entry: ProjectRegistryEntry | undefined;
  if (activeProjectRoot) {
    entry = entries.find((candidate) => path.resolve(candidate.root) === activeProjectRoot);
  } else if (activeProject) {
    const result = findProject(entries, { projectId: activeProject, name: activeProject });
    if (result.ok) entry = result.entry;
  }

  if (!entry) {
    throw new Error(
      `Startup active project not found: ${activeProjectRoot ?? activeProject}. ` +
        `Make sure --workspace points at that project folder or its workspace root.`,
    );
  }

  const preset = parseLeasePreset(flags["active-project-preset"]);
  const lease = makeLease(entry, preset);
  await ctx.store.setSession({ activeProjectId: entry.projectId, mode: "read", lease });
  await ctx.ledger.append({
    type: "project.selected",
    projectId: entry.projectId,
    reason: "startup active project",
    preset,
  });
}

async function cmdServeStdio(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const instance = normalizeInstanceName(flags.instance);
  const ctx = await buildToolContext(workspace, instance);
  await applyStartupProjectSelection(ctx, flags);
  if (isControlEnabled()) startExecutor(ctx);
  const server = await createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await ctx.ledger.append({ type: "workspace.opened", workspaceRoot: ctx.workspaceRoot });
  console.error(`chatgpt2codex serve: listening on stdio (workspace=${ctx.workspaceRoot}, instance=${instance})`);
}

/**
 * HTTP mode (PRD §4 Transport Gateway, §5 CLI): `chatgpt2codex serve --http
 * [--port 7979] [--public-url <origin>]`. Exposes the SAME registerTools(ctx)
 * catalog as stdio mode over a Streamable HTTP `/mcp` endpoint, gated by
 * OAuth 2.1 (see src/server/http.ts, src/auth/oauth-provider.ts).
 */
async function cmdServeHttp(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const instance = normalizeInstanceName(flags.instance);
  const ctx = await buildToolContext(workspace, instance);

  if (!(await hasOwnerToken(ctx.stateDir))) {
    console.error(
      "chatgpt2codex serve --http: no owner token found. Run `chatgpt2codex init` first to generate one.",
    );
    process.exitCode = 1;
    return;
  }

  const port = typeof flags.port === "string" ? Number.parseInt(flags.port, 10) : 7979;
  const host = typeof flags.host === "string" ? flags.host : "127.0.0.1";
  const publicUrl =
    typeof flags["public-url"] === "string" ? (flags["public-url"] as string) : `http://${host}:${port}`;
  ctx.config.publicUrl = publicUrl;
  const idleShutdownMinutes =
    typeof flags["idle-shutdown-minutes"] === "string" ? Number.parseFloat(flags["idle-shutdown-minutes"]) : 0;
  const idleShutdownMs =
    Number.isFinite(idleShutdownMinutes) && idleShutdownMinutes > 0 ? idleShutdownMinutes * 60 * 1000 : undefined;
  await applyStartupProjectSelection(ctx, flags);
  if (isControlEnabled()) startExecutor(ctx);

  let httpServer: ReturnType<ReturnType<typeof createHttpServer>["app"]["listen"]> | undefined;
  let closeHttpServer: () => void = () => undefined;
  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const finish = () => {
      closeHttpServer();
      void removeRuntimeInstance(ctx.stateDir, instance).finally(() => process.exit(exitCode));
    };
    if (httpServer) httpServer.close(finish);
    else finish();
  };

  const httpConfig = defaultHttpServerConfig({
    host,
    port,
    publicUrl,
    idleShutdownMs,
    onIdleTimeout: () => {
      console.error("chatgpt2codex serve --http: idle timeout reached; stopping.");
      shutdown(0);
    },
  });
  const running = createHttpServer(ctx, httpConfig);
  const { app } = running;
  closeHttpServer = running.close;

  httpServer = app.listen(port, host, () => {
    console.error(`chatgpt2codex serve --http: listening on http://${host}:${port}/mcp`);
    console.error(`chatgpt2codex serve --http: public URL ${publicUrl}/mcp`);
    console.error(`chatgpt2codex serve --http: workspace=${ctx.workspaceRoot}`);
    console.error(`chatgpt2codex serve --http: instance=${instance}`);
    if (idleShutdownMs !== undefined) {
      console.error(`chatgpt2codex serve --http: idle shutdown after ${idleShutdownMinutes} minute(s) without sessions`);
    }
  });

  await writeRuntimeInstance(ctx.stateDir, {
    version: 1,
    name: instance,
    pid: process.pid,
    workspace: ctx.workspaceRoot,
    host,
    port,
    publicUrl,
    startedAt: Date.now(),
  });

  await ctx.ledger.append({ type: "workspace.opened", workspaceRoot: ctx.workspaceRoot, transport: "http" });

  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));

  // Keep the process alive; httpServer.listen already does this, but guard
  // against callers awaiting cmdServeHttp() expecting it to resolve only
  // once the server is asked to stop.
  await new Promise<void>(() => {});
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
  if (flags.http) {
    await cmdServeHttp(flags);
    return;
  }
  await cmdServeStdio(flags);
}

async function cmdInit(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const workspaceRoot = path.resolve(workspace);
  const stateDir = defaultStateDir();

  const store = new Store(stateDir);
  const ledger = new Ledger(stateDir);

  const registry = await scanWorkspace(workspaceRoot);
  await store.saveProjects(registry);
  await store.setSession({ activeProjectId: null, mode: "observe", lease: null });
  await ledger.append({ type: "workspace.opened", workspaceRoot });

  console.error(
    `chatgpt2codex init: initialized state dir ${stateDir} with ${registry.length} project(s) from ${workspaceRoot}`,
  );

  // PRD §11 SR-04: owner secret lives only as a hash on disk; the plaintext
  // is generated here and shown to the operator exactly once. Re-running
  // `init` rotates it unless --keep-owner-token is passed.
  const alreadyHasToken = await hasOwnerToken(stateDir);
  if (alreadyHasToken && !flags["rotate-owner-token"]) {
    console.error(
      "chatgpt2codex init: owner token already set (pass --rotate-owner-token to generate a new one).",
    );
  } else {
    const ownerToken = generateOwnerToken();
    await storeOwnerToken(stateDir, ownerToken);
    console.error("");
    console.error("chatgpt2codex init: generated a new HTTP owner token (shown once, never logged again):");
    console.error("");
    console.error(`  ${ownerToken}`);
    console.error("");
    console.error(
      "Store this securely (e.g. a password manager). It is required to approve the OAuth /authorize prompt when a ChatGPT/MCP client connects over `chatgpt2codex serve --http`.",
    );
  }
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

async function cmdConfig(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = positional[0] ?? "show";
  const configDir = defaultConfigDir();
  const instance = typeof flags.instance === "string" ? normalizeInstanceName(flags.instance) : undefined;

  if (action === "show") {
    const config = await readRuntimeConfig(configDir);
    const runtimeEnv = await loadRuntimeEnvironment(configDir);
    if (instance) {
      console.log(JSON.stringify({
        configDir,
        instance,
        persisted: { ...config.defaults, ...(config.instances[instance] ?? {}) },
        effective: resolveRuntimeSettingsWithLegacy(config, instance, runtimeEnv.fileEnv),
        runtimeEnvPath: runtimeEnv.runtimeEnvPath,
        runtimeEnvLoaded: runtimeEnv.loaded,
        runtimeEnvUnset: runtimeEnv.unset,
      }, null, 2));
    } else {
      console.log(JSON.stringify({
        configDir,
        ...config,
        runtimeEnvPath: runtimeEnv.runtimeEnvPath,
        runtimeEnvLoaded: runtimeEnv.loaded,
        runtimeEnvUnset: runtimeEnv.unset,
      }, null, 2));
    }
    return;
  }

  if (action === "set") {
    const key = positional[1];
    const value = positional[2];
    if (!key || value === undefined) throw new Error("usage: c2c config set <key> <value> [--instance <name>]");
    await setRuntimeConfigValue(configDir, key, value, instance);
    console.log(JSON.stringify({ updated: true, configDir, instance: instance ?? "defaults", key }));
    return;
  }

  if (action === "unset") {
    const key = positional[1];
    if (!key) throw new Error("usage: c2c config unset <key> [--instance <name>]");
    await unsetRuntimeConfigValue(configDir, key, instance);
    console.log(JSON.stringify({ updated: true, configDir, instance: instance ?? "defaults", key, unset: true }));
    return;
  }

  if (action === "import-env") {
    const runtimeEnv = await loadRuntimeEnvironment(configDir);
    const imported = settingsFromEnvironment(runtimeEnv.env);
    const config = await readRuntimeConfig(configDir);
    const target = instance ? (config.instances[instance] ??= {}) : config.defaults;
    Object.assign(target, imported);
    await writeRuntimeConfig(configDir, config);

    const token = runtimeEnv.env.CLOUDFLARED_TUNNEL_TOKEN?.trim();
    let importedCloudflareToken = false;
    if (token) {
      await setRuntimeSecret(defaultStateDir(), "cloudflare-token", token);
      importedCloudflareToken = true;
    }
    console.log(JSON.stringify({
      imported: Object.keys(imported),
      importedCloudflareToken,
      configDir,
      runtimeEnvPath: runtimeEnv.runtimeEnvPath,
      runtimeEnvLoaded: runtimeEnv.loaded,
      runtimeEnvUnset: runtimeEnv.unset,
      instance: instance ?? "defaults",
    }, null, 2));
    return;
  }

  throw new Error(
    "usage: c2c config [show|set <key> <value>|unset <key>|import-env] [--instance <name>]",
  );
}

async function cmdSecret(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = positional[0] ?? "list";
  const stateDir = defaultStateDir();

  if (action === "list") {
    console.log(JSON.stringify({ stateDir, names: await listRuntimeSecrets(stateDir) }, null, 2));
    return;
  }

  if (action === "set") {
    const name = positional[1];
    if (!name || !flags.stdin) throw new Error("usage: c2c secret set <name> --stdin");
    const value = (await readStdin()).trim();
    await setRuntimeSecret(stateDir, name, value);
    console.log(JSON.stringify({ stored: true, name }));
    return;
  }

  if (action === "import-env") {
    const name = positional[1];
    const envName = positional[2];
    if (!name || !envName) throw new Error("usage: c2c secret import-env <name> <ENV_VAR>");
    const value = process.env[envName]?.trim();
    if (!value) throw new Error("environment variable is empty or unset: " + envName);
    await setRuntimeSecret(stateDir, name, value);
    console.log(JSON.stringify({ stored: true, name, source: envName }));
    return;
  }

  if (action === "remove") {
    const name = positional[1];
    if (!name) throw new Error("usage: c2c secret remove <name>");
    console.log(JSON.stringify({ removed: await removeRuntimeSecret(stateDir, name), name }));
    return;
  }

  throw new Error("usage: c2c secret [list|set <name> --stdin|import-env <name> <ENV_VAR>|remove <name>]");
}

async function cmdOwnerToken(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const stateDir = defaultStateDir();

  if (flags.status) {
    console.log(JSON.stringify({ configured: await hasOwnerToken(stateDir), stateDir }));
    return;
  }

  if (flags["set-stdin"]) {
    const token = (await readStdin()).trim();
    await storeOwnerToken(stateDir, token);
    await new JsonOAuthStore(stateDir).clearAll();
    console.log(JSON.stringify({ configured: true, rotated: true, stateDir }));
    return;
  }

  if (flags.generate || flags.rotate) {
    const ownerToken = generateOwnerToken();
    await storeOwnerToken(stateDir, ownerToken);
    await new JsonOAuthStore(stateDir).clearAll();
    console.log(JSON.stringify({ configured: true, rotated: true, ownerToken, stateDir }));
    return;
  }

  console.error("usage: chatgpt2codex owner-token --status|--generate|--set-stdin [--workspace <path>]");
  console.error(`workspace: ${path.resolve(workspace)}`);
  process.exitCode = 1;
}

/**
 * `chatgpt2codex control <list|approve|approve-all|reject|kill|preflight|auto> [actionId]`
 *
 * The local-only human-approval surface for Option B desktop control
 * (src/control/queue.ts). This is the mechanism a local approver (today:
 * this CLI directly; eventually the macOS status-bar app via the same
 * runCli pattern it already uses) uses to move a queued click/type/key
 * request from `pending` to `approved`/`rejected`, kill the session
 * outright, or turn on a bounded auto-approve scope (src/control/auto.ts).
 * ChatGPT/MCP clients cannot reach any of this: there is no MCP tool or
 * HTTP route that calls approveAction, setKill, or setAuto.
 */
async function cmdControl(positional: string[], flags: Record<string, string | boolean> = {}): Promise<void> {
  const stateDir = defaultStateDir();
  const [sub, actionId] = positional;
  switch (sub) {
    case "list": {
      const actions = await listActions(stateDir);
      console.log(JSON.stringify(actions.map(toSummary), null, 2));
      return;
    }
    case "approve": {
      if (!actionId) {
        console.error("usage: chatgpt2codex control approve <actionId>");
        process.exitCode = 1;
        return;
      }
      const record = await approveAction(stateDir, actionId);
      console.log(JSON.stringify(toSummary(record), null, 2));
      return;
    }
    case "approve-all": {
      // Local human batch-approve: only pending actions targeting a
      // non-sensitive, allowlisted app are approved. Everything else is
      // reported back as skipped rather than silently approved, and a kill
      // mid-loop stops the whole batch immediately.
      const approved: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      if (await isKilled(stateDir)) {
        console.log(JSON.stringify({ approved, skipped, killed: true }, null, 2));
        return;
      }
      const allowlist = controlAllowlist();
      const pending = (await listActions(stateDir)).filter((a) => a.status === "pending");
      for (const action of pending) {
        if (await isKilled(stateDir)) break;
        if (isSensitiveApp(action.appName) || !isAppAllowed(action.appName, allowlist)) {
          skipped.push({ id: action.actionId, reason: "blocked-not-eligible" });
          continue;
        }
        try {
          await approveAction(stateDir, action.actionId);
          approved.push(action.actionId);
        } catch (err) {
          skipped.push({ id: action.actionId, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      console.log(JSON.stringify({ approved, skipped }, null, 2));
      return;
    }
    case "auto": {
      const mode = actionId;
      switch (mode) {
        case "on": {
          if (!isControlEnabled()) {
            console.error("Desktop control is not enabled (CHATGPT2CODEX_CONTROL); refusing to enable auto-approve.");
            process.exitCode = 1;
            return;
          }
          const apps =
            typeof flags.apps === "string"
              ? flags.apps
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0)
              : [];
          if (apps.length === 0) {
            console.error(
              "usage: chatgpt2codex control auto on --apps <a,b,...> [--minutes N] [--kinds click,type,key] [--max N]",
            );
            process.exitCode = 1;
            return;
          }
          const minutes = typeof flags.minutes === "string" ? Number(flags.minutes) : undefined;
          const kinds =
            typeof flags.kinds === "string"
              ? (flags.kinds
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry): entry is AutoActionKind => entry === "click" || entry === "type" || entry === "key"))
              : undefined;
          const maxCountRaw = typeof flags.max === "string" ? Number(flags.max) : undefined;
          const maxCount = maxCountRaw !== undefined && !Number.isNaN(maxCountRaw) ? maxCountRaw : undefined;
          const scope = await setAuto(stateDir, {
            apps,
            minutes: clampMinutes(minutes),
            kinds: kinds && kinds.length > 0 ? kinds : undefined,
            maxCount,
          });
          if (scope.apps.length === 0) {
            console.error(
              "warning: none of the requested --apps are on the control allowlist (or all are sensitive apps); auto-approve is on but matches nothing.",
            );
          }
          console.log(JSON.stringify(scope, null, 2));
          return;
        }
        case "off": {
          await clearAuto(stateDir);
          console.log(JSON.stringify({ autoEnabled: false }));
          return;
        }
        case "status": {
          const scope = await readAuto(stateDir);
          if (!scope) {
            console.log(JSON.stringify({ autoEnabled: false }));
            return;
          }
          const now = Date.now();
          const active = now < scope.expiresAt;
          console.log(
            JSON.stringify({ autoEnabled: active, remainingMs: Math.max(0, scope.expiresAt - now), ...scope }, null, 2),
          );
          return;
        }
        default:
          console.error(
            "usage: chatgpt2codex control auto <on --apps a,b [--minutes N] [--kinds click,type,key] [--max N] | off | status>",
          );
          process.exitCode = 1;
          return;
      }
    }
    case "reject": {
      if (!actionId) {
        console.error("usage: chatgpt2codex control reject <actionId>");
        process.exitCode = 1;
        return;
      }
      const record = await rejectAction(stateDir, actionId, "rejected-by-local-approver");
      console.log(JSON.stringify(toSummary(record), null, 2));
      return;
    }
    case "kill": {
      await setKill(stateDir);
      console.log(JSON.stringify({ killed: true }));
      return;
    }
    case "preflight": {
      // Live Accessibility/Screen Recording trust check exposed for local
      // operators and doctor-style diagnosis (src/control/mac-input.ts
      // preflightPermissions). Reports a clear reason instead of a control
      // action failing silently partway through; never throws a raw
      // NOT_IMPLEMENTED stack trace off darwin, always structured JSON.
      try {
        const result = await preflightPermissions();
        console.log(JSON.stringify(result, null, 2));
        if (!result.accessibilityTrusted || !result.screenRecordingAllowed) {
          process.exitCode = 1;
        }
      } catch (err) {
        console.log(
          JSON.stringify(
            {
              accessibilityTrusted: false,
              screenRecordingAllowed: false,
              source: "unavailable",
              reason: err instanceof Error ? err.message : String(err),
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
      }
      return;
    }
    default:
      console.error("usage: chatgpt2codex control <list|approve|approve-all|reject|kill|preflight|auto> [actionId]");
      process.exitCode = 1;
  }
}

async function checkCommand(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
    return stdout.trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

async function cmdDoctor(flags: Record<string, string | boolean>): Promise<void> {
  const nodeVersion = process.version;
  const rgVersion = await checkCommand("rg", ["--version"]);
  const gitVersion = await checkCommand("git", ["--version"]);
  const workspacePath =
    typeof flags.workspace === "string"
      ? path.resolve(flags.workspace)
      : process.cwd();

  let toolCount = "unknown";
  try {
    // Import lazily so a broken registration path doesn't crash doctor.
    const { createServer } = await import("./server/mcp-server.js");
    const ctx = await buildToolContext(workspacePath);
    const server = await createServer(ctx);
    const serverAny = server as unknown as {
      _registeredTools?: Record<string, unknown>;
    };
    const registered = serverAny._registeredTools;
    toolCount = registered ? String(Object.keys(registered).length) : "unknown";
  } catch (err) {
    toolCount = `error: ${(err as Error).message}`;
  }

  const stateDir = defaultStateDir();
  const ownerTokenReady = await hasOwnerToken(stateDir);
  const intake = await checkIntakeAvailability();

  console.log(`node: ${nodeVersion}`);
  console.log(`ripgrep: ${rgVersion ?? "not found"}`);
  console.log(`git: ${gitVersion ?? "not found"}`);
  console.log(`workspace: ${workspacePath}`);
  console.log(`state dir: ${stateDir}`);
  console.log(`registered tools: ${toolCount}`);
  console.log(
    `http/oauth: owner token ${ownerTokenReady ? "configured" : "NOT SET — run `chatgpt2codex init` to generate one"}`,
  );
  console.log(`http default endpoint: http://127.0.0.1:7979/mcp (start via \`chatgpt2codex serve --http\`)`);
  console.log(
    `image intake: pngpaste ${intake.pngpasteAvailable ? "found" : "not found — clipboard image intake unavailable"}, ` +
      `~/Downloads ${intake.downloadsDirExists ? "found" : "NOT FOUND — download intake unavailable"}`,
  );
  console.log(
    "ChatGPT image app flow: open_chatgpt_images_app opens/prepares the first-party Images app; save_chatgpt_image imports from passed URL, copied URL, clipboard image, latest download, or path; " +
      "URL fetches remain SSRF-hardened (blocks loopback/private/link-local/metadata targets, re-validates redirects, 50MB/15s caps).",
  );
}

async function runtimeHttpOptions(
  flags: Record<string, string | boolean>,
  legacyEnv: NodeJS.ProcessEnv,
): Promise<{
  instance: string;
  workspace: string;
  host: string;
  port: number;
  publicUrl: string;
  publicHostname?: string;
  tunnel: TunnelMode;
  tunnelName?: string;
  portExplicit: boolean;
}> {
  const instance = normalizeInstanceName(flags.instance);
  const config = await readRuntimeConfig(defaultConfigDir());
  const persisted = resolveRuntimeSettingsWithLegacy(config, instance, legacyEnv);
  const workspace = path.resolve(
    typeof flags.workspace === "string" ? flags.workspace : persisted.workspace ?? process.cwd(),
  );
  const host = typeof flags.host === "string" ? flags.host : persisted.host ?? "127.0.0.1";
  const configuredPort = typeof flags.port === "string"
    ? Number.parseInt(flags.port, 10)
    : persisted.port;
  const port = configuredPort ?? 7979;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
  const tunnelFlag = typeof flags.tunnel === "string" ? flags.tunnel : undefined;
  if (tunnelFlag !== undefined && tunnelFlag !== "none" && tunnelFlag !== "cloudflare") {
    throw new Error("tunnel must be none or cloudflare");
  }
  const tunnel: TunnelMode = flags["no-tunnel"]
    ? "none"
    : (tunnelFlag as TunnelMode | undefined) ?? persisted.tunnel ?? "none";
  const publicHostname =
    typeof flags["public-hostname"] === "string" ? flags["public-hostname"] : persisted.publicHostname;
  const tunnelName =
    typeof flags["tunnel-name"] === "string" ? flags["tunnel-name"] : persisted.tunnelName;
  const publicUrl =
    typeof flags["public-url"] === "string"
      ? flags["public-url"]
      : tunnel === "cloudflare" && publicHostname
        ? "https://" + publicHostname
        : "http://" + host + ":" + port;
  return {
    instance,
    workspace,
    host,
    port,
    publicUrl,
    publicHostname,
    tunnel,
    tunnelName,
    portExplicit: configuredPort !== undefined,
  };
}

async function findAvailableLocalPort(host: string, startPort = 7979, attempts = 100): Promise<number> {
  const bindHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  for (let port = startPort; port < startPort + attempts; port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createNetServer();
      server.once("error", () => resolve(false));
      server.listen(port, bindHost, () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("no available local port found");
}

async function runtimeHealth(record: { host: string; port: number }): Promise<boolean> {
  const host = record.host === "0.0.0.0" || record.host === "::" ? "127.0.0.1" : record.host;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch("http://" + host + ":" + record.port + "/healthz", { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function publicRuntimeHealth(publicUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(publicUrl.replace(/\/$/, "") + "/healthz", { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function spawnDetachedLogged(
  command: string,
  args: string[],
  logPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(logPath, "", { encoding: "utf8", mode: 0o600 });
  const log = await fs.open(logPath, "a");
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        const pid = child.pid;
        if (!pid) {
          reject(new Error("failed to obtain child pid for " + command));
          return;
        }
        child.unref();
        resolve(pid);
      });
    });
  } finally {
    await log.close();
  }
}

async function waitForQuickTunnelUrl(logPath: string, pid: number, attempts = 90): Promise<string> {
  const urlPattern = /https:\/\/[A-Za-z0-9.-]+\.trycloudflare\.com/;
  for (let i = 0; i < attempts; i += 1) {
    if (!isProcessAlive(pid)) {
      const log = await fs.readFile(logPath, "utf8").catch(() => "");
      throw new Error("cloudflared exited before publishing a quick tunnel URL" + (log ? "\n" + log.slice(-4000) : ""));
    }
    const log = await fs.readFile(logPath, "utf8").catch(() => "");
    const found = log.match(urlPattern)?.[0];
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out waiting for Cloudflare quick tunnel URL; see " + logPath);
}

async function startCloudflareTunnel(options: {
  stateDir: string;
  instance: string;
  localUrl: string;
  publicHostname?: string;
  tunnelName?: string;
  credential?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ pid: number; publicUrl: string; logPath: string }> {
  if (!(await checkCommand("cloudflared", ["--version"]))) {
    throw new Error("cloudflared is not available on PATH");
  }

  const logPath = path.join(options.stateDir, "logs", options.instance + ".cloudflared.log");
  let args: string[];
  let publicUrl: string;
  const baseEnv = options.env ?? process.env;
  let tunnelEnv = baseEnv;

  if (options.credential) {
    if (!options.publicHostname) throw new Error("public-hostname is required for a credential-backed Cloudflare tunnel");
    args = ["tunnel", "--no-autoupdate", "run"];
    const credentialEnvName = ["TUNNEL", "TOKEN"].join("_");
    tunnelEnv = { ...baseEnv, [credentialEnvName]: options.credential };
    publicUrl = "https://" + options.publicHostname;
  } else if (options.tunnelName) {
    if (!options.publicHostname) throw new Error("public-hostname is required for a named Cloudflare tunnel");
    args = ["tunnel", "--no-autoupdate", "run", "--url", options.localUrl, options.tunnelName];
    publicUrl = "https://" + options.publicHostname;
  } else if (options.publicHostname) {
    args = ["tunnel", "--hostname", options.publicHostname, "--url", options.localUrl, "--no-autoupdate"];
    publicUrl = "https://" + options.publicHostname;
  } else {
    args = ["tunnel", "--no-autoupdate", "--url", options.localUrl];
    const pid = await spawnDetachedLogged("cloudflared", args, logPath);
    try {
      publicUrl = await waitForQuickTunnelUrl(logPath, pid);
      return { pid, publicUrl, logPath };
    } catch (err) {
      if (isProcessAlive(pid)) process.kill(pid, "SIGTERM");
      throw err;
    }
  }

  const pid = await spawnDetachedLogged("cloudflared", args, logPath, tunnelEnv);
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (!isProcessAlive(pid)) {
    const log = await fs.readFile(logPath, "utf8").catch(() => "");
    throw new Error("cloudflared exited during startup" + (log ? "\n" + log.slice(-4000) : ""));
  }
  return { pid, publicUrl, logPath };
}

async function cmdStatus(flags: Record<string, string | boolean>): Promise<void> {
  const stateDir = defaultStateDir();
  const requested = typeof flags.instance === "string" ? normalizeInstanceName(flags.instance) : undefined;
  const records = requested
    ? [await readRuntimeInstance(stateDir, requested)].filter((r): r is NonNullable<typeof r> => r !== null)
    : await listRuntimeInstances(stateDir);
  const status = [];
  for (const record of records) {
    const alive = isProcessAlive(record.pid);
    const healthy = alive ? await runtimeHealth(record) : false;
    const tunnelAlive = record.tunnelPid !== undefined ? isProcessAlive(record.tunnelPid) : null;
    if (!alive && tunnelAlive !== true) await removeRuntimeInstance(stateDir, record.name);
    status.push({ ...record, alive, healthy, tunnelAlive });
  }
  console.log(JSON.stringify(requested ? status[0] ?? { name: requested, alive: false, healthy: false } : status, null, 2));
}

async function cmdHealth(flags: Record<string, string | boolean>): Promise<void> {
  const instance = normalizeInstanceName(flags.instance);
  const record = await readRuntimeInstance(defaultStateDir(), instance);
  const alive = record ? isProcessAlive(record.pid) : false;
  const healthy = record && alive ? await runtimeHealth(record) : false;
  const tunnelAlive = record?.tunnelPid !== undefined ? isProcessAlive(record.tunnelPid) : null;
  const publicHealthy =
    record && record.tunnelMode === "cloudflare" && healthy && tunnelAlive
      ? await publicRuntimeHealth(record.publicUrl)
      : record?.tunnelMode === "cloudflare"
        ? false
        : null;
  console.log(JSON.stringify({
    instance,
    alive,
    healthy,
    tunnelAlive,
    publicHealthy,
    endpoint: record ? record.publicUrl + "/healthz" : null,
  }));
  if (!healthy || (record?.tunnelMode === "cloudflare" && !publicHealthy)) process.exitCode = 1;
}

async function waitForRuntimeHealth(record: { host: string; port: number }, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await runtimeHealth(record)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForPublicRuntimeHealth(publicUrl: string, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await publicRuntimeHealth(publicUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function cmdStart(flags: Record<string, string | boolean>): Promise<void> {
  const runtimeEnv = await loadRuntimeEnvironment(defaultConfigDir());
  const options = await runtimeHttpOptions(flags, runtimeEnv.fileEnv);
  if (!options.portExplicit) {
    options.port = await findAvailableLocalPort(options.host);
    if (typeof flags["public-url"] !== "string" && options.tunnel === "none") {
      options.publicUrl = "http://" + options.host + ":" + options.port;
    }
  }
  const stateDir = defaultStateDir();
  const current = await readRuntimeInstance(stateDir, options.instance);
  if (current && isProcessAlive(current.pid)) {
    console.log(JSON.stringify({ started: false, reason: "already-running", ...current, healthy: await runtimeHealth(current) }, null, 2));
    return;
  }
  if (current?.tunnelPid && isProcessAlive(current.tunnelPid)) {
    throw new Error(
      "instance " + options.instance + " has a stale server record but its tunnel process is still alive; stop it before restarting",
    );
  }
  if (current) await removeRuntimeInstance(stateDir, options.instance);
  if (!(await hasOwnerToken(stateDir))) {
    throw new Error("owner token is not configured; run chatgpt2codex init first");
  }

  let tunnelPid: number | undefined;
  let tunnelLogPath: string | undefined;
  if (options.tunnel === "cloudflare") {
    const legacyCredentialKey = ["CLOUDFLARED", "TUNNEL", "TOKEN"].join("_");
    const credential =
      process.env[legacyCredentialKey]?.trim() ||
      await getRuntimeSecret(stateDir, "cloudflare-token") ||
      runtimeEnv.fileEnv[legacyCredentialKey]?.trim();
    const tunnel = await startCloudflareTunnel({
      stateDir,
      instance: options.instance,
      localUrl: "http://127.0.0.1:" + options.port,
      publicHostname: options.publicHostname,
      tunnelName: options.tunnelName,
      credential,
      env: runtimeEnv.env,
    });
    tunnelPid = tunnel.pid;
    tunnelLogPath = tunnel.logPath;
    options.publicUrl = tunnel.publicUrl;
  }

  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("cannot determine chatgpt2codex CLI entrypoint");
  const args = [
    entrypoint,
    "serve",
    "--http",
    "--instance", options.instance,
    "--workspace", options.workspace,
    "--host", options.host,
    "--port", String(options.port),
    "--public-url", options.publicUrl,
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: runtimeEnv.env,
  });
  child.unref();

  const healthy = await waitForRuntimeHealth({ host: options.host, port: options.port });
  const record = await readRuntimeInstance(stateDir, options.instance);
  if (!healthy || !record) {
    if (tunnelPid && isProcessAlive(tunnelPid)) process.kill(tunnelPid, "SIGTERM");
    throw new Error("instance " + options.instance + " failed to become healthy");
  }
  const mergedRecord = {
    ...record,
    tunnelPid,
    tunnelMode: options.tunnel,
    tunnelLogPath,
    publicUrl: options.publicUrl,
  };
  await writeRuntimeInstance(stateDir, mergedRecord);
  const publicHealthy =
    options.tunnel === "cloudflare"
      ? await waitForPublicRuntimeHealth(options.publicUrl)
      : null;
  console.log(JSON.stringify({
    started: true,
    ...mergedRecord,
    healthy: true,
    tunnelAlive: tunnelPid ? isProcessAlive(tunnelPid) : null,
    publicHealthy,
  }, null, 2));
}

async function cmdStop(flags: Record<string, string | boolean>): Promise<void> {
  const instance = normalizeInstanceName(flags.instance);
  const stateDir = defaultStateDir();
  const record = await readRuntimeInstance(stateDir, instance);
  if (!record) {
    console.log(JSON.stringify({ stopped: false, reason: "not-running", instance }));
    return;
  }
  if (!isProcessAlive(record.pid)) {
    if (record.tunnelPid && isProcessAlive(record.tunnelPid)) {
      console.log(JSON.stringify({
        stopped: false,
        reason: "stale-server-live-tunnel",
        instance,
        pid: record.pid,
        tunnelPid: record.tunnelPid,
      }));
      process.exitCode = 1;
      return;
    }
    await removeRuntimeInstance(stateDir, instance);
    console.log(JSON.stringify({ stopped: true, stale: true, instance, pid: record.pid }));
    return;
  }
  if (!(await runtimeHealth(record))) {
    throw new Error(
      "refusing to signal pid " + record.pid + " because the recorded instance is alive but its health endpoint is not responding",
    );
  }
  process.kill(record.pid, "SIGTERM");
  for (let i = 0; i < 50 && isProcessAlive(record.pid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessAlive(record.pid)) throw new Error("instance " + instance + " did not stop cleanly");
  if (record.tunnelPid && isProcessAlive(record.tunnelPid)) {
    process.kill(record.tunnelPid, "SIGTERM");
    for (let i = 0; i < 50 && isProcessAlive(record.tunnelPid); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isProcessAlive(record.tunnelPid)) {
      throw new Error("Cloudflare tunnel for instance " + instance + " did not stop cleanly");
    }
  }
  await removeRuntimeInstance(stateDir, instance);
  console.log(JSON.stringify({ stopped: true, instance, pid: record.pid, tunnelPid: record.tunnelPid ?? null }));
}

async function cmdRestart(flags: Record<string, string | boolean>): Promise<void> {
  await cmdStop(flags);
  await cmdStart(flags);
}

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  switch (command) {
    case "serve":
      await cmdServe(flags);
      break;
    case "init":
      await cmdInit(flags);
      break;
    case "doctor":
      await cmdDoctor(flags);
      break;
    case "config":
      await cmdConfig(positional, flags);
      break;
    case "secret":
      await cmdSecret(positional, flags);
      break;
    case "start":
      await cmdStart(flags);
      break;
    case "stop":
      await cmdStop(flags);
      break;
    case "restart":
      await cmdRestart(flags);
      break;
    case "status":
      await cmdStatus(flags);
      break;
    case "health":
      await cmdHealth(flags);
      break;
    case "owner-token":
      await cmdOwnerToken(flags);
      break;
    case "control":
      await cmdControl(positional, flags);
      break;
    default:
      console.error("Unknown command: " + command);
      console.error("");
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
