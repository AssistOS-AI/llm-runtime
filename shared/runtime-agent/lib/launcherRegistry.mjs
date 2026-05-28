import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    validateLauncherDescribe,
    validateLauncherName,
} from './schemas.mjs';

const DEFAULT_LAUNCHER_DESCRIBE_TIMEOUT_MS = 5000;

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
    let result;
    if (typeof options.run === 'function') {
        result = options.run(launcher);
    } else {
        result = spawnSync(launcher.scriptPath, ['describe'], {
            encoding: 'utf8',
            timeout: timeoutMs,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    if (result.error || result.status !== 0) {
        const message = result.error?.message
            || (result.stderr ? String(result.stderr).slice(0, 256) : `exit code ${result.status}`);
        return { ok: false, error: message };
    }
    let parsed;
    try {
        parsed = JSON.parse(String(result.stdout || ''));
    } catch (err) {
        return { ok: false, error: `describe output is not valid JSON: ${err.message}` };
    }
    try {
        const describe = validateLauncherDescribe(parsed);
        if (describe.id !== launcher.id) {
            return { ok: false, error: `describe.id '${describe.id}' does not match script id '${launcher.id}'` };
        }
        return { ok: true, describe };
    } catch (err) {
        return { ok: false, error: err.message };
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
