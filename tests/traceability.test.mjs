import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
    DEFAULT_ENGINE_VERSIONS_LOCK_PATH,
    digestArtifactPath,
    readEngineVersionsLock,
} from '../shared/runtime-agent/lib/runtimeState.mjs';
import {
    instanceConfigPath,
    instanceLogPath,
    instanceStatePath,
    startInstance,
} from '../shared/runtime-agent/lib/launcherProcess.mjs';

const HF_TOKEN_VALUE = 'plain-hf-token-from-env';
const HF_TOKEN_LOOKING_VALUE = 'hf_FAKE1234567890SECRET';
const AUTH_HEADER_VALUE = `Authorization: Bearer ${HF_TOKEN_LOOKING_VALUE}`;
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function waitForListen(server) {
    return new Promise((resolve) => server.on('listening', () => resolve(server)));
}

function request(server, urlPath, options = {}) {
    return new Promise((resolve, reject) => {
        const { port } = server.address();
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: options.method || 'GET',
            path: urlPath,
            headers: options.headers || (options.body ? { 'Content-Type': 'application/json' } : {}),
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, body, json: JSON.parse(body) });
            });
        });
        req.on('error', reject);
        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

function mcpTool(server, name, input = {}) {
    return request(server, '/mcp', {
        method: 'POST',
        body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: input },
        },
    });
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSelectedArchitecture(runtimeDir) {
    writeJson(path.join(runtimeDir, 'selected-architecture.json'), {
        schemaVersion: 1,
        architecture: {
            id: 'cpu-amd64',
            imageRef: 'assistos/llm-runtime:cpu-amd64',
            imageDigest: IMAGE_DIGEST,
        },
        env: {
            HF_TOKEN: HF_TOKEN_VALUE,
            PLOINKY_MASTER_KEY: 'master-key-value',
        },
        diagnostic: AUTH_HEADER_VALUE,
    });
}

function writeEngineVersionsLock(filePath) {
    writeJson(filePath, {
        schemaVersion: 1,
        image: {
            ref: 'assistos/llm-runtime:cpu-amd64',
            digest: IMAGE_DIGEST,
        },
        runtime: {
            node: '22.0.0',
            env: {
                PATH: '/usr/local/bin:/usr/bin',
            },
            arbitraryNote: 'runtime note must not be copied',
        },
        engines: {
            llamacpp: {
                version: 'b4389',
                commit: 'abc123',
                secretNote: 'engine note must not be copied',
                env: {
                    NORMAL_ENV: 'visible but not traceability',
                },
            },
            vllm: {
                version: '0.9.1',
            },
        },
        env: {
            HF_TOKEN: HF_TOKEN_VALUE,
        },
    });
}

function writeFlatEngineVersionsLock(filePath) {
    writeJson(filePath, {
        schemaVersion: 1,
        imageId: 'llm-runtime-cpu',
        platform: 'linux/amd64,linux/arm64',
        supportedEngines: ['llamacpp-cpu', 'trtllm', 'openvino-model-server'],
        lockfilePath: '/opt/ploinky/engineVersions.lock.json',
        llamaCppCommit: 'b6412',
        tensorRtLlmVersion: '0.20.0',
        openvinoModelServerVersion: '2025.2',
        pythonVersion: '3.11',
        env: {
            HF_TOKEN: HF_TOKEN_VALUE,
        },
        buildNotes: AUTH_HEADER_VALUE,
    });
}

function writeArtifactFixtures(rootDir) {
    const filePath = path.join(rootDir, 'model.gguf');
    fs.writeFileSync(filePath, 'model-bytes');
    fs.utimesSync(filePath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const dirPath = path.join(rootDir, 'derived');
    fs.mkdirSync(path.join(dirPath, 'nested'), { recursive: true });
    const first = path.join(dirPath, 'a.bin');
    const second = path.join(dirPath, 'nested', 'b.bin');
    fs.writeFileSync(first, 'alpha');
    fs.writeFileSync(second, 'bravo');
    for (const filePathInDir of [first, second]) {
        fs.utimesSync(filePathInDir, new Date('2026-02-03T04:05:06Z'), new Date('2026-02-03T04:05:06Z'));
    }

    return { filePath, dirPath };
}

function writeTraceableLauncherScript(dir, artifactPaths) {
    const scriptPath = path.join(dir, 'modelLauncher_llamacpp-cpu.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  start)
    node -e 'process.stdout.write(JSON.stringify({
      pid: 4242,
      port: 8080,
      health: { status: "healthy", detail: "ready" },
      artifactPaths: ${JSON.stringify(artifactPaths)},
      commandSummary: "llama-server --header ${AUTH_HEADER_VALUE}",
      env: { HF_TOKEN: "${HF_TOKEN_VALUE}", TOKEN_LIKE: "${HF_TOKEN_LOOKING_VALUE}" }
    }))'
    ;;
  status)
    echo '{"status":"running","pid":4242,"port":8080,"health":{"status":"healthy"}}'
    ;;
  stop)
    echo '{"stopped":true}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    fs.chmodSync(scriptPath, 0o755);
    return {
        id: 'llamacpp-cpu',
        scriptPath,
        describe: {
            schemaVersion: 1,
            id: 'llamacpp-cpu',
            modelId: 'planning-local-qwen2.5-0.5b-instruct',
            engine: 'llamacpp',
            modelFormat: 'gguf',
            hfRepoId: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
            hfRevision: 'df5bf01389a39c743ab467d734bf501681e041c5',
            modelFiles: ['qwen2.5-0.5b-instruct-q4_k_m.gguf'],
            supportedAccelerators: ['cpu'],
            supportedPlatforms: ['linux/amd64'],
            configurableParameters: {},
            profiles: { primary: {} },
            resourceEstimates: { cpu: { memoryMiB: 512 } },
        },
    };
}

function writeModelPathLauncherScript(dir, modelPath) {
    const scriptPath = path.join(dir, 'modelLauncher_llamacpp-cpu.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  start)
    node -e 'process.stdout.write(JSON.stringify({
      pid: 4243,
      port: 8081,
      health: { status: "healthy" },
      modelPath: ${JSON.stringify(modelPath)}
    }))'
    ;;
  status)
    echo '{"status":"running","pid":4243,"port":8081,"health":{"status":"healthy"}}'
    ;;
  stop)
    echo '{"stopped":true}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    fs.chmodSync(scriptPath, 0o755);
    return {
        id: 'llamacpp-cpu',
        scriptPath,
        describe: {
            schemaVersion: 1,
            id: 'llamacpp-cpu',
            engine: 'llamacpp',
        },
    };
}

function writeInvalidArtifactPathsModelPathLauncherScript(dir, modelPath) {
    const scriptPath = path.join(dir, 'modelLauncher_llamacpp-cpu.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  start)
    node -e 'process.stdout.write(JSON.stringify({
      pid: 4244,
      port: 8082,
      health: { status: "healthy" },
      artifactPaths: [null, "", 42],
      modelPath: ${JSON.stringify(modelPath)}
    }))'
    ;;
  status)
    echo '{"status":"running","pid":4244,"port":8082,"health":{"status":"healthy"}}'
    ;;
  stop)
    echo '{"stopped":true}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    fs.chmodSync(scriptPath, 0o755);
    return {
        id: 'llamacpp-cpu',
        scriptPath,
        describe: {
            schemaVersion: 1,
            id: 'llamacpp-cpu',
            engine: 'llamacpp',
        },
    };
}

function writeStaleArtifactPathsModelPathLauncherScript(dir, stalePath, modelPath) {
    const scriptPath = path.join(dir, 'modelLauncher_llamacpp-cpu.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  start)
    node -e 'process.stdout.write(JSON.stringify({
      pid: 4245,
      port: 8083,
      health: { status: "healthy" },
      artifactPaths: [${JSON.stringify(stalePath)}],
      modelPath: ${JSON.stringify(modelPath)}
    }))'
    ;;
  status)
    echo '{"status":"running","pid":4245,"port":8083,"health":{"status":"healthy"}}'
    ;;
  stop)
    echo '{"stopped":true}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    fs.chmodSync(scriptPath, 0o755);
    return {
        id: 'llamacpp-cpu',
        scriptPath,
        describe: {
            schemaVersion: 1,
            id: 'llamacpp-cpu',
            engine: 'llamacpp',
        },
    };
}

async function withSecretEnv(fn) {
    const previous = process.env.HF_TOKEN;
    process.env.HF_TOKEN = HF_TOKEN_VALUE;
    try {
        return await fn();
    } finally {
        if (previous === undefined) {
            delete process.env.HF_TOKEN;
        } else {
            process.env.HF_TOKEN = previous;
        }
    }
}

test('started instances record traceability fields with redacted state and injected engine lock path', () => withSecretEnv(() => {
    assert.equal(DEFAULT_ENGINE_VERSIONS_LOCK_PATH, '/opt/ploinky/engineVersions.lock.json');

    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-traceability-'));
    try {
        writeSelectedArchitecture(runtimeDir);
        const engineVersionsPath = path.join(runtimeDir, 'engineVersions.lock.json');
        writeEngineVersionsLock(engineVersionsPath);
        const artifactRoot = path.join(runtimeDir, 'artifacts');
        fs.mkdirSync(artifactRoot, { recursive: true });
        const { filePath, dirPath } = writeArtifactFixtures(artifactRoot);
        const launcher = writeTraceableLauncherScript(runtimeDir, [filePath, dirPath]);

        const result = startInstance({
            runtimeDir,
            launcher,
            engineVersionsPath,
            artifactDigestOptions: {
                directoryManifestThresholdBytes: 1,
                maxHashedDirectoryFiles: 1,
            },
            config: {
                launcherId: 'llamacpp-cpu',
                instanceId: 'trace-primary',
                contextTokens: 2048,
            },
        });

        assert.equal(result.ok, true);
        const recordPath = instanceStatePath(runtimeDir, 'trace-primary');
        const recordBytes = fs.readFileSync(recordPath, 'utf8');
        for (const secret of ['HF_TOKEN', HF_TOKEN_VALUE, HF_TOKEN_LOOKING_VALUE, AUTH_HEADER_VALUE]) {
            assert.equal(recordBytes.includes(secret), false, `state leaked ${secret}`);
        }

        const record = JSON.parse(recordBytes);
        for (const field of [
            'instanceId',
            'launcherId',
            'engine',
            'modelId',
            'hfRepoId',
            'hfRevision',
            'modelFiles',
            'artifactPaths',
            'artifactDigests',
            'imageRef',
            'imageDigest',
            'engineVersions',
            'launchConfigPath',
            'pid',
            'port',
            'startedAt',
            'health',
        ]) {
            assert.equal(Object.hasOwn(record, field), true, `missing ${field}`);
        }

        assert.equal(record.engine, 'llamacpp');
        assert.equal(record.modelId, 'planning-local-qwen2.5-0.5b-instruct');
        assert.equal(record.hfRepoId, 'Qwen/Qwen2.5-0.5B-Instruct-GGUF');
        assert.equal(record.hfRevision, 'df5bf01389a39c743ab467d734bf501681e041c5');
        assert.deepEqual(record.modelFiles, ['qwen2.5-0.5b-instruct-q4_k_m.gguf']);
        assert.deepEqual(record.artifactPaths, [filePath, dirPath]);
        assert.equal(record.imageRef, 'assistos/llm-runtime:cpu-amd64');
        assert.equal(record.imageDigest, IMAGE_DIGEST);
        assert.equal(record.launchConfigPath, instanceConfigPath(runtimeDir, 'trace-primary'));
        assert.equal(record.pid, 4242);
        assert.equal(record.port, 8080);
        assert.equal(record.health.status, 'healthy');
        assert.match(record.startedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.deepEqual(record.engineVersions, {
            schemaVersion: 1,
            image: {
                ref: 'assistos/llm-runtime:cpu-amd64',
                digest: IMAGE_DIGEST,
            },
            runtime: {
                node: '22.0.0',
            },
            engines: {
                llamacpp: {
                    version: 'b4389',
                    commit: 'abc123',
                },
            },
        });
        const engineVersionsBytes = JSON.stringify(record.engineVersions);
        for (const rejected of ['arbitraryNote', 'secretNote', 'NORMAL_ENV', 'PATH']) {
            assert.equal(engineVersionsBytes.includes(rejected), false, `nested lock traceability leaked ${rejected}`);
        }

        assert.equal(record.artifactDigests[filePath].type, 'file');
        assert.equal(record.artifactDigests[filePath].sha256, sha256('model-bytes'));
        assert.equal(record.artifactDigests[dirPath].type, 'directory-manifest');
        assert.equal(record.artifactDigests[dirPath].fileCount, 2);
        assert.deepEqual(
            record.artifactDigests[dirPath].manifest.map((entry) => entry.path),
            ['a.bin', 'nested/b.bin'],
        );
        assert.equal(record.artifactDigests[dirPath].manifest[0].sha256, sha256('alpha'));
        assert.equal(Object.hasOwn(record.artifactDigests[dirPath].manifest[1], 'sha256'), false);

        if (process.platform !== 'win32') {
            assert.equal((fs.statSync(instanceConfigPath(runtimeDir, 'trace-primary')).mode & 0o777), 0o600);
        }
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
}));

test('launcher modelPath output is traced as an artifact with a digest', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-model-path-artifact-'));
    try {
        const artifactRoot = path.join(runtimeDir, 'artifacts');
        fs.mkdirSync(artifactRoot, { recursive: true });
        const { filePath } = writeArtifactFixtures(artifactRoot);
        const launcher = writeModelPathLauncherScript(runtimeDir, filePath);

        const result = startInstance({
            runtimeDir,
            launcher,
            config: {
                launcherId: 'llamacpp-cpu',
                instanceId: 'trace-model-path',
            },
        });

        assert.equal(result.ok, true);
        const record = JSON.parse(fs.readFileSync(instanceStatePath(runtimeDir, 'trace-model-path'), 'utf8'));
        assert.deepEqual(record.artifactPaths, [filePath]);
        assert.equal(record.artifactDigests[filePath].type, 'file');
        assert.equal(record.artifactDigests[filePath].sha256, sha256('model-bytes'));
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('launcher modelPath output is used when artifactPaths filters to empty', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-model-path-fallback-'));
    try {
        const artifactRoot = path.join(runtimeDir, 'artifacts');
        fs.mkdirSync(artifactRoot, { recursive: true });
        const { filePath } = writeArtifactFixtures(artifactRoot);
        const launcher = writeInvalidArtifactPathsModelPathLauncherScript(runtimeDir, filePath);

        const result = startInstance({
            runtimeDir,
            launcher,
            config: {
                launcherId: 'llamacpp-cpu',
                instanceId: 'trace-model-path-fallback',
            },
        });

        assert.equal(result.ok, true);
        const record = JSON.parse(fs.readFileSync(instanceStatePath(runtimeDir, 'trace-model-path-fallback'), 'utf8'));
        assert.deepEqual(record.artifactPaths, [filePath]);
        assert.equal(record.artifactDigests[filePath].type, 'file');
        assert.equal(record.artifactDigests[filePath].sha256, sha256('model-bytes'));
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('launcher modelPath output is used when artifactPaths contains only stale paths', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-model-path-stale-fallback-'));
    try {
        const artifactRoot = path.join(runtimeDir, 'artifacts');
        fs.mkdirSync(artifactRoot, { recursive: true });
        const { filePath } = writeArtifactFixtures(artifactRoot);
        const stalePath = path.join(runtimeDir, 'missing', 'model.gguf');
        const launcher = writeStaleArtifactPathsModelPathLauncherScript(runtimeDir, stalePath, filePath);

        const result = startInstance({
            runtimeDir,
            launcher,
            config: {
                launcherId: 'llamacpp-cpu',
                instanceId: 'trace-model-path-stale-fallback',
            },
        });

        assert.equal(result.ok, true);
        const record = JSON.parse(fs.readFileSync(instanceStatePath(runtimeDir, 'trace-model-path-stale-fallback'), 'utf8'));
        assert.deepEqual(record.artifactPaths, [filePath]);
        assert.equal(Object.hasOwn(record.artifactDigests, stalePath), false);
        assert.equal(record.artifactDigests[filePath].type, 'file');
        assert.equal(record.artifactDigests[filePath].sha256, sha256('model-bytes'));
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('directory artifact manifests are capped with deterministic truncation metadata', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-large-manifest-'));
    try {
        const dirPath = path.join(runtimeDir, 'derived');
        fs.mkdirSync(dirPath, { recursive: true });
        for (let index = 0; index < 5; index += 1) {
            const filePath = path.join(dirPath, `${String(index).padStart(3, '0')}.bin`);
            fs.writeFileSync(filePath, `payload-${index}`);
            fs.utimesSync(filePath, new Date('2026-03-04T05:06:07Z'), new Date('2026-03-04T05:06:07Z'));
        }

        const digest = digestArtifactPath(dirPath, {
            maxDirectoryManifestEntries: 3,
            maxHashedDirectoryFiles: 2,
        });

        assert.equal(digest.type, 'directory-manifest');
        assert.equal(digest.truncated, true);
        assert.equal(digest.maxManifestEntries, 3);
        assert.equal(digest.manifestEntryCount, 3);
        assert.equal(digest.visitedFileCount, 4);
        assert.equal(digest.fileCount, 4);
        assert.deepEqual(
            digest.manifest.map((entry) => entry.path),
            ['000.bin', '001.bin', '002.bin'],
        );
        assert.equal(digest.manifest[0].sha256, sha256('payload-0'));
        assert.equal(digest.manifest[1].sha256, sha256('payload-1'));
        assert.equal(Object.hasOwn(digest.manifest[2], 'sha256'), false);
        assert.equal(JSON.stringify(digest).includes('004.bin'), false);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('directory artifact manifest cap zero refuses deep traversal', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cap-zero-manifest-'));
    try {
        const dirPath = path.join(runtimeDir, 'derived');
        const deepPath = path.join(dirPath, 'a', 'b', 'c');
        fs.mkdirSync(deepPath, { recursive: true });
        fs.writeFileSync(path.join(deepPath, 'model.bin'), 'deep-payload');

        const digest = digestArtifactPath(dirPath, {
            maxDirectoryManifestEntries: 0,
        });

        assert.equal(digest.type, 'directory-manifest');
        assert.equal(digest.truncated, true);
        assert.equal(digest.manifestEntryCount, 0);
        assert.equal(digest.visitedDirectoryCount, 1);
        assert.equal(digest.visitedEntryCount, 0);
        assert.equal(digest.visitedFileCount, 0);
        assert.deepEqual(digest.truncationReasons, ['manifest-entry-cap']);
        assert.deepEqual(digest.manifest, []);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('directory artifact manifest traversal depth zero does not descend into child directories', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-depth-zero-manifest-'));
    try {
        const dirPath = path.join(runtimeDir, 'derived');
        const deepPath = path.join(dirPath, 'nested', 'deep');
        fs.mkdirSync(deepPath, { recursive: true });
        fs.writeFileSync(path.join(dirPath, 'root.bin'), 'root-payload');
        fs.writeFileSync(path.join(deepPath, 'model.bin'), 'deep-payload');

        const digest = digestArtifactPath(dirPath, {
            maxDirectoryTraversalDepth: 0,
            maxDirectoryManifestEntries: 10,
            maxDirectoryReadEntries: 10,
        });

        assert.equal(digest.type, 'directory-manifest');
        assert.equal(digest.truncated, true);
        assert.equal(digest.visitedDirectoryCount, 1);
        assert.equal(digest.visitedEntryCount, 2);
        assert.equal(digest.visitedFileCount, 1);
        assert.deepEqual(digest.truncationReasons, ['max-traversal-depth']);
        assert.deepEqual(
            digest.manifest.map((entry) => entry.path),
            ['root.bin'],
        );
        assert.equal(JSON.stringify(digest).includes('model.bin'), false);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('directory artifact manifest read entry cap zero does not enumerate directory entries', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-read-zero-manifest-'));
    try {
        const dirPath = path.join(runtimeDir, 'derived');
        fs.mkdirSync(path.join(dirPath, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(dirPath, 'root.bin'), 'root-payload');
        fs.writeFileSync(path.join(dirPath, 'nested', 'model.bin'), 'deep-payload');

        const digest = digestArtifactPath(dirPath, {
            maxDirectoryReadEntries: 0,
            maxDirectoryManifestEntries: 10,
            maxDirectoryTraversalDepth: 10,
        });

        assert.equal(digest.type, 'directory-manifest');
        assert.equal(digest.truncated, true);
        assert.equal(digest.visitedDirectoryCount, 1);
        assert.equal(digest.visitedEntryCount, 0);
        assert.equal(digest.visitedFileCount, 0);
        assert.deepEqual(digest.truncationReasons, ['directory-entry-read-cap']);
        assert.deepEqual(digest.manifest, []);
        assert.equal(JSON.stringify(digest).includes('root.bin'), false);
        assert.equal(JSON.stringify(digest).includes('model.bin'), false);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('flat production engine lockfiles preserve safe image and engine version fields', () => withSecretEnv(() => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-flat-lock-'));
    try {
        const engineVersionsPath = path.join(runtimeDir, 'engineVersions.lock.json');
        writeFlatEngineVersionsLock(engineVersionsPath);

        const engineVersions = readEngineVersionsLock({
            engineVersionsPath,
            engine: 'llamacpp',
        });
        assert.deepEqual(engineVersions, {
            schemaVersion: 1,
            imageId: 'llm-runtime-cpu',
            platform: 'linux/amd64,linux/arm64',
            supportedEngines: ['llamacpp-cpu', 'trtllm', 'openvino-model-server'],
            lockfilePath: '/opt/ploinky/engineVersions.lock.json',
            llamaCppCommit: 'b6412',
            tensorRtLlmVersion: '0.20.0',
            openvinoModelServerVersion: '2025.2',
            pythonVersion: '3.11',
        });

        const serialized = JSON.stringify(engineVersions);
        for (const secret of ['HF_TOKEN', HF_TOKEN_VALUE, HF_TOKEN_LOOKING_VALUE, AUTH_HEADER_VALUE, 'buildNotes']) {
            assert.equal(serialized.includes(secret), false, `flat lock traceability leaked ${secret}`);
        }
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
}));

test('nested engine lockfiles drop object-valued schemaVersion', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-nested-schema-version-'));
    try {
        const engineVersionsPath = path.join(runtimeDir, 'engineVersions.lock.json');
        writeJson(engineVersionsPath, {
            schemaVersion: {
                value: 1,
                env: {
                    NORMAL_ENV: 'must not be copied',
                },
            },
            runtime: {
                node: '22.0.0',
            },
            engines: {
                llamacpp: {
                    version: 'b4389',
                },
            },
        });

        const engineVersions = readEngineVersionsLock({
            engineVersionsPath,
            engine: 'llamacpp',
        });
        assert.deepEqual(engineVersions, {
            runtime: {
                node: '22.0.0',
            },
            engines: {
                llamacpp: {
                    version: 'b4389',
                },
            },
        });
        assert.equal(JSON.stringify(engineVersions).includes('NORMAL_ENV'), false);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('instance.logs returns a bounded redacted tail', async (t) => withSecretEnv(async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-log-tail-'));
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const { createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?logs=${Date.now()}`);
    const logPath = instanceLogPath(runtimeDir, 'trace-primary');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `old-prefix ${'x'.repeat(4096)} ${HF_TOKEN_VALUE}\n`);
    fs.appendFileSync(logPath, `tail line HF_TOKEN=${HF_TOKEN_LOOKING_VALUE} ${AUTH_HEADER_VALUE} ${HF_TOKEN_VALUE}\n`);

    const server = createServer({ runtimeDir, launcherDirs: [] });
    server.listen(0, '127.0.0.1');
    await waitForListen(server);

    t.after(() => {
        server.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    });

    const response = await mcpTool(server, 'instance.logs', {
        instanceId: 'trace-primary',
        tailBytes: 256,
    });
    const serialized = JSON.stringify(response.json);
    assert.equal(response.status, 200);
    assert.equal(serialized.includes('old-prefix'), false);
    assert.equal(serialized.includes('HF_TOKEN'), false);
    assert.equal(serialized.includes(HF_TOKEN_VALUE), false);
    assert.equal(serialized.includes(HF_TOKEN_LOOKING_VALUE), false);
    assert.equal(serialized.includes(AUTH_HEADER_VALUE), false);
    assert.match(serialized, /tail line/);
    assert.ok(serialized.length < 1024, `logs response should be bounded, got ${serialized.length} bytes`);
}));

test('runtime.describe exposes selected architecture only after secret-key and token redaction', async (t) => withSecretEnv(async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-selected-state-'));
    const repoRoot = path.resolve(import.meta.dirname, '..');
    writeSelectedArchitecture(runtimeDir);

    const { createServer } = await import(`${path.join(repoRoot, 'shared/runtime-agent/mcp-server.mjs')}?describe=${Date.now()}`);
    const server = createServer({ runtimeDir, launcherDirs: [] });
    server.listen(0, '127.0.0.1');
    await waitForListen(server);

    t.after(() => {
        server.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    });

    const response = await mcpTool(server, 'runtime.describe');
    const serialized = JSON.stringify(response.json);
    assert.equal(response.status, 200);
    assert.equal(response.json.result.selectedArchitecture.architecture.imageRef, 'assistos/llm-runtime:cpu-amd64');
    for (const secret of ['HF_TOKEN', 'PLOINKY_MASTER_KEY', HF_TOKEN_VALUE, HF_TOKEN_LOOKING_VALUE, AUTH_HEADER_VALUE]) {
        assert.equal(serialized.includes(secret), false, `runtime.describe leaked ${secret}`);
    }
}));
