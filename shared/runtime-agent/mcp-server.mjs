import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { discoverAndDescribe } from './lib/launcherRegistry.mjs';
import {
    applyPriorityOverrides,
    describeProfile,
    listProfiles,
    loadProfiles,
    selectCandidate,
} from './lib/modelProfiles.mjs';
import { redactEnv, redactString } from './lib/redaction.mjs';
import {
    DEFAULT_RUNTIME_DIR,
    ensureRuntimeSubdir,
    readSelectedArchitecture,
} from './lib/runtimeState.mjs';
import {
    InstanceError,
    getActiveInstance,
    prepareInstance,
    readInstanceLogs,
    readJsonIfExists,
    safeJsonWrite,
    startInstance,
    statusInstance,
    stopInstance,
} from './lib/launcherProcess.mjs';
import { validateInstanceId, validateLauncherName } from './lib/schemas.mjs';

const DEFAULT_PORT = Number(process.env.PLOINKY_LLM_RUNTIME_PORT || process.env.PLOINKY_LLM_CONTROL_PORT || 9000);
const DEFAULT_ENGINE_PORT = Number(process.env.PLOINKY_LLM_ENGINE_PORT || 8080);
const CONTROL_BIND_HOST = '127.0.0.1';
const ENGINE_HOST = process.env.PLOINKY_LLM_ENGINE_HOST || '127.0.0.1';
const AGENT_LAUNCHERS_DIR = process.env.PLOINKY_LLM_LAUNCHERS_DIR || '/code/launchers';
const SHARED_LAUNCHERS_DIR = process.env.PLOINKY_LLM_SHARED_LAUNCHERS_DIR || '/opt/ploinky/launchers';
const AGENT_MODELS_FILE = process.env.PLOINKY_LLM_AGENT_MODELS || '/code/agent-models.json';
const AGENT_CARD_FILE = process.env.PLOINKY_LLM_AGENT_CARD || '/code/agent-card.json';
const PRIORITY_OVERRIDES_FILE_NAME = 'priority-overrides.json';

function readJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readAllLaunchers() {
    const merged = new Map();
    for (const dir of [SHARED_LAUNCHERS_DIR, AGENT_LAUNCHERS_DIR]) {
        if (!dir) continue;
        for (const launcher of discoverAndDescribe(dir)) {
            merged.set(launcher.id, launcher);
        }
    }
    return Array.from(merged.values());
}

function readPriorityOverrides(runtimeDir) {
    const overridePath = path.join(runtimeDir, PRIORITY_OVERRIDES_FILE_NAME);
    if (!fs.existsSync(overridePath)) return [];
    const doc = readJson(overridePath) || {};
    return Array.isArray(doc.overrides) ? doc.overrides : [];
}

function buildRuntimeContext(runtimeDir = DEFAULT_RUNTIME_DIR) {
    const selected = readSelectedArchitecture(runtimeDir);
    const launchers = readAllLaunchers();
    const knownLauncherIds = new Set(launchers.filter((l) => l.ok).map((l) => l.id));
    let modelsDoc = readJson(AGENT_MODELS_FILE);
    if (modelsDoc) {
        modelsDoc = loadProfiles(modelsDoc, knownLauncherIds);
        const overrides = readPriorityOverrides(runtimeDir);
        if (overrides.length) {
            modelsDoc = applyPriorityOverrides(modelsDoc, overrides);
        }
    }
    return { selected, launchers, modelsDoc, runtimeDir };
}

function send(res, status, payload, contentType = 'application/json') {
    res.writeHead(status, {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
    });
    if (payload === undefined || payload === null) {
        res.end();
    } else if (typeof payload === 'string') {
        res.end(payload);
    } else {
        res.end(JSON.stringify(payload));
    }
}

function handleAgentCard(res) {
    const card = readJson(AGENT_CARD_FILE);
    if (!card) {
        send(res, 404, { error: 'agent-card.json missing' });
        return;
    }
    send(res, 200, card);
}

function safeRuntimeContextOrError(res, runtimeDir) {
    try {
        return buildRuntimeContext(runtimeDir);
    } catch (err) {
        send(res, 503, { status: 'error', error: redactString(err.message) });
        return null;
    }
}

function handleRuntimeDescribe(res, runtimeDir) {
    const context = safeRuntimeContextOrError(res, runtimeDir);
    if (!context) return;
    send(res, 200, {
        architecture: context.selected.architecture,
        catalog: context.selected.catalog,
        runtimePolicyHash: context.selected.runtimePolicyHash,
        hardware: context.selected.hardware,
        launchers: context.launchers.map((l) => ({
            id: l.id,
            ok: Boolean(l.ok),
            describeError: l.error || null,
            engine: l.describe?.engine || null,
            supportedAccelerators: l.describe?.supportedAccelerators || [],
            capabilities: l.describe?.capabilities || {},
        })),
        profiles: context.modelsDoc ? listProfiles(context.modelsDoc) : [],
        envExposed: context.selected.envExposed,
    });
}

function handleRuntimeHealth(res, runtimeDir) {
    try {
        const context = buildRuntimeContext(runtimeDir);
        send(res, 200, {
            status: 'ok',
            architectureId: context.selected.architecture?.id || null,
            launcherCount: context.launchers.length,
            healthyLaunchers: context.launchers.filter((l) => l.ok).length,
        });
    } catch (err) {
        send(res, 503, { status: 'error', error: redactString(err.message) });
    }
}

function handleLaunchersList(res) {
    try {
        const launchers = readAllLaunchers();
        send(res, 200, {
            launchers: launchers.map((l) => ({
                id: l.id,
                ok: Boolean(l.ok),
                error: l.error || null,
            })),
        });
    } catch (err) {
        send(res, 500, { error: redactString(err.message) });
    }
}

function handleLauncherDescribe(res, launcherId) {
    if (!validateLauncherName(launcherId)) {
        send(res, 400, { error: 'invalid launcher id' });
        return;
    }
    const launchers = readAllLaunchers();
    const found = launchers.find((l) => l.id === launcherId);
    if (!found) {
        send(res, 404, { error: 'launcher not found' });
        return;
    }
    send(res, 200, { id: found.id, ok: Boolean(found.ok), describe: found.describe || null, error: found.error || null });
}

function handleModelProfilesList(res, runtimeDir) {
    const context = safeRuntimeContextOrError(res, runtimeDir);
    if (!context) return;
    send(res, 200, { profiles: context.modelsDoc ? listProfiles(context.modelsDoc) : [] });
}

function handleProfileDescribe(res, runtimeDir, profileId) {
    const context = safeRuntimeContextOrError(res, runtimeDir);
    if (!context) return;
    if (!context.modelsDoc) {
        send(res, 404, { error: 'no agent-models.json present' });
        return;
    }
    const profile = describeProfile(context.modelsDoc, profileId);
    if (!profile) {
        send(res, 404, { error: 'profile not found' });
        return;
    }
    send(res, 200, profile);
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

async function handleSetPriorities(req, res, runtimeDir) {
    try {
        const body = await readJsonBody(req);
        const context = buildRuntimeContext(runtimeDir);
        if (!context.modelsDoc) {
            send(res, 400, { error: 'no agent-models.json present' });
            return;
        }
        const overrides = Array.isArray(body?.overrides) ? body.overrides : [];
        const updated = applyPriorityOverrides(context.modelsDoc, overrides);
        ensureRuntimeSubdir(runtimeDir, '.');
        safeJsonWrite(path.join(runtimeDir, PRIORITY_OVERRIDES_FILE_NAME), { overrides });
        send(res, 200, { profiles: listProfiles(updated) });
    } catch (err) {
        send(res, 400, { error: redactString(err.message) });
    }
}

function handleResetPriorities(res, runtimeDir) {
    try {
        const overrideFile = path.join(runtimeDir, PRIORITY_OVERRIDES_FILE_NAME);
        if (fs.existsSync(overrideFile)) fs.unlinkSync(overrideFile);
        send(res, 200, { reset: true });
    } catch (err) {
        send(res, 500, { error: redactString(err.message) });
    }
}

function pickLauncherForProfile(context, profileId) {
    if (!context.modelsDoc) return { ok: false, error: 'no agent-models.json present' };
    const profile = describeProfile(context.modelsDoc, profileId || 'primary');
    if (!profile) return { ok: false, error: `profile '${profileId}' not found` };
    const candidate = selectCandidate(profile, context.selected?.hardware || {});
    if (!candidate) return { ok: false, error: `no compatible launcher candidate for profile '${profile.id}'` };
    const launcher = context.launchers.find((l) => l.ok && l.id === candidate.launcher);
    if (!launcher) return { ok: false, error: `launcher '${candidate.launcher}' is not available (describe failed)` };
    return { ok: true, profile, candidate, launcher };
}

async function handleLauncherPrepareStart(req, res, runtimeDir, action) {
    try {
        const body = await readJsonBody(req);
        const launcherId = body?.launcher;
        if (!validateLauncherName(launcherId || '')) {
            send(res, 400, { error: 'invalid launcher id' });
            return;
        }
        const launchers = readAllLaunchers();
        const launcher = launchers.find((l) => l.id === launcherId);
        if (!launcher) {
            send(res, 404, { error: 'launcher not found' });
            return;
        }
        if (!launcher.ok) {
            send(res, 503, { error: `launcher '${launcherId}' describe failed: ${launcher.error}` });
            return;
        }
        const instanceId = body?.instanceId || `inst-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        if (!validateInstanceId(instanceId)) {
            send(res, 400, { error: 'invalid instanceId' });
            return;
        }
        const config = {
            instanceId,
            launcher: launcherId,
            parameters: body?.parameters && typeof body.parameters === 'object' ? body.parameters : {},
        };
        if (action === 'prepare') {
            const out = prepareInstance({ runtimeDir, launcher, config });
            send(res, 200, { ok: true, instanceId, prepared: out });
            return;
        }
        const out = startInstance({ runtimeDir, launcher, config });
        send(res, 200, out);
    } catch (err) {
        if (err instanceof InstanceError) {
            send(res, err.code === 'INVALID_LAUNCHER' || err.code === 'INVALID_INSTANCE' ? 400 : 500, {
                error: redactString(err.message),
                code: err.code,
            });
            return;
        }
        send(res, 500, { error: redactString(err.message) });
    }
}

function handleInstanceStatus(res, runtimeDir, instanceId) {
    if (!validateInstanceId(instanceId)) {
        send(res, 400, { error: 'invalid instanceId' });
        return;
    }
    const record = readJsonIfExists(path.join(runtimeDir, 'instances', `${instanceId}.json`));
    if (!record) {
        send(res, 404, { error: 'instance not found' });
        return;
    }
    const launcher = readAllLaunchers().find((l) => l.id === record.launcher);
    if (!launcher) {
        send(res, 200, { ok: true, record, launcherAvailable: false });
        return;
    }
    const probe = statusInstance({ runtimeDir, launcher, instanceId });
    send(res, 200, { ok: probe.ok, record, status: probe.status, error: probe.error || null });
}

function handleInstanceStop(res, runtimeDir, instanceId) {
    if (!validateInstanceId(instanceId)) {
        send(res, 400, { error: 'invalid instanceId' });
        return;
    }
    const record = readJsonIfExists(path.join(runtimeDir, 'instances', `${instanceId}.json`));
    if (!record) {
        send(res, 404, { error: 'instance not found' });
        return;
    }
    const launcher = readAllLaunchers().find((l) => l.id === record.launcher) || {
        id: record.launcher,
        scriptPath: record.scriptPath,
    };
    const result = stopInstance({ runtimeDir, launcher, instanceId });
    send(res, 200, result);
}

function handleInstanceLogs(res, runtimeDir, instanceId) {
    if (!validateInstanceId(instanceId)) {
        send(res, 400, { error: 'invalid instanceId' });
        return;
    }
    try {
        const out = readInstanceLogs({ runtimeDir, instanceId });
        send(res, 200, { lines: out.lines.map((line) => redactString(line)) });
    } catch (err) {
        send(res, 500, { error: redactString(err.message) });
    }
}

function handleRuntimeLogs(res, runtimeDir) {
    const active = getActiveInstance(runtimeDir);
    if (!active) {
        send(res, 200, { active: null, lines: [] });
        return;
    }
    try {
        const out = readInstanceLogs({ runtimeDir, instanceId: active.instanceId });
        send(res, 200, { active, lines: out.lines.map((line) => redactString(line)) });
    } catch (err) {
        send(res, 500, { error: redactString(err.message) });
    }
}

async function handleChatCompletions(req, res, runtimeDir) {
    const context = safeRuntimeContextOrError(res, runtimeDir);
    if (!context) return;
    let body;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        send(res, 400, { error: redactString(err.message) });
        return;
    }
    const profileId = typeof body?.profile === 'string' ? body.profile : 'primary';
    const pick = pickLauncherForProfile(context, profileId);
    if (!pick.ok) {
        send(res, 503, { error: pick.error });
        return;
    }
    try {
        const config = {
            instanceId: `chat-${pick.profile.id}`,
            launcher: pick.candidate.launcher,
            parameters: body?.parameters && typeof body.parameters === 'object' ? body.parameters : {},
        };
        startInstance({ runtimeDir, launcher: pick.launcher, config });
    } catch (err) {
        send(res, 503, { error: `launcher start failed: ${redactString(err.message)}` });
        return;
    }
    proxyToEngine(req, res, body);
}

function proxyToEngine(req, res, body) {
    const payload = JSON.stringify(body);
    const proxyReq = http.request({
        host: ENGINE_HOST,
        port: DEFAULT_ENGINE_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Accept: req.headers.accept || 'application/json',
        },
        timeout: 120_000,
    }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
        send(res, 502, { error: `engine unreachable: ${redactString(err.message)}` });
    });
    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        send(res, 504, { error: 'engine timeout' });
    });
    proxyReq.write(payload);
    proxyReq.end();
}

function logSafeRequest(method, url) {
    void redactEnv(process.env);
    process.stdout.write(`[llm-runtime-control] ${method} ${url}\n`);
}

function matchPath(pattern, pathname) {
    const re = new RegExp(`^${pattern.replace(/\//g, '\\/').replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    const m = pathname.match(re);
    if (!m) return null;
    return m.slice(1);
}

function createServer(options = {}) {
    const runtimeDir = options.runtimeDir || DEFAULT_RUNTIME_DIR;
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        logSafeRequest(req.method, url.pathname);

        if (req.method === 'GET' && url.pathname === '/health') {
            handleRuntimeHealth(res, runtimeDir);
            return;
        }
        if (req.method === 'GET' && url.pathname === '/agent-card') {
            handleAgentCard(res);
            return;
        }
        if (req.method === 'GET' && url.pathname === '/runtime/describe') {
            handleRuntimeDescribe(res, runtimeDir);
            return;
        }
        if (req.method === 'GET' && url.pathname === '/runtime/logs') {
            handleRuntimeLogs(res, runtimeDir);
            return;
        }
        if (req.method === 'GET' && url.pathname === '/runtime/launchers') {
            handleLaunchersList(res);
            return;
        }
        const launcherDescribeMatch = req.method === 'GET' && matchPath('/runtime/launchers/:id', url.pathname);
        if (launcherDescribeMatch) {
            handleLauncherDescribe(res, decodeURIComponent(launcherDescribeMatch[0]));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/runtime/launchers/prepare') {
            await handleLauncherPrepareStart(req, res, runtimeDir, 'prepare');
            return;
        }
        if (req.method === 'POST' && url.pathname === '/runtime/launchers/start') {
            await handleLauncherPrepareStart(req, res, runtimeDir, 'start');
            return;
        }
        const instanceLogsMatch = req.method === 'GET' && matchPath('/runtime/instances/:id/logs', url.pathname);
        if (instanceLogsMatch) {
            handleInstanceLogs(res, runtimeDir, decodeURIComponent(instanceLogsMatch[0]));
            return;
        }
        const instanceStatusMatch = req.method === 'GET' && matchPath('/runtime/instances/:id', url.pathname);
        if (instanceStatusMatch) {
            handleInstanceStatus(res, runtimeDir, decodeURIComponent(instanceStatusMatch[0]));
            return;
        }
        const instanceStopMatch = req.method === 'DELETE' && matchPath('/runtime/instances/:id', url.pathname);
        if (instanceStopMatch) {
            handleInstanceStop(res, runtimeDir, decodeURIComponent(instanceStopMatch[0]));
            return;
        }
        if (req.method === 'GET' && url.pathname === '/runtime/profiles') {
            handleModelProfilesList(res, runtimeDir);
            return;
        }
        const profileDescribeMatch = req.method === 'GET' && matchPath('/runtime/profiles/:id', url.pathname);
        if (profileDescribeMatch) {
            handleProfileDescribe(res, runtimeDir, decodeURIComponent(profileDescribeMatch[0]));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/runtime/profiles/priorities') {
            await handleSetPriorities(req, res, runtimeDir);
            return;
        }
        if (req.method === 'DELETE' && url.pathname === '/runtime/profiles/priorities') {
            handleResetPriorities(res, runtimeDir);
            return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            await handleChatCompletions(req, res, runtimeDir);
            return;
        }
        send(res, 404, { error: 'not found' });
    });
    if (options.port !== undefined) {
        server.listen(options.port, options.host || '127.0.0.1');
    }
    return server;
}

export {
    AGENT_CARD_FILE,
    AGENT_LAUNCHERS_DIR,
    AGENT_MODELS_FILE,
    DEFAULT_ENGINE_PORT,
    DEFAULT_PORT,
    CONTROL_BIND_HOST,
    ENGINE_HOST,
    SHARED_LAUNCHERS_DIR,
    createServer,
    describeProfile,
    pickLauncherForProfile,
    selectCandidate,
};

if (import.meta.url === `file://${process.argv[1]}`) {
    createServer({ port: DEFAULT_PORT, host: CONTROL_BIND_HOST });
    process.stdout.write(`[llm-runtime-control] listening on ${CONTROL_BIND_HOST}:${DEFAULT_PORT}\n`);
}
