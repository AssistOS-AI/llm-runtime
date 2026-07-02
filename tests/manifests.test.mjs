import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { validateAgentModelProfiles } from '../shared/runtime-agent/lib/schemas.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readJson(...segments) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, ...segments), 'utf8'));
}

test('planning-local manifest uses the clean runtime-container port and readiness contract', () => {
    const manifest = readJson('planning-local', 'manifest.json');

    assert.equal(manifest.llmRuntime?.enabled, true);
    assert.notEqual(manifest.workdir, '/code');
    assert.equal(Object.hasOwn(manifest, 'start'), false);
    assert.equal((manifest.env || []).some((entry) => entry?.name === 'HF_TOKEN'), false);
    assert.deepEqual(manifest.profiles?.default?.openPorts, [
        '127.0.0.1:0:9000',
        '127.0.0.1:0:8080',
    ]);
    const defaultProfile = manifest.profiles?.default || {};
    assert.equal(Object.hasOwn(defaultProfile, ['po', 'rts'].join('')), false);
    assert.deepEqual(manifest.readiness, {
        protocol: 'mcp',
    });
    assert.ok(manifest.endpoints?.['agent-card'], 'agent-card endpoint metadata must remain present');
});

test('secondary manifests use openPorts for MCP readiness without legacy profile ports', () => {
    for (const packageName of ['language-detection', 'relevance']) {
        const manifest = readJson(packageName, 'manifest.json');
        const defaultProfile = manifest.profiles?.default || {};

        assert.equal(manifest.llmRuntime?.enabled, true);
        assert.notEqual(manifest.workdir, '/code');
        assert.equal((manifest.env || []).some((entry) => entry?.name === 'HF_TOKEN'), false);
        assert.deepEqual(defaultProfile.openPorts, ['127.0.0.1:0:9000']);
        assert.equal(Object.hasOwn(defaultProfile, ['po', 'rts'].join('')), false);
        assert.equal(Object.hasOwn(manifest, 'start'), false);
        assert.deepEqual(manifest.readiness, {
            protocol: 'mcp',
        });
    }
});

test('planning-local model profiles reference the llama.cpp CPU launcher only', () => {
    const models = readJson('planning-local', 'agent-models.json');
    validateAgentModelProfiles(models, new Set(['llama-cpp-cpu']));

    assert.deepEqual(models.profiles.map((profile) => profile.id), ['primary', 'long-context']);
    for (const profile of models.profiles) {
        assert.deepEqual(profile.candidates, [
            { launcher: 'llama-cpp-cpu', priority: 100, requiredAccelerators: ['cpu'] },
        ]);
    }
});

test('secondary model catalogs allow empty profiles in runtime validation and published schema', () => {
    const schema = readJson('schemas', 'agent-models.schema.json');
    const profileArraySchema = schema.properties?.profiles;
    const candidateArraySchema = profileArraySchema?.items?.properties?.candidates;

    assert.equal(schema.additionalProperties, false);
    assert.equal(profileArraySchema?.type, 'array');
    assert.equal(Object.hasOwn(profileArraySchema, 'minItems'), false);
    assert.equal(candidateArraySchema?.minItems, 1);

    for (const packageName of ['language-detection', 'relevance']) {
        const models = readJson(packageName, 'agent-models.json');
        const parsed = validateAgentModelProfiles(models);

        assert.deepEqual(models.profiles, [], `${packageName} publishes an empty secondary profile catalog`);
        assert.deepEqual(parsed.profiles, []);
    }
});

test('planning-local package contains no active fake launcher', () => {
    const fakeLauncherName = ['modelLauncher', '_fake-cpu.sh'].join('');
    assert.equal(
        fs.existsSync(path.join(repoRoot, 'planning-local', 'launchers', fakeLauncherName)),
        false,
    );
    assert.equal(
        fs.existsSync(path.join(repoRoot, 'planning-local', 'modelLaunchers', 'modelLauncher_llama-cpp-cpu.sh')),
        true,
    );
});
