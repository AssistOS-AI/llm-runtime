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
        const headers = { ...(options.headers || {}) };
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: options.method || 'GET',
            path: urlPath,
            headers,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
                headers: res.headers,
            }));
        });
        req.on('error', reject);
        if (options.body !== undefined) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

function startFakeEngine(engineResponse) {
    const engine = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(engineResponse));
        });
    });
    engine.listen(0, '127.0.0.1');
    return engine;
}

test('chat proxy starts launcher and proxies to engine', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-chat-proxy-'));
    fs.writeFileSync(path.join(runtimeDir, 'selected-architecture.json'), JSON.stringify({
        schemaVersion: 1,
        writtenAt: new Date().toISOString(),
        agent: { name: 'baseLocal' },
        catalog: { id: 'test/catalog', ref: 'local:test' },
        architecture: {
            id: 'cpu-amd64', platform: 'linux/amd64', acceleratorFamily: 'cpu',
            imageId: 'cpu-amd64', imageRef: 'reg/cpu-amd64:dev', imageDigest: null, imageSource: 'catalog',
        },
        runtimePolicy: { platform: 'linux/amd64' },
        runtimePolicyHash: 'abc',
        hardware: { runtime: 'docker', acceleratorFamilies: ['cpu'], probes: {} },
        envExposed: [],
    }));

    const engineResponse = { id: 'chat.fake', choices: [{ message: { role: 'assistant', content: 'pong' } }] };
    const engine = startFakeEngine(engineResponse);
    await waitForListen(engine);
    const enginePort = engine.address().port;

    process.env.PLOINKY_LLM_LAUNCHERS_DIR = path.join(repoRoot, 'base-local/launchers');
    process.env.PLOINKY_LLM_SHARED_LAUNCHERS_DIR = '';
    process.env.PLOINKY_LLM_AGENT_MODELS = path.join(repoRoot, 'base-local/agent-models.json');
    process.env.PLOINKY_LLM_AGENT_CARD = path.join(repoRoot, 'base-local/agent-card.json');
    process.env.PLOINKY_LLM_ENGINE_HOST = '127.0.0.1';
    process.env.PLOINKY_LLM_ENGINE_PORT = String(enginePort);

    const moduleNonce = Date.now();
    const mcpModule = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?test=${moduleNonce}`);

    const server = mcpModule.createServer({ runtimeDir });
    server.listen(0, '127.0.0.1');
    await waitForListen(server);

    t.after(() => {
        server.close();
        engine.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    });

    const describe = await request(server, '/runtime/describe');
    assert.equal(describe.status, 200);
    const describeJson = JSON.parse(describe.body);
    assert.equal(describeJson.architecture.id, 'cpu-amd64');
    assert.equal(describeJson.runtimePolicyHash, 'abc');

    const chat = await request(server, '/v1/chat/completions', {
        method: 'POST',
        body: { profile: 'primary', messages: [{ role: 'user', content: 'ping' }] },
    });
    assert.equal(chat.status, 200);
    const chatJson = JSON.parse(chat.body);
    assert.equal(chatJson.id, 'chat.fake');
    assert.equal(chatJson.choices[0].message.content, 'pong');

    // Verify single-active-instance file was written.
    const activePath = path.join(runtimeDir, 'active-instance.json');
    assert.ok(fs.existsSync(activePath), 'active-instance.json must be written');
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    assert.equal(active.launcher, 'fake-cpu');
    assert.equal(active.instanceId, 'chat-primary');
});

test('chat proxy reports 503 when no engine is reachable', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-chat-proxy-fail-'));
    fs.writeFileSync(path.join(runtimeDir, 'selected-architecture.json'), JSON.stringify({
        schemaVersion: 1,
        writtenAt: new Date().toISOString(),
        agent: { name: 'baseLocal' },
        catalog: { id: 'test/catalog', ref: 'local:test' },
        architecture: {
            id: 'cpu-amd64', platform: 'linux/amd64', acceleratorFamily: 'cpu',
            imageId: 'cpu-amd64', imageRef: 'reg/cpu-amd64:dev', imageDigest: null, imageSource: 'catalog',
        },
        runtimePolicy: {},
        runtimePolicyHash: 'abc',
        hardware: { runtime: 'docker', acceleratorFamilies: ['cpu'], probes: {} },
        envExposed: [],
    }));

    process.env.PLOINKY_LLM_LAUNCHERS_DIR = path.join(repoRoot, 'base-local/launchers');
    process.env.PLOINKY_LLM_SHARED_LAUNCHERS_DIR = '';
    process.env.PLOINKY_LLM_AGENT_MODELS = path.join(repoRoot, 'base-local/agent-models.json');
    process.env.PLOINKY_LLM_AGENT_CARD = path.join(repoRoot, 'base-local/agent-card.json');
    process.env.PLOINKY_LLM_ENGINE_HOST = '127.0.0.1';
    process.env.PLOINKY_LLM_ENGINE_PORT = '1'; // privileged port nobody listens on

    const mcpModule = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?test=${Date.now()}fail`);
    const server = mcpModule.createServer({ runtimeDir });
    server.listen(0, '127.0.0.1');
    await waitForListen(server);

    t.after(() => {
        server.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    });

    const chat = await request(server, '/v1/chat/completions', {
        method: 'POST',
        body: { profile: 'primary', messages: [{ role: 'user', content: 'ping' }] },
    });
    assert.equal(chat.status, 502);
});
