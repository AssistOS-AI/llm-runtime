#!/usr/bin/env bash
# Fake reranker launcher. Describes a rerank capability instead of chat.
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
    "capabilities": { "rerank": true }
}
JSON
        ;;
    prepare) echo '{"prepared":true}' ;;
    start)   echo '{"instanceId":"fake","status":"running"}' ;;
    stop)    echo '{"stopped":true}' ;;
    status)  echo '{"status":"running"}' ;;
    *) echo "unknown command: ${1:-}" >&2; exit 2 ;;
esac
