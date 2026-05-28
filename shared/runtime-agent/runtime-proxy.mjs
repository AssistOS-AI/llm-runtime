import http from 'node:http';

const DEFAULT_PUBLIC_PORT = Number(process.env.PLOINKY_LLM_PUBLIC_PORT || 9000);
const DEFAULT_MCP_PORT = Number(process.env.PLOINKY_LLM_MCP_PORT || 9001);
const DEFAULT_CONTROL_PORT = Number(process.env.PLOINKY_LLM_CONTROL_PORT || process.env.PLOINKY_LLM_RUNTIME_PORT || 9002);
const TARGET_HOST = process.env.PLOINKY_LLM_INTERNAL_HOST || '127.0.0.1';

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

function stripHopByHopHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
        out[key] = value;
    }
    return out;
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}

function classifyTarget(pathname) {
    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
        return { port: DEFAULT_MCP_PORT, service: 'mcp' };
    }
    if (
        pathname === '/health'
        || pathname === '/agent-card'
        || pathname === '/v1/chat/completions'
        || pathname.startsWith('/runtime/')
    ) {
        return { port: DEFAULT_CONTROL_PORT, service: 'control' };
    }
    return null;
}

function proxyRequest(req, res, target) {
    const headers = stripHopByHopHeaders(req.headers);
    headers.host = `${TARGET_HOST}:${target.port}`;
    const upstream = http.request({
        host: TARGET_HOST,
        port: target.port,
        method: req.method,
        path: req.url,
        headers,
        timeout: 120_000,
    }, (upstreamRes) => {
        const responseHeaders = stripHopByHopHeaders(upstreamRes.headers);
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
        if (res.headersSent) {
            res.destroy(err);
            return;
        }
        sendJson(res, 502, { error: `${target.service} service unreachable` });
    });
    upstream.on('timeout', () => {
        upstream.destroy();
        if (!res.headersSent) sendJson(res, 504, { error: `${target.service} service timeout` });
    });
    req.pipe(upstream);
}

function createProxyServer(options = {}) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const target = classifyTarget(url.pathname);
        if (!target) {
            sendJson(res, 404, { error: 'not found' });
            return;
        }
        proxyRequest(req, res, target);
    });
    if (options.port !== undefined) {
        server.listen(options.port, options.host || '127.0.0.1');
    }
    return server;
}

export {
    DEFAULT_CONTROL_PORT,
    DEFAULT_MCP_PORT,
    DEFAULT_PUBLIC_PORT,
    classifyTarget,
    createProxyServer,
};

if (import.meta.url === `file://${process.argv[1]}`) {
    createProxyServer({ port: DEFAULT_PUBLIC_PORT, host: '0.0.0.0' });
    process.stdout.write(`[llm-runtime-proxy] listening on 0.0.0.0:${DEFAULT_PUBLIC_PORT}\n`);
}
