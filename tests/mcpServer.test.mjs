import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { MCP_TOOL_NAMES } from '../shared/runtime-agent/lib/runtimeContract.mjs';

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
            headers: options.headers || (options.body ? { 'Content-Type': 'application/json' } : {}),
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, headers: res.headers, body });
            });
        });
        req.on('error', reject);
        if (Number.isInteger(options.timeoutMs) && options.timeoutMs > 0) {
            req.setTimeout(options.timeoutMs, () => {
                req.destroy(new Error(`request timed out: ${urlPath}`));
            });
        }
        if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        req.end();
    });
}

function mcpCall(server, method, params = {}, headers = {}) {
    return request(server, '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: { jsonrpc: '2.0', id: 1, method, params },
    }).then((response) => ({
        ...response,
        json: JSON.parse(response.body),
    }));
}

function mcpTool(server, name, input = {}, headers = {}) {
    return mcpCall(server, 'tools/call', { name, arguments: input }, headers);
}

function writeLauncherScript(dir) {
    const scriptPath = path.join(dir, 'modelLauncher_llamacpp-cpu.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  describe)
    cat <<'JSON'
{"schemaVersion":1,"id":"llamacpp-cpu","modelId":"tiny-test","engine":"llamacpp","modelFormat":"gguf","hfRepoId":"test/tiny","hfRevision":"main","modelFiles":["tiny.gguf"],"supportedAccelerators":["cpu"],"supportedPlatforms":["linux/amd64"],"configurableParameters":{"contextTokens":{"type":"integer","minimum":1}},"profiles":{"primary":{"contextTokens":1024}},"resourceEstimates":{"cpu":{"memoryMiB":512}}}
JSON
    ;;
  prepare)
    config_path="\${3:?missing config path}"
    node -e 'const fs=require("fs"); const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(JSON.stringify({prepared:true,config:cfg}));' "$config_path"
    ;;
  start)
    config_path="\${3:?missing config path}"
    node -e 'const fs=require("fs"); const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(JSON.stringify({started:true,config:cfg}));' "$config_path"
    ;;
  status)
    echo '{"status":"running"}'
    ;;
  stop)
    echo '{"stopped":true}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    fs.chmodSync(scriptPath, 0o755);
}

function writeLeakyDescribeLauncherScript(dir, markerPath) {
    const scriptPath = path.join(dir, 'modelLauncher_llamacpp-cpu.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
marker_path=${JSON.stringify(markerPath)}
case "$cmd" in
  describe)
    if [ -n "\${PLOINKY_MODEL_SECRET_FILE:-}" ] && [ -f "\${PLOINKY_MODEL_SECRET_FILE}" ]; then
      printf 'saw model secret file env\\n' > "$marker_path"
      printf 'describe leaked %s\\n' "$(cat "\${PLOINKY_MODEL_SECRET_FILE}")" >&2
      exit 44
    fi
    if [ -n "\${HF_TOKEN:-}" ]; then
      printf 'saw child token env\\n' > "$marker_path"
      printf 'describe leaked %s\\n' "\${HF_TOKEN}" >&2
      exit 45
    fi
    echo 'describe missing model secret env'
    exit 46
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    fs.chmodSync(scriptPath, 0o755);
}

function writeObservedLauncherScript(dir, operationLogPath) {
    const scriptPath = path.join(dir, 'modelLauncher_llamacpp-cpu.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
log_path=${JSON.stringify(operationLogPath)}
record_op() {
  printf '%s\\n' "$cmd" >> "$log_path"
}
case "$cmd" in
  describe)
    cat <<'JSON'
{"schemaVersion":1,"id":"llamacpp-cpu","modelId":"tiny-test","engine":"llamacpp","modelFormat":"gguf","hfRepoId":"test/tiny","hfRevision":"main","modelFiles":["tiny.gguf"],"supportedAccelerators":["cpu"],"supportedPlatforms":["linux/amd64"],"configurableParameters":{},"profiles":{"primary":{}},"resourceEstimates":{"cpu":{"memoryMiB":512}}}
JSON
    ;;
  prepare)
    record_op
    echo '{"prepared":true}'
    ;;
  start)
    record_op
    echo '{"started":true}'
    ;;
  stop)
    record_op
    echo '{"stopped":true}'
    ;;
  status)
    echo '{"status":"running"}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
}

async function withTemporaryEnv(overrides, fn) {
    const previous = {};
    for (const [name, value] of Object.entries(overrides)) {
        previous[name] = process.env[name];
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
    try {
        return await fn();
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    }
}

test('single runtime MCP service lists and calls clean runtime tools', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-state-'));
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launchers-'));
    writeLauncherScript(launcherDir);

    const { CONTROL_BIND_HOST, DEFAULT_PORT, createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?test=${Date.now()}`);
    assert.equal(CONTROL_BIND_HOST, '0.0.0.0');
    assert.equal(DEFAULT_PORT, 9000);

    const server = createServer({ runtimeDir, launcherDirs: [launcherDir] });
    server.listen(0, '127.0.0.1');
    await waitForListen(server);

    t.after(() => {
        server.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.rmSync(launcherDir, { recursive: true, force: true });
    });

    const health = await request(server, '/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).status, 'ok');

    const listed = await mcpCall(server, 'tools/list');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.result.tools.map((tool) => tool.name), MCP_TOOL_NAMES);

    const describe = await mcpTool(server, 'runtime.describe');
    assert.equal(describe.status, 200);
    assert.equal(describe.json.result.ports.mcp, 9000);
    assert.equal(describe.json.result.ports.inference, 8080);
    assert.equal(describe.json.result.paths.launchersDir, '/workspace/modelLaunchers');

    const launchers = await mcpTool(server, 'launchers.list');
    assert.deepEqual(launchers.json.result.launchers.map((launcher) => launcher.id), ['llamacpp-cpu']);

    const launcher = await mcpTool(server, 'launchers.describe', { launcherId: 'llamacpp-cpu' });
    assert.equal(launcher.json.result.describe.engine, 'llamacpp');
});

test('runtime describe redacts and withholds model secret file from launcher describe', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-describe-secret-'));
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launchers-describe-secret-'));
    const token = ['describe', 'secret', 'token'].join('-');
    const secretPath = path.join(runtimeDir, 'host-secrets', 'hf_token');
    const markerPath = path.join(runtimeDir, 'describe-saw-secret-env.txt');
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, token, { mode: 0o600 });
    writeLeakyDescribeLauncherScript(launcherDir, markerPath);

    await withTemporaryEnv({
        PLOINKY_MODEL_SECRET_FILE: secretPath,
        HF_TOKEN: token,
    }, async () => {
        const { createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?describeSecret=${Date.now()}`);
        const server = createServer({ runtimeDir, launcherDirs: [launcherDir] });
        server.listen(0, '127.0.0.1');
        await waitForListen(server);

        t.after(() => {
            server.close();
            fs.rmSync(runtimeDir, { recursive: true, force: true });
            fs.rmSync(launcherDir, { recursive: true, force: true });
        });

        const describe = await mcpTool(server, 'runtime.describe');
        const describeBytes = JSON.stringify(describe.json);
        assert.equal(describe.status, 200);
        assert.equal(describeBytes.includes(token), false);
        assert.equal(describeBytes.includes('HF_TOKEN'), false);
        assert.equal(describeBytes.includes(secretPath), false);
        assert.equal(describe.json.result.launchers[0].ok, false);
        assert.equal(fs.existsSync(markerPath), false, 'launcher describe must not receive model secret env');

        const launcher = await mcpTool(server, 'launchers.describe', { launcherId: 'llamacpp-cpu' });
        const launcherBytes = JSON.stringify(launcher.json);
        assert.equal(launcher.status, 200);
        assert.equal(launcherBytes.includes(token), false);
        assert.equal(launcherBytes.includes('HF_TOKEN'), false);
        assert.equal(launcherBytes.includes(secretPath), false);
        assert.equal(fs.existsSync(markerPath), false, 'launchers.describe must not receive model secret env');
    });
});

test('GET runtime state endpoints return errors instead of crashing on corrupt persistent JSON', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-corrupt-get-'));
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launchers-corrupt-get-'));
    writeLauncherScript(launcherDir);

    const { createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?corruptGet=${Date.now()}`);
    const server = createServer({ runtimeDir, launcherDirs: [launcherDir] });
    server.listen(0, '127.0.0.1');
    await waitForListen(server);

    t.after(() => {
        server.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.rmSync(launcherDir, { recursive: true, force: true });
    });

    fs.writeFileSync(path.join(runtimeDir, 'active-instance.json'), '{"instanceId":');
    const active = await request(server, '/runtime/active-instance', { timeoutMs: 1000 });
    assert.equal(active.status, 500);
    assert.match(JSON.parse(active.body).error, /JSON|Unexpected|valid/i);

    const health = await request(server, '/health', { timeoutMs: 1000 });
    assert.equal(health.status, 200, 'server should remain alive after corrupt active instance read');

    fs.unlinkSync(path.join(runtimeDir, 'active-instance.json'));
    fs.writeFileSync(path.join(runtimeDir, 'selected-architecture.json'), '{"schemaVersion":');
    const describe = await request(server, '/runtime/describe', { timeoutMs: 1000 });
    assert.equal(describe.status, 500);
    assert.match(JSON.parse(describe.body).error, /JSON|Unexpected|valid/i);
});

test('state-changing MCP tools use injected auth verifier and write normalized launch configs', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-auth-'));
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launchers-auth-'));
    writeLauncherScript(launcherDir);

    const seenAuth = [];
    const { createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?auth=${Date.now()}`);
    const server = createServer({
        runtimeDir,
        launcherDirs: [launcherDir],
        authVerifier: ({ req, toolName }) => {
            seenAuth.push(toolName);
            if (req.headers['router-request'] !== 'valid-router-token') {
                throw new Error('missing router request');
            }
            return { subject: 'router' };
        },
    });
    server.listen(0, '127.0.0.1');
    await waitForListen(server);

    t.after(() => {
        server.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.rmSync(launcherDir, { recursive: true, force: true });
    });

    const rejected = await mcpTool(server, 'launchers.prepare', {
        launcherId: 'llamacpp-cpu',
        instanceId: 'inst-primary',
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.json.error.code, -32001);
    assert.match(rejected.json.error.message, /missing router request/);

    const prepared = await mcpTool(server, 'launchers.prepare', {
        launcherId: 'llamacpp-cpu',
        instanceId: 'inst-primary',
        contextTokens: 2048,
    }, { 'router-request': 'valid-router-token' });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.json.result.prepared.prepared, true);
    assert.equal(prepared.json.result.prepared.config.launcherId, 'llamacpp-cpu');
    assert.equal(prepared.json.result.prepared.config.contextTokens, 2048);
    assert.equal('launcher' in prepared.json.result.prepared.config, false);
    assert.equal('parameters' in prepared.json.result.prepared.config, false);

    assert.deepEqual(seenAuth, ['launchers.prepare', 'launchers.prepare']);
});

test('state-changing MCP tools use production router-request verifier from env modules', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-prod-auth-'));
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launchers-prod-auth-'));
    writeLauncherScript(launcherDir);

    const authModule = path.join(repoRoot, 'tests/fixtures/runtime-auth/invocationAuth.fixture.mjs');
    const hashModule = path.join(repoRoot, 'tests/fixtures/runtime-auth/requestHash.fixture.mjs');
    const { computeRchTool } = await import(pathToFileURL(hashModule).href);

    await withTemporaryEnv({
        PLOINKY_INVOCATION_AUTH_MODULE: authModule,
        PLOINKY_REQUEST_HASH_MODULE: hashModule,
    }, async () => {
        const { createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?prodAuth=${Date.now()}`);
        const server = createServer({ runtimeDir, launcherDirs: [launcherDir] });
        server.listen(0, '127.0.0.1');
        await waitForListen(server);

        t.after(() => {
            server.close();
            fs.rmSync(runtimeDir, { recursive: true, force: true });
            fs.rmSync(launcherDir, { recursive: true, force: true });
        });

        const input = {
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-prod-auth',
            contextTokens: 1536,
        };
        const rch = computeRchTool({
            method: 'POST',
            path: '/mcp',
            tool: 'launchers.prepare',
            arguments: input,
        });
        const headers = {
            authorization: 'Bearer fixture-valid-router-request',
            'x-fixture-jti': 'prod-auth-jti-1',
            'x-fixture-rch': rch,
        };

        const accepted = await mcpTool(server, 'launchers.prepare', input, headers);
        assert.equal(accepted.status, 200);
        assert.equal(accepted.json.result.prepared.prepared, true);
        assert.equal(accepted.json.result.prepared.config.contextTokens, 1536);

        const replayed = await mcpTool(server, 'launchers.prepare', input, headers);
        assert.equal(replayed.status, 200);
        assert.equal(replayed.json.error.code, -32001);
        assert.match(replayed.json.error.message, /already been consumed/);
    });
});

test('production router-request verifier fails closed when hash module is not configured', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-missing-hash-'));
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launchers-missing-hash-'));
    writeLauncherScript(launcherDir);
    const authModule = path.join(repoRoot, 'tests/fixtures/runtime-auth/invocationAuth.fixture.mjs');

    await withTemporaryEnv({
        PLOINKY_INVOCATION_AUTH_MODULE: authModule,
        PLOINKY_REQUEST_HASH_MODULE: undefined,
    }, async () => {
        const { createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?missingHash=${Date.now()}`);
        const server = createServer({ runtimeDir, launcherDirs: [launcherDir] });
        server.listen(0, '127.0.0.1');
        await waitForListen(server);

        t.after(() => {
            server.close();
            fs.rmSync(runtimeDir, { recursive: true, force: true });
            fs.rmSync(launcherDir, { recursive: true, force: true });
        });

        const response = await mcpTool(server, 'launchers.prepare', {
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-primary',
        }, { authorization: 'Bearer fixture-valid-router-request' });
        assert.equal(response.status, 200);
        assert.equal(response.json.error.code, -32001);
        assert.match(response.json.error.message, /PLOINKY_REQUEST_HASH_MODULE/);
    });
});

test('state-changing MCP tools fail closed when no auth verifier is configured', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-no-auth-'));
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launchers-no-auth-'));
    writeLauncherScript(launcherDir);

    const { createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?noAuth=${Date.now()}`);
    const server = createServer({ runtimeDir, launcherDirs: [launcherDir] });
    server.listen(0, '127.0.0.1');
    await waitForListen(server);

    t.after(() => {
        server.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.rmSync(launcherDir, { recursive: true, force: true });
    });

    for (const [name, input] of [
        ['launchers.prepare', { launcherId: 'llamacpp-cpu', instanceId: 'inst-primary' }],
        ['launchers.start', { launcherId: 'llamacpp-cpu', instanceId: 'inst-primary' }],
        ['instance.stop', { instanceId: 'inst-primary' }],
    ]) {
        const response = await mcpTool(server, name, input);
        assert.equal(response.status, 200);
        assert.equal(response.json.error.code, -32001, `${name} must fail closed`);
        assert.match(response.json.error.message, /router-request verification is not configured/);
    }
});

test('async auth verifier rejection blocks state-changing tools before launcher dispatch', async (t) => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-async-auth-'));
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launchers-async-auth-'));
    const operationLogPath = path.join(runtimeDir, 'launcher-ops.log');
    const launcherPath = writeObservedLauncherScript(launcherDir, operationLogPath);
    const instancesDir = path.join(runtimeDir, 'instances');
    fs.mkdirSync(instancesDir, { recursive: true });
    fs.writeFileSync(path.join(instancesDir, 'inst-primary.json'), JSON.stringify({
        instanceId: 'inst-primary',
        launcherId: 'llamacpp-cpu',
        scriptPath: launcherPath,
        status: 'running',
    }));

    const { createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?asyncAuth=${Date.now()}`);
    const server = createServer({
        runtimeDir,
        launcherDirs: [launcherDir],
        authVerifier: async ({ toolName }) => {
            await Promise.resolve();
            throw new Error(`async denied ${toolName}`);
        },
    });
    server.listen(0, '127.0.0.1');
    await waitForListen(server);

    t.after(() => {
        server.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.rmSync(launcherDir, { recursive: true, force: true });
    });

    for (const [name, input] of [
        ['launchers.prepare', { launcherId: 'llamacpp-cpu', instanceId: 'inst-primary' }],
        ['launchers.start', { launcherId: 'llamacpp-cpu', instanceId: 'inst-primary' }],
        ['instance.stop', { instanceId: 'inst-primary' }],
    ]) {
        const response = await mcpTool(server, name, input);
        assert.equal(response.status, 200);
        assert.equal(response.json.error.code, -32001, `${name} must return auth error`);
        assert.match(response.json.error.message, new RegExp(`async denied ${name}`));
    }

    assert.equal(fs.existsSync(operationLogPath), false, 'launcher operations must not run after async auth denial');
});
