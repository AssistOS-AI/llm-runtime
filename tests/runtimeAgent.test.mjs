import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    LauncherDescribeError,
    ProfileValidationError,
    validateLauncherName,
    validateAgentModelProfiles,
    validateLauncherDescribe,
} from '../shared/runtime-agent/lib/schemas.mjs';
import { redactEnv, redactString, shouldRedactEnvName } from '../shared/runtime-agent/lib/redaction.mjs';
import {
    applyPriorityOverrides,
    loadProfiles,
    selectCandidate,
} from '../shared/runtime-agent/lib/modelProfiles.mjs';
import {
    discoverAndDescribe,
    discoverLauncherScripts,
} from '../shared/runtime-agent/lib/launcherRegistry.mjs';

test('validateAgentModelProfiles accepts a valid document', () => {
    const doc = {
        schemaVersion: 1,
        profiles: [
            {
                id: 'primary',
                candidates: [
                    { launcher: 'fake-cpu', priority: 100, requiredAccelerators: ['cpu'] },
                ],
            },
        ],
    };
    assert.equal(validateAgentModelProfiles(doc).profiles.length, 1);
});

test('validateAgentModelProfiles rejects unknown launcher reference', () => {
    const doc = {
        schemaVersion: 1,
        profiles: [
            { id: 'primary', candidates: [{ launcher: 'missing' }] },
        ],
    };
    assert.throws(
        () => validateAgentModelProfiles(doc, new Set(['fake-cpu'])),
        (err) => err instanceof ProfileValidationError && /unknown launcher/.test(err.message),
    );
});

test('validateAgentModelProfiles rejects duplicate profile ids', () => {
    const doc = {
        schemaVersion: 1,
        profiles: [
            { id: 'p1', candidates: [{ launcher: 'fake-cpu' }] },
            { id: 'p1', candidates: [{ launcher: 'fake-cpu' }] },
        ],
    };
    assert.throws(() => validateAgentModelProfiles(doc), /duplicate profile id/);
});

test('validateLauncherDescribe rejects unsupported accelerator', () => {
    assert.throws(
        () => validateLauncherDescribe({
            schemaVersion: 1,
            id: 'fake',
            engine: 'fake',
            supportedAccelerators: ['quantum'],
        }),
        (err) => err instanceof LauncherDescribeError && /unsupported/.test(err.message),
    );
});

test('redactEnv replaces named secret values', () => {
    const out = redactEnv({
        HF_TOKEN: 'hf_realtoken123',
        HUGGING_FACE_HUB_TOKEN: 'hf_realtoken456',
        OPENAI_API_TOKEN: 'sk-abcdefghijklmnopqrstuvwxyz',
        PLOINKY_MASTER_KEY: 'master-secret',
        CUSTOM_SERVICE_TOKEN: 'service-token',
        SERVICE_PRIVATE_KEY: 'private-key',
        SAFE_VAR: 'visible',
    });
    assert.equal(out.HF_TOKEN, '[REDACTED]');
    assert.equal(out.HUGGING_FACE_HUB_TOKEN, '[REDACTED]');
    assert.equal(out.OPENAI_API_TOKEN, '[REDACTED]');
    assert.equal(out.PLOINKY_MASTER_KEY, '[REDACTED]');
    assert.equal(out.CUSTOM_SERVICE_TOKEN, '[REDACTED]');
    assert.equal(out.SERVICE_PRIVATE_KEY, '[REDACTED]');
    assert.equal(out.SAFE_VAR, 'visible');
    assert.equal(shouldRedactEnvName('HUGGING_FACE_HUB_TOKEN'), true);
    assert.equal(shouldRedactEnvName('SAFE_VAR'), false);
});

test('redactString replaces inline secret patterns', () => {
    const out = redactString('HF token is hf_abcdefghijklmnopqrstu and openai sk-abcdefghijklmnopqrstu');
    assert.ok(!out.includes('hf_abcdefghijklmnopqrstu'));
    assert.ok(!out.includes('sk-abcdefghijklmnopqrstu'));
});

test('applyPriorityOverrides reorders candidates and rejects unknown launcher in override', () => {
    const doc = loadProfiles({
        schemaVersion: 1,
        profiles: [
            {
                id: 'primary',
                candidates: [
                    { launcher: 'a' },
                    { launcher: 'b' },
                    { launcher: 'c' },
                ],
            },
        ],
    });
    const reordered = applyPriorityOverrides(doc, [{ profileId: 'primary', order: ['c', 'a'] }]);
    assert.deepEqual(reordered.profiles[0].candidates.map((c) => c.launcher), ['c', 'a', 'b']);

    assert.throws(
        () => applyPriorityOverrides(doc, [{ profileId: 'primary', order: ['nonexistent'] }]),
        /unknown launcher/,
    );
});

test('selectCandidate picks first candidate that has all required accelerators', () => {
    const profile = {
        candidates: [
            { launcher: 'nvidia', requiredAccelerators: ['nvidia-cuda'] },
            { launcher: 'cpu', requiredAccelerators: ['cpu'] },
        ],
    };
    const gpu = selectCandidate(profile, { acceleratorFamilies: ['cpu', 'nvidia-cuda'] });
    assert.equal(gpu.launcher, 'nvidia');
    const cpuOnly = selectCandidate(profile, { acceleratorFamilies: ['cpu'] });
    assert.equal(cpuOnly.launcher, 'cpu');
});

test('discoverLauncherScripts finds modelLauncher_*.sh scripts in a directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launchers-'));
    try {
        const sh = path.join(tmp, 'modelLauncher_demo.sh');
        fs.writeFileSync(sh, '#!/bin/sh\nexit 0\n');
        fs.chmodSync(sh, 0o755);
        fs.writeFileSync(path.join(tmp, 'not-a-launcher.txt'), 'ignored');
        const found = discoverLauncherScripts(tmp);
        assert.equal(found.length, 1);
        assert.equal(found[0].id, 'demo');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('launcher names reject dot-only and traversal-like ids', () => {
    assert.equal(validateLauncherName('fake-cpu'), true);
    assert.equal(validateLauncherName('llama.cpp-cpu'), true);
    assert.equal(validateLauncherName('.'), false);
    assert.equal(validateLauncherName('..'), false);
    assert.equal(validateLauncherName('a..b'), false);
    assert.equal(validateLauncherName('a.'), false);
    assert.equal(validateLauncherName('../secret'), false);
});

test('discoverAndDescribe validates the fake-cpu launcher and reports describe metadata', () => {
    const launcherDir = path.resolve(import.meta.dirname, '..', 'base-local', 'launchers');
    const found = discoverAndDescribe(launcherDir);
    const fake = found.find((l) => l.id === 'fake-cpu');
    assert.ok(fake, 'fake-cpu launcher must be discovered');
    assert.ok(fake.ok, `fake-cpu describe must succeed: ${fake.error}`);
    assert.equal(fake.describe.engine, 'fake');
    assert.deepEqual(fake.describe.supportedAccelerators, ['cpu']);

    // The real CPU llama.cpp launcher is also present; its describe block
    // is allowed to succeed (when GGUF/llama-server are absent, only start
    // would fail — describe is independent).
    const llama = found.find((l) => l.id === 'llama-cpp-cpu');
    if (llama && llama.ok) {
        assert.equal(llama.describe.engine, 'llama.cpp');
    }
});

test('real llama.cpp launcher keeps model artifacts out of /runtime', () => {
    const launcherPath = path.resolve(
        import.meta.dirname,
        '..',
        'base-local',
        'launchers',
        'modelLauncher_llama-cpp-cpu.sh',
    );
    const script = fs.readFileSync(launcherPath, 'utf8');
    assert.match(script, /PLOINKY_MODELS_DIR:-\/models\/artifacts/);
    assert.match(script, /HF_HOME:-\/models\/hf-cache/);
    assert.match(script, /PLOINKY_DERIVED_DIR:-\/models\/derived/);
    assert.ok(!script.includes('/runtime/models'), 'model cache must not be stored under runtime state');
    assert.ok(!script.includes('>"$log_file" 2>&1'), 'engine output must not persist raw stdout/stderr by default');
    assert.match(script, />\/dev\/null 2>&1/, 'engine output must be discarded unless a redacted log path is added');
});

test('runtime start wrapper supervises every child service', () => {
    const wrapperPath = path.resolve(
        import.meta.dirname,
        '..',
        'shared',
        'runtime-agent',
        'start-runtime-agent.sh',
    );
    const script = fs.readFileSync(wrapperPath, 'utf8');
    assert.match(script, /^#!\/usr\/bin\/env bash/);
    assert.match(script, /wait -n "\$control_pid" "\$mcp_pid" "\$proxy_pid"/);
    assert.ok(!script.includes('wait "$proxy_pid"'), 'wrapper must not wait only on the public proxy');
});
