import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

function waitForListen(server) {
    return new Promise((resolve) => server.on('listening', () => resolve(server)));
}

function startJsonServer(handler) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    return server;
}

function request(port, urlPath, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: urlPath,
            method: options.method || 'GET',
            headers: options.headers || {},
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

test('runtime proxy routes /mcp to AgentServer sidecar and runtime routes to control service', async (t) => {
    const seen = { mcpSession: null, chatBody: null };
    const mcp = startJsonServer((req, res) => {
        seen.mcpSession = req.headers['mcp-session-id'];
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'session-out' });
        res.end(JSON.stringify({ service: 'mcp', path: req.url }));
    });
    const control = startJsonServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
                seen.chatBody = Buffer.concat(chunks).toString('utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ service: 'control-chat' }));
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service: 'control', path: req.url }));
    });
    await Promise.all([waitForListen(mcp), waitForListen(control)]);

    process.env.PLOINKY_LLM_MCP_PORT = String(mcp.address().port);
    process.env.PLOINKY_LLM_CONTROL_PORT = String(control.address().port);
    const proxyModule = await import(`${path.resolve(import.meta.dirname, '..', 'shared/runtime-agent/runtime-proxy.mjs')}?test=${Date.now()}`);
    const proxy = proxyModule.createProxyServer({});
    proxy.listen(0, '127.0.0.1');
    await waitForListen(proxy);
    const proxyPort = proxy.address().port;

    t.after(() => {
        proxy.close();
        mcp.close();
        control.close();
        delete process.env.PLOINKY_LLM_MCP_PORT;
        delete process.env.PLOINKY_LLM_CONTROL_PORT;
    });

    const mcpResponse = await request(proxyPort, '/mcp', {
        method: 'POST',
        headers: { 'mcp-session-id': 'session-in', accept: 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    assert.equal(mcpResponse.status, 200);
    assert.equal(JSON.parse(mcpResponse.body).service, 'mcp');
    assert.equal(mcpResponse.headers['mcp-session-id'], 'session-out');
    assert.equal(seen.mcpSession, 'session-in');

    const runtime = await request(proxyPort, '/runtime/describe');
    assert.equal(runtime.status, 200);
    assert.equal(JSON.parse(runtime.body).service, 'control');

    const chat = await request(proxyPort, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"messages":[]}',
    });
    assert.equal(chat.status, 200);
    assert.equal(JSON.parse(chat.body).service, 'control-chat');
    assert.equal(seen.chatBody, '{"messages":[]}');

    const missing = await request(proxyPort, '/not-real');
    assert.equal(missing.status, 404);
});

test('runtime proxy public port default does not inherit sidecar MCP port', async (t) => {
    process.env.PLOINKY_LLM_MCP_PORT = '19001';
    delete process.env.PLOINKY_LLM_PUBLIC_PORT;
    const proxyModule = await import(`${path.resolve(import.meta.dirname, '..', 'shared/runtime-agent/runtime-proxy.mjs')}?portDefault=${Date.now()}`);
    t.after(() => {
        delete process.env.PLOINKY_LLM_MCP_PORT;
    });

    assert.equal(proxyModule.DEFAULT_PUBLIC_PORT, 9000);
    assert.equal(proxyModule.DEFAULT_MCP_PORT, 19001);
});
