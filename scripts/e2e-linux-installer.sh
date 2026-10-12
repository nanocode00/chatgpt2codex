#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT/build/linux/chatgpt2codex-linux-x64.run"
SKIP_TUNNEL=0
TIMEOUT_SEC=180

while [ "$#" -gt 0 ]; do
  case "$1" in
    --installer)
      INSTALLER="${2:?--installer requires a value}"
      shift 2
      ;;
    --skip-tunnel)
      SKIP_TUNNEL=1
      shift
      ;;
    --timeout)
      TIMEOUT_SEC="${2:?--timeout requires a value}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$(uname -s)" != "Linux" ]; then
  echo "This E2E test must run on Linux." >&2
  exit 1
fi

RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt2codex-linux-e2e.XXXXXX")"
PREFIX="$RUN_ROOT/install"
HOME_DIR="$RUN_ROOT/home"
WORKSPACE="$RUN_ROOT/workspace"
PROJECT="$WORKSPACE/e2e-project"
REPORT="$RUN_ROOT/report.json"
mkdir -p "$HOME_DIR" "$PROJECT"

RESULTS=()
PROCS=()

cleanup() {
  for pid in "${PROCS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

add_result() {
  local name="$1" status="$2" seconds="$3" detail="$4"
  RESULTS+=("{\"name\":\"$(json_escape "$name")\",\"status\":\"$status\",\"seconds\":$seconds,\"detail\":\"$(json_escape "$detail")\"}")
}

write_report() {
  local status="$1"
  {
    printf '{\n'
    printf '  "status": "%s",\n' "$status"
    printf '  "installer": "%s",\n' "$(json_escape "$INSTALLER")"
    printf '  "prefix": "%s",\n' "$(json_escape "$PREFIX")"
    printf '  "runRoot": "%s",\n' "$(json_escape "$RUN_ROOT")"
    printf '  "results": [\n'
    local i
    for ((i = 0; i < ${#RESULTS[@]}; i++)); do
      printf '    %s' "${RESULTS[$i]}"
      [ "$i" -lt $((${#RESULTS[@]} - 1)) ] && printf ','
      printf '\n'
    done
    printf '  ]\n'
    printf '}\n'
  } >"$REPORT"
}

step() {
  local name="$1"
  shift
  echo "[e2e-linux] $name"
  local start end elapsed detail tmpout
  tmpout="$RUN_ROOT/step-$(
    printf '%s' "$name" | tr -c 'A-Za-z0-9_' '_'
  ).log"
  start="$(date +%s)"
  if "$@" >"$tmpout" 2>&1; then
    end="$(date +%s)"
    elapsed="$((end - start))"
    detail="$(cat "$tmpout")"
    add_result "$name" "passed" "$elapsed" "$detail"
    echo "[e2e-linux] ok: $name (${elapsed}s)"
  else
    local code=$?
    end="$(date +%s)"
    elapsed="$((end - start))"
    detail="$(cat "$tmpout" 2>/dev/null || true)"
    add_result "$name" "failed" "$elapsed" "$detail"
    write_report "failed"
    echo "$detail" >&2
    exit "$code"
  fi
}

get_free_port() {
  local node_bin="$PREFIX/bin/node"
  [ -x "$node_bin" ] || node_bin="node"
  "$node_bin" -e 'const s=require("net").createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

wait_http() {
  local url="$1" timeout="$2"
  local deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if "$PREFIX/bin/node" -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$url"; then
      return 0
    fi
    sleep 1
  done
  echo "timeout waiting for $url" >&2
  return 1
}

prepare_workspace() {
  cat >"$PROJECT/package.json" <<'JSON'
{"name":"e2e-project","version":"1.0.0","scripts":{"echo":"node -e \"console.log('e2e-command-ok')\""}}
JSON
  echo "e2e project" >"$PROJECT/README.md"
  if command -v git >/dev/null 2>&1; then
    git -C "$PROJECT" init -q
    git -C "$PROJECT" config user.email "e2e@example.invalid"
    git -C "$PROJECT" config user.name "chatgpt2codex e2e"
  fi
  echo "workspace=$WORKSPACE"
}

install_app() {
  test -f "$INSTALLER" || return
  HOME="$HOME_DIR" bash "$INSTALLER" --prefix "$PREFIX" --no-launch --workspace "$WORKSPACE" || return
  test -x "$PREFIX/bin/node" || return
  test -x "$PREFIX/bin/cloudflared" || return
  test -f "$PREFIX/dist/cli.js" || return
  test -x "$PREFIX/chatgpt2codex" || return
  test -x "$PREFIX/start-chatgpt2codex.sh" || return
  echo "installed=$PREFIX"
}

init_tokens() {
  local output
  output="$(HOME="$HOME_DIR" "$PREFIX/bin/node" "$PREFIX/dist/cli.js" init --workspace "$WORKSPACE" --rotate-owner-token 2>&1)" || return
  OWNER_TOKEN="$(printf '%s\n' "$output" | sed -n 's/^  \([A-Za-z0-9_-]\{40,\}\)$/\1/p' | sed -n '1p')"
  test -n "$OWNER_TOKEN" || return
  export OWNER_TOKEN
  echo "owner token parsed"
}

doctor_runtime() {
  local output
  output="$(HOME="$HOME_DIR" PATH="$PREFIX/bin:$PATH" "$PREFIX/bin/node" "$PREFIX/dist/cli.js" doctor)" || return
  grep -q "owner token configured" <<<"$output" || return
  grep -q "registered tools:" <<<"$output" || return
  echo "doctor ok"
}

write_http_harness() {
  cat >"$RUN_ROOT/http-e2e.mjs" <<'JS'
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [baseUrl, ownerToken, projectRoot] = process.argv.slice(2);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  return { res, text, body: text ? JSON.parse(text) : null };
}

async function text(method, url, body, headers = {}) {
  const res = await fetch(url, { method, headers, body, redirect: "manual" });
  return { res, text: await res.text() };
}

function form(fields) {
  const data = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function oauthToken() {
  const redirect = "https://chatgpt.com/chatgpt2codex-e2e/callback";
  const resource = `${baseUrl}/mcp`;
  const registered = await json("POST", `${baseUrl}/register`, {
    client_name: "chatgpt2codex-linux-e2e",
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  assert(registered.res.status === 200 || registered.res.status === 201, `register failed ${registered.res.status}`);
  const clientId = registered.body.client_id;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "chatgpt2codex",
    state,
    resource,
  });
  const authGet = await text("GET", `${baseUrl}/authorize?${params}`);
  assert(authGet.res.status === 200, `authorize form failed ${authGet.res.status}`);
  const csrf = authGet.text.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert(csrf, "missing csrf");
  const authPost = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "chatgpt2codex",
      state,
      resource,
      csrf_token: csrf,
      owner_token: ownerToken,
    }),
    redirect: "manual",
  });
  assert(authPost.status === 302, `authorize post failed ${authPost.status}`);
  const location = authPost.headers.get("location");
  assert(location, "missing redirect location");
  const redirected = new URL(location);
  const code = redirected.searchParams.get("code");
  assert(code, "missing authorization code");
  assert(redirected.searchParams.get("state") === state, "state mismatch");
  const tokenRes = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: clientId,
      resource,
    }),
  });
  const token = await tokenRes.json();
  assert(tokenRes.status === 200 && token.access_token, `token failed ${tokenRes.status}`);
  return token.access_token;
}

function parseMcp(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  assert(data, `no MCP JSON in ${text}`);
  return JSON.parse(data);
}

async function mcp(accessToken, request, sessionId) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(request) });
  const textBody = await res.text();
  return { res, body: parseMcp(textBody) };
}

const health = await json("GET", `${baseUrl}/healthz`);
assert(health.res.status === 200 && health.body.ok === true, "health failed");
const actions = await json("GET", `${baseUrl}/actions/health`);
assert(actions.body.actions >= 20, "actions health failed");
const openapi = await json("GET", `${baseUrl}/actions/openapi.json`);
assert(openapi.body.openapi === "3.1.0", "openapi failed");

const unauth = await json("POST", `${baseUrl}/actions/agent-guide`, {});
assert(unauth.res.status === 401, "action did not require owner bearer");
const auth = { authorization: `Bearer ${ownerToken}` };
const projects = await json("POST", `${baseUrl}/actions/workspace-list-projects`, { limit: 20 }, auth);
const project = projects.body.structuredContent.projects.find((p) => p.name === "e2e-project");
assert(project, "project not listed");
const selected = await json("POST", `${baseUrl}/actions/project-select`, {
  projectId: project.projectId,
  reason: "linux installer e2e",
  preset: "full-write",
  confirmSwitch: true,
}, auth);
assert(selected.body.ok === true, "project-select failed");
const created = await json("POST", `${baseUrl}/actions/file-create`, {
  projectId: project.projectId,
  path: "e2e-created.txt",
  content: "created by linux installer e2e\n",
}, auth);
assert(created.body.ok === true, "file-create failed");
assert(await readFile(path.join(projectRoot, "e2e-created.txt"), "utf8") === "created by linux installer e2e\n", "file content mismatch");
const commandList = await json("POST", `${baseUrl}/actions/command-list`, { projectId: project.projectId }, auth);
assert(commandList.body.ok === true, "command-list failed");
const echoCommand = commandList.body.structuredContent.commands.find((command) => command.commandId === "npm:echo");
assert(echoCommand, "npm:echo was not discovered");
const commandRun = await json("POST", `${baseUrl}/actions/command-run`, {
  projectId: project.projectId,
  commandId: "npm:echo",
  intent: { needsNetwork: false, expectedDurationSec: 10 },
}, auth);
assert(commandRun.body.ok === true && /e2e-command-ok/.test(commandRun.body.structuredContent.stdoutSummary), "command-run failed");
const shell = await json("POST", `${baseUrl}/actions/local-shell-run`, {
  projectId: project.projectId,
  command: "echo must-not-run",
  timeoutSec: 10,
  intent: { reason: "linux e2e arbitrary shell denial", writesWorkspace: false, needsNetwork: false, destructive: false },
}, auth);
assert(shell.body.ok === false && shell.body.structuredContent.code === "ARBITRARY_SHELL_DENIED", "remote arbitrary shell was not denied");

const noAuthMcp = await fetch(`${baseUrl}/mcp`, {
  method: "POST",
  headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
});
assert(noAuthMcp.status === 401, "MCP did not require OAuth");
const accessToken = await oauthToken();
const initialized = await mcp(accessToken, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "chatgpt2codex-linux-e2e", version: "1.0.0" },
  },
});
const sessionId = initialized.res.headers.get("mcp-session-id");
assert(sessionId, "missing mcp-session-id");
const tools = await mcp(accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
assert(tools.body.result.tools.some((tool) => tool.name === "file_create"), "MCP missing file_create");

console.log(JSON.stringify({
  ok: true,
  actions: actions.body.actions,
  mcpTools: tools.body.result.tools.length,
}));
JS
}

start_http_runtime() {
  PORT="$(get_free_port)" || return
  BASE_URL="http://127.0.0.1:$PORT"
  HOME="$HOME_DIR" PATH="$PREFIX/bin:$PATH" CHATGPT2CODEX_REMOTE_WRITE=1 CHATGPT2CODEX_REMOTE_EXEC=1 \
    "$PREFIX/bin/node" "$PREFIX/dist/cli.js" serve --http --port "$PORT" --public-url "$BASE_URL" --workspace "$WORKSPACE" --active-project-root "$PROJECT" --active-project-preset full-write >"$RUN_ROOT/server.out.log" 2>"$RUN_ROOT/server.err.log" &
  SERVER_PID="$!"
  PROCS+=("$SERVER_PID")
  if ! wait_http "$BASE_URL/healthz" "$TIMEOUT_SEC"; then
    echo "installed HTTP runtime did not become healthy" >&2
    echo "--- server stdout ---" >&2
    cat "$RUN_ROOT/server.out.log" >&2 2>/dev/null || true
    echo "--- server stderr ---" >&2
    cat "$RUN_ROOT/server.err.log" >&2 2>/dev/null || true
    echo "--- installed bin ---" >&2
    ls -la "$PREFIX/bin" >&2 2>/dev/null || true
    echo "--- server process ---" >&2
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "pid=$SERVER_PID alive" >&2
    else
      echo "pid=$SERVER_PID exited" >&2
    fi
    return 1
  fi
  export PORT BASE_URL SERVER_PID
  echo "port=$PORT"
}

http_feature_tests() {
  write_http_harness || return
  HOME="$HOME_DIR" "$PREFIX/bin/node" "$RUN_ROOT/http-e2e.mjs" "$BASE_URL" "$OWNER_TOKEN" "$PROJECT" || return
}

launcher_test() {
  local port
  port="$(get_free_port)" || return
  HOME="$HOME_DIR" "$PREFIX/start-chatgpt2codex.sh" --no-tunnel --port "$port" --workspace "$WORKSPACE" >"$RUN_ROOT/launcher.out.log" 2>"$RUN_ROOT/launcher.err.log" &
  local pid="$!"
  PROCS+=("$pid")
  if ! wait_http "http://127.0.0.1:$port/healthz" "$TIMEOUT_SEC"; then
    cat "$RUN_ROOT/launcher.out.log" "$RUN_ROOT/launcher.err.log" >&2 2>/dev/null || true
    return 1
  fi
  local ready_deadline=$((SECONDS + 5))
  while [ "$SECONDS" -lt "$ready_deadline" ]; do
    if grep -q "chatgpt2codex is ready" "$RUN_ROOT/launcher.out.log"; then
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  grep -q "chatgpt2codex is ready" "$RUN_ROOT/launcher.out.log" || {
    cat "$RUN_ROOT/launcher.out.log" "$RUN_ROOT/launcher.err.log" >&2 2>/dev/null || true
    return 1
  }
  kill "$pid" 2>/dev/null || true
  echo "port=$port"
}

tunnel_test() {
  if [ "$SKIP_TUNNEL" -eq 1 ]; then
    echo "skipped"
    return 0
  fi
  local port pid url deadline body
  port="$(get_free_port)" || return
  HOME="$HOME_DIR" "$PREFIX/start-chatgpt2codex.sh" --port "$port" --workspace "$WORKSPACE" >"$RUN_ROOT/tunnel.out.log" 2>"$RUN_ROOT/tunnel.err.log" &
  pid="$!"
  PROCS+=("$pid")
  deadline=$((SECONDS + TIMEOUT_SEC))
  url=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    url="$(grep -Eo 'https://[A-Za-z0-9.-]+\.trycloudflare\.com' "$RUN_ROOT/tunnel.out.log" 2>/dev/null | head -n 1 || true)"
    if [ -n "$url" ] && grep -q "chatgpt2codex is ready" "$RUN_ROOT/tunnel.out.log"; then
      break
    fi
    sleep 1
  done
  test -n "$url" || return
  wait_http "$url/healthz" "$TIMEOUT_SEC" || return
  body="$("$PREFIX/bin/node" -e 'fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e.message);process.exit(1)})' "$url/healthz")" || return
  grep -q '"ok":true' <<<"$body" || return
  kill "$pid" 2>/dev/null || true
  echo "url=$url"
}

mac_trace_check() {
  local terms=("osa""script" "apple ""events" "j""xa" "/usr/bin/""open" "/usr/bin/""which" "png""paste")
  local term
  for term in "${terms[@]}"; do
    if grep -R -I -n -i -F "$term" "$PREFIX/README.md" "$PREFIX/browser" "$PREFIX/dist" "$PREFIX/start-chatgpt2codex.sh" "$PREFIX/install-linux.sh"; then
      echo "forbidden trace found: $term" >&2
      return 1
    fi
  done
  echo "clean"
}

step "prepare workspace" prepare_workspace
step "install from one file" install_app
step "initialize isolated tokens" init_tokens
step "doctor packaged runtime" doctor_runtime
step "start installed HTTP runtime" start_http_runtime
step "verify HTTP actions OAuth MCP" http_feature_tests
step "verify Linux launcher" launcher_test
step "verify Cloudflare tunnel" tunnel_test
step "verify no macOS automation traces" mac_trace_check

write_report "passed"
echo "[e2e-linux] PASSED"
echo "[e2e-linux] report: $REPORT"
