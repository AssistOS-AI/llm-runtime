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

function validLauncherDescribe(overrides = {}) {
    return {
        schemaVersion: 1,
        id: 'llamacpp-cpu',
        modelId: 'tiny-test',
        engine: 'llamacpp',
        modelFormat: 'gguf',
        hfRepoId: 'test/tiny',
        hfRevision: 'main',
        modelFiles: ['tiny.gguf'],
        supportedAccelerators: ['cpu'],
        supportedPlatforms: ['linux/amd64'],
        configurableParameters: {
            contextTokens: { type: 'integer', minimum: 1 },
        },
        profiles: {
            primary: { contextTokens: 1024 },
        },
        resourceEstimates: {
            cpu: { memoryMiB: 512 },
        },
        ...overrides,
    };
}

test('validateAgentModelProfiles accepts a valid document', () => {
    const doc = {
        schemaVersion: 1,
        profiles: [
            {
                id: 'primary',
                candidates: [
                    { launcher: 'test-cpu', priority: 100, requiredAccelerators: ['cpu'] },
                ],
            },
        ],
    };
    assert.equal(validateAgentModelProfiles(doc).profiles.length, 1);
});

test('validateAgentModelProfiles accepts an empty package model catalog', () => {
    const doc = {
        schemaVersion: 1,
        profiles: [],
    };
    const parsed = validateAgentModelProfiles(doc);
    assert.deepEqual(parsed.profiles, []);
});

test('validateAgentModelProfiles rejects unknown launcher reference', () => {
    const doc = {
        schemaVersion: 1,
        profiles: [
            { id: 'primary', candidates: [{ launcher: 'missing' }] },
        ],
    };
    assert.throws(
        () => validateAgentModelProfiles(doc, new Set(['test-cpu'])),
        (err) => err instanceof ProfileValidationError && /unknown launcher/.test(err.message),
    );
});

test('validateAgentModelProfiles rejects duplicate profile ids', () => {
    const doc = {
        schemaVersion: 1,
        profiles: [
            { id: 'p1', candidates: [{ launcher: 'test-cpu' }] },
            { id: 'p1', candidates: [{ launcher: 'test-cpu' }] },
        ],
    };
    assert.throws(() => validateAgentModelProfiles(doc), /duplicate profile id/);
});

test('validateAgentModelProfiles rejects non-empty profiles without candidates', () => {
    const doc = {
        schemaVersion: 1,
        profiles: [
            { id: 'primary', candidates: [] },
        ],
    };
    assert.throws(() => validateAgentModelProfiles(doc), /profile 'primary'\.candidates: requires at least 1 item/);
});

test('validateLauncherDescribe rejects unsupported accelerator', () => {
    assert.throws(
        () => validateLauncherDescribe(validLauncherDescribe({ supportedAccelerators: ['quantum'] })),
        (err) => err instanceof LauncherDescribeError && /unsupported/.test(err.message),
    );
});

test('validateLauncherDescribe accepts only supported runtime engines', () => {
    for (const engine of ['llamacpp', 'vllm', 'sglang', 'trtllm', 'openvino']) {
        assert.equal(validateLauncherDescribe(validLauncherDescribe({ engine })).engine, engine);
    }
    assert.throws(
        () => validateLauncherDescribe(validLauncherDescribe({ engine: 'llama.cpp' })),
        (err) => err instanceof LauncherDescribeError && /describe.engine/.test(err.message),
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
    assert.equal(validateLauncherName('test-cpu'), true);
    assert.equal(validateLauncherName('llama.cpp-cpu'), true);
    assert.equal(validateLauncherName('.'), false);
    assert.equal(validateLauncherName('..'), false);
    assert.equal(validateLauncherName('a..b'), false);
    assert.equal(validateLauncherName('a.'), false);
    assert.equal(validateLauncherName('../secret'), false);
});

test('discoverAndDescribe validates a clean launcher describe contract', () => {
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-describe-'));
    try {
        const scriptPath = path.join(launcherDir, 'modelLauncher_llamacpp-cpu.sh');
        fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "describe" ]; then
  cat <<'JSON'
${JSON.stringify(validLauncherDescribe())}
JSON
  exit 0
fi
echo '{}'
`);
        fs.chmodSync(scriptPath, 0o755);

        const found = discoverAndDescribe(launcherDir);
        const launcher = found.find((l) => l.id === 'llamacpp-cpu');
        assert.ok(launcher, 'llamacpp-cpu launcher must be discovered');
        assert.ok(launcher.ok, `llamacpp-cpu describe must succeed: ${launcher.error}`);
        assert.equal(launcher.describe.engine, 'llamacpp');
        assert.equal(launcher.describe.modelFormat, 'gguf');
    } finally {
        fs.rmSync(launcherDir, { recursive: true, force: true });
    }
});

test('runtime MCP service is the single active runtime entrypoint', () => {
    const serverPath = path.resolve(
        import.meta.dirname,
        '..',
        'shared',
        'runtime-agent',
        'mcp-server.mjs',
    );
    const source = fs.readFileSync(serverPath, 'utf8');
    assert.match(source, /createServer/);
    assert.ok(!source.includes('runtime-proxy'));
    assert.ok(!source.includes('runtime-tool'));
    assert.ok(!source.includes('start-runtime-agent'));
});
