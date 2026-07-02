import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    validateLauncherDescribe,
    validateLauncherName,
} from './schemas.mjs';
import { redactString } from './redaction.mjs';

const DEFAULT_LAUNCHER_DESCRIBE_TIMEOUT_MS = 5000;
const MODEL_SECRET_FILE_ENV = 'PLOINKY_MODEL_SECRET_FILE';
const CHILD_MODEL_SECRET_ENV = 'HF_TOKEN';

function readModelSecretToken(env = process.env) {
    const filePath = String(env?.[MODEL_SECRET_FILE_ENV] || '').trim();
    if (!filePath) return '';
    try {
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch (_) {
        return '';
    }
}

function describeChildEnv(baseEnv = process.env) {
    const childEnv = { ...(baseEnv || {}) };
    delete childEnv[MODEL_SECRET_FILE_ENV];
    delete childEnv[CHILD_MODEL_SECRET_ENV];
    return childEnv;
}

function describeRedactionEnv(baseEnv = process.env) {
    const env = { ...(baseEnv || {}) };
    const token = readModelSecretToken(env);
    if (token) {
        env[CHILD_MODEL_SECRET_ENV] = token;
    }
    return env;
}

function discoverLauncherScripts(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) return [];
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch (_) {
        return [];
    }
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = entry.name.match(/^modelLauncher_([a-zA-Z0-9._-]+)\.sh$/);
        if (!match) continue;
        const launcherId = match[1];
        if (!validateLauncherName(launcherId)) continue;
        out.push({
            id: launcherId,
            scriptPath: path.join(rootDir, entry.name),
        });
    }
    return out;
}

function describeLauncher(launcher, options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_LAUNCHER_DESCRIBE_TIMEOUT_MS);
    const baseEnv = options.env || process.env;
    const redactionEnv = describeRedactionEnv(baseEnv);
    let result;
    if (typeof options.run === 'function') {
        result = options.run(launcher);
    } else {
        result = spawnSync(launcher.scriptPath, ['describe'], {
            encoding: 'utf8',
            timeout: timeoutMs,
            env: describeChildEnv(baseEnv),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    if (result.error || result.status !== 0) {
        const message = result.error?.message
            || (result.stderr ? String(result.stderr).slice(0, 256) : `exit code ${result.status}`);
        return { ok: false, error: redactString(message, { env: redactionEnv }) };
    }
    let parsed;
    try {
        parsed = JSON.parse(String(result.stdout || ''));
    } catch (err) {
        return { ok: false, error: redactString(`describe output is not valid JSON: ${err.message}`, { env: redactionEnv }) };
    }
    try {
        const describe = validateLauncherDescribe(parsed);
        if (describe.id !== launcher.id) {
            return {
                ok: false,
                error: redactString(`describe.id '${describe.id}' does not match script id '${launcher.id}'`, { env: redactionEnv }),
            };
        }
        return { ok: true, describe };
    } catch (err) {
        return { ok: false, error: redactString(err.message, { env: redactionEnv }) };
    }
}

function discoverAndDescribe(rootDir, options = {}) {
    const launchers = discoverLauncherScripts(rootDir);
    return launchers.map((launcher) => {
        const described = describeLauncher(launcher, options);
        return { ...launcher, ...described };
    });
}

export {
    DEFAULT_LAUNCHER_DESCRIBE_TIMEOUT_MS,
    describeLauncher,
    discoverAndDescribe,
    discoverLauncherScripts,
};
