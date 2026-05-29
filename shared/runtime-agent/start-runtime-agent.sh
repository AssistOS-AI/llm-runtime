#!/usr/bin/env bash
set -euo pipefail

PUBLIC_PORT="${PLOINKY_LLM_PUBLIC_PORT:-9000}"
MCP_PORT="${PLOINKY_LLM_MCP_PORT:-9001}"
CONTROL_PORT="${PLOINKY_LLM_CONTROL_PORT:-9002}"

export PLOINKY_LLM_PUBLIC_PORT="$PUBLIC_PORT"
export PLOINKY_LLM_MCP_PORT="$MCP_PORT"
export PLOINKY_LLM_CONTROL_PORT="$CONTROL_PORT"
export PLOINKY_LLM_RUNTIME_PORT="$CONTROL_PORT"
export PLOINKY_MCP_CONFIG_PATH="/Agent/llm-runtime/mcp-config.json"

control_pid=""
mcp_pid=""
proxy_pid=""

cleanup() {
    for pid in "$proxy_pid" "$mcp_pid" "$control_pid"; do
        if [ -n "$pid" ]; then
            kill "$pid" 2>/dev/null || true
        fi
    done
}

trap cleanup INT TERM EXIT

node /Agent/llm-runtime/runtime-agent/mcp-server.mjs &
control_pid="$!"

ready="false"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if curl -fsS "http://127.0.0.1:${CONTROL_PORT}/health" >/dev/null 2>&1; then
        ready="true"
        break
    fi
    if ! kill -0 "$control_pid" 2>/dev/null; then
        echo "[llm-runtime] control service exited before becoming ready" >&2
        exit 1
    fi
    sleep 0.25
done

if [ "$ready" != "true" ]; then
    echo "[llm-runtime] control service did not become ready on port ${CONTROL_PORT}" >&2
    exit 1
fi

PORT="$MCP_PORT" sh /Agent/server/AgentServer.sh &
mcp_pid="$!"

node /Agent/llm-runtime/runtime-agent/runtime-proxy.mjs &
proxy_pid="$!"

status=0
if wait -n "$control_pid" "$mcp_pid" "$proxy_pid"; then
    status=1
else
    status="$?"
fi

echo "[llm-runtime] one runtime service exited; stopping remaining services" >&2
exit "$status"
