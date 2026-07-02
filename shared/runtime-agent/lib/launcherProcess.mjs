import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { redactEnv, redactObject, redactString } from './redaction.mjs';
import { normalizeLaunchConfig } from './launchConfig.mjs';
import { DEFAULT_RUNTIME_PORTS, STARTUP_FIELD_NAMES } from './runtimeContract.mjs';
import {
    digestArtifactPaths,
    readEngineVersionsLock,
    readSelectedArchitectureIfExists,
    selectedImageTraceability,
} from './runtimeState.mjs';
import {
    INSTANCE_ID_RE,
    validateInstanceId,
    validateLauncherName,
} from './schemas.mjs';

const DEFAULT_LAUNCHER_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_LAUNCHER_PREPARE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_LOG_TAIL_BYTES = 64 * 1024;
const MODEL_SECRET_FILE_ENV = 'PLOINKY_MODEL_SECRET_FILE';
const CHILD_MODEL_SECRET_ENV = 'HF_TOKEN';

function positiveIntegerEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

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

function activeInstanceLockPath(runtimeDir) {
    return path.join(runtimeDir, 'active-instance.lock');
}

function sanitizeConfigForDisk(config) {
    const out = {};
    for (const key of STARTUP_FIELD_NAMES) {
        if (config && Object.prototype.hasOwnProperty.call(config, key)) {
            out[key] = config[key];
        }
    }
    return out;
}

function readJsonIfExists(filePath, options = {}) {
    if (!fs.existsSync(filePath)) return null;
    return redactObject(JSON.parse(fs.readFileSync(filePath, 'utf8')), {
        ...options,
        env: options.env || process.env,
    });
}

function tempFilePath(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return path.join(dir, `.${base}.tmp-${nonce}`);
}

function safeFileWrite(filePath, bytes, mode = 0o600) {
    ensureDir(path.dirname(filePath));
    const tmpPath = tempFilePath(filePath);
    let fd = null;
    let cleanupTmp = false;
    try {
        fd = fs.openSync(tmpPath, 'wx', mode);
        cleanupTmp = true;
        fs.writeFileSync(fd, bytes, { encoding: 'utf8' });
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmpPath, filePath);
        cleanupTmp = false;
        try { fs.chmodSync(filePath, mode); } catch (_) {}
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        if (cleanupTmp) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
        }
    }
}

function safeJsonWrite(filePath, value) {
    safeFileWrite(filePath, `${JSON.stringify(redactObject(value), null, 2)}\n`, 0o600);
}

function appendLog(filePath, label, payload, options = {}) {
    ensureDir(path.dirname(filePath));
    const safe = redactString(typeof payload === 'string' ? payload : JSON.stringify(payload), {
        env: options.env || process.env,
    });
    const line = `[${new Date().toISOString()}] [${label}] ${safe}\n`;
    fs.appendFileSync(filePath, line);
}

function readModelSecretToken(env = process.env) {
    const filePath = String(env?.[MODEL_SECRET_FILE_ENV] || '').trim();
    if (!filePath) return '';
    try {
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch (_) {
        return '';
    }
}

function buildLauncherChildEnv(baseEnv = process.env) {
    const childEnv = { ...(baseEnv || {}) };
    const token = readModelSecretToken(childEnv);
    if (token) {
        childEnv[CHILD_MODEL_SECRET_ENV] = token;
    }
    return childEnv;
}

function runLauncherCommand(launcher, args, options = {}) {
    const childEnv = buildLauncherChildEnv(options.env || process.env);
    const result = spawnSync(launcher.scriptPath, args, {
        encoding: 'utf8',
        timeout: options.timeoutMs || DEFAULT_LAUNCHER_CALL_TIMEOUT_MS,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        ok: !result.error && result.status === 0,
        status: result.status ?? null,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        error: result.error ? result.error.message : null,
        redactionEnv: childEnv,
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

function launcherFailureMessage(result, fallbackStatus) {
    return redactString(result.stderr || result.error || `exit ${fallbackStatus}`, {
        env: result?.redactionEnv || process.env,
    });
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

function parseLockPid(raw) {
    const value = String(raw || '').trim();
    if (!/^[1-9]\d*$/.test(value)) return null;
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? pid : null;
}

function pidIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        if (err && (err.code === 'ESRCH' || err.code === 'EINVAL')) return false;
        return true;
    }
}

function removeStaleActiveInstanceLock(lockPath) {
    let pid = null;
    try {
        pid = parseLockPid(fs.readFileSync(lockPath, 'utf8'));
    } catch (err) {
        if (err && err.code === 'ENOENT') return true;
        return false;
    }
    if (pid === null || pidIsAlive(pid)) return false;
    try {
        fs.unlinkSync(lockPath);
        return true;
    } catch (err) {
        return err && err.code === 'ENOENT';
    }
}

function acquireActiveInstanceLock(runtimeDir) {
    const lockPath = activeInstanceLockPath(runtimeDir);
    ensureDir(path.dirname(lockPath));
    let fd = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            fd = fs.openSync(lockPath, 'wx', 0o600);
            fs.writeFileSync(fd, `${process.pid}\n`, { encoding: 'utf8' });
            return { fd, lockPath };
        } catch (err) {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch (_) {}
                try { fs.unlinkSync(lockPath); } catch (_) {}
            }
            fd = null;
            if (err && err.code === 'EEXIST' && attempt === 0 && removeStaleActiveInstanceLock(lockPath)) {
                continue;
            }
            if (err && err.code === 'EEXIST') {
                throw new InstanceError(`active instance lock is busy: ${lockPath}`, 'INSTANCE_BUSY');
            }
            throw err;
        }
    }
    throw new InstanceError(`active instance lock is busy: ${lockPath}`, 'INSTANCE_BUSY');
}

function releaseActiveInstanceLock(lock) {
    if (!lock) return;
    try { fs.closeSync(lock.fd); } catch (_) {}
    try { fs.unlinkSync(lock.lockPath); } catch (_) {}
}

function prepareInstance({ runtimeDir, launcher, config }) {
    const normalized = normalizeLaunchConfig(config);
    if (!validateLauncherName(normalized.launcherId) || launcher.id !== normalized.launcherId) {
        throw new InstanceError(`launcherId '${normalized.launcherId}' is invalid`, 'INVALID_LAUNCHER');
    }
    if (!validateInstanceId(normalized.instanceId)) {
        throw new InstanceError(`instanceId '${normalized.instanceId}' does not match ${INSTANCE_ID_RE}`, 'INVALID_INSTANCE');
    }
    const sanitized = sanitizeConfigForDisk(normalized);
    const configPath = instanceConfigPath(runtimeDir, sanitized.instanceId);
    safeJsonWrite(configPath, sanitized);
    const logPath = instanceLogPath(runtimeDir, sanitized.instanceId);
    const result = runLauncherCommand(launcher, ['prepare', '--config', configPath], {
        timeoutMs: positiveIntegerEnv('PLOINKY_LAUNCHER_PREPARE_TIMEOUT_MS', DEFAULT_LAUNCHER_PREPARE_TIMEOUT_MS),
    });
    appendLog(logPath, 'prepare', { stdout: result.stdout, stderr: result.stderr, status: result.status }, { env: result.redactionEnv });
    if (!result.ok) {
        throw new InstanceError(`launcher prepare failed: ${launcherFailureMessage(result, result.status)}`, 'PREPARE_FAILED');
    }
    return redactObject(parseJsonResponse(result.stdout, 'prepare'), { env: result.redactionEnv });
}

function normalizeArtifactPaths(parsed) {
    const candidateGroups = [
        Array.isArray(parsed?.artifactPaths) ? parsed.artifactPaths : [],
        [parsed?.artifactPath],
        [parsed?.modelPath],
        Array.isArray(parsed?.artifacts)
            ? parsed.artifacts.map((entry) => typeof entry === 'string' ? entry : entry?.path)
            : [],
    ];
    for (const group of candidateGroups) {
        const existing = group
            .filter((entry) => typeof entry === 'string' && entry)
            .filter((entry) => fs.existsSync(entry));
        if (existing.length) return existing;
    }
    return [];
}

function instancePid(parsed) {
    return Number.isInteger(parsed?.pid) ? parsed.pid
        : Number.isInteger(parsed?.process?.pid) ? parsed.process.pid
        : null;
}

function instancePort(parsed) {
    return Number.isInteger(parsed?.port) ? parsed.port
        : Number.isInteger(parsed?.engine?.port) ? parsed.engine.port
        : DEFAULT_RUNTIME_PORTS.inference;
}

function instanceHealth(parsed) {
    if (parsed?.health && typeof parsed.health === 'object' && !Array.isArray(parsed.health)) {
        return parsed.health;
    }
    if (typeof parsed?.status === 'string') return { status: parsed.status };
    return { status: 'unknown' };
}

function buildInstanceStateRecord({
    runtimeDir,
    launcher,
    sanitized,
    configPath,
    parsed,
    startedAt,
    engineVersionsPath,
    artifactDigestOptions,
}) {
    const describe = launcher.describe || {};
    const artifactPaths = normalizeArtifactPaths(parsed);
    const selectedArchitecture = readSelectedArchitectureIfExists(runtimeDir);
    const { imageRef, imageDigest } = selectedImageTraceability(selectedArchitecture);
    return redactObject({
        instanceId: sanitized.instanceId,
        launcherId: launcher.id,
        scriptPath: launcher.scriptPath,
        engine: describe.engine || null,
        modelId: describe.modelId || null,
        hfRepoId: describe.hfRepoId || null,
        hfRevision: describe.hfRevision || null,
        modelFiles: Array.isArray(describe.modelFiles) ? [...describe.modelFiles] : [],
        artifactPaths,
        artifactDigests: digestArtifactPaths(artifactPaths, artifactDigestOptions),
        imageRef,
        imageDigest,
        engineVersions: readEngineVersionsLock({
            engineVersionsPath,
            engine: describe.engine || null,
        }),
        launchConfigPath: configPath,
        pid: instancePid(parsed),
        port: instancePort(parsed),
        startedAt,
        health: instanceHealth(parsed),
        status: 'running',
        launcherStart: parsed,
    });
}

function startInstance({ runtimeDir, launcher, config, engineVersionsPath, artifactDigestOptions } = {}) {
    const normalized = normalizeLaunchConfig(config);
    if (launcher.id !== normalized.launcherId) {
        throw new InstanceError(`launcherId '${normalized.launcherId}' does not match script id`, 'INVALID_LAUNCHER');
    }
    if (!validateInstanceId(normalized.instanceId)) {
        throw new InstanceError(`instanceId '${normalized.instanceId}' is invalid`, 'INVALID_INSTANCE');
    }
    const activeLock = acquireActiveInstanceLock(runtimeDir);
    try {
        return startInstanceWithActiveLock({
            runtimeDir,
            launcher,
            normalized,
            engineVersionsPath,
            artifactDigestOptions,
        });
    } finally {
        releaseActiveInstanceLock(activeLock);
    }
}

function startInstanceWithActiveLock({ runtimeDir, launcher, normalized, engineVersionsPath, artifactDigestOptions }) {
    const active = getActiveInstance(runtimeDir);
    if (active && active.launcherId === normalized.launcherId && active.instanceId === normalized.instanceId) {
        const probe = statusInstance({ runtimeDir, launcher, instanceId: normalized.instanceId });
        if (probe.ok && probe.status?.status === 'running') {
            return { ok: true, reused: true, instanceId: normalized.instanceId, launcherId: normalized.launcherId };
        }
        clearActiveInstance(runtimeDir);
    }
    if (active) {
        stopInstance({ runtimeDir, launcher: { id: active.launcherId, scriptPath: active.scriptPath }, instanceId: active.instanceId });
    }
    const sanitized = sanitizeConfigForDisk(normalized);
    const configPath = instanceConfigPath(runtimeDir, sanitized.instanceId);
    safeJsonWrite(configPath, sanitized);
    const logPath = instanceLogPath(runtimeDir, sanitized.instanceId);
    const result = runLauncherCommand(launcher, ['start', '--config', configPath]);
    appendLog(logPath, 'start', { stdout: result.stdout, stderr: result.stderr, status: result.status }, { env: result.redactionEnv });
    if (!result.ok) {
        throw new InstanceError(`launcher start failed: ${launcherFailureMessage(result, result.status)}`, 'START_FAILED');
    }
    const parsed = redactObject(parseJsonResponse(result.stdout, 'start'), { env: result.redactionEnv });
    const startedAt = new Date().toISOString();
    const stateRecord = buildInstanceStateRecord({
        runtimeDir,
        launcher,
        sanitized,
        configPath,
        parsed,
        startedAt,
        engineVersionsPath,
        artifactDigestOptions,
    });
    safeJsonWrite(instanceStatePath(runtimeDir, sanitized.instanceId), stateRecord);
    setActiveInstance(runtimeDir, {
        instanceId: sanitized.instanceId,
        launcherId: launcher.id,
        scriptPath: launcher.scriptPath,
        startedAt,
    });
    return { ok: true, reused: false, instanceId: sanitized.instanceId, launcherId: launcher.id, launcherStart: parsed };
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
    appendLog(instanceLogPath(runtimeDir, instanceId), 'status', { stdout: probe.stdout, stderr: probe.stderr, status: probe.status }, { env: probe.redactionEnv });
    if (!probe.ok) {
        return { ok: false, found: true, error: launcherFailureMessage(probe, probe.status) };
    }
    return redactObject({ ok: true, found: true, record, status: parseJsonResponse(probe.stdout, 'status') }, { env: probe.redactionEnv });
}

function stopInstance({ runtimeDir, launcher, instanceId }) {
    if (!validateInstanceId(instanceId)) {
        throw new InstanceError(`instanceId '${instanceId}' is invalid`, 'INVALID_INSTANCE');
    }
    const statePath = instanceStatePath(runtimeDir, instanceId);
    const preservedRecord = readJsonIfExists(statePath);
    const result = runLauncherCommand(launcher, ['stop', '--instance', instanceId]);
    appendLog(instanceLogPath(runtimeDir, instanceId), 'stop', { stdout: result.stdout, stderr: result.stderr, status: result.status }, { env: result.redactionEnv });
    let stopped = null;
    let parseError = null;
    if (result.ok) {
        try {
            stopped = redactObject(parseJsonResponse(result.stdout, 'stop'), { env: result.redactionEnv });
        } catch (err) {
            parseError = err;
        }
    }
    const record = redactObject(
        preservedRecord || readJsonIfExists(statePath, { env: result.redactionEnv }),
        { env: result.redactionEnv },
    );
    if (record) {
        record.status = 'stopped';
        record.stoppedAt = new Date().toISOString();
        if (stopped !== null) {
            record.launcherStop = stopped;
        }
        safeJsonWrite(statePath, record);
    }
    const active = getActiveInstance(runtimeDir);
    if (active && active.instanceId === instanceId) {
        clearActiveInstance(runtimeDir);
    }
    if (!result.ok) {
        return { ok: false, error: launcherFailureMessage(result, result.status) };
    }
    if (parseError) {
        throw parseError;
    }
    return redactObject({ ok: true, stopped });
}

function boundedTailBytes(tailBytes) {
    const parsed = Number(tailBytes);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOG_TAIL_BYTES;
    return Math.min(Math.trunc(parsed), DEFAULT_LOG_TAIL_BYTES);
}

function readInstanceLogs({ runtimeDir, instanceId, tailBytes = DEFAULT_LOG_TAIL_BYTES }) {
    if (!validateInstanceId(instanceId)) {
        throw new InstanceError(`instanceId '${instanceId}' is invalid`, 'INVALID_INSTANCE');
    }
    const filePath = instanceLogPath(runtimeDir, instanceId);
    if (!fs.existsSync(filePath)) return { ok: true, lines: [] };
    const stat = fs.statSync(filePath);
    const limit = Math.min(boundedTailBytes(tailBytes), stat.size);
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(limit);
        fs.readSync(fd, buf, 0, limit, Math.max(0, stat.size - limit));
        return { ok: true, lines: redactString(buf.toString('utf8')).split('\n') };
    } finally {
        fs.closeSync(fd);
    }
}

function readRuntimeEnvSummary() {
    return redactEnv(process.env);
}

export {
    DEFAULT_LAUNCHER_CALL_TIMEOUT_MS,
    DEFAULT_LAUNCHER_PREPARE_TIMEOUT_MS,
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
