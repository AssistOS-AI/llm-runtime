# llm-runtime

Specialized Ploinky LLM agents. Each agent owns its `agent-models.json`,
launcher scripts, manifest, and capability metadata. The shared
`runtime-agent/` directory provides the MCP server image entrypoint used by
each agent's container.

## Layout

```
shared/
  runtime-agent/        Reusable MCP server, validation helpers, redaction.
  launchers/lib/        Shell helpers for launcher scripts.
schemas/                JSON Schemas for agent-models.json / launcher describe.
base-local/             First-wave LLM agent. Chat-capable, CPU-friendly.
tests/                  Unit + smoke tests.
```

## Boundary

Ploinky core selects the container image, builds the safe runtime policy,
mounts `/runtime/selected-architecture.json`, and starts the container.
Ploinky core does NOT parse `agent-models.json`, does NOT execute launcher
scripts, and does NOT learn launcher-specific or model-specific flags.

The in-container MCP server (runtime-agent/mcp-server.mjs) reads
`/runtime/selected-architecture.json` plus the agent-owned
`agent-models.json` and selects compatible launchers. The router proxies
generic `/agent-card`, `/v1/chat/completions/<agent>`, and
`/mcps/<agent>/mcp` to the runtime port (container port 9000).
