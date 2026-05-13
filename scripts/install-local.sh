#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TARGET_HOME="${HOME}/.openclaw"

mkdir -p "${TARGET_HOME}/extensions" "${TARGET_HOME}/skills"
rm -rf "${TARGET_HOME}/extensions/cmp"
rm -rf "${TARGET_HOME}/skills/cmp"
rm -rf "${TARGET_HOME}/skills/_shared"

cp -R "${ROOT}/extensions/cmp" "${TARGET_HOME}/extensions/"
cp -R "${ROOT}/skills/cmp" "${TARGET_HOME}/skills/"
cp -R "${ROOT}/skills/_shared" "${TARGET_HOME}/skills/"

echo "Installed openclaw-cmp into ${TARGET_HOME}"
echo "Next: openclaw gateway restart"
