#!/usr/bin/env bash
# Restore the acp profile to the registry @hanxu131/dshacp.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/acp}"

echo "Restoring registry @hanxu131/dshacp in $PROFILE ..."
node -e "
const fs = require('node:fs')
const path = process.argv[1]
const wsPath = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'))
pkg.dependencies['@hanxu131/dshacp'] = '0.1.9'
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
if (fs.existsSync(wsPath)) {
  const lines = fs.readFileSync(wsPath, 'utf8').split('\n')
  const out = []
  let skipping = false
  for (const line of lines) {
    if (line.startsWith('overrides:')) { skipping = true; continue }
    if (skipping) {
      if (/^\S/.test(line) && !line.startsWith(' ')) skipping = false
      else continue
    }
    out.push(line)
  }
  fs.writeFileSync(wsPath, out.join('\n').replace(/\n+$/, '\n'))
}
" "$PROFILE/package.json" "$PROFILE/pnpm-workspace.yaml"

(cd "$PROFILE" && dsh plugin --profile acp update @hanxu131/dshacp)

echo "Done. Optional: rm -rf $ROOT/.dev-link-pack"
