#!/usr/bin/env bash
# Install a local build of @hanxu131/dshacp into ~/.dsh/profiles/acp for Zed testing.
#
# Do NOT `npm link` the source tree: its node_modules/ pins a second copy of
# @deepseek-ai/* (rc.6) beside the profile graph (rc.8 / global dsh), which
# makes Cordis plugins load twice (deployment:persona already registered) or
# breaks imports when node_modules is hidden (schemastery not found).
#
# Instead we pack only the published files (lib/ + cordis ymls — no node_modules)
# and install the tarball with pnpm, exactly like a registry release.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/acp}"
PACK_DIR="$ROOT/.dev-link-pack"

# Restore legacy full hide if present.
if [[ -d "$ROOT/.node_modules-dev-link" && ! -d "$ROOT/node_modules" ]]; then
  echo "Restoring repo node_modules from legacy .node_modules-dev-link ..."
  mv "$ROOT/.node_modules-dev-link" "$ROOT/node_modules"
fi

# Restore selectively stashed Cordis plugins if a prior link run left them behind.
if [[ -d "$ROOT/.dev-link-stash/@deepseek-ai" ]]; then
  echo "Restoring stashed @deepseek-ai packages into repo node_modules..."
  mkdir -p "$ROOT/node_modules/@deepseek-ai"
  for pkg in "$ROOT/.dev-link-stash/@deepseek-ai"/*; do
    [[ -d "$pkg" ]] || continue
    name="$(basename "$pkg")"
    rm -rf "$ROOT/node_modules/@deepseek-ai/$name"
    mv "$pkg" "$ROOT/node_modules/@deepseek-ai/$name"
  done
  rmdir "$ROOT/.dev-link-stash/@deepseek-ai" 2>/dev/null || true
  rmdir "$ROOT/.dev-link-stash" 2>/dev/null || true
fi

# Drop any prior npm/pnpm link to the source tree (causes duplicate Cordis plugins).
npm unlink -g @hanxu131/dshacp 2>/dev/null || true

echo "Building @hanxu131/dshacp..."
(cd "$ROOT" && npm run build)

mkdir -p "$PACK_DIR"
echo "Packing tarball (published files only, no node_modules)..."
TARBALL="$(cd "$ROOT" && npm pack --pack-destination "$PACK_DIR" 2>&1 | tail -1 | tr -d '\r\n')"
TARBALL_PATH="$PACK_DIR/$TARBALL"
if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "npm pack failed; expected $TARBALL_PATH" >&2
  exit 1
fi

echo "Installing $TARBALL_PATH into $PROFILE ..."
node -e "
const fs = require('node:fs')
const path = process.argv[1]
const tarball = process.argv[2]
const wsPath = process.argv[3]
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'))
pkg.dependencies['@hanxu131/dshacp'] = 'file:' + tarball
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
if (fs.existsSync(wsPath)) {
  const text = fs.readFileSync(wsPath, 'utf8')
  const cleaned = text.replace(/\noverrides:\n(?:  .*\n)*/g, '\n')
  fs.writeFileSync(wsPath, cleaned.endsWith('\n') ? cleaned : cleaned + '\n')
}
" "$PROFILE/package.json" "$TARBALL_PATH" "$PROFILE/pnpm-workspace.yaml"

# Drop any prior pnpm link (global or local) so the tarball install is used.
(cd "$PROFILE" && pnpm unlink @hanxu131/dshacp 2>/dev/null || true)
(cd "$PROFILE" && rm -rf node_modules pnpm-lock.yaml && pnpm install)

echo "Installed $(basename "$TARBALL_PATH"). Restart Zed DSH sessions."
echo "After code changes: re-run this script (rebuild + repack + pnpm install)."
echo "To restore registry version: scripts/dev-unlink-dsh-profile.sh"
