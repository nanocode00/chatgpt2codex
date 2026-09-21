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
import { findProject, inspectProjectRoot, scanWorkspace } from "./workspace/registry.js";
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
  runtimeProcessMatchesRecord,
  writeRuntimeInstance,
} from "./runtime/instances.js";
import {
  getRuntimeSecret,
  defaultRuntimeConfigDir,
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
import {
  applyManagedProfiles,
  normalizeManagedProfileAlias,
  normalizeRepositoryId,
  readManagedProfiles,
  readManagedRepositories,
  slugRepositoryName,
  testPythonProfile,
  writeManagedProfiles,
  writeManagedRepositories,
  type ManagedDockerProfile,
} from "./runtime/catalog.js";
import { forceReleaseWorkspaceLock, listWorkspaceLocks } from "./workspace/operation-lock.js";
import {
  durableJobLogs,
  listDurableJobs,
  readDurableJob,
  setDurableJobStatus,
} from "./runtime/jobs.js";

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
    "  reload      Reload live-safe profile/repository configuration",
    "  status      Show one or all running instances",
    "  ps          Alias for status",
    "  health      Check whether an instance is alive and responding",
    "  logs        Show recent server or tunnel log lines",
    "  serve       Run the MCP server in the foreground",
    "",
    "Setup / diagnostics:",
    "  init        Initialize workspace state and owner token",
    "  doctor      Check runtime dependencies and configuration",
    "  config      Show or update persistent non-secret runtime settings",
    "  secret      Manage persistent runtime secrets",
    "  profile     Manage persistent Python/Docker runtime profiles",
    "  repository  Manage persistent repository registrations",
    "  lock        Inspect or recover workspace operation locks",
    "  job         Inspect, resume, or cancel durable coding jobs",
    "  owner-token Manage the HTTP owner token",
    "  control     Manage local desktop-control approvals",
    "",
    "Common options:",
    "  --instance <name>   Runtime instance name (default: default)",
    "  --workspace <path>  Workspace root",
    "  --repository <id>   Registered repository to use as workspace",
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
  return defaultRuntimeConfigDir();
}

function withoutTunnelCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned = { ...env };
  delete cleaned.CLOUDFLARED_TUNNEL_TOKEN;
  delete cleaned.TUNNEL_TOKEN;
  return cleaned;
}

async function hydrateDirectServeEnvironment(): Promise<void> {
  const pythonLocked =
    process.env.CHATGPT2CODEX_PYTHON_PROFILE_LOCKED !== undefined
      ? process.env.CHATGPT2CODEX_PYTHON_PROFILE_LOCKED === "1"
      : Boolean(process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES?.trim());
  const dockerLocked =
    process.env.CHATGPT2CODEX_DOCKER_PROFILE_LOCKED !== undefined
      ? process.env.CHATGPT2CODEX_DOCKER_PROFILE_LOCKED === "1"
      : Boolean(process.env.CHATGPT2CODEX_DOCKER_PROFILES?.trim());
  const loaded = await loadRuntimeEnvironment(defaultConfigDir());
  const effective = withoutTunnelCredentials(
    await applyManagedProfiles(defaultConfigDir(), loaded.env),
  );
  for (const name of loaded.unset) delete process.env[name];
  for (const [name, value] of Object.entries(effective)) {
    if (value !== undefined) process.env[name] = value;
  }
  delete process.env.CLOUDFLARED_TUNNEL_TOKEN;
  delete process.env.TUNNEL_TOKEN;
  process.env.CHATGPT2CODEX_PYTHON_PROFILE_LOCKED = pythonLocked ? "1" : "0";
  process.env.CHATGPT2CODEX_DOCKER_PROFILE_LOCKED = dockerLocked ? "1" : "0";
}

function defaultConfig(workspaceRoot: string, stateDir: string, instanceName = "default"): Config {
  return {
    workspaceRoot,
    stateDir,
    runtimeConfigDir: defaultConfigDir(),
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

  const scanned = await scanWorkspace(workspaceRoot);
  const rememberedRaw = await store.loadProjects().catch(() => [] as ProjectRegistryEntry[]);
  const remembered: ProjectRegistryEntry[] = [];
  for (const project of rememberedRaw) {
    try {
      remembered.push(
        await inspectProjectRoot(project.root, {
          name: project.name,
          projectId: project.projectId,
        }),
      );
    } catch {
      // Drop stale remembered roots that no longer exist or are no longer projects.
    }
  }
  const managed = await readManagedRepositories(defaultConfigDir());
  const configured: ProjectRegistryEntry[] = [];
  for (const repo of managed.repositories) {
    try {
      configured.push(await inspectProjectRoot(repo.root, { name: repo.name, projectId: repo.id }));
    } catch {
      // Keep startup resilient when a configured repository is temporarily unavailable.
    }
  }
  const byRoot = new Map<string, ProjectRegistryEntry>();
  for (const entry of [...remembered, ...scanned, ...configured]) byRoot.set(path.resolve(entry.root), entry);
  const registry = [...byRoot.values()];
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

async function reloadLiveRuntimeConfiguration(ctx: ToolContext): Promise<void> {
  const configDir = defaultConfigDir();
  const profiles = await readManagedProfiles(configDir);
  const legacy = await loadRuntimeEnvironment(configDir, {});

  if (process.env.CHATGPT2CODEX_PYTHON_PROFILE_LOCKED !== "1") {
    const value =
      Object.keys(profiles.python).length > 0
        ? JSON.stringify(profiles.python)
        : legacy.fileEnv.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES;
    if (value) process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES = value;
    else delete process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES;
  }
  if (process.env.CHATGPT2CODEX_DOCKER_PROFILE_LOCKED !== "1") {
    const value =
      Object.keys(profiles.docker).length > 0
        ? JSON.stringify(profiles.docker)
        : legacy.fileEnv.CHATGPT2CODEX_DOCKER_PROFILES;
    if (value) process.env.CHATGPT2CODEX_DOCKER_PROFILES = value;
    else delete process.env.CHATGPT2CODEX_DOCKER_PROFILES;
  }

  const candidates: ProjectRegistryEntry[] = await scanWorkspace(ctx.workspaceRoot);
  const remembered = await ctx.store.loadProjects().catch(() => [] as ProjectRegistryEntry[]);
  for (const project of remembered) {
    try {
      candidates.push(
        await inspectProjectRoot(project.root, {
          name: project.name,
          projectId: project.projectId,
        }),
      );
    } catch {
      // Ignore stale remembered roots.
    }
  }
  const managedRepositories = await readManagedRepositories(configDir);
  for (const repository of managedRepositories.repositories) {
    try {
      candidates.push(
        await inspectProjectRoot(repository.root, {
          name: repository.name,
          projectId: repository.id,
        }),
      );
    } catch {
      // Keep live reload resilient when a configured repository is temporarily unavailable.
    }
  }

  const byRoot = new Map<string, ProjectRegistryEntry>();
  for (const project of candidates) byRoot.set(path.resolve(project.root), project);
  ctx.registry.splice(0, ctx.registry.length, ...byRoot.values());
  await ctx.store.saveProjects(ctx.registry);
}

function installLiveReloadSignal(ctx: ToolContext): void {
  if (process.platform === "win32") return;
  process.on("SIGHUP", () => {
    void reloadLiveRuntimeConfiguration(ctx)
      .then(() => console.error("chatgpt2codex: reloaded live profile/repository configuration"))
      .catch((err) =>
        console.error(
          "chatgpt2codex: live reload failed:",
          err instanceof Error ? err.message : String(err),
        ));
  });
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
  await hydrateDirectServeEnvironment();
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const instance = normalizeInstanceName(flags.instance);
  const ctx = await buildToolContext(workspace, instance);
  installLiveReloadSignal(ctx);
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
  await hydrateDirectServeEnvironment();
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const instance = normalizeInstanceName(flags.instance);
  const ctx = await buildToolContext(workspace, instance);
  installLiveReloadSignal(ctx);

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
    closeHttpServer();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      void removeRuntimeInstance(ctx.stateDir, instance).finally(() => process.exit(exitCode));
    };
    if (httpServer) {
      httpServer.close(finish);
      httpServer.closeIdleConnections?.();
      const forceCloseTimer = setTimeout(() => {
        httpServer?.closeAllConnections?.();
        finish();
      }, 2_000);
      forceCloseTimer.unref();
    } else {
      finish();
    }
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
    entrypoint: process.argv[1] ? path.resolve(process.argv[1]) : undefined,
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
      const secretName = instance ? "cloudflare-token." + instance : "cloudflare-token";
      await setRuntimeSecret(defaultStateDir(), secretName, token);
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

  if (action === "export") {
    const bundle = {
      version: 1,
      containsSecrets: false,
      config: await readRuntimeConfig(configDir),
      profiles: await readManagedProfiles(configDir),
      repositories: await readManagedRepositories(configDir),
    };
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }

  if (action === "import") {
    if (!flags.stdin) throw new Error("usage: c2c config import --stdin");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readStdin());
    } catch {
      throw new Error("config import input must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config import bundle must be an object");
    }
    const bundle = parsed as Record<string, unknown>;
    if (bundle.version !== 1) throw new Error("unsupported config import bundle version");
    if (bundle.containsSecrets !== false) throw new Error("config import bundle must explicitly declare containsSecrets=false");
    if (!bundle.config || !bundle.profiles || !bundle.repositories) {
      throw new Error("config import bundle must include config, profiles, and repositories");
    }

    const incomingConfig = bundle.config as Awaited<ReturnType<typeof readRuntimeConfig>>;
    const incomingProfiles = bundle.profiles as Awaited<ReturnType<typeof readManagedProfiles>>;
    const incomingRepositories = bundle.repositories as Awaited<ReturnType<typeof readManagedRepositories>>;
    const currentConfig = await readRuntimeConfig(configDir);
    const currentProfiles = await readManagedProfiles(configDir);
    const currentRepositories = await readManagedRepositories(configDir);

    await writeRuntimeConfig(configDir, {
      version: 1,
      defaults: { ...currentConfig.defaults, ...incomingConfig.defaults },
      instances: { ...currentConfig.instances, ...incomingConfig.instances },
    });
    await writeManagedProfiles(configDir, {
      version: 1,
      python: { ...currentProfiles.python, ...incomingProfiles.python },
      docker: { ...currentProfiles.docker, ...incomingProfiles.docker },
    });
    const repositoriesById = new Map(currentRepositories.repositories.map((repo) => [repo.id, repo]));
    for (const repo of incomingRepositories.repositories) repositoriesById.set(repo.id, repo);
    await writeManagedRepositories(configDir, {
      version: 1,
      repositories: [...repositoriesById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    });
    console.log(JSON.stringify({
      imported: true,
      containsSecrets: false,
      configDir,
      note: "Secrets are intentionally excluded; configure them separately with c2c secret.",
    }, null, 2));
    return;
  }

  throw new Error(
    "usage: c2c config [show|set <key> <value>|unset <key>|import-env|export|import --stdin] [--instance <name>]",
  );
}

async function cmdSecret(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = positional[0] ?? "list";
  const stateDir = defaultStateDir();
  const instance = typeof flags.instance === "string" ? normalizeInstanceName(flags.instance) : undefined;
  const scopedName = (name: string): string => instance ? name + "." + instance : name;

  if (action === "list") {
    console.log(JSON.stringify({ stateDir, names: await listRuntimeSecrets(stateDir) }, null, 2));
    return;
  }

  if (action === "set") {
    const name = positional[1];
    if (!name || !flags.stdin) throw new Error("usage: c2c secret set <name> --stdin");
    const value = (await readStdin()).trim();
    const storedName = scopedName(name);
    await setRuntimeSecret(stateDir, storedName, value);
    console.log(JSON.stringify({ stored: true, name: storedName }));
    return;
  }

  if (action === "import-env") {
    const name = positional[1];
    const envName = positional[2];
    if (!name || !envName) throw new Error("usage: c2c secret import-env <name> <ENV_VAR>");
    const value = process.env[envName]?.trim();
    if (!value) throw new Error("environment variable is empty or unset: " + envName);
    const storedName = scopedName(name);
    await setRuntimeSecret(stateDir, storedName, value);
    console.log(JSON.stringify({ stored: true, name: storedName, source: envName }));
    return;
  }

  if (action === "remove") {
    const name = positional[1];
    if (!name) throw new Error("usage: c2c secret remove <name>");
    const storedName = scopedName(name);
    console.log(JSON.stringify({ removed: await removeRuntimeSecret(stateDir, storedName), name: storedName }));
    return;
  }

  throw new Error("usage: c2c secret [list|set <name> --stdin|import-env <name> <ENV_VAR>|remove <name>]");
}

function commaList(value: string | boolean | undefined, label: string): string[] {
  if (typeof value !== "string") throw new Error(label + " requires a comma-separated value");
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(label + " must not be empty");
  return items;
}

async function cmdProfile(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = positional[0] ?? "list";
  const configDir = defaultConfigDir();
  const profiles = await readManagedProfiles(configDir);

  if (action === "list") {
    const aliases = Array.from(new Set([...Object.keys(profiles.python), ...Object.keys(profiles.docker)])).sort();
    console.log(JSON.stringify({
      configDir,
      profiles: aliases.map((alias) => ({
        alias,
        python: alias in profiles.python,
        docker: alias in profiles.docker,
      })),
    }, null, 2));
    return;
  }

  if (action === "show") {
    const alias = normalizeManagedProfileAlias(positional[1] ?? "");
    if (!(alias in profiles.python) && !(alias in profiles.docker)) throw new Error("profile not found: " + alias);
    console.log(JSON.stringify({
      alias,
      python: profiles.python[alias] ?? null,
      docker: profiles.docker[alias] ?? null,
    }, null, 2));
    return;
  }

  if (action === "add") {
    const alias = normalizeManagedProfileAlias(positional[1] ?? "");
    let changed = false;
    if (typeof flags.python === "string") {
      const executable = path.resolve(flags.python);
      const checked = await testPythonProfile(executable);
      if (!checked.available) throw new Error("python executable is unavailable or not executable: " + executable);
      profiles.python[alias] = executable;
      changed = true;
    }
    if (flags["compose-file"] !== undefined || flags["project-name"] !== undefined || flags.services !== undefined) {
      if (
        typeof flags["compose-file"] !== "string" ||
        typeof flags["project-name"] !== "string" ||
        typeof flags.services !== "string"
      ) {
        throw new Error(
          "docker profile requires --compose-file <relative> --project-name <name> --services <a,b> [--control-services <a,b>]",
        );
      }
      const docker: ManagedDockerProfile = {
        composeFile: flags["compose-file"],
        projectName: flags["project-name"],
        services: commaList(flags.services, "--services"),
        controlServices:
          typeof flags["control-services"] === "string"
            ? commaList(flags["control-services"], "--control-services")
            : [],
      };
      profiles.docker[alias] = docker;
      changed = true;
    }
    if (!changed) {
      throw new Error(
        "usage: c2c profile add <alias> --python <absolute-path> OR --compose-file <relative> --project-name <name> --services <a,b>",
      );
    }
    await writeManagedProfiles(configDir, profiles);
    console.log(JSON.stringify({ updated: true, alias, python: alias in profiles.python, docker: alias in profiles.docker }));
    return;
  }

  if (action === "remove") {
    const alias = normalizeManagedProfileAlias(positional[1] ?? "");
    const removePython = flags.python === true;
    const removeDocker = flags.docker === true;
    const removeBoth = !removePython && !removeDocker;
    const removed = {
      python: (removeBoth || removePython) && delete profiles.python[alias],
      docker: (removeBoth || removeDocker) && delete profiles.docker[alias],
    };
    await writeManagedProfiles(configDir, profiles);
    console.log(JSON.stringify({ alias, removed }));
    return;
  }

  if (action === "test") {
    const alias = normalizeManagedProfileAlias(positional[1] ?? "");
    if (!(alias in profiles.python) && !(alias in profiles.docker)) throw new Error("profile not found: " + alias);
    console.log(JSON.stringify({
      alias,
      python: profiles.python[alias]
        ? { configured: true, ...(await testPythonProfile(profiles.python[alias])) }
        : { configured: false },
      docker: profiles.docker[alias]
        ? { configured: true, valid: true, profile: profiles.docker[alias] }
        : { configured: false },
    }, null, 2));
    return;
  }

  if (action === "import-env") {
    const runtimeEnv = await loadRuntimeEnvironment(configDir);
    const imported: string[] = [];
    for (const [envName, target] of [
      ["CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES", "python"],
      ["CHATGPT2CODEX_DOCKER_PROFILES", "docker"],
    ] as const) {
      const raw = runtimeEnv.env[envName]?.trim();
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(envName + " is not valid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(envName + " must be a JSON object");
      if (target === "python") {
        for (const [aliasRaw, executable] of Object.entries(parsed as Record<string, unknown>)) {
          const alias = normalizeManagedProfileAlias(aliasRaw);
          if (typeof executable !== "string" || !path.isAbsolute(executable)) {
            throw new Error("invalid Python profile in " + envName + ": " + alias);
          }
          profiles.python[alias] = executable;
        }
      } else {
        for (const [aliasRaw, docker] of Object.entries(parsed as Record<string, unknown>)) {
          const alias = normalizeManagedProfileAlias(aliasRaw);
          profiles.docker[alias] = docker as ManagedDockerProfile;
        }
      }
      imported.push(target);
    }
    await writeManagedProfiles(configDir, profiles);
    console.log(JSON.stringify({ imported, configDir }, null, 2));
    return;
  }

  throw new Error("usage: c2c profile [list|show <alias>|add <alias>|remove <alias>|test <alias>|import-env]");
}

async function cmdRepository(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = positional[0] ?? "list";
  const configDir = defaultConfigDir();
  const data = await readManagedRepositories(configDir);

  if (action === "list") {
    const repositories = [];
    for (const repo of data.repositories) {
      const available = await fs.stat(repo.root).then((st) => st.isDirectory()).catch(() => false);
      repositories.push({ ...repo, available });
    }
    console.log(JSON.stringify({ configDir, repositories }, null, 2));
    return;
  }

  if (action === "show") {
    const id = normalizeRepositoryId(positional[1] ?? "");
    const repo = data.repositories.find((item) => item.id === id);
    if (!repo) throw new Error("repository not found: " + id);
    const entry = await inspectProjectRoot(repo.root, { name: repo.name, projectId: repo.id });
    console.log(JSON.stringify({ ...repo, project: entry }, null, 2));
    return;
  }

  if (action === "add") {
    const rootInput = positional[1];
    if (!rootInput) throw new Error("usage: c2c repository add <path> [--id <id>] [--name <name>]");
    const root = path.resolve(rootInput);
    const name = typeof flags.name === "string" ? flags.name.trim() : path.basename(root);
    const id = typeof flags.id === "string" ? normalizeRepositoryId(flags.id) : slugRepositoryName(name);
    await inspectProjectRoot(root, { name, projectId: id });
    if (data.repositories.some((repo) => repo.id === id)) throw new Error("repository id already exists: " + id);
    if (data.repositories.some((repo) => path.resolve(repo.root) === root)) throw new Error("repository root is already registered: " + root);
    data.repositories.push({ id, name, root });
    data.repositories.sort((a, b) => a.id.localeCompare(b.id));
    await writeManagedRepositories(configDir, data);
    console.log(JSON.stringify({ added: true, id, name, root }, null, 2));
    return;
  }

  if (action === "remove") {
    const id = normalizeRepositoryId(positional[1] ?? "");
    const before = data.repositories.length;
    data.repositories = data.repositories.filter((repo) => repo.id !== id);
    const removed = data.repositories.length !== before;
    if (removed) await writeManagedRepositories(configDir, data);
    console.log(JSON.stringify({ removed, id }));
    return;
  }

  if (action === "use") {
    const id = normalizeRepositoryId(positional[1] ?? "");
    if (!data.repositories.some((repo) => repo.id === id)) throw new Error("repository not found: " + id);
    const instance = typeof flags.instance === "string" ? normalizeInstanceName(flags.instance) : undefined;
    await setRuntimeConfigValue(configDir, "repository", id, instance);
    await unsetRuntimeConfigValue(configDir, "workspace", instance);
    console.log(JSON.stringify({ selected: true, repository: id, instance: instance ?? "defaults" }));
    return;
  }

  throw new Error("usage: c2c repository [list|show <id>|add <path>|remove <id>|use <id>]");
}

async function cmdLock(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = positional[0] ?? "list";
  const stateDir = defaultStateDir();
  if (action === "list") {
    console.log(JSON.stringify({ stateDir, locks: await listWorkspaceLocks(stateDir) }, null, 2));
    return;
  }
  if (action === "release") {
    if (flags.force !== true) {
      throw new Error("c2c lock release requires --force because it can interrupt another active c2c operation");
    }
    const target = positional[1];
    if (!target) throw new Error("usage: c2c lock release <repository-id|path> --force");
    const repositories = await readManagedRepositories(defaultConfigDir());
    const byId = repositories.repositories.find((repo) => repo.id === target);
    const projectRoot = byId?.root ?? path.resolve(target);
    console.log(JSON.stringify({
      released: await forceReleaseWorkspaceLock(stateDir, projectRoot),
      projectRoot,
    }));
    return;
  }
  throw new Error("usage: c2c lock [list|release <repository-id|path> --force]");
}

async function cmdJob(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = positional[0] ?? "list";
  const stateDir = defaultStateDir();

  if (action === "list") {
    console.log(JSON.stringify({ stateDir, jobs: await listDurableJobs(stateDir) }, null, 2));
    return;
  }

  const id = positional[1];
  if (!id) throw new Error("usage: c2c job <status|logs|resume|cancel> <job-id>");

  if (action === "status") {
    const job = await readDurableJob(stateDir, id);
    if (!job) throw new Error("job not found: " + id);
    const { filePath: _filePath, turns: _turns, ...summary } = job;
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (action === "logs") {
    const limit =
      typeof flags.limit === "string"
        ? Number.parseInt(flags.limit, 10)
        : 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit must be an integer from 1 to 50");
    const logs = await durableJobLogs(stateDir, id, limit);
    if (!logs) throw new Error("job not found: " + id);
    console.log(JSON.stringify(logs, null, 2));
    return;
  }

  if (action === "cancel" || action === "resume") {
    const job = await setDurableJobStatus(stateDir, id, action === "cancel" ? "canceled" : "active");
    if (!job) throw new Error("job not found: " + id);
    console.log(JSON.stringify({
      id,
      status: job.status,
      projectId: job.projectId ?? null,
      turnCount: job.turnCount,
      nextActions: job.nextActions,
      ...(action === "resume"
        ? {
            instruction:
              "The durable job is active again. Continue it from ChatGPT with goal_loop using this loopId, or goal_workflow resume in the originating session.",
          }
        : {}),
    }, null, 2));
    return;
  }

  throw new Error("usage: c2c job [list|status <id>|logs <id> [--limit N]|resume <id>|cancel <id>]");
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
  const repositoryId =
    typeof flags.repository === "string"
      ? normalizeRepositoryId(flags.repository)
      : persisted.repository
        ? normalizeRepositoryId(persisted.repository)
        : undefined;
  let workspaceInput =
    typeof flags.workspace === "string"
      ? flags.workspace
      : persisted.workspace;
  if (!workspaceInput && repositoryId) {
    const repositories = await readManagedRepositories(defaultConfigDir());
    const repository = repositories.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new Error("configured repository is not registered: " + repositoryId);
    workspaceInput = repository.root;
  }
  const workspace = path.resolve(workspaceInput ?? process.cwd());
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

async function cmdReload(flags: Record<string, string | boolean>): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("c2c reload currently requires Linux/WSL; use c2c restart on this platform");
  }
  const instance = normalizeInstanceName(flags.instance);
  const record = await readRuntimeInstance(defaultStateDir(), instance);
  if (!record || !isProcessAlive(record.pid)) throw new Error("instance is not running: " + instance);
  if (!(await runtimeProcessMatchesRecord(record))) {
    throw new Error("refusing reload because the recorded pid could not be verified as this c2c instance");
  }
  process.kill(record.pid, "SIGHUP");
  console.log(JSON.stringify({
    reloaded: true,
    instance,
    pid: record.pid,
    scope: ["profiles", "repositories"],
    restartRequiredFor: ["port", "host", "tunnel", "public-hostname"],
  }, null, 2));
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
  const childEnv = await applyManagedProfiles(defaultConfigDir(), runtimeEnv.env);
  const serverEnv = withoutTunnelCredentials(childEnv);
  serverEnv.CHATGPT2CODEX_PYTHON_PROFILE_LOCKED =
    process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES?.trim() ? "1" : "0";
  serverEnv.CHATGPT2CODEX_DOCKER_PROFILE_LOCKED =
    process.env.CHATGPT2CODEX_DOCKER_PROFILES?.trim() ? "1" : "0";
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
      await getRuntimeSecret(stateDir, "cloudflare-token." + options.instance) ||
      await getRuntimeSecret(stateDir, "cloudflare-token") ||
      runtimeEnv.fileEnv[legacyCredentialKey]?.trim();
    const tunnel = await startCloudflareTunnel({
      stateDir,
      instance: options.instance,
      localUrl: "http://127.0.0.1:" + options.port,
      publicHostname: options.publicHostname,
      tunnelName: options.tunnelName,
      credential,
      env: childEnv,
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
  const serverLogPath = path.join(stateDir, "logs", options.instance + ".server.log");
  const serverPid = await spawnDetachedLogged(process.execPath, args, serverLogPath, serverEnv);

  const healthy = await waitForRuntimeHealth({ host: options.host, port: options.port });
  const record = await readRuntimeInstance(stateDir, options.instance);
  if (!healthy || !record) {
    if (tunnelPid && isProcessAlive(tunnelPid)) process.kill(tunnelPid, "SIGTERM");
    throw new Error("instance " + options.instance + " failed to become healthy");
  }
  const mergedRecord = {
    ...record,
    pid: serverPid,
    serverLogPath,
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

async function cmdLogs(flags: Record<string, string | boolean>): Promise<void> {
  const instance = normalizeInstanceName(flags.instance);
  const component =
    typeof flags.component === "string" ? flags.component : "server";
  if (component !== "server" && component !== "tunnel") {
    throw new Error("--component must be server or tunnel");
  }
  const lines =
    typeof flags.lines === "string" ? Number.parseInt(flags.lines, 10) : 100;
  if (!Number.isInteger(lines) || lines < 1 || lines > 5000) {
    throw new Error("--lines must be an integer from 1 to 5000");
  }
  const record = await readRuntimeInstance(defaultStateDir(), instance);
  if (!record) throw new Error("instance not found: " + instance);
  const logPath = component === "server" ? record.serverLogPath : record.tunnelLogPath;
  if (!logPath) throw new Error(component + " log is not recorded for instance " + instance);
  const content = await fs.readFile(logPath, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
  const tail = content.split(/\r?\n/).slice(-lines).join("\n");
  process.stdout.write(tail + (tail.endsWith("\n") || !tail ? "" : "\n"));
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
  const healthy = await runtimeHealth(record);
  if (!healthy) {
    if (flags.force !== true) {
      throw new Error(
        "refusing to signal pid " + record.pid + " because the recorded instance is alive but its health endpoint is not responding; retry with --force only after verifying the instance identity",
      );
    }
    if (!(await runtimeProcessMatchesRecord(record))) {
      throw new Error(
        "refusing forced stop because pid " + record.pid + " could not be verified as this c2c instance",
      );
    }
  }
  process.kill(record.pid, "SIGTERM");
  for (let i = 0; i < 50 && isProcessAlive(record.pid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessAlive(record.pid) && flags.force === true) {
    if (!(await runtimeProcessMatchesRecord(record))) {
      throw new Error("refusing SIGKILL because runtime process identity no longer matches the recorded c2c instance");
    }
    process.kill(record.pid, "SIGKILL");
    for (let i = 0; i < 20 && isProcessAlive(record.pid); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (isProcessAlive(record.pid)) throw new Error("instance " + instance + " did not stop cleanly");
  if (record.tunnelPid && isProcessAlive(record.tunnelPid)) {
    process.kill(record.tunnelPid, "SIGTERM");
    for (let i = 0; i < 50 && isProcessAlive(record.tunnelPid); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isProcessAlive(record.tunnelPid)) {
      if (flags.force === true) {
        process.kill(record.tunnelPid, "SIGKILL");
        for (let i = 0; i < 20 && isProcessAlive(record.tunnelPid); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (isProcessAlive(record.tunnelPid)) {
        throw new Error("Cloudflare tunnel for instance " + instance + " did not stop cleanly");
      }
    }
  }
  await removeRuntimeInstance(stateDir, instance);
  console.log(JSON.stringify({ stopped: true, instance, pid: record.pid, tunnelPid: record.tunnelPid ?? null }));
}

async function cmdRestart(flags: Record<string, string | boolean>): Promise<void> {
  await cmdStop({ ...flags, force: true });
  await cmdStart(flags);
}

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (flags.help === true) {
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
    case "profile":
      await cmdProfile(positional, flags);
      break;
    case "repository":
      await cmdRepository(positional, flags);
      break;
    case "lock":
      await cmdLock(positional, flags);
      break;
    case "job":
      await cmdJob(positional, flags);
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
    case "reload":
      await cmdReload(flags);
      break;
    case "status":
      await cmdStatus(flags);
      break;
    case "ps":
      await cmdStatus(flags);
      break;
    case "health":
      await cmdHealth(flags);
      break;
    case "logs":
      await cmdLogs(flags);
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
