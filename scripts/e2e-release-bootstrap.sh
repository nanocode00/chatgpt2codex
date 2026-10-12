#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT/install.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/c2c-release-bootstrap-e2e.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

make_artifact() {
  local version="$1" out_dir="$2"
  local pkg="$TMP/pkg-$version"
  rm -rf "$pkg"
  mkdir -p "$pkg/bin" "$pkg/dist" "$out_dir"

  cat >"$pkg/package.json" <<EOF
{"name":"chatgpt2codex","version":"$version"}
EOF
  echo "// fixture" >"$pkg/dist/cli.js"

  cat >"$pkg/bin/node" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == "-p" ]]; then
  grep -Eo '"version"[[:space:]]*:[[:space:]]*"[^"]+"' package.json | sed -E 's/.*"([^"]+)"$/\1/'
  exit 0
fi
exit 2
EOF
  chmod +x "$pkg/bin/node"

  cat >"$pkg/bin/cloudflared" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$pkg/bin/cloudflared"

  cat >"$pkg/chatgpt2codex" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
state="$HOME/.local/share/chatgpt2codex"
config="${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt2codex"
log="$HOME/fake-c2c.log"
mkdir -p "$state/runtime" "$config"
cmd="${1:-help}"
shift || true
case "$cmd" in
  --help|help)
    echo "fake c2c help"
    ;;
  owner-token)
    if [[ "${1:-}" == "--status" ]]; then
      if [[ -f "$state/owner-token.json" ]]; then echo '{"configured":true}'; else echo '{"configured":false}'; fi
    fi
    ;;
  init)
    echo '{"hash":"fixture"}' >"$state/owner-token.json"
    echo "fixture-owner-token-visible-once" >&2
    ;;
  config)
    action="${1:-}"; key="${2:-}"; value="${3:-}"
    if [[ "$action" == "set" ]]; then
      echo "CONFIG_SET $key=$value" >>"$log"
      echo '{}' >"$config/config.json"
      [[ "$key" != "tunnel" ]] || echo "$value" >"$config/tunnel"
      [[ "$key" != "public-hostname" ]] || echo "$value" >"$config/public-hostname"
    elif [[ "$action" == "unset" ]]; then
      echo "CONFIG_UNSET $key" >>"$log"
      [[ "$key" != "public-hostname" ]] || rm -f "$config/public-hostname"
    fi
    echo '{"updated":true}'
    ;;
  secret)
    action="${1:-}"; name="${2:-}"
    if [[ "$action" == "set" ]]; then
      IFS= read -r secret || true
      echo "SECRET_SET $name length=${#secret}" >>"$log"
      unset secret
    elif [[ "$action" == "remove" ]]; then
      echo "SECRET_REMOVE $name" >>"$log"
    fi
    echo '{"ok":true}'
    ;;
  health)
    if [[ ! -f "$state/healthy" ]]; then
      echo '{"instance":"default","alive":false,"healthy":false,"tunnelAlive":null,"publicHealthy":null}'
      exit 1
    fi
    if [[ -f "$config/tunnel" && "$(cat "$config/tunnel")" == "cloudflare" ]]; then
      count_file="$state/public-health-count"
      count=0
      [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"
      count=$((count + 1))
      echo "$count" >"$count_file"
      if [[ "$count" -lt 3 ]]; then
        echo '{"instance":"default","alive":true,"healthy":true,"tunnelAlive":true,"publicHealthy":false}'
        exit 1
      fi
      echo '{"instance":"default","alive":true,"healthy":true,"tunnelAlive":true,"publicHealthy":true}'
    else
      echo '{"instance":"default","alive":true,"healthy":true,"tunnelAlive":null,"publicHealthy":null}'
    fi
    ;;
  start|restart)
    touch "$state/healthy"
    echo "{\"entrypoint\":\"$0\"}" >"$state/runtime/default.json"
    echo '{"started":true}'
    ;;
  stop)
    rm -f "$state/healthy"
    echo '{"stopped":true}'
    ;;
  status)
    if [[ -f "$config/public-hostname" ]]; then
      host="$(cat "$config/public-hostname")"
      echo "{\"healthy\":true,\"publicUrl\":\"https://$host\"}"
    elif [[ -f "$config/tunnel" && "$(cat "$config/tunnel")" == "cloudflare" ]]; then
      echo '{"healthy":true,"publicUrl":"https://fixture.trycloudflare.com"}'
    else
      echo '{"healthy":true,"publicUrl":"http://127.0.0.1:7979"}'
    fi
    ;;
  *) echo '{}' ;;
esac
EOF
  chmod +x "$pkg/chatgpt2codex"

  local payload="$TMP/payload-$version.tar.gz"
  tar -czf "$payload" -C "$pkg" .
  local run="$out_dir/chatgpt2codex-linux-x64.run"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'exit 0' '__CHATGPT2CODEX_PAYLOAD_BELOW__'
    cat "$payload"
  } >"$run"
  chmod +x "$run"
  (cd "$out_dir" && sha256sum chatgpt2codex-linux-x64.run >SHA256SUMS)
}

make_minimal_path() {
  local dir="$1"
  mkdir -p "$dir"
  local cmd target
  for cmd in bash env awk tar gzip tail grep sed readlink dirname basename mktemp cp mv rm ln chmod mkdir sha256sum uname rmdir date head cat touch sleep; do
    target="$(command -v "$cmd")"
    ln -s "$target" "$dir/$cmd"
  done
}

run_install() {
  local home="$1" clone="$2" artifact_dir="$3"
  shift 3
  HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_BIN_HOME="$home/.local/bin" PATH="$MINPATH" \
    /bin/bash "$clone/install.sh" \
      --artifact "$artifact_dir/chatgpt2codex-linux-x64.run" \
      --checksums "$artifact_dir/SHA256SUMS" \
      --workspace "$home/workspace" "$@"
}

MINPATH="$TMP/minbin"
make_minimal_path "$MINPATH"
if PATH="$MINPATH" command -v node >/dev/null 2>&1 || PATH="$MINPATH" command -v npm >/dev/null 2>&1 || PATH="$MINPATH" command -v python3 >/dev/null 2>&1; then
  echo "test harness accidentally exposes Node/npm/Python" >&2
  exit 1
fi

ART1="$TMP/release-1"; ART2="$TMP/release-2"
make_artifact "0.3.0" "$ART1"
make_artifact "0.3.1" "$ART2"

HOME1="$TMP/home-quick"; CLONE1="$TMP/clone"
mkdir -p "$HOME1" "$CLONE1"
cp "$INSTALLER" "$CLONE1/install.sh"; chmod +x "$CLONE1/install.sh"
quick_output="$(run_install "$HOME1" "$CLONE1" "$ART1" --non-interactive --quick-tunnel 2>&1)"
grep -q 'configured Cloudflare Quick Tunnel' <<<"$quick_output"
grep -q 'fixture.trycloudflare.com/mcp' <<<"$quick_output"
[[ "$(cat "$HOME1/.local/share/chatgpt2codex/public-health-count")" -ge 3 ]]
grep -q 'CONFIG_SET tunnel=cloudflare' "$HOME1/fake-c2c.log"
! grep -q 'CONFIG_SET public-hostname=' "$HOME1/fake-c2c.log"
! grep -q 'SECRET_SET cloudflare-token' "$HOME1/fake-c2c.log"

mv "$CLONE1" "$TMP/clone-moved"
(
  cd "$TMP"
  HOME="$HOME1" XDG_CONFIG_HOME="$HOME1/.config" XDG_BIN_HOME="$HOME1/.local/bin" PATH="$MINPATH" \
    "$HOME1/.local/bin/c2c" health >/dev/null
)
version1="$(HOME="$HOME1" PATH="$MINPATH" "$HOME1/.local/bin/c2c" --installed-version)"
grep -q '"version":"0.3.0"' <<<"$version1"

HOME="$HOME1" XDG_CONFIG_HOME="$HOME1/.config" XDG_BIN_HOME="$HOME1/.local/bin" PATH="$MINPATH" \
  /bin/bash "$HOME1/.local/lib/chatgpt2codex/current/manage.sh" install \
    --artifact "$ART2/chatgpt2codex-linux-x64.run" --checksums "$ART2/SHA256SUMS" \
    --workspace "$HOME1/workspace" --non-interactive --no-start >/dev/null
version2="$(HOME="$HOME1" PATH="$MINPATH" "$HOME1/.local/bin/c2c" --installed-version)"
grep -q '"version":"0.3.1"' <<<"$version2"
HOME="$HOME1" PATH="$MINPATH" /bin/bash "$HOME1/.local/lib/chatgpt2codex/current/manage.sh" rollback >/dev/null
version_rollback="$(HOME="$HOME1" PATH="$MINPATH" "$HOME1/.local/bin/c2c" --installed-version)"
grep -q '"version":"0.3.0"' <<<"$version_rollback"

HOME2="$TMP/home-named"; CLONE2="$TMP/clone-named"
mkdir -p "$HOME2" "$CLONE2"
cp "$INSTALLER" "$CLONE2/install.sh"; chmod +x "$CLONE2/install.sh"
secret_value="super-secret-tunnel-token"
named_output="$(
  printf '%s\n' "$secret_value" |
    HOME="$HOME2" XDG_CONFIG_HOME="$HOME2/.config" XDG_BIN_HOME="$HOME2/.local/bin" PATH="$MINPATH" \
      /bin/bash "$CLONE2/install.sh" \
        --artifact "$ART1/chatgpt2codex-linux-x64.run" --checksums "$ART1/SHA256SUMS" \
        --workspace "$HOME2/workspace" --non-interactive --named-tunnel \
        --public-hostname codex.example.com --tunnel-token-stdin 2>&1
)"
! grep -q "$secret_value" <<<"$named_output"
! grep -q "$secret_value" "$HOME2/fake-c2c.log"
grep -q 'SECRET_SET cloudflare-token' "$HOME2/fake-c2c.log"
grep -q 'CONFIG_SET public-hostname=codex.example.com' "$HOME2/fake-c2c.log"

BAD="$TMP/bad-sums"
mkdir -p "$BAD"
cp "$ART1/chatgpt2codex-linux-x64.run" "$BAD/"
printf '%064d  %s\n' 0 chatgpt2codex-linux-x64.run >"$BAD/SHA256SUMS"
HOME3="$TMP/home-bad"
mkdir -p "$HOME3" "$TMP/clone-bad"
cp "$INSTALLER" "$TMP/clone-bad/install.sh"
if run_install "$HOME3" "$TMP/clone-bad" "$BAD" --non-interactive --no-start >/dev/null 2>&1; then
  echo "checksum mismatch unexpectedly succeeded" >&2
  exit 1
fi
[[ ! -e "$HOME3/.local/lib/chatgpt2codex/current" ]]

HOME4="$TMP/home-collision"
mkdir -p "$HOME4/.local/bin" "$TMP/clone-collision"
cp "$INSTALLER" "$TMP/clone-collision/install.sh"
printf '%s\n' '#!/bin/sh' 'echo unrelated' >"$HOME4/.local/bin/c2c"
if run_install "$HOME4" "$TMP/clone-collision" "$ART1" --non-interactive --no-start >/dev/null 2>&1; then
  echo "unrelated launcher unexpectedly overwritten" >&2
  exit 1
fi

HOME5="$TMP/home-lock"
mkdir -p "$HOME5/.local/lib/chatgpt2codex/releases" "$HOME5/.local/lib/chatgpt2codex/.install-lock" "$TMP/clone-lock"
cp "$INSTALLER" "$TMP/clone-lock/install.sh"
if run_install "$HOME5" "$TMP/clone-lock" "$ART1" --non-interactive --no-start >/dev/null 2>&1; then
  echo "concurrent install lock unexpectedly ignored" >&2
  exit 1
fi

echo "PASS: Bash-only release bootstrap, Quick/Named Cloudflare setup, checksum/collision/lock safety, upgrade+rollback"
