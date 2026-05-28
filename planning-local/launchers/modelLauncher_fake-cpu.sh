#!/usr/bin/env bash
# Fake CPU test launcher for planning-local. Mirrors base-local's fake launcher.
set -euo pipefail
case "${1:-}" in
    describe)
        cat <<'JSON'
{
    "schemaVersion": 1,
    "id": "fake-cpu",
    "engine": "fake",
    "supportedAccelerators": ["cpu"],
    "supportedPlatforms": ["linux/amd64", "linux/arm64"],
    "capabilities": { "chat": true }
}
JSON
        ;;
    prepare) echo '{"prepared":true}' ;;
    start)   echo '{"instanceId":"fake","status":"running"}' ;;
    stop)    echo '{"stopped":true}' ;;
    status)  echo '{"status":"running"}' ;;
    *) echo "unknown command: ${1:-}" >&2; exit 2 ;;
esac
