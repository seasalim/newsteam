#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLIST_NAME="com.newsteam.plist"
LABEL="com.newsteam"

DOMAIN="gui/$(id -u)"

uninstall_macos() {
  local launch_agents_dir="${HOME}/Library/LaunchAgents"
  local target_plist="${launch_agents_dir}/${PLIST_NAME}"

  # bootout (modern) with fallback to unload (legacy)
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null \
    || launchctl unload "${target_plist}" 2>/dev/null \
    || true

  rm -f "${target_plist}"
  echo "✅ Uninstalled ${LABEL}"
}

install_macos() {
  local launch_agents_dir="${HOME}/Library/LaunchAgents"
  local template_plist="${SCRIPT_DIR}/${PLIST_NAME}"
  local target_plist="${launch_agents_dir}/${PLIST_NAME}"

  mkdir -p "${launch_agents_dir}" "${INSTALL_DIR}/logs"
  sed "s|__INSTALL_DIR__|${INSTALL_DIR}|g" "${template_plist}" > "${target_plist}"

  # Remove existing service if running
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null \
    || launchctl unload "${target_plist}" 2>/dev/null \
    || true

  # Bootstrap (modern) with fallback to load (legacy)
  launchctl bootstrap "${DOMAIN}" "${target_plist}" 2>/dev/null \
    || launchctl load "${target_plist}"

  echo "✅ Installed and started ${LABEL}"
  echo "   Logs: ${INSTALL_DIR}/logs/"
  echo "   Stop: launchctl kill SIGTERM ${DOMAIN}/${LABEL}"
  echo "   Start: launchctl kickstart ${DOMAIN}/${LABEL}"
}

main() {
  local platform
  platform="$(uname -s)"

  if [[ "${1:-}" == "--uninstall" ]]; then
    case "${platform}" in
      Darwin)
        uninstall_macos
        ;;
      Linux)
        echo "Linux systemd support coming soon"
        ;;
      *)
        echo "Unsupported platform: ${platform}" >&2
        exit 1
        ;;
    esac
    exit 0
  fi

  case "${platform}" in
    Darwin)
      install_macos
      ;;
    Linux)
      echo "Linux systemd support coming soon"
      exit 0
      ;;
    *)
      echo "Unsupported platform: ${platform}" >&2
      exit 1
      ;;
  esac
}

main "$@"
