import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const agents = ['base-local', 'planning-local', 'relevance', 'language-detection'];

test('LLM runtime manifests use the shared startup wrapper and MCP readiness', () => {
    const root = path.resolve(import.meta.dirname, '..');
    for (const agent of agents) {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, agent, 'manifest.json'), 'utf8'));
        assert.equal(manifest.llmRuntime?.enabled, true, `${agent} must opt into LLM runtime handling`);
        assert.equal(manifest.start, 'sh /Agent/llm-runtime/runtime-agent/start-runtime-agent.sh');
        assert.equal(manifest.readiness?.protocol, 'mcp');
        assert.ok(manifest.endpoints?.['agent-card'], `${agent} should declare endpoint metadata with agent-card key`);
    }
});

test('shared MCP config exposes required runtime tools', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'shared', 'mcp-config.json'), 'utf8'));
    const tools = new Set(config.tools.map((tool) => tool.name));
    for (const toolName of [
        'runtime.describe',
        'runtime.health',
        'runtime.logs',
        'modelProfiles.list',
        'modelProfiles.describe',
        'modelProfiles.setPriorities',
        'modelProfiles.resetPriorities',
        'launchers.list',
        'launchers.describe',
        'launchers.prepare',
        'launchers.start',
        'instance.status',
        'instance.stop',
        'instance.logs',
    ]) {
        assert.ok(tools.has(toolName), `missing MCP tool ${toolName}`);
    }
});
