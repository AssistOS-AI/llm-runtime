import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { redactEnv, redactString } from './redaction.mjs';
import {
    INSTANCE_ID_RE,
    validateInstanceId,
    validateLauncherName,
} from './schemas.mjs';

const DEFAULT_LAUNCHER_CALL_TIMEOUT_MS = 60_000;

class InstanceError extends Error {
    constructor(message, code = 'INSTANCE_ERROR') {
        super(message);
        this.name = 'InstanceError';
        this.code = code;
    }
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function instanceConfigPath(runtimeDir, instanceId) {
    return path.join(runtimeDir, 'launch-configs', `${instanceId}.json`);
}

function instanceStatePath(runtimeDir, instanceId) {
    return path.join(runtimeDir, 'instances', `${instanceId}.json`);
}

function instanceLogPath(runtimeDir, instanceId) {
    return path.join(runtimeDir, 'logs', `${instanceId}.log`);
}

function activePointerPath(runtimeDir) {
    return path.join(runtimeDir, 'active-instance.json');
}

function sanitizeConfigForDisk(config) {
    const allowed = ['instanceId', 'launcher', 'parameters'];
    const out = {};
    for (const key of allowed) {
        if (config && Object.prototype.hasOwnProperty.call(config, key)) {
            out[key] = config[key];
        }
    }
    return out;
}

function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeJsonWrite(filePath, value) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function appendLog(filePath, label, payload) {
    ensureDir(path.dirname(filePath));
    const safe = redactString(typeof payload === 'string' ? payload : JSON.stringify(payload));
    const line = `[${new Date().toISOString()}] [${label}] ${safe}\n`;
    fs.appendFileSync(filePath, line);
}

function runLauncherCommand(launcher, args, options = {}) {
    const result = spawnSync(launcher.scriptPath, args, {
        encoding: 'utf8',
        timeout: options.timeoutMs || DEFAULT_LAUNCHER_CALL_TIMEOUT_MS,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        ok: !result.error && result.status === 0,
        status: result.status ?? null,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        error: result.error ? result.error.message : null,
    };
}

function parseJsonResponse(stdout, label) {
    try {
        const trimmed = String(stdout || '').trim();
        if (!trimmed) return {};
        return JSON.parse(trimmed);
    } catch (err) {
        throw new InstanceError(`${label}: launcher returned non-JSON: ${err.message}`, 'LAUNCHER_PROTOCOL');
    }
}

function getActiveInstance(runtimeDir) {
    return readJsonIfExists(activePointerPath(runtimeDir));
}

function setActiveInstance(runtimeDir, payload) {
    safeJsonWrite(activePointerPath(runtimeDir), payload);
}

function clearActiveInstance(runtimeDir) {
    try { fs.unlinkSync(activePointerPath(runtimeDir)); } catch (_) {}
}

function prepareInstance({ runtimeDir, launcher, config }) {
    if (!validateLauncherName(config.launcher) || launcher.id !== config.launcher) {
        throw new InstanceError(`launcher name '${config.launcher}' is invalid`, 'INVALID_LAUNCHER');
    }
    if (!validateInstanceId(config.instanceId)) {
        throw new InstanceError(`instanceId '${config.instanceId}' does not match ${INSTANCE_ID_RE}`, 'INVALID_INSTANCE');
    }
    const sanitized = sanitizeConfigForDisk(config);
    const configPath = instanceConfigPath(runtimeDir, sanitized.instanceId);
    safeJsonWrite(configPath, sanitized);
    const logPath = instanceLogPath(runtimeDir, sanitized.instanceId);
    const result = runLauncherCommand(launcher, ['prepare', '--config', configPath]);
    appendLog(logPath, 'prepare', { stdout: result.stdout, stderr: result.stderr, status: result.status });
    if (!result.ok) {
        throw new InstanceError(`launcher prepare failed: ${result.stderr || result.error || `exit ${result.status}`}`, 'PREPARE_FAILED');
    }
    return parseJsonResponse(result.stdout, 'prepare');
}

function startInstance({ runtimeDir, launcher, config }) {
    if (launcher.id !== config.launcher) {
        throw new InstanceError(`launcher name '${config.launcher}' does not match script id`, 'INVALID_LAUNCHER');
    }
    if (!validateInstanceId(config.instanceId)) {
        throw new InstanceError(`instanceId '${config.instanceId}' is invalid`, 'INVALID_INSTANCE');
    }
    const active = getActiveInstance(runtimeDir);
    if (active && active.launcher === config.launcher && active.instanceId === config.instanceId) {
        return { ok: true, reused: true, instanceId: config.instanceId, launcher: config.launcher };
    }
    if (active) {
        stopInstance({ runtimeDir, launcher: { id: active.launcher, scriptPath: active.scriptPath }, instanceId: active.instanceId });
    }
    const sanitized = sanitizeConfigForDisk(config);
    const configPath = instanceConfigPath(runtimeDir, sanitized.instanceId);
    safeJsonWrite(configPath, sanitized);
    const logPath = instanceLogPath(runtimeDir, sanitized.instanceId);
    const result = runLauncherCommand(launcher, ['start', '--config', configPath]);
    appendLog(logPath, 'start', { stdout: result.stdout, stderr: result.stderr, status: result.status });
    if (!result.ok) {
        throw new InstanceError(`launcher start failed: ${result.stderr || result.error || `exit ${result.status}`}`, 'START_FAILED');
    }
    const parsed = parseJsonResponse(result.stdout, 'start');
    const stateRecord = {
        instanceId: sanitized.instanceId,
        launcher: launcher.id,
        scriptPath: launcher.scriptPath,
        startedAt: new Date().toISOString(),
        status: 'running',
        launcherStart: parsed,
    };
    safeJsonWrite(instanceStatePath(runtimeDir, sanitized.instanceId), stateRecord);
    setActiveInstance(runtimeDir, {
        instanceId: sanitized.instanceId,
        launcher: launcher.id,
        scriptPath: launcher.scriptPath,
        startedAt: stateRecord.startedAt,
    });
    return { ok: true, reused: false, instanceId: sanitized.instanceId, launcher: launcher.id, launcherStart: parsed };
}

function statusInstance({ runtimeDir, launcher, instanceId }) {
    if (!validateInstanceId(instanceId)) {
        throw new InstanceError(`instanceId '${instanceId}' is invalid`, 'INVALID_INSTANCE');
    }
    const record = readJsonIfExists(instanceStatePath(runtimeDir, instanceId));
    if (!record) {
        return { ok: false, found: false };
    }
    const probe = runLauncherCommand(launcher, ['status', '--instance', instanceId]);
    appendLog(instanceLogPath(runtimeDir, instanceId), 'status', { stdout: probe.stdout, stderr: probe.stderr, status: probe.status });
    if (!probe.ok) {
        return { ok: false, found: true, error: probe.stderr || probe.error || `exit ${probe.status}` };
    }
    return { ok: true, found: true, record, status: parseJsonResponse(probe.stdout, 'status') };
}

function stopInstance({ runtimeDir, launcher, instanceId }) {
    if (!validateInstanceId(instanceId)) {
        throw new InstanceError(`instanceId '${instanceId}' is invalid`, 'INVALID_INSTANCE');
    }
    const result = runLauncherCommand(launcher, ['stop', '--instance', instanceId]);
    appendLog(instanceLogPath(runtimeDir, instanceId), 'stop', { stdout: result.stdout, stderr: result.stderr, status: result.status });
    const record = readJsonIfExists(instanceStatePath(runtimeDir, instanceId));
    if (record) {
        record.status = 'stopped';
        record.stoppedAt = new Date().toISOString();
        safeJsonWrite(instanceStatePath(runtimeDir, instanceId), record);
    }
    const active = getActiveInstance(runtimeDir);
    if (active && active.instanceId === instanceId) {
        clearActiveInstance(runtimeDir);
    }
    if (!result.ok) {
        return { ok: false, error: result.stderr || result.error || `exit ${result.status}` };
    }
    return { ok: true, stopped: parseJsonResponse(result.stdout, 'stop') };
}

function readInstanceLogs({ runtimeDir, instanceId, tailBytes = 64 * 1024 }) {
    if (!validateInstanceId(instanceId)) {
        throw new InstanceError(`instanceId '${instanceId}' is invalid`, 'INVALID_INSTANCE');
    }
    const filePath = instanceLogPath(runtimeDir, instanceId);
    if (!fs.existsSync(filePath)) return { ok: true, lines: [] };
    const stat = fs.statSync(filePath);
    const limit = Math.min(tailBytes, stat.size);
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(limit);
        fs.readSync(fd, buf, 0, limit, Math.max(0, stat.size - limit));
        return { ok: true, lines: buf.toString('utf8').split('\n') };
    } finally {
        fs.closeSync(fd);
    }
}

function readRuntimeEnvSummary() {
    return redactEnv(process.env);
}

export {
    DEFAULT_LAUNCHER_CALL_TIMEOUT_MS,
    InstanceError,
    activePointerPath,
    appendLog,
    clearActiveInstance,
    getActiveInstance,
    instanceConfigPath,
    instanceLogPath,
    instanceStatePath,
    prepareInstance,
    readInstanceLogs,
    readJsonIfExists,
    readRuntimeEnvSummary,
    safeJsonWrite,
    sanitizeConfigForDisk,
    setActiveInstance,
    startInstance,
    statusInstance,
    stopInstance,
};
