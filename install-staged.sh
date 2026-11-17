#!/usr/bin/env bash
# Swap the staged Tiling Shell build into the user extension directory.
# Run this immediately before logging out (or from a TTY). Swapping the
# files under a live GNOME Shell session can crash the shell.
set -euo pipefail

STAGED="${HOME}/.local/share/tilingshell-staged"
LIVE="${HOME}/.local/share/gnome-shell/extensions/tilingshell@ferrarodomenico.com"
BACKUP="${HOME}/.local/share/tilingshell-backup-phase1"
V18="${HOME}/.local/share/tilingshell-backup-v18.0"
PREVIOUS="${LIVE}.previous"

if [[ "${BACKUP}" == "${V18}" || "${STAGED}" == "${V18}" || "${LIVE}" == "${V18}" ]]; then
    echo "Refusing to touch the v18.0 backup at ${V18}." >&2
    exit 1
fi

if [[ ! -f "${STAGED}/metadata.json" || ! -f "${STAGED}/extension.js" ]]; then
    echo "Staged build is incomplete: ${STAGED}" >&2
    exit 1
fi

if [[ ! -d "${LIVE}" ]]; then
    echo "Live extension is not installed at ${LIVE}." >&2
    exit 1
fi

if [[ -e "${BACKUP}" ]]; then
    echo "Phase 1 backup already exists at ${BACKUP}." >&2
    echo "Leave that directory in place. Not swapping again." >&2
    exit 1
fi

if [[ -e "${PREVIOUS}" ]]; then
    echo "Unexpected leftover at ${PREVIOUS}." >&2
    exit 1
fi

if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "${STAGED}/schemas"
fi

cp -a "${LIVE}" "${BACKUP}"
mv "${LIVE}" "${PREVIOUS}"
if ! cp -a "${STAGED}" "${LIVE}"; then
    mv "${PREVIOUS}" "${LIVE}"
    echo "Copy failed. Restored the previous extension." >&2
    echo "Phase 1 backup remains at ${BACKUP}." >&2
    exit 1
fi

if command -v gio >/dev/null 2>&1; then
    gio trash "${PREVIOUS}"
else
    echo "Left the replaced copy at ${PREVIOUS}."
fi

echo "Installed staged Tiling Shell over the live extension."
echo "Phase 1 backup: ${BACKUP}"
echo "v18.0 backup was left untouched: ${V18}"
echo "Log out and back in so GNOME Shell loads the new files."
