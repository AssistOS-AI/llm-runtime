# llm-runtime

Specialized Ploinky LLM agents. Each agent owns its `agent-models.json`,
launcher scripts, manifest, and capability metadata. Runtime container images
embed the shared MCP/control server from this repository and start it directly
as the image entrypoint at `/opt/ploinky/runtime-agent/mcp-server.mjs`.

## Layout

```
shared/
  runtime-agent/        Reusable MCP server, validation helpers, redaction.
  launchers/lib/        Shell helpers for launcher scripts.
schemas/                JSON Schemas for agent-models.json / launcher describe.
planning-local/         CPU reference package and pinned planning model.
language-detection/     LLM runtime package for language detection.
relevance/              LLM runtime package for relevance scoring.
tests/                  Unit + smoke tests.
```

## Boundary

Ploinky core selects a generic hardware runtime image from the external
architecture catalog, builds the safe runtime policy, mounts
`/runtime/selected-architecture.json`, mounts persistent model storage at
`/models`, publishes the runtime ports on loopback host ports, and starts the
container image entrypoint. Ploinky core does NOT parse `agent-models.json`,
does NOT execute launcher scripts, and does NOT learn launcher-specific or
model-specific flags.

The runtime image runs one MCP/control service on container port `9000`.
Engines start only on demand and listen on container port `8080` after a
launcher starts them. Ploinky publishes both ports to loopback host ports, and
the router proxies generic `/agent-card`, `/v1/chat/completions/<agent>`, and
`/mcps/<agent>/mcp` to the resolved runtime endpoints.

Profile `HF_TOKEN` values are not ordinary container env. Ploinky mounts the
token read-only at `/run/secrets/hf_token`, exposes that path as
`PLOINKY_MODEL_SECRET_FILE`, and the runtime injects `HF_TOKEN` only into
launcher child processes. Launcher describe payloads, runtime state, lockfiles,
logs, errors, and MCP responses must stay redacted.

## Runtime Paths

Runtime containers use fixed paths owned by the runtime contract:

| Path | Owner | Purpose |
| --- | --- | --- |
| `/workspace/modelLaunchers` | Agent package | Launcher scripts copied or mounted for this package. |
| `/models/hf-cache` | Ploinky model storage | Hugging Face cache. |
| `/models/artifacts` | Ploinky model storage | Downloaded model files. |
| `/models/derived` | Ploinky model storage | Derived artifacts such as converted weights. |
| `/runtime` | Ploinky runtime state | Selected architecture, launch configs, PIDs, state, and redacted logs. |

## Launcher Protocol

Launchers are executable scripts named `modelLauncher_<launcher-id>.sh` under
the package's `modelLaunchers/` directory. The runtime MCP server discovers
them from `/workspace/modelLaunchers`, asks each launcher for a JSON
`describe` response, and then uses the same launcher for `prepare`, `start`,
`status`, and `stop` commands. Launcher ids must match the id returned by
`describe`; launch configs carry the selected `launcherId`, `instanceId`, and
startup-only engine parameters. User generation parameters stay outside the
launcher startup contract.

## CPU Reference

`planning-local` is the CPU reference package. Its default launcher is
`llama-cpp-cpu`, and its pinned model is:

| Field | Value |
| --- | --- |
| Repository | `Qwen/Qwen2.5-0.5B-Instruct-GGUF` |
| Revision | `df5bf01389a39c743ab467d734bf501681e041c5` |
| File | `qwen2.5-0.5b-instruct-q4_k_m.gguf` |
