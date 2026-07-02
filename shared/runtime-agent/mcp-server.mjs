import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { discoverAndDescribe } from './lib/launcherRegistry.mjs';
import { normalizeLaunchConfig } from './lib/launchConfig.mjs';
import { redactObject, redactString } from './lib/redaction.mjs';
import {
    DEFAULT_RUNTIME_ENV,
    DEFAULT_RUNTIME_PATHS,
    MCP_TOOL_NAMES,
    runtimeEnvFromEnv,
    runtimePathsFromEnv,
    runtimePortsFromEnv,
} from './lib/runtimeContract.mjs';
import {
    DEFAULT_RUNTIME_DIR,
    readSelectedArchitectureIfExists,
} from './lib/runtimeState.mjs';
import {
    InstanceError,
    getActiveInstance,
    prepareInstance,
    readInstanceLogs,
    readJsonIfExists,
    startInstance,
    statusInstance,
    stopInstance,
} from './lib/launcherProcess.mjs';
import {
    validateInstanceId,
    validateLauncherName,
} from './lib/schemas.mjs';

const CONTROL_BIND_HOST = '0.0.0.0';
const DEFAULT_PORT = runtimePortsFromEnv().mcp;
const DEFAULT_INFERENCE_PORT = runtimePortsFromEnv().inference;
const STATE_CHANGING_TOOLS = new Set(['launchers.prepare', 'launchers.start', 'instance.stop']);
const DEFAULT_AUTH_REPLAY_CACHE_MAX_SIZE = 4096;

class ToolAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolAuthError';
    }
}

function createMemoryReplayCache({ maxSize = DEFAULT_AUTH_REPLAY_CACHE_MAX_SIZE } = {}) {
    const entries = new Map();
    function prune() {
        const now = Date.now();
        for (const [jti, expiresAt] of entries) {
            if (expiresAt <= now) entries.delete(jti);
        }
        while (entries.size > maxSize) {
            const firstKey = entries.keys().next().value;
            if (firstKey === undefined) break;
            entries.delete(firstKey);
        }
    }
    return {
        seen(jti) {
            prune();
            return entries.has(jti);
        },
        remember(jti, ttlMs) {
            prune();
            entries.set(jti, Date.now() + Math.max(1, Number(ttlMs) || 1));
        },
        reset() {
            entries.clear();
        },
    };
}

function moduleSpecifier(modulePath) {
    const value = String(modulePath || '').trim();
    if (!value) return '';
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return value;
    return pathToFileURL(path.resolve(value)).href;
}

async function loadProductionAuthModules(env = process.env) {
    const invocationAuthModule = String(env.PLOINKY_INVOCATION_AUTH_MODULE || '').trim();
    const requestHashModule = String(env.PLOINKY_REQUEST_HASH_MODULE || '').trim();
    if (!invocationAuthModule && !requestHashModule) {
        throw new ToolAuthError('state-changing tool router-request verification is not configured: set PLOINKY_INVOCATION_AUTH_MODULE and PLOINKY_REQUEST_HASH_MODULE');
    }
    if (!invocationAuthModule) {
        throw new ToolAuthError('state-changing tool router-request verification is not configured: set PLOINKY_INVOCATION_AUTH_MODULE');
    }
    if (!requestHashModule) {
        throw new ToolAuthError('state-changing tool router-request verification is not configured: set PLOINKY_REQUEST_HASH_MODULE');
    }

    let verifierModule;
    let hashModule;
    try {
        [verifierModule, hashModule] = await Promise.all([
            import(moduleSpecifier(invocationAuthModule)),
            import(moduleSpecifier(requestHashModule)),
        ]);
    } catch (err) {
        throw new ToolAuthError(`state-changing tool auth verifier failed to load: ${redactString(err.message)}`);
    }

    if (typeof verifierModule.verifyRouterRequestFromHeaders !== 'function') {
        throw new ToolAuthError('state-changing tool auth verifier module must export verifyRouterRequestFromHeaders');
    }
    if (typeof hashModule.computeRchTool !== 'function') {
        throw new ToolAuthError('state-changing tool request hash module must export computeRchTool');
    }
    return {
        verifyRouterRequestFromHeaders: verifierModule.verifyRouterRequestFromHeaders,
        computeRchTool: hashModule.computeRchTool,
    };
}

function createProductionAuthVerifier(options = {}) {
    const env = options.env || process.env;
    const replayCache = createMemoryReplayCache({
        maxSize: Number.isInteger(options.authReplayCacheMaxSize)
            ? Math.max(1, options.authReplayCacheMaxSize)
            : DEFAULT_AUTH_REPLAY_CACHE_MAX_SIZE,
    });
    let modulesPromise = null;
    return async ({ req, toolName, input }) => {
        if (!modulesPromise) modulesPromise = loadProductionAuthModules(env);
        const { verifyRouterRequestFromHeaders, computeRchTool } = await modulesPromise;
        let rch;
        try {
            rch = computeRchTool({
                method: 'POST',
                path: '/mcp',
                tool: toolName,
                arguments: input || {},
            });
        } catch (err) {
            throw new ToolAuthError(`router request hash failed: ${redactString(err.message)}`);
        }
        const verified = await verifyRouterRequestFromHeaders(req.headers, {
            env,
            replayCache,
            method: 'POST',
            path: '/mcp',
            tool: toolName,
            rch,
        });
        if (!verified?.ok) {
            throw new ToolAuthError(verified?.reason || 'router-request verification failed');
        }
        return verified;
    };
}

function createAuthContext(options = {}) {
    return {
        insecureAllowUnauthenticatedStateChanges: options.insecureAllowUnauthenticatedStateChanges === true,
        authVerifier: typeof options.authVerifier === 'function'
            ? options.authVerifier
            : createProductionAuthVerifier(options),
    };
}

function send(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(redactObject(payload)));
}

function sendHttpError(res, err) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    send(res, 500, { error: redactString(err?.message || 'internal server error') });
}

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id, code, message, data = undefined) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id: id ?? null, error };
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let bytes = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 1 * 1024 * 1024) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function launcherDirsFromOptions(options = {}) {
    if (Array.isArray(options.launcherDirs)) return options.launcherDirs;
    if (typeof options.launchersDir === 'string') return [options.launchersDir];
    return [runtimePathsFromEnv().launchersDir];
}

function readAllLaunchers(options = {}) {
    const merged = new Map();
    for (const dir of launcherDirsFromOptions(options)) {
        if (!dir) continue;
        for (const launcher of discoverAndDescribe(dir)) {
            merged.set(launcher.id, launcher);
        }
    }
    return Array.from(merged.values());
}

function toolDescriptor(name) {
    return {
        name,
        inputSchema: {
            type: 'object',
            additionalProperties: true,
        },
    };
}

async function requireToolAuth({ req, authContext, toolName, input }) {
    if (!STATE_CHANGING_TOOLS.has(toolName)) return null;
    if (authContext.insecureAllowUnauthenticatedStateChanges === true) return null;
    if (typeof authContext.authVerifier !== 'function') {
        throw new ToolAuthError('state-changing tool router-request verification is unavailable');
    }
    try {
        return await authContext.authVerifier({ req, toolName, input });
    } catch (err) {
        throw new ToolAuthError(err.message);
    }
}

function requireLauncher(launchers, launcherId) {
    if (!validateLauncherName(launcherId || '')) {
        const err = new Error('invalid launcherId');
        err.statusCode = 400;
        throw err;
    }
    const launcher = launchers.find((entry) => entry.id === launcherId);
    if (!launcher) {
        const err = new Error('launcher not found');
        err.statusCode = 404;
        throw err;
    }
    if (!launcher.ok) {
        const err = new Error(`launcher '${launcherId}' describe failed: ${launcher.error}`);
        err.statusCode = 503;
        throw err;
    }
    return launcher;
}

function generatedInstanceId(prefix = 'inst') {
    return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function launcherSummary(launcher) {
    return {
        id: launcher.id,
        ok: Boolean(launcher.ok),
        error: launcher.error || null,
        engine: launcher.describe?.engine || null,
        modelId: launcher.describe?.modelId || null,
        supportedAccelerators: launcher.describe?.supportedAccelerators || [],
        supportedPlatforms: launcher.describe?.supportedPlatforms || [],
    };
}

function runtimeDescribe(options = {}) {
    const paths = runtimePathsFromEnv();
    const ports = runtimePortsFromEnv();
    const runtimeDir = options.runtimeDir || paths.runtimeDir || DEFAULT_RUNTIME_DIR;
    return {
        paths,
        ports,
        env: runtimeEnvFromEnv(),
        defaultEnv: DEFAULT_RUNTIME_ENV,
        tools: MCP_TOOL_NAMES,
        launchers: readAllLaunchers(options).map(launcherSummary),
        selectedArchitecture: readSelectedArchitectureIfExists(runtimeDir),
        activeInstance: getActiveInstance(runtimeDir),
    };
}

function readInstanceRecord(runtimeDir, instanceId) {
    return redactObject(readJsonIfExists(path.join(runtimeDir, 'instances', `${instanceId}.json`)));
}

async function callTool({ req, runtimeDir, options, authContext, name, input }) {
    await requireToolAuth({ req, authContext, toolName: name, input });
    const launchers = () => readAllLaunchers(options);
    switch (name) {
        case 'runtime.describe':
            return runtimeDescribe({ ...options, runtimeDir });
        case 'launchers.list':
            return { launchers: launchers().map(launcherSummary) };
        case 'launchers.describe': {
            const launcher = requireLauncher(launchers(), input?.launcherId || input?.id);
            return { id: launcher.id, ok: true, describe: launcher.describe };
        }
        case 'launchers.prepare': {
            const config = normalizeLaunchConfig({
                ...input,
                instanceId: input?.instanceId || generatedInstanceId('prep'),
            });
            const launcher = requireLauncher(launchers(), config.launcherId);
            const prepared = prepareInstance({ runtimeDir, launcher, config });
            return { ok: true, instanceId: config.instanceId, prepared };
        }
        case 'launchers.start': {
            const config = normalizeLaunchConfig({
                ...input,
                instanceId: input?.instanceId || generatedInstanceId('inst'),
            });
            const launcher = requireLauncher(launchers(), config.launcherId);
            return startInstance({ runtimeDir, launcher, config });
        }
        case 'instance.status': {
            const instanceId = input?.instanceId || input?.id;
            if (!validateInstanceId(instanceId)) throw new Error('invalid instanceId');
            const record = readInstanceRecord(runtimeDir, instanceId);
            if (!record) return { ok: false, found: false };
            const launcher = launchers().find((entry) => entry.id === record.launcherId);
            if (!launcher) return { ok: true, found: true, record, launcherAvailable: false };
            return statusInstance({ runtimeDir, launcher, instanceId });
        }
        case 'instance.stop': {
            const instanceId = input?.instanceId || input?.id;
            if (!validateInstanceId(instanceId)) throw new Error('invalid instanceId');
            const record = readInstanceRecord(runtimeDir, instanceId);
            if (!record) return { ok: false, found: false };
            const launcher = launchers().find((entry) => entry.id === record.launcherId) || {
                id: record.launcherId,
                scriptPath: record.scriptPath,
            };
            return stopInstance({ runtimeDir, launcher, instanceId });
        }
        case 'instance.logs': {
            const instanceId = input?.instanceId || input?.id;
            if (!validateInstanceId(instanceId)) throw new Error('invalid instanceId');
            const out = readInstanceLogs({ runtimeDir, instanceId, tailBytes: input?.tailBytes });
            return { ok: true, lines: out.lines.map((line) => redactString(line)) };
        }
        default:
            throw new Error(`unknown tool '${name}'`);
    }
}

async function handleMcp(req, res, runtimeDir, options, authContext) {
    let body;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        send(res, 200, rpcError(null, -32700, redactString(err.message)));
        return;
    }

    try {
        if (body.method === 'initialize') {
            send(res, 200, rpcResult(body.id, {
                protocolVersion: '2024-11-05',
                serverInfo: { name: 'ploinky-llm-runtime', version: '1.0.0' },
                capabilities: { tools: {} },
            }));
            return;
        }
        if (body.method === 'tools/list') {
            send(res, 200, rpcResult(body.id, { tools: MCP_TOOL_NAMES.map(toolDescriptor) }));
            return;
        }
        if (body.method === 'tools/call') {
            const name = body.params?.name;
            const input = body.params?.arguments && typeof body.params.arguments === 'object'
                ? body.params.arguments
                : {};
            if (!MCP_TOOL_NAMES.includes(name)) {
                send(res, 200, rpcError(body.id, -32602, `unknown tool '${name}'`));
                return;
            }
            const result = await callTool({ req, runtimeDir, options, authContext, name, input });
            send(res, 200, rpcResult(body.id, result));
            return;
        }
        send(res, 200, rpcError(body.id, -32601, `unknown method '${body.method}'`));
    } catch (err) {
        if (err instanceof ToolAuthError) {
            send(res, 200, rpcError(body.id, -32001, redactString(err.message)));
            return;
        }
        if (err instanceof InstanceError) {
            send(res, 200, rpcError(body.id, -32000, redactString(err.message), { code: err.code }));
            return;
        }
        send(res, 200, rpcError(body.id, -32603, redactString(err.message)));
    }
}

function createServer(options = {}) {
    const runtimeDir = options.runtimeDir || runtimePathsFromEnv().runtimeDir || DEFAULT_RUNTIME_DIR;
    const authContext = createAuthContext(options);
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            if (req.method === 'GET' && url.pathname === '/health') {
                send(res, 200, {
                    status: 'ok',
                    service: 'ploinky-llm-runtime',
                    port: runtimePortsFromEnv().mcp,
                });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/mcp') {
                await handleMcp(req, res, runtimeDir, options, authContext);
                return;
            }
            if (req.method === 'GET' && url.pathname === '/runtime/describe') {
                send(res, 200, runtimeDescribe({ ...options, runtimeDir }));
                return;
            }
            if (req.method === 'GET' && url.pathname === '/runtime/active-instance') {
                send(res, 200, { activeInstance: getActiveInstance(runtimeDir) });
                return;
            }
            send(res, 404, { error: 'not found' });
        } catch (err) {
            sendHttpError(res, err);
        }
    });
}

export {
    CONTROL_BIND_HOST,
    DEFAULT_INFERENCE_PORT,
    DEFAULT_PORT,
    DEFAULT_RUNTIME_PATHS,
    createServer,
    readAllLaunchers,
    runtimeDescribe,
};

if (import.meta.url === `file://${process.argv[1]}`) {
    createServer({}).listen(DEFAULT_PORT, CONTROL_BIND_HOST, () => {
        process.stdout.write(`[llm-runtime] listening on ${CONTROL_BIND_HOST}:${DEFAULT_PORT}\n`);
    });
}
