import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
    DEFAULT_RUNTIME_ENV,
    DEFAULT_RUNTIME_PATHS,
    DEFAULT_RUNTIME_PORTS,
    FORBIDDEN_GENERATION_FIELDS,
    MCP_TOOL_NAMES,
    STARTUP_FIELD_NAMES,
} from '../shared/runtime-agent/lib/runtimeContract.mjs';
import {
    LaunchConfigError,
    normalizeLaunchConfig,
} from '../shared/runtime-agent/lib/launchConfig.mjs';
import {
    LauncherDescribeError,
    validateAgentModelProfiles,
    validateLauncherDescribe,
} from '../shared/runtime-agent/lib/schemas.mjs';

function collectLegacyLauncherMarkerFiles(rootDir) {
    const matches = [];
    const excludedDirectoryNames = new Set(['.git', 'node_modules']);
    const fixturesDir = path.join(rootDir, 'tests', 'fixtures');
    const legacyLauncherPrefix = ['modelLauncher_', 'fak', 'e'].join('');

    function walk(dir) {
        if (dir === fixturesDir) return;

        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (excludedDirectoryNames.has(entry.name) || entryPath === fixturesDir) continue;
                walk(entryPath);
                continue;
            }

            if (entry.isFile() && entry.name.startsWith(legacyLauncherPrefix)) {
                matches.push(path.relative(rootDir, entryPath));
            }
        }
    }

    walk(rootDir);
    return matches.sort();
}

test('runtime contract exposes clean default paths, ports, and tool names', () => {
    assert.deepEqual(DEFAULT_RUNTIME_PATHS, {
        hfHome: '/models/hf-cache',
        modelsDir: '/models/artifacts',
        derivedDir: '/models/derived',
        runtimeDir: '/runtime',
        launchersDir: '/workspace/modelLaunchers',
    });
    assert.deepEqual(DEFAULT_RUNTIME_PORTS, {
        mcp: 9000,
        inference: 8080,
    });
    assert.deepEqual(DEFAULT_RUNTIME_ENV, {
        HF_HOME: '/models/hf-cache',
        PLOINKY_MODELS_DIR: '/models/artifacts',
        PLOINKY_DERIVED_DIR: '/models/derived',
        PLOINKY_RUNTIME_DIR: '/runtime',
        PLOINKY_LAUNCHERS_DIR: '/workspace/modelLaunchers',
        PLOINKY_MCP_PORT: '9000',
        PLOINKY_INFERENCE_PORT: '8080',
    });
    assert.deepEqual(MCP_TOOL_NAMES, [
        'runtime.describe',
        'launchers.list',
        'launchers.describe',
        'launchers.prepare',
        'launchers.start',
        'instance.status',
        'instance.stop',
        'instance.logs',
    ]);
});

test('launch config accepts only startup fields and rejects generation fields', () => {
    const normalized = normalizeLaunchConfig({
        launcherId: 'llamacpp-cpu',
        instanceId: 'inst-primary',
        profile: 'primary',
        contextTokens: 4096,
        concurrency: 2,
        batchTokens: 512,
        prefillChunkTokens: 128,
        acceleratorMemoryFraction: 0.75,
        acceleratorReserveMiB: 1024,
        kvCachePrecision: 'q8_0',
        gpuLayers: 32,
        tensorParallelSize: 1,
        pipelineParallelSize: 1,
        deviceIds: ['0'],
        splitMode: 'layer',
        tensorSplit: [1, 1],
        mainGpu: 0,
        cpuThreads: 8,
        cpuOffloadGiB: 4.5,
        flashAttention: 'auto',
        enableMetrics: false,
    });

    assert.deepEqual(Object.keys(normalized), STARTUP_FIELD_NAMES);
    assert.equal(normalized.launcherId, 'llamacpp-cpu');
    assert.equal(normalized.contextTokens, 4096);
    assert.deepEqual(normalized.deviceIds, ['0']);
    assert.equal(normalized.splitMode, 'layer');
    assert.deepEqual(normalized.tensorSplit, [1, 1]);
    assert.equal(normalized.mainGpu, 0);
    assert.equal(normalized.cpuOffloadGiB, 4.5);
    assert.equal(normalized.flashAttention, 'auto');

    for (const field of FORBIDDEN_GENERATION_FIELDS) {
        assert.throws(
            () => normalizeLaunchConfig({ launcherId: 'llamacpp-cpu', instanceId: 'inst-primary', [field]: true }),
            (err) => err instanceof LaunchConfigError && new RegExp(`forbidden generation field '${field}'`).test(err.message),
            `${field} must be rejected`,
        );
    }

    assert.throws(
        () => normalizeLaunchConfig({ launcher: 'old-field', instanceId: 'inst-primary' }),
        (err) => err instanceof LaunchConfigError && /unknown field 'launcher'/.test(err.message),
    );
    assert.throws(
        () => normalizeLaunchConfig({ launcherId: 'llamacpp-cpu', instanceId: 'inst-primary', parameters: {} }),
        (err) => err instanceof LaunchConfigError && /unknown field 'parameters'/.test(err.message),
    );
});

test('launch config validates explicit startup policy and split controls', () => {
    assert.throws(
        () => normalizeLaunchConfig({
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-primary',
            flashAttention: true,
        }),
        (err) => err instanceof LaunchConfigError && /launch config\.flashAttention: expected one of on, off, auto/.test(err.message),
    );
    assert.throws(
        () => normalizeLaunchConfig({
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-primary',
            splitMode: 'tensor',
        }),
        (err) => err instanceof LaunchConfigError && /launch config\.splitMode: expected one of none, layer, row/.test(err.message),
    );
    assert.throws(
        () => normalizeLaunchConfig({
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-primary',
            tensorSplit: [1, 0],
        }),
        (err) => err instanceof LaunchConfigError && /launch config\.tensorSplit: expected non-empty array of positive numbers/.test(err.message),
    );
    assert.throws(
        () => normalizeLaunchConfig({
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-primary',
            mainGpu: -1,
        }),
        (err) => err instanceof LaunchConfigError && /launch config\.mainGpu: expected non-negative integer/.test(err.message),
    );
    assert.throws(
        () => normalizeLaunchConfig({
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-primary',
            cpuOffloadGiB: -0.5,
        }),
        (err) => err instanceof LaunchConfigError && /launch config\.cpuOffloadGiB: expected non-negative number/.test(err.message),
    );
});

test('launch config rejects duplicate deviceIds without leaking values', () => {
    const duplicateDeviceId = 'secret-device-token';

    assert.throws(
        () => normalizeLaunchConfig({
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-primary',
            deviceIds: [duplicateDeviceId, duplicateDeviceId],
        }),
        (err) => {
            assert.equal(err instanceof LaunchConfigError, true);
            assert.match(err.message, /launch config\.deviceIds: expected unique non-empty strings/);
            assert.equal(err.message.includes(duplicateDeviceId), false);
            return true;
        },
    );

    assert.deepEqual(
        normalizeLaunchConfig({
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-primary',
            deviceIds: ['0', '1'],
        }).deviceIds,
        ['0', '1'],
    );
});

test('launch config rejects kvCachePrecision over 64 characters without leaking values', () => {
    const secretPrecision = `secret-${'x'.repeat(58)}`;

    assert.equal(secretPrecision.length, 65);
    assert.throws(
        () => normalizeLaunchConfig({
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-primary',
            kvCachePrecision: secretPrecision,
        }),
        (err) => {
            assert.equal(err instanceof LaunchConfigError, true);
            assert.match(err.message, /launch config\.kvCachePrecision: expected non-empty string up to 64 characters/);
            assert.equal(err.message.includes(secretPrecision), false);
            return true;
        },
    );

    assert.equal(
        normalizeLaunchConfig({
            launcherId: 'llamacpp-cpu',
            instanceId: 'inst-primary',
            kvCachePrecision: 'x'.repeat(64),
        }).kvCachePrecision,
        'x'.repeat(64),
    );
});

test('launcher describe requires the clean contract and valid engine names', () => {
    const valid = {
        schemaVersion: 1,
        id: 'llamacpp-cpu',
        modelId: 'meta-llama/Llama-3.2-1B-Instruct',
        engine: 'llamacpp',
        modelFormat: 'gguf',
        hfRepoId: 'meta-llama/Llama-3.2-1B-Instruct',
        hfRevision: 'main',
        modelFiles: ['model.gguf'],
        supportedAccelerators: ['cpu'],
        supportedPlatforms: ['linux/amd64'],
        configurableParameters: {
            contextTokens: { type: 'integer', minimum: 1 },
        },
        profiles: {
            primary: { contextTokens: 4096 },
        },
        resourceEstimates: {
            cpu: { memoryMiB: 4096 },
        },
    };

    assert.equal(validateLauncherDescribe(valid), valid);

    for (const engine of ['placeholder', 'llama.cpp', 'transformers']) {
        assert.throws(
            () => validateLauncherDescribe({ ...valid, engine }),
            (err) => err instanceof LauncherDescribeError && /describe.engine/.test(err.message),
        );
    }

    assert.throws(
        () => validateLauncherDescribe({ ...valid, resourceEstimates: undefined }),
        (err) => err instanceof LauncherDescribeError && /describe.resourceEstimates/.test(err.message),
    );

    assert.throws(
        () => {
            const { supportedPlatforms: _supportedPlatforms, ...missingPlatforms } = valid;
            validateLauncherDescribe(missingPlatforms);
        },
        (err) => err instanceof LauncherDescribeError && /describe.supportedPlatforms/.test(err.message),
    );

    assert.throws(
        () => validateLauncherDescribe({ ...valid, supportedPlatforms: [] }),
        (err) => err instanceof LauncherDescribeError && /describe.supportedPlatforms/.test(err.message),
    );
});

test('legacy launcher marker files are confined to tests fixtures', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    assert.deepEqual(collectLegacyLauncherMarkerFiles(repoRoot), []);
});

test('secondary packages without launchers publish empty model catalogs', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');

    for (const packageName of ['language-detection', 'relevance']) {
        const modelsPath = path.join(repoRoot, packageName, 'agent-models.json');
        const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
        const parsed = validateAgentModelProfiles(models);
        assert.deepEqual(parsed.profiles, []);
    }
});

test('active runtime-agent implementation has no old sidecar contract references', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const scanRoot = path.join(repoRoot, 'shared', 'runtime-agent');
    const pattern = [
        'PLOINKY_LLM_PUBLIC_PORT',
        'PLOINKY_LLM_MCP_PORT',
        'PLOINKY_LLM_CONTROL_PORT',
        'PLOINKY_LLM_LAUNCHERS_DIR',
        'runtime-proxy',
        'runtime-tool',
        'start-runtime-agent',
        '9001',
        '9002',
        '/code/launchers',
        '/opt/ploinky/launchers',
    ].join('|');
    let output = '';
    try {
        output = execFileSync('rg', ['-n', pattern, scanRoot], { encoding: 'utf8' });
    } catch (err) {
        if (err.status === 1) return;
        throw err;
    }
    assert.equal(output.trim(), '');
});

test('active package-level runtime config has no old sidecar contract references', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const scanRoots = [
        path.join(repoRoot, 'shared'),
        path.join(repoRoot, 'language-detection'),
        path.join(repoRoot, 'relevance'),
        path.join(repoRoot, 'schemas'),
    ];
    const pattern = [
        'PLOINKY_LLM_PUBLIC_PORT',
        'PLOINKY_LLM_MCP_PORT',
        'PLOINKY_LLM_CONTROL_PORT',
        'PLOINKY_LLM_LAUNCHERS_DIR',
        'runtime-proxy',
        'runtime-tool',
        'start-runtime-agent',
        '9001',
        '9002',
        '/code/launchers',
        '/opt/ploinky/launchers',
    ].join('|');
    let output = '';
    try {
        output = execFileSync('rg', ['-n', pattern, ...scanRoots], { encoding: 'utf8' });
    } catch (err) {
        if (err.status === 1) return;
        throw err;
    }
    assert.equal(output.trim(), '');
});

test('JSON schemas no longer admit generation fields in launch configs', () => {
    const schemaPath = path.resolve(import.meta.dirname, '..', 'schemas', 'launch-config.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    assert.deepEqual(Object.keys(schema.properties), STARTUP_FIELD_NAMES);
    assert.deepEqual(schema.properties.flashAttention, { enum: ['on', 'off', 'auto'] });
    assert.deepEqual(schema.properties.splitMode, { enum: ['none', 'layer', 'row'] });
    assert.deepEqual(schema.properties.tensorSplit, {
        type: 'array',
        items: { type: 'number', exclusiveMinimum: 0 },
        minItems: 1,
    });
    assert.deepEqual(schema.properties.mainGpu, { type: 'integer', minimum: 0 });
    assert.deepEqual(schema.properties.cpuOffloadGiB, { type: 'number', minimum: 0 });
    for (const field of FORBIDDEN_GENERATION_FIELDS) {
        assert.equal(JSON.stringify(schema).includes(`"${field}"`), false, `${field} must not appear`);
    }
});

test('launch config schema rejects whitespace-only deviceIds while preserving unique ids', () => {
    const schemaPath = path.resolve(import.meta.dirname, '..', 'schemas', 'launch-config.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const deviceIdsSchema = schema.properties.deviceIds;
    const deviceIdPattern = new RegExp(deviceIdsSchema.items.pattern);

    assert.equal(deviceIdsSchema.uniqueItems, true);
    assert.equal(deviceIdPattern.test('0'), true);
    assert.equal(deviceIdPattern.test('gpu-0'), true);
    assert.equal(deviceIdPattern.test(' '), false);
    assert.equal(deviceIdPattern.test('\t'), false);
});
