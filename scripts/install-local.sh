#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TARGET_HOME="${HOME}/.openclaw"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${TARGET_HOME}/extensions" "${TARGET_HOME}/skills" "${TARGET_HOME}/skills/_shared"

for file in state.json platforms.json; do
  if [ -f "${TARGET_HOME}/skills/cmp/config/${file}" ]; then
    mkdir -p "${TMP_DIR}/cmp-config"
    cp "${TARGET_HOME}/skills/cmp/config/${file}" "${TMP_DIR}/cmp-config/${file}"
  fi
done

if [ -d "${TARGET_HOME}/skills/cmp/logs" ]; then
  mkdir -p "${TMP_DIR}/cmp-logs"
  cp -R "${TARGET_HOME}/skills/cmp/logs/." "${TMP_DIR}/cmp-logs/"
fi

rm -rf "${TARGET_HOME}/extensions/cmp"
rm -rf "${TARGET_HOME}/skills/cmp"

cp -R "${ROOT}/extensions/cmp" "${TARGET_HOME}/extensions/"
cp -R "${ROOT}/skills/cmp" "${TARGET_HOME}/skills/"
cp -R "${ROOT}/skills/_shared/." "${TARGET_HOME}/skills/_shared/"

for file in state.json platforms.json; do
  if [ -f "${TMP_DIR}/cmp-config/${file}" ]; then
    mkdir -p "${TARGET_HOME}/skills/cmp/config"
    cp "${TMP_DIR}/cmp-config/${file}" "${TARGET_HOME}/skills/cmp/config/${file}"
    echo "Preserved existing skills/cmp/config/${file}"
  fi
done

if [ -d "${TMP_DIR}/cmp-logs" ]; then
  mkdir -p "${TARGET_HOME}/skills/cmp/logs"
  cp -R "${TMP_DIR}/cmp-logs/." "${TARGET_HOME}/skills/cmp/logs/"
  echo "Preserved existing skills/cmp/logs"
fi

echo "Installed openclaw-cmp into ${TARGET_HOME}"
echo "Validate: npm run doctor"
echo "Next: openclaw gateway restart"
