import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

function waitForListen(server) {
    return new Promise((resolve) => server.on('listening', () => resolve(server)));
}

function runTool(toolName, input, port) {
    const toolPath = path.resolve(import.meta.dirname, '..', 'shared/runtime-agent/tools/runtime-tool.mjs');
    return new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [toolPath], {
            env: {
                ...process.env,
                TOOL_NAME: toolName,
                PLOINKY_LLM_CONTROL_PORT: String(port),
            },
            timeout: 5000,
        }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
                return;
            }
            resolve(JSON.parse(stdout));
        });
        child.stdin.end(JSON.stringify({ tool: toolName, input }));
    });
}

test('runtime MCP wrapper maps tool calls to the internal control service', async (t) => {
    const requests = [];
    const control = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            requests.push({ method: req.method, url: req.url, body });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, method: req.method, url: req.url, body: body ? JSON.parse(body) : null }));
        });
    });
    control.listen(0, '127.0.0.1');
    await waitForListen(control);
    t.after(() => control.close());

    const describe = await runTool('runtime.describe', {}, control.address().port);
    assert.equal(describe.url, '/runtime/describe');
    assert.equal(describe.method, 'GET');

    const launcher = await runTool('launchers.describe', { launcherId: 'fake-cpu' }, control.address().port);
    assert.equal(launcher.url, '/runtime/launchers/fake-cpu');

    const priorities = await runTool('modelProfiles.setPriorities', {
        profileId: 'primary',
        priorities: [
            { launcherId: 'slow', priority: 10 },
            { launcherId: 'fast', priority: 100 },
        ],
    }, control.address().port);
    assert.equal(priorities.url, '/runtime/profiles/priorities');
    assert.deepEqual(priorities.body, { overrides: [{ profileId: 'primary', order: ['fast', 'slow'] }] });

    assert.equal(requests.length, 3);
});

test('runtime MCP wrapper rejects path traversal launcher ids before HTTP call', async () => {
    const control = http.createServer((_req, res) => {
        res.writeHead(500);
        res.end();
    });
    control.listen(0, '127.0.0.1');
    await waitForListen(control);
    try {
        await assert.rejects(
            () => runTool('launchers.describe', { launcherId: '../secret' }, control.address().port),
            /missing or invalid launcherId/,
        );
    } finally {
        control.close();
    }
});
