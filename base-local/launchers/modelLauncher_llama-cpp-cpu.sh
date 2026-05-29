#!/usr/bin/env bash
# CPU llama.cpp launcher.
#
# Real launcher contract:
#   describe                              -> JSON describe block on stdout
#   prepare --config <launch-config.json> -> downloads/locates model files
#   start   --config <launch-config.json> -> spawns llama-server on 127.0.0.1:8080
#   stop    --instance <instanceId>       -> graceful stop of llama-server
#   status  --instance <instanceId>       -> JSON status block
#
# Required tools inside the container image:
#   - llama-server (from llama.cpp). Looked up via $LLAMA_SERVER_BIN or PATH.
#   - hf            (Hugging Face CLI) for model downloads. Looked up via PATH.
#
# Hugging Face token: HF_TOKEN may be present in the environment. NEVER echo
# its value to stdout/stderr or write it into any logged path. The token is
# consumed only by the `hf` invocation.
set -euo pipefail

cmd="${1:-}"
shift || true

CONFIG_PATH=""
INSTANCE_ID=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --config) CONFIG_PATH="${2:-}"; shift 2 ;;
        --instance) INSTANCE_ID="${2:-}"; shift 2 ;;
        *) shift ;;
    esac
done

# Defaults; can be overridden by /runtime/launch-configs/<instance>.json.
MODEL_REPO="${LLAMA_CPP_DEFAULT_REPO:-ggml-org/Qwen2.5-0.5B-Instruct-GGUF}"
MODEL_REVISION="${LLAMA_CPP_DEFAULT_REVISION:-main}"
MODEL_FILE="${LLAMA_CPP_DEFAULT_FILE:-qwen2.5-0.5b-instruct-q4_k_m.gguf}"
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-llama-server}"
PORT="${PLOINKY_LLM_ENGINE_PORT:-8080}"
RUNTIME_DIR="${PLOINKY_RUNTIME_DIR:-/runtime}"
PID_DIR="$RUNTIME_DIR/instances"
LOG_DIR="$RUNTIME_DIR/logs"
HF_HOME="${HF_HOME:-/models/hf-cache}"
MODELS_DIR="${PLOINKY_MODELS_DIR:-/models/artifacts}"
DERIVED_DIR="${PLOINKY_DERIVED_DIR:-/models/derived}"
safe_repo="${MODEL_REPO//\//__}"
safe_revision="${MODEL_REVISION//\//__}"
MODEL_CACHE_DIR="$MODELS_DIR/$safe_repo/$safe_revision"
export HF_HOME

case "$cmd" in
    describe)
        cat <<JSON
{
    "schemaVersion": 1,
    "id": "llama-cpp-cpu",
    "engine": "llama.cpp",
    "modelRepo": "${MODEL_REPO}",
    "modelFiles": ["${MODEL_FILE}"],
    "supportedAccelerators": ["cpu"],
    "supportedPlatforms": ["linux/amd64", "linux/arm64"],
    "capabilities": { "chat": true }
}
JSON
        ;;
    prepare)
        mkdir -p "$HF_HOME" "$MODEL_CACHE_DIR" "$DERIVED_DIR"
        if ! command -v hf >/dev/null 2>&1; then
            echo '{"prepared":false,"error":"hf CLI not installed in this image"}'
            exit 1
        fi
        # The hf CLI reads HF_TOKEN from the environment. Do not echo it.
        hf download "$MODEL_REPO" "$MODEL_FILE" --revision "$MODEL_REVISION" --local-dir "$MODEL_CACHE_DIR" >/dev/null 2>&1 || true
        if [[ ! -f "$MODEL_CACHE_DIR/$MODEL_FILE" ]]; then
            echo '{"prepared":false,"error":"model file not present after download attempt"}'
            exit 1
        fi
        echo '{"prepared":true}'
        ;;
    start)
        mkdir -p "$PID_DIR" "$LOG_DIR" "$HF_HOME" "$MODEL_CACHE_DIR" "$DERIVED_DIR"
        instance_id="$(basename "$CONFIG_PATH" .json 2>/dev/null || echo llama-cpp-cpu)"
        pid_file="$PID_DIR/$instance_id.pid"
        log_file="$LOG_DIR/$instance_id.engine.log"
        if [[ ! -x "$(command -v "$LLAMA_SERVER_BIN")" ]]; then
            echo '{"started":false,"error":"llama-server binary not found"}'
            exit 1
        fi
        if [[ ! -f "$MODEL_CACHE_DIR/$MODEL_FILE" ]]; then
            echo '{"started":false,"error":"model file missing; run prepare first"}'
            exit 1
        fi
        {
            echo "[llama-cpp-cpu] engine stdout/stderr are discarded by default to avoid persisting prompts or secrets."
            echo "[llama-cpp-cpu] add a redacted diagnostic log path before collecting engine output."
        } >"$log_file"
        chmod 600 "$log_file" 2>/dev/null || true
        nohup "$LLAMA_SERVER_BIN" \
            --model "$MODEL_CACHE_DIR/$MODEL_FILE" \
            --port "$PORT" \
            --host 127.0.0.1 \
            >/dev/null 2>&1 &
        echo $! > "$pid_file"
        echo "{\"started\":true,\"instanceId\":\"$instance_id\",\"port\":$PORT}"
        ;;
    stop)
        pid_file="$PID_DIR/${INSTANCE_ID}.pid"
        if [[ -f "$pid_file" ]]; then
            pid="$(cat "$pid_file")"
            kill "$pid" 2>/dev/null || true
            rm -f "$pid_file"
        fi
        echo '{"stopped":true}'
        ;;
    status)
        pid_file="$PID_DIR/${INSTANCE_ID}.pid"
        if [[ -f "$pid_file" ]]; then
            pid="$(cat "$pid_file")"
            if kill -0 "$pid" 2>/dev/null; then
                echo "{\"status\":\"running\",\"pid\":$pid}"
                exit 0
            fi
        fi
        echo '{"status":"stopped"}'
        ;;
    *)
        echo "unknown command: $cmd" >&2
        exit 2
        ;;
esac
