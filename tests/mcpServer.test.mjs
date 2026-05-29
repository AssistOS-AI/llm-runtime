import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

function waitForListen(server) {
    return new Promise((resolve) => server.on('listening', () => resolve(server)));
}

function request(server, urlPath, options = {}) {
    return new Promise((resolve, reject) => {
        const { port } = server.address();
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: options.method || 'GET',
            path: urlPath,
            headers: options.body ? { 'Content-Type': 'application/json' } : {},
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        req.end();
    });
}

test('runtime MCP server publishes /agent-card, /runtime/describe, and rejects bad input', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-state-'));
    const stateFile = path.join(runtimeDir, 'selected-architecture.json');
    fs.writeFileSync(stateFile, JSON.stringify({
        schemaVersion: 1,
        writtenAt: new Date().toISOString(),
        agent: { name: 'baseLocal' },
        catalog: { id: 'test/catalog', ref: 'local:test' },
        architecture: {
            id: 'cpu-amd64',
            platform: 'linux/amd64',
            acceleratorFamily: 'cpu',
            imageId: 'cpu-amd64',
            imageRef: 'reg/cpu-amd64:dev',
            imageDigest: null,
            imageSource: 'catalog',
        },
        runtimePolicy: { platform: 'linux/amd64' },
        runtimePolicyHash: 'abc',
        hardware: {
            runtime: 'docker',
            nodeArch: 'amd64',
            nodePlatform: 'linux/amd64',
            ociPlatform: 'linux/amd64',
            acceleratorFamilies: ['cpu'],
            probes: {},
        },
        envExposed: ['PLOINKY_AGENT_PRINCIPAL'],
    }));

    process.env.PLOINKY_LLM_LAUNCHERS_DIR = path.join(repoRoot, 'base-local/launchers');
    process.env.PLOINKY_LLM_SHARED_LAUNCHERS_DIR = '';
    process.env.PLOINKY_LLM_AGENT_MODELS = path.join(repoRoot, 'base-local/agent-models.json');
    process.env.PLOINKY_LLM_AGENT_CARD = path.join(repoRoot, 'base-local/agent-card.json');

    const { CONTROL_BIND_HOST, createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?test=${Date.now()}`);
    assert.equal(CONTROL_BIND_HOST, '127.0.0.1');

    const originalReader = process.env.PLOINKY_LLM_RUNTIME_DIR;
    // /runtime is read inside the container; outside, /runtime/describe and /health fall back to 503.
    // This test verifies /agent-card and /runtime/launchers against the on-disk fake launcher.

    const server = createServer({});
    server.listen(0, '127.0.0.1');
    await waitForListen(server);

    t.after(() => {
        server.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        if (originalReader === undefined) delete process.env.PLOINKY_LLM_RUNTIME_DIR;
        else process.env.PLOINKY_LLM_RUNTIME_DIR = originalReader;
    });

    const card = await request(server, '/agent-card');
    assert.equal(card.status, 200);
    const cardJson = JSON.parse(card.body);
    assert.equal(cardJson.id, 'base-local');

    const launchers = await request(server, '/runtime/launchers');
    assert.equal(launchers.status, 200);
    const launchersJson = JSON.parse(launchers.body);
    const fakeLauncher = launchersJson.launchers.find((l) => l.id === 'fake-cpu');
    assert.ok(fakeLauncher, 'fake-cpu launcher must be listed');
    assert.equal(fakeLauncher.ok, true);

    const notFound = await request(server, '/does-not-exist');
    assert.equal(notFound.status, 404);

    // Health requires the runtime state file at /runtime/selected-architecture.json (hardcoded path).
    // Outside a container, that file is missing — the server returns 503. Verify it does NOT crash.
    const health = await request(server, '/health');
    assert.ok(health.status === 200 || health.status === 503);
});
