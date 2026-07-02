#!/usr/bin/env bash
set -euo pipefail

LAUNCHER_ID="llama-cpp-cpu"
MODEL_ID="planning-local-qwen2.5-0.5b-instruct"
MODEL_REPO="Qwen/Qwen2.5-0.5B-Instruct-GGUF"
MODEL_REVISION="df5bf01389a39c743ab467d734bf501681e041c5"
MODEL_FILE="qwen2.5-0.5b-instruct-q4_k_m.gguf"
DEFAULT_MODELS_DIR="/models/artifacts"
DEFAULT_RUNTIME_DIR="/runtime"
DEFAULT_INFERENCE_PORT="8080"

redact_text() {
    python3 -c '
import os
import re
import sys

text = sys.stdin.read()
text = re.sub(r"Authorization:\s*Bearer\s+\S+", "[REDACTED]", text, flags=re.IGNORECASE)
for name in ("HF" + "_TOKEN", "HUGGING_FACE_HUB" + "_TOKEN"):
    value = os.environ.get(name)
    if value:
        text = text.replace(value, "[REDACTED]")
text = re.sub(r"\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|PRIVATE_KEY|MASTER_KEY)[A-Z0-9_]*\b", "[REDACTED]", text)
text = re.sub("hf" + r"_[A-Za-z0-9_=-]{8,}", "[REDACTED]", text)
text = re.sub(r"sk-[A-Za-z0-9_=-]{12,}", "[REDACTED]", text)
text = re.sub(r"\b[A-Za-z0-9_=-]{40,}\b", "[REDACTED]", text)
sys.stdout.write(text)
'
}

fail() {
    local code="$1"
    shift
    printf 'launcher error: %s\n' "$*" | redact_text >&2
    exit "$code"
}

json_describe() {
    cat <<'JSON'
{
  "schemaVersion": 1,
  "id": "llama-cpp-cpu",
  "modelId": "planning-local-qwen2.5-0.5b-instruct",
  "engine": "llamacpp",
  "modelFormat": "gguf",
  "hfRepoId": "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
  "hfRevision": "df5bf01389a39c743ab467d734bf501681e041c5",
  "modelFiles": ["qwen2.5-0.5b-instruct-q4_k_m.gguf"],
  "supportedAccelerators": ["cpu"],
  "supportedPlatforms": ["linux/amd64", "linux/arm64"],
  "configurableParameters": {
    "contextTokens": { "type": "integer", "minimum": 1, "default": 4096 },
    "concurrency": { "type": "integer", "minimum": 1, "default": 2 },
    "batchTokens": { "type": "integer", "minimum": 1, "default": 512 },
    "prefillChunkTokens": { "type": "integer", "minimum": 1, "default": 128 },
    "acceleratorMemoryFraction": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
    "acceleratorReserveMiB": { "type": "integer", "minimum": 1 },
    "kvCachePrecision": { "type": "string", "minLength": 1, "maxLength": 64 },
    "gpuLayers": { "type": "integer", "minimum": 0 },
    "tensorParallelSize": { "type": "integer", "minimum": 1 },
    "pipelineParallelSize": { "type": "integer", "minimum": 1 },
    "deviceIds": { "type": "array", "items": { "type": "string", "minLength": 1 }, "uniqueItems": true },
    "splitMode": { "enum": ["none", "layer", "row"] },
    "tensorSplit": { "type": "array", "items": { "type": "number", "exclusiveMinimum": 0 }, "minItems": 1 },
    "mainGpu": { "type": "integer", "minimum": 0 },
    "cpuThreads": { "type": "integer", "minimum": 1 },
    "cpuOffloadGiB": { "type": "number", "minimum": 0 },
    "flashAttention": { "enum": ["on", "off", "auto"] },
    "enableMetrics": { "type": "boolean" }
  },
  "profiles": {
    "primary": {
      "description": "Default CPU planning profile.",
      "defaults": {
        "contextTokens": 4096,
        "concurrency": 2,
        "batchTokens": 512,
        "prefillChunkTokens": 128
      }
    },
    "long-context": {
      "description": "Larger context CPU planning profile.",
      "defaults": {
        "contextTokens": 8192,
        "concurrency": 1,
        "batchTokens": 512,
        "prefillChunkTokens": 128
      }
    }
  },
  "resourceEstimates": {
    "cpu": {
      "memoryMiB": 1024,
      "diskMiB": 512
    }
  }
}
JSON
}

models_dir() {
    printf '%s\n' "${PLOINKY_MODELS_DIR:-$DEFAULT_MODELS_DIR}"
}

runtime_dir() {
    printf '%s\n' "${PLOINKY_RUNTIME_DIR:-$DEFAULT_RUNTIME_DIR}"
}

artifact_dir() {
    printf '%s/%s\n' "$(models_dir)" "$MODEL_REPO"
}

model_path() {
    printf '%s/%s\n' "$(artifact_dir)" "$MODEL_FILE"
}

state_dir() {
    printf '%s/instances\n' "$(runtime_dir)"
}

pid_path() {
    printf '%s/%s.pid\n' "$(state_dir)" "$1"
}

state_path() {
    printf '%s/%s.json\n' "$(state_dir)" "$1"
}

active_path() {
    printf '%s/active-instance.json\n' "$(runtime_dir)"
}

log_path() {
    printf '%s/logs/%s.log\n' "$(runtime_dir)" "$1"
}

parse_config_path() {
    local config=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --config)
                [ "$#" -ge 2 ] || fail 2 "missing value for --config"
                config="$2"
                shift 2
                ;;
            *)
                fail 2 "unknown argument '$1'"
                ;;
        esac
    done
    [ -n "$config" ] || fail 2 "missing --config"
    [ -f "$config" ] || fail 2 "config file not found: $config"
    printf '%s\n' "$config"
}

parse_instance_arg() {
    local instance=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --instance)
                [ "$#" -ge 2 ] || fail 2 "missing value for --instance"
                instance="$2"
                shift 2
                ;;
            *)
                fail 2 "unknown argument '$1'"
                ;;
        esac
    done
    [ -n "$instance" ] || fail 2 "missing --instance"
    printf '%s\n' "$instance"
}

normalize_config() {
    local config_path="$1"
    python3 - "$config_path" "$LAUNCHER_ID" <<'PY'
import json
import os
import re
import sys

config_path, launcher_id = sys.argv[1], sys.argv[2]
allowed = {
    "launcherId",
    "instanceId",
    "profile",
    "contextTokens",
    "concurrency",
    "batchTokens",
    "prefillChunkTokens",
    "acceleratorMemoryFraction",
    "acceleratorReserveMiB",
    "kvCachePrecision",
    "gpuLayers",
    "tensorParallelSize",
    "pipelineParallelSize",
    "deviceIds",
    "splitMode",
    "tensorSplit",
    "mainGpu",
    "cpuThreads",
    "cpuOffloadGiB",
    "flashAttention",
    "enableMetrics",
}
defaults = {
    "launcherId": launcher_id,
    "instanceId": "planning-local",
    "profile": "primary",
    "contextTokens": 4096,
    "concurrency": 2,
    "batchTokens": 512,
    "prefillChunkTokens": 128,
}

def cpu_count():
    try:
        return os.cpu_count() or 1
    except Exception:
        return 1

def detect_cpu_threads():
    quota_path = "/sys/fs/cgroup/cpu.max"
    try:
        quota, period = open(quota_path, "r", encoding="utf-8").read().split()[:2]
        if quota != "max":
            detected = max(1, int(quota) // max(1, int(period)))
            return max(1, min(detected, cpu_count()))
    except Exception:
        pass
    return max(1, cpu_count())

try:
    with open(config_path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
except Exception as exc:
    raise SystemExit(f"launch config: failed to read JSON: {exc}")

if not isinstance(config, dict):
    raise SystemExit("launch config: expected object")

for key in config:
    if key not in allowed:
        raise SystemExit(f"launch config: unsupported field '{key}'")

normalized = {**defaults, **config}
if normalized["launcherId"] != launcher_id:
    raise SystemExit(f"launch config.launcherId must be '{launcher_id}'")
if not re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", str(normalized["instanceId"])):
    raise SystemExit("launch config.instanceId invalid")
for key in ("contextTokens", "concurrency", "batchTokens", "prefillChunkTokens"):
    if not isinstance(normalized[key], int) or normalized[key] < 1:
        raise SystemExit(f"launch config.{key}: expected positive integer")
def is_integer(value):
    return type(value) is int

def is_number(value):
    return type(value) in (int, float)

positive_integer_fields = {
    "contextTokens",
    "concurrency",
    "batchTokens",
    "prefillChunkTokens",
    "acceleratorReserveMiB",
    "tensorParallelSize",
    "pipelineParallelSize",
    "cpuThreads",
}
non_negative_integer_fields = {"gpuLayers", "mainGpu"}

for key in positive_integer_fields:
    if key in normalized and (not is_integer(normalized[key]) or normalized[key] < 1):
        raise SystemExit(f"launch config.{key}: expected positive integer")
for key in non_negative_integer_fields:
    if key in normalized and (not is_integer(normalized[key]) or normalized[key] < 0):
        raise SystemExit(f"launch config.{key}: expected non-negative integer")
if "acceleratorMemoryFraction" in normalized:
    value = normalized["acceleratorMemoryFraction"]
    if not is_number(value) or not 0 < value <= 1:
        raise SystemExit("launch config.acceleratorMemoryFraction: expected number > 0 and <= 1")
if "cpuOffloadGiB" in normalized:
    value = normalized["cpuOffloadGiB"]
    if not is_number(value) or value < 0:
        raise SystemExit("launch config.cpuOffloadGiB: expected non-negative number")
if "kvCachePrecision" in normalized:
    value = normalized["kvCachePrecision"]
    if not isinstance(value, str) or not value.strip() or len(value) > 64:
        raise SystemExit("launch config.kvCachePrecision: expected non-empty string up to 64 characters")
if "deviceIds" in normalized:
    value = normalized["deviceIds"]
    if (
        not isinstance(value, list)
        or any(not isinstance(entry, str) or not entry.strip() for entry in value)
        or len(set(value)) != len(value)
    ):
        raise SystemExit("launch config.deviceIds: expected unique non-empty strings")
if "splitMode" in normalized and normalized["splitMode"] not in {"none", "layer", "row"}:
    raise SystemExit("launch config.splitMode: expected one of none, layer, row")
if "tensorSplit" in normalized:
    value = normalized["tensorSplit"]
    if (
        not isinstance(value, list)
        or not value
        or any(not is_number(entry) or entry <= 0 for entry in value)
    ):
        raise SystemExit("launch config.tensorSplit: expected non-empty array of positive numbers")
if "flashAttention" in normalized and normalized["flashAttention"] not in {"on", "off", "auto"}:
    raise SystemExit("launch config.flashAttention: expected one of on, off, auto")
if "enableMetrics" in normalized and type(normalized["enableMetrics"]) is not bool:
    raise SystemExit("launch config.enableMetrics: expected boolean")

if "cpuThreads" not in normalized:
    normalized["cpuThreads"] = detect_cpu_threads()

print(json.dumps(normalized, separators=(",", ":")))
PY
}

field_from_json() {
    local json="$1"
    local field="$2"
    python3 - "$json" "$field" <<'PY'
import json
import sys

doc = json.loads(sys.argv[1])
value = doc.get(sys.argv[2], "")
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

json_response_prepare() {
    local path="$1"
    python3 - "$LAUNCHER_ID" "$MODEL_ID" "$path" <<'PY'
import json
import sys

print(json.dumps({
    "ok": True,
    "launcherId": sys.argv[1],
    "modelId": sys.argv[2],
    "modelPath": sys.argv[3],
}, separators=(",", ":")))
PY
}

json_response_command() {
    local instance_id="$1"
    shift
    python3 - "$LAUNCHER_ID" "$instance_id" "$@" <<'PY'
import json
import sys

print(json.dumps({
    "ok": True,
    "dryRun": True,
    "launcherId": sys.argv[1],
    "instanceId": sys.argv[2],
    "command": sys.argv[3:],
}, separators=(",", ":")))
PY
}

json_response_start() {
    local instance_id="$1"
    local pid="$2"
    local path="$3"
    python3 - "$LAUNCHER_ID" "$instance_id" "$pid" "$path" <<'PY'
import json
import sys

print(json.dumps({
    "ok": True,
    "launcherId": sys.argv[1],
    "instanceId": sys.argv[2],
    "status": "running",
    "pid": int(sys.argv[3]),
    "modelPath": sys.argv[4],
}, separators=(",", ":")))
PY
}

json_response_error() {
    local instance_id="$1"
    local message="$2"
    local details="${3:-}"
    python3 - "$LAUNCHER_ID" "$instance_id" "$message" "$details" <<'PY'
import json
import sys

payload = {
    "ok": False,
    "launcherId": sys.argv[1],
    "instanceId": sys.argv[2],
    "status": "error",
    "error": sys.argv[3],
}
if sys.argv[4]:
    payload["details"] = sys.argv[4]
print(json.dumps(payload, separators=(",", ":")))
PY
}

json_response_status() {
    local instance_id="$1"
    local found="$2"
    local status="$3"
    local pid="${4:-}"
    python3 - "$instance_id" "$found" "$status" "$pid" <<'PY'
import json
import sys

payload = {
    "ok": True,
    "instanceId": sys.argv[1],
    "found": sys.argv[2] == "true",
    "status": sys.argv[3],
}
if sys.argv[4]:
    payload["pid"] = int(sys.argv[4])
print(json.dumps(payload, separators=(",", ":")))
PY
}

write_state() {
    local instance_id="$1"
    local status="$2"
    local pid="$3"
    shift 3
    mkdir -p "$(state_dir)" "$(dirname "$(active_path)")"
    python3 - "$(state_path "$instance_id")" "$(active_path)" "$LAUNCHER_ID" "$instance_id" "$status" "$pid" "$@" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

state_path = pathlib.Path(sys.argv[1])
active_path = pathlib.Path(sys.argv[2])
launcher_id, instance_id, status, pid = sys.argv[3:7]
command = sys.argv[7:]
payload = {
    "launcherId": launcher_id,
    "instanceId": instance_id,
    "status": status,
    "updatedAt": datetime.now(timezone.utc).isoformat(),
}
if pid:
    payload["pid"] = int(pid)
if command:
    payload["command"] = command
state_path.write_text(json.dumps(payload, indent=2) + "\n")
if status == "running":
    active_path.write_text(json.dumps({
        "launcherId": launcher_id,
        "instanceId": instance_id,
        "pid": int(pid),
        "updatedAt": payload["updatedAt"],
    }, indent=2) + "\n")
PY
}

process_state() {
    local pid="$1"
    local state
    command -v ps >/dev/null 2>&1 || return 0
    state="$(ps -p "$pid" -o stat= 2>/dev/null || true)"
    state="${state#"${state%%[![:space:]]*}"}"
    state="${state%%[[:space:]]*}"
    printf '%s\n' "$state"
}

is_pid_running() {
    local pid="$1"
    local state
    [ -n "$pid" ] || return 1
    kill -0 "$pid" >/dev/null 2>&1 || return 1
    state="$(process_state "$pid")"
    case "$state" in
        Z*|X*)
            return 1
            ;;
    esac
    return 0
}

redacted_log_excerpt() {
    local file="$1"
    [ -f "$file" ] || return 0
    tail -n 20 "$file" 2>/dev/null | redact_text | head -c 1200
}

report_start_failure() {
    local instance_id="$1"
    local message="$2"
    local details="${3:-}"
    local safe_message safe_details
    safe_message="$(printf '%s' "$message" | redact_text)"
    safe_details="$(printf '%s' "$details" | redact_text | head -c 1200)"
    json_response_error "$instance_id" "$safe_message" "$safe_details"
    if [ -n "$safe_details" ]; then
        printf 'launcher error: %s; redacted log excerpt: %s\n' "$safe_message" "$safe_details" | redact_text >&2
    else
        printf 'launcher error: %s\n' "$safe_message" | redact_text >&2
    fi
    return 1
}

probe_started_process() {
    local instance_id="$1"
    local pid="$2"
    local log_file="$3"
    local attempt excerpt
    for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        sleep 0.05
        if ! is_pid_running "$pid"; then
            excerpt="$(redacted_log_excerpt "$log_file")"
            report_start_failure "$instance_id" "llama-server exited during startup" "$excerpt"
            return 1
        fi
    done
    return 0
}

read_pid() {
    local file
    file="$(pid_path "$1")"
    [ -f "$file" ] || return 1
    tr -d '\n\r ' < "$file"
}

download_model() {
    command -v hf >/dev/null 2>&1 || fail 127 "required tool 'hf' not found in PATH"
    mkdir -p "$(artifact_dir)"
    local output
    set +e
    output="$(hf download \
        --repo-id "$MODEL_REPO" \
        --revision "$MODEL_REVISION" \
        --include "$MODEL_FILE" \
        --local-dir "$(artifact_dir)" 2>&1)"
    local status=$?
    set -e
    if [ "$status" -ne 0 ]; then
        if printf '%s' "$output" | grep -Eiq '401|403|unauthorized|forbidden|gated|private|authentication|access'; then
            fail "$status" "Hugging Face authentication failed for $MODEL_REPO; configure valid Hugging Face credentials with access to the model"
        fi
        local safe_output
        safe_output="$(printf '%s' "$output" | redact_text | head -c 400)"
        fail "$status" "hf download failed for $MODEL_REPO: $safe_output"
    fi
    [ -f "$(model_path)" ] || fail 1 "hf download did not create expected GGUF artifact at $(model_path)"
}

engine_args_module() {
    local script_dir candidate
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    for candidate in \
        "${PLOINKY_ENGINE_ARGS_MODULE:-}" \
        "$script_dir/../../shared/runtime-agent/lib/engineArgs.mjs" \
        "/opt/ploinky/runtime-agent/lib/engineArgs.mjs"; do
        [ -n "$candidate" ] || continue
        if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    fail 127 "engine args module not found"
}

prepare_model() {
    local config_path normalized
    config_path="$(parse_config_path "$@")"
    normalized="$(normalize_config "$config_path" 2>&1)" || fail 2 "$normalized"
    download_model
    json_response_prepare "$(model_path)"
}

stop_active_conflict() {
    local instance_id="$1"
    local active_file
    active_file="$(active_path)"
    [ -f "$active_file" ] || return 0
    local active_instance active_pid
    active_instance="$(python3 - "$active_file" <<'PY'
import json
import sys
try:
    print(json.load(open(sys.argv[1], encoding="utf-8")).get("instanceId", ""))
except Exception:
    print("")
PY
)"
    [ -n "$active_instance" ] || return 0
    [ "$active_instance" != "$instance_id" ] || return 0
    active_pid="$(read_pid "$active_instance" || true)"
    if is_pid_running "$active_pid"; then
        kill "$active_pid" >/dev/null 2>&1 || true
    fi
    rm -f "$(pid_path "$active_instance")" "$active_file"
    write_state "$active_instance" "stopped" "" >/dev/null
}

build_command() {
    local normalized="$1"
    local port="${PLOINKY_INFERENCE_PORT:-$DEFAULT_INFERENCE_PORT}"
    local engine_args
    engine_args="$(engine_args_module)"
    node --input-type=module - "$normalized" "$port" "$(model_path)" "$engine_args" <<'NODE'
import { pathToFileURL } from 'node:url';

const [normalizedJson, port, modelPath, engineArgsPath] = process.argv.slice(2);
const { buildLlamaCppArgs } = await import(pathToFileURL(engineArgsPath).href);
const config = JSON.parse(normalizedJson);
const command = [
    'llama-server',
    '--host', '0.0.0.0',
    '--port', port,
    '--model', modelPath,
    ...buildLlamaCppArgs(config),
];

process.stdout.write(command.map((part) => String(part)).join('\0'));
process.stdout.write('\0');
NODE
}

start_model() {
    local config_path normalized instance_id
    config_path="$(parse_config_path "$@")"
    normalized="$(normalize_config "$config_path" 2> >(redact_text >&2))" || exit 2
    instance_id="$(field_from_json "$normalized" instanceId)"

    local cmd=()
    while IFS= read -r -d '' part; do
        cmd+=("$part")
    done < <(build_command "$normalized")

    if [ "${PLOINKY_LAUNCHER_DRY_RUN:-}" = "1" ]; then
        json_response_command "$instance_id" "${cmd[@]}"
        return 0
    fi

    [ -f "$(model_path)" ] || prepare_model --config "$config_path" >/dev/null
    stop_active_conflict "$instance_id"
    command -v llama-server >/dev/null 2>&1 || fail 127 "required tool 'llama-server' not found in PATH"

    local log_file
    log_file="$(log_path "$instance_id")"
    mkdir -p "$(state_dir)" "$(dirname "$log_file")"
    nohup "${cmd[@]}" >>"$log_file" 2>&1 &
    local pid="$!"
    if ! probe_started_process "$instance_id" "$pid" "$log_file"; then
        wait "$pid" >/dev/null 2>&1 || true
        return 1
    fi
    printf '%s\n' "$pid" >"$(pid_path "$instance_id")"
    write_state "$instance_id" "running" "$pid" "${cmd[@]}"
    json_response_start "$instance_id" "$pid" "$(model_path)"
}

status_model() {
    local instance_id pid found status
    instance_id="$(parse_instance_arg "$@")"
    pid="$(read_pid "$instance_id" || true)"
    found="false"
    status="stopped"
    if [ -f "$(state_path "$instance_id")" ] || [ -n "$pid" ]; then
        found="true"
    fi
    if is_pid_running "$pid"; then
        status="running"
        json_response_status "$instance_id" "$found" "$status" "$pid"
    else
        json_response_status "$instance_id" "$found" "$status"
    fi
}

stop_model() {
    local instance_id pid found
    instance_id="$(parse_instance_arg "$@")"
    pid="$(read_pid "$instance_id" || true)"
    found="false"
    if [ -f "$(state_path "$instance_id")" ] || [ -n "$pid" ]; then
        found="true"
    fi
    if is_pid_running "$pid"; then
        kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$(pid_path "$instance_id")"
    if [ -f "$(active_path)" ]; then
        python3 - "$(active_path)" "$instance_id" <<'PY'
import json
import pathlib
import sys

active_path = pathlib.Path(sys.argv[1])
instance_id = sys.argv[2]
try:
    active = json.loads(active_path.read_text())
except Exception:
    active = {}
if active.get("instanceId") == instance_id:
    active_path.unlink(missing_ok=True)
PY
    fi
    if [ -f "$(state_path "$instance_id")" ]; then
        write_state "$instance_id" "stopped" ""
    fi
    json_response_status "$instance_id" "$found" "stopped"
}

case "${1:-}" in
    describe)
        shift
        [ "$#" -eq 0 ] || fail 2 "describe does not accept arguments"
        json_describe
        ;;
    prepare)
        shift
        prepare_model "$@"
        ;;
    start)
        shift
        start_model "$@"
        ;;
    stop)
        shift
        stop_model "$@"
        ;;
    status)
        shift
        status_model "$@"
        ;;
    *)
        fail 2 "unknown command: ${1:-}"
        ;;
esac
