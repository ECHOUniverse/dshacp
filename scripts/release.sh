#!/usr/bin/env bash
# Publish @hanxu131/dshacp to npm and update the local DSH dshacp profile.
#
# Usage:
#   ./scripts/release.sh "short release note"              # patch bump (0.1.9 → 0.1.10)
#   ./scripts/release.sh "short release note" minor        # minor bump
#   ./scripts/release.sh "short release note" 0.2.0       # explicit version
#   ./scripts/release.sh "short release note" patch --no-install   # publish only
#
# Steps: test → version bump → release commit → npm publish → git tag → dsh plugin update

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/dshacp}"
INSTALL=1

usage() {
  sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

[[ $# -ge 1 ]] || usage

NOTE="$1"
shift

BUMP="patch"
while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major)
      BUMP="$1"
      shift
      ;;
    --no-install)
      INSTALL=0
      shift
      ;;
    *)
      if [[ "$BUMP" == "patch" && "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        EXPLICIT_VERSION="$1"
      else
        echo "Unknown argument: $1" >&2
        usage
      fi
      shift
      ;;
  esac
done

cd "$ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; commit or stash changes before releasing." >&2
  git status --short >&2
  exit 1
fi

echo "Running typecheck and unit tests..."
npm run typecheck
npm run test:unit

OLD_VERSION="$(node -p "require('./package.json').version")"

if [[ -n "${EXPLICIT_VERSION:-}" ]]; then
  echo "Bumping version: $OLD_VERSION → $EXPLICIT_VERSION"
  npm version "$EXPLICIT_VERSION" --no-git-tag-version
else
  echo "Bumping $BUMP version from $OLD_VERSION..."
  npm version "$BUMP" --no-git-tag-version
fi

NEW_VERSION="$(node -p "require('./package.json').version")"

git add package.json package-lock.json
git commit -m "$(cat <<EOF
release: v${NEW_VERSION} — ${NOTE}

EOF
)"

echo "Publishing @hanxu131/dshacp@${NEW_VERSION} to npm..."
npm publish

git tag "v${NEW_VERSION}"

if [[ "$INSTALL" -eq 1 ]]; then
  echo "Updating $PROFILE from registry..."
  if [[ -f "$PROFILE/package.json" ]]; then
    node -e "
const fs = require('node:fs')
const path = process.argv[1]
const version = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'))
pkg.dependencies['@hanxu131/dshacp'] = '^' + version
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
" "$PROFILE/package.json" "$NEW_VERSION"
    for attempt in 1 2 3 4 5; do
      if (cd "$PROFILE" && dsh plugin --profile dshacp update @hanxu131/dshacp); then
        break
      fi
      if [[ "$attempt" -eq 5 ]]; then
        echo "Install failed after 5 attempts; registry may still be propagating." >&2
        echo "Retry: dsh plugin --profile dshacp update @hanxu131/dshacp" >&2
        exit 1
      fi
      echo "Registry not ready yet; retrying in ${attempt}0s..."
      sleep "${attempt}0"
    done
  else
    echo "Profile not found at $PROFILE; skip install (run: dsh plugin --profile dshacp update @hanxu131/dshacp)" >&2
  fi
fi

echo ""
echo "Released v${NEW_VERSION}. Next:"
echo "  git push && git push origin v${NEW_VERSION}"
