#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

cd "$ROOT"
npm run build >/dev/null

mkdir -p "$BIN_DIR"

write_wrapper() {
  local name="$1"
  local target="$BIN_DIR/$name"
  cat >"$target" <<EOF
#!/usr/bin/env bash
exec node "$ROOT/dist/cli.js" "\$@"
EOF
  chmod 0755 "$target"
}

write_wrapper c2c
write_wrapper chatgpt2codex

echo "Installed local CLI wrappers:"
echo "  $BIN_DIR/c2c"
echo "  $BIN_DIR/chatgpt2codex"

case ":${PATH:-}:" in
  *":$BIN_DIR:"*)
    echo "PATH is ready. Try: c2c"
    ;;
  *)
    echo
    echo "PATH does not include $BIN_DIR."
    echo "Add this to your shell profile, then open a new shell:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
