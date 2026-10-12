#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${C2C_GITHUB_REPOSITORY:-nanocode00/chatgpt2codex}"
ASSET_NAME="chatgpt2codex-linux-x64.run"
CHECKSUM_NAME="SHA256SUMS"
PREFIX="${C2C_INSTALL_PREFIX:-$HOME/.local/lib/chatgpt2codex}"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
WORKSPACE="${WORKSPACE:-$HOME/workspace}"
COMMAND="install"
TAG=""
ARTIFACT=""
CHECKSUMS=""
RECONFIGURE=0
START_AFTER=1
NON_INTERACTIVE=0
TUNNEL_CHOICE=""
PUBLIC_HOSTNAME=""
TOKEN_STDIN=0
LOCK_HELD=0
TMP_ROOT=""

die() { echo "[c2c install] error: $*" >&2; exit 1; }
note() { echo "[c2c install] $*"; }

usage() {
  cat <<'EOF'
Usage:
  ./install.sh [install] [options]
  ./install.sh status [--prefix PATH]
  ./install.sh rollback [--prefix PATH]

Install options:
  --tag TAG
  --artifact PATH           Local .run artifact (offline/testing).
  --checksums PATH          SHA256SUMS for --artifact.
  --prefix PATH
  --bin-dir PATH
  --workspace PATH
  --reconfigure
  --quick-tunnel
  --named-tunnel
  --no-tunnel
  --public-hostname HOST
  --tunnel-token-stdin
  --non-interactive
  --no-start
  -h, --help
EOF
}

if [[ $# -gt 0 && "${1:-}" != -* ]]; then
  case "$1" in
    install|status|rollback) COMMAND="$1"; shift ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:?--tag requires a value}"; shift 2 ;;
    --artifact) ARTIFACT="${2:?--artifact requires a value}"; shift 2 ;;
    --checksums) CHECKSUMS="${2:?--checksums requires a value}"; shift 2 ;;
    --prefix) PREFIX="${2:?--prefix requires a value}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:?--bin-dir requires a value}"; shift 2 ;;
    --workspace) WORKSPACE="${2:?--workspace requires a value}"; shift 2 ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    --quick-tunnel) TUNNEL_CHOICE="quick"; shift ;;
    --named-tunnel) TUNNEL_CHOICE="named"; shift ;;
    --no-tunnel) TUNNEL_CHOICE="none"; shift ;;
    --public-hostname) PUBLIC_HOSTNAME="${2:?--public-hostname requires a value}"; shift 2 ;;
    --tunnel-token-stdin) TOKEN_STDIN=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --no-start) START_AFTER=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

PREFIX="${PREFIX/#\~/$HOME}"
BIN_DIR="${BIN_DIR/#\~/$HOME}"
WORKSPACE="${WORKSPACE/#\~/$HOME}"
RELEASES="$PREFIX/releases"

cleanup() {
  local rc=$?
  if [[ "$LOCK_HELD" -eq 1 ]]; then rmdir "$PREFIX/.install-lock" 2>/dev/null || true; fi
  if [[ -n "$TMP_ROOT" && -d "$TMP_ROOT" ]]; then rm -rf "$TMP_ROOT"; fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

safe_directory() {
  local target="$1"
  [[ ! -L "$target" ]] || die "refusing symlink directory: $target"
  [[ ! -e "$target" || -d "$target" ]] || die "expected directory: $target"
  mkdir -p "$target"
}
checked_regular_file() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || die "expected regular non-symlink file: $file"
}
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}
download_file() {
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 20 --max-time 300 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$2" "$1"
  else
    die "curl or wget is required"
  fi
}
validate_release_id() {
  [[ "$1" =~ ^[0-9A-Za-z.-]+-[0-9a-f]{16}$ && "$1" != *..* ]] || die "invalid release id: $1"
}
read_pointer() {
  local link="$PREFIX/$1"
  if [[ ! -e "$link" && ! -L "$link" ]]; then return 0; fi
  [[ -L "$link" ]] || die "refusing unmanaged $1 pointer"
  local rel id
  rel="$(readlink "$link")"
  [[ "$rel" == releases/* && "$rel" != *"/../"* ]] || die "unsafe $1 pointer"
  id="${rel#releases/}"
  [[ "$id" != */* ]] || die "invalid $1 pointer"
  validate_release_id "$id"
  checked_regular_file "$PREFIX/$rel/release.json"
  printf '%s' "$id"
}
atomic_pointer() {
  validate_release_id "$2"
  local tmp="$PREFIX/.$1.$$"
  rm -f "$tmp"
  ln -s "releases/$2" "$tmp"
  mv -Tf "$tmp" "$PREFIX/$1"
}
print_status() {
  safe_directory "$PREFIX"; safe_directory "$RELEASES"
  local current previous
  current="$(read_pointer current)"
  previous="$(read_pointer previous)"
  printf 'prefix=%s\ncurrent=%s\nprevious=%s\n' "$PREFIX" "${current:-none}" "${previous:-none}"
}
acquire_lock() {
  safe_directory "$PREFIX"; safe_directory "$RELEASES"
  mkdir "$PREFIX/.install-lock" 2>/dev/null || die "another install/rollback may be active: $PREFIX/.install-lock"
  LOCK_HELD=1
}
release_lock() {
  if [[ "$LOCK_HELD" -eq 1 ]]; then rmdir "$PREFIX/.install-lock"; LOCK_HELD=0; fi
}

if [[ "$COMMAND" == "status" ]]; then print_status; exit 0; fi
if [[ "$COMMAND" == "rollback" ]]; then
  acquire_lock
  current="$(read_pointer current)"; previous="$(read_pointer previous)"
  [[ -n "$current" && -n "$previous" && "$current" != "$previous" ]] || die "no distinct previous release is available"
  atomic_pointer current "$previous"; atomic_pointer previous "$current"
  release_lock
  note "rolled back: $previous is now current"
  note "running instances were not restarted; run: c2c restart && c2c health"
  exit 0
fi

[[ "$(uname -s)" == "Linux" ]] || die "one-touch bootstrap currently supports Linux/WSL only"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "this release bootstrap currently supports Linux x86_64/amd64 only" ;;
esac
for cmd in awk tar gzip tail grep sed readlink dirname basename mktemp cp mv rm ln chmod mkdir date head cat; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command is missing: $cmd"
done

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c2c-release-bootstrap.XXXXXX")"
asset="$TMP_ROOT/$ASSET_NAME"; sums="$TMP_ROOT/$CHECKSUM_NAME"
if [[ -n "$ARTIFACT" ]]; then
  checked_regular_file "$ARTIFACT"; [[ -n "$CHECKSUMS" ]] || die "--checksums is required with --artifact"
  checked_regular_file "$CHECKSUMS"; cp "$ARTIFACT" "$asset"; cp "$CHECKSUMS" "$sums"
else
  if [[ -n "$TAG" ]]; then base="https://github.com/$REPOSITORY/releases/download/$TAG"; else base="https://github.com/$REPOSITORY/releases/latest/download"; fi
  note "downloading $ASSET_NAME"
  download_file "$base/$ASSET_NAME" "$asset"; download_file "$base/$CHECKSUM_NAME" "$sums"
fi

expected="$(awk -v n="$ASSET_NAME" '$2 == n || $2 == "*" n {print $1; exit}' "$sums")"
[[ "$expected" =~ ^[0-9A-Fa-f]{64}$ ]] || die "checksum file does not contain $ASSET_NAME"
expected="${expected,,}"; actual="$(sha256_file "$asset")"
[[ "$actual" == "$expected" ]] || die "SHA-256 mismatch for $ASSET_NAME"

acquire_lock
stage="$(mktemp -d "$RELEASES/.staging.XXXXXX")"
payload_line="$(awk '/^__CHATGPT2CODEX_PAYLOAD_BELOW__$/ {print NR + 1; exit}' "$asset")"
[[ "$payload_line" =~ ^[0-9]+$ ]] || die "release artifact payload marker is missing"
tail -n +"$payload_line" "$asset" | tar -xzf - -C "$stage"
for file in "$stage/bin/node" "$stage/bin/cloudflared" "$stage/dist/cli.js" "$stage/chatgpt2codex" "$stage/package.json"; do checked_regular_file "$file"; done
chmod +x "$stage/bin/node" "$stage/bin/cloudflared" "$stage/chatgpt2codex"

version="$(cd "$stage" && "$stage/bin/node" -p "require('./package.json').version")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || die "invalid package version: $version"
release_id="$version-${actual:0:16}"; validate_release_id "$release_id"
HOME="$TMP_ROOT/smoke-home" "$stage/chatgpt2codex" --help >/dev/null

self="${BASH_SOURCE[0]}"
if [[ "$self" != /* ]]; then self="$(cd -P "$(dirname "$self")" && pwd)/$(basename "$self")"; fi
cp "$self" "$stage/manage.sh"; chmod +x "$stage/manage.sh"
printf '{"schema":1,"version":"%s","id":"%s","assetSha256":"%s"}\n' "$version" "$release_id" "$actual" >"$stage/release.json"

target="$RELEASES/$release_id"
if [[ -e "$target" || -L "$target" ]]; then
  [[ -d "$target" && ! -L "$target" ]] || die "unsafe existing release path: $target"
  checked_regular_file "$target/release.json"
  stored="$(grep -Eo '"assetSha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$target/release.json" | grep -Eo '[0-9a-f]{64}' | head -n 1 || true)"
  [[ "$stored" == "$actual" ]] || die "existing release does not match downloaded artifact"
  rm -rf "$stage"
else
  mv "$stage" "$target"
fi

safe_directory "$BIN_DIR"; safe_directory "$PREFIX/legacy-launchers"
printf -v prefix_q '%q' "$PREFIX"
launcher="$(cat <<EOF
#!/usr/bin/env bash
# c2c-release managed launcher v1
set -Eeuo pipefail
C2C_ROOT=$prefix_q
[[ -L "\$C2C_ROOT/current" ]] || { echo "Missing C2C active release" >&2; exit 1; }
RELEASE="\$(readlink -f "\$C2C_ROOT/current")"
case "\$RELEASE" in "\$C2C_ROOT"/releases/*) ;; *) echo "Unsafe C2C release pointer" >&2; exit 1;; esac
[[ -f "\$RELEASE/release.json" && -x "\$RELEASE/chatgpt2codex" ]] || { echo "Incomplete C2C release" >&2; exit 1; }
if [[ "\${1:-}" == "--installed-version" ]]; then cat "\$RELEASE/release.json"; exit 0; fi
exec "\$RELEASE/chatgpt2codex" "\$@"
EOF
)"

for name in c2c chatgpt2codex; do
  file="$BIN_DIR/$name"
  if [[ -e "$file" || -L "$file" ]]; then
    [[ -f "$file" && ! -L "$file" ]] || die "refusing non-regular launcher: $file"
    if [[ "$(cat "$file")" != "$launcher" ]]; then
      if grep -Fq "# c2c-release managed launcher v1" "$file" ||
         grep -Fq "# c2c-standalone managed launcher v1" "$file" ||
         grep -Eq '^exec node "[^"]+/dist/cli\.js" "\$@"$' "$file"; then
        cp "$file" "$PREFIX/legacy-launchers/$name-$(date +%Y%m%d%H%M%S)-$$.sh"
      else
        die "refusing unrelated launcher: $file"
      fi
    fi
  fi
done

old_current="$(read_pointer current)"
if [[ -n "$old_current" && "$old_current" != "$release_id" ]]; then atomic_pointer previous "$old_current"; fi
atomic_pointer current "$release_id"
for name in c2c chatgpt2codex; do
  file="$BIN_DIR/$name"; tmp="$file.tmp.$$"
  printf '%s\n' "$launcher" >"$tmp"; chmod 0755 "$tmp"; mv -f "$tmp" "$file"
done
release_lock
note "installed release $release_id"

C2C="$BIN_DIR/c2c"
mkdir -p "$WORKSPACE"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt2codex"
token_status="$("$C2C" owner-token --status --workspace "$WORKSPACE" 2>/dev/null || true)"
owner=0; grep -Eq '"configured"[[:space:]]*:[[:space:]]*true' <<<"$token_status" && owner=1
existing_config=0; [[ -f "$config_dir/config.json" ]] && existing_config=1
setup=0; [[ "$owner" -eq 0 || "$existing_config" -eq 0 || "$RECONFIGURE" -eq 1 ]] && setup=1

if [[ "$owner" -eq 0 ]]; then
  note "initializing local state and Owner Token"
  "$C2C" init --workspace "$WORKSPACE"
fi

if [[ "$setup" -eq 1 ]]; then
  if [[ -z "$TUNNEL_CHOICE" ]]; then
    if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
      TUNNEL_CHOICE="none"
    else
      read -r -p "Enable ChatGPT web connector through Cloudflare? [Y/n] " answer
      case "${answer:-Y}" in
        n|N|no|NO) TUNNEL_CHOICE="none" ;;
        *)
          read -r -p "Do you already have a Cloudflare Named Tunnel + hostname for C2C? [y/N] " has_domain
          case "${has_domain:-N}" in y|Y|yes|YES) TUNNEL_CHOICE="named" ;; *) TUNNEL_CHOICE="quick" ;; esac
          ;;
      esac
    fi
  fi
  "$C2C" config set workspace "$WORKSPACE" >/dev/null
  case "$TUNNEL_CHOICE" in
    quick)
      "$C2C" config set tunnel cloudflare >/dev/null
      "$C2C" config unset public-hostname >/dev/null || true
      "$C2C" config unset tunnel-name >/dev/null || true
      "$C2C" secret remove cloudflare-token >/dev/null || true
      note "configured Cloudflare Quick Tunnel: no Cloudflare account/domain/token required"
      note "trycloudflare.com URL is temporary and changes after tunnel restart"
      ;;
    named)
      if [[ -z "$PUBLIC_HOSTNAME" ]]; then
        [[ "$NON_INTERACTIVE" -eq 0 && -t 0 ]] || die "--public-hostname is required with --named-tunnel"
        read -r -p "Public hostname (example: codex.example.com): " PUBLIC_HOSTNAME
      fi
      [[ -n "$PUBLIC_HOSTNAME" && "$PUBLIC_HOSTNAME" != *"://"* && "$PUBLIC_HOSTNAME" != */* ]] || die "invalid public hostname"
      token=""
      if [[ "$TOKEN_STDIN" -eq 1 ]]; then IFS= read -r token
      else
        [[ "$NON_INTERACTIVE" -eq 0 && -t 0 ]] || die "--tunnel-token-stdin is required for non-interactive named setup"
        read -r -s -p "Cloudflare Tunnel Token: " token; echo
      fi
      [[ -n "$token" ]] || die "Cloudflare Tunnel Token cannot be empty"
      "$C2C" config set tunnel cloudflare >/dev/null
      "$C2C" config set public-hostname "$PUBLIC_HOSTNAME" >/dev/null
      printf '%s' "$token" | "$C2C" secret set cloudflare-token --stdin >/dev/null
      unset token
      note "configured named Cloudflare Tunnel for $PUBLIC_HOSTNAME"
      ;;
    none)
      "$C2C" config set tunnel none >/dev/null
      if [[ "$RECONFIGURE" -eq 1 ]]; then
        "$C2C" config unset public-hostname >/dev/null || true
        "$C2C" config unset tunnel-name >/dev/null || true
        "$C2C" secret remove cloudflare-token >/dev/null || true
      fi
      note "web tunnel disabled"
      ;;
    *) die "invalid tunnel choice: $TUNNEL_CHOICE" ;;
  esac
else
  note "existing configuration detected; preserving it (use --reconfigure to change)"
fi

if [[ "$START_AFTER" -eq 1 ]]; then
  if "$C2C" health >/dev/null 2>&1; then
    restart=1
    if [[ "$NON_INTERACTIVE" -eq 0 && -t 0 ]]; then
      read -r -p "C2C is running. Restart into $release_id now? [Y/n] " answer
      case "${answer:-Y}" in n|N|no|NO) restart=0 ;; esac
    fi
    [[ "$restart" -eq 0 ]] || "$C2C" restart --workspace "$WORKSPACE" >/dev/null
  else
    "$C2C" start --workspace "$WORKSPACE" >/dev/null
  fi
  "$C2C" health >/dev/null 2>&1 || die "runtime did not become healthy; run: c2c status && c2c logs"
  note "health check passed"
  status_json="$("$C2C" status 2>/dev/null || true)"
  public_url="$(printf '%s\n' "$status_json" | grep -Eo '"publicUrl"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n 1 | sed -E 's/.*"([^"]+)"$/\1/' || true)"
  if [[ -n "$public_url" ]]; then
    note "connector URL: ${public_url%/}/mcp"
    [[ "$public_url" != *.trycloudflare.com ]] || note "this trycloudflare.com URL is temporary and changes on restart"
  fi
else
  note "runtime was not started (--no-start)"
fi

note "installed version:"
"$C2C" --installed-version
