#!/usr/bin/env bash
# Fake test launcher. Implements the launcher contract surface without
# downloading or running a real model so unit/smoke tests can exercise the
# runtime MCP server end-to-end.
set -euo pipefail

cmd="${1:-}"

case "$cmd" in
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
    prepare)
        echo '{"prepared":true}'
        ;;
    start)
        echo '{"instanceId":"fake","status":"running"}'
        ;;
    stop)
        echo '{"stopped":true}'
        ;;
    status)
        echo '{"status":"running"}'
        ;;
    *)
        echo "unknown command: $cmd" >&2
        exit 2
        ;;
esac
