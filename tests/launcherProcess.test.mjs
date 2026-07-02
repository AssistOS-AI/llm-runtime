import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    activePointerPath,
    instanceLogPath,
    instanceStatePath,
    readRuntimeEnvSummary,
    safeJsonWrite,
    startInstance,
    stopInstance,
} from '../shared/runtime-agent/lib/launcherProcess.mjs';
import {
    LaunchConfigError,
    normalizeLaunchConfig,
} from '../shared/runtime-agent/lib/launchConfig.mjs';

const HF_TOKEN_LOOKING_VALUE = 'hf_FAKE1234567890SECRET';
const AUTH_HEADER_VALUE = `Authorization: Bearer ${HF_TOKEN_LOOKING_VALUE}`;

function writeLauncherScript(dir, statusResponse) {
    const scriptPath = path.join(dir, 'modelLauncher_test.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  start)
    echo '{"started":true}'
    ;;
  stop)
    echo '{"stopped":true}'
    ;;
  status)
    echo '${statusResponse}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    fs.chmodSync(scriptPath, 0o755);
    return { id: 'test', scriptPath };
}

function writeMinimalStopStateLauncherScript(dir, statePath) {
    const scriptPath = path.join(dir, 'modelLauncher_stop_rewrites_state.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  stop)
    node -e 'const fs=require("fs"); const path=require("path"); const statePath=process.argv[1]; fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify({ instanceId: "trace-primary", launcherId: "test", status: "stopped-by-launcher", minimalOnly: true }) + "\\n");' ${JSON.stringify(statePath)}
    echo '{"stopped":true,"source":"launcher"}'
    ;;
  status)
    echo '{"status":"running"}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    fs.chmodSync(scriptPath, 0o755);
    return { id: 'test', scriptPath };
}

function writeSecretStopLauncherScript(dir, statePath) {
    const scriptPath = path.join(dir, 'modelLauncher_stop_secret_state.sh');
    const secretState = {
        instanceId: 'secret-stop',
        launcherId: 'test',
        status: 'stopped-by-launcher',
        env: { HF_TOKEN: HF_TOKEN_LOOKING_VALUE },
        diagnostic: `HF_TOKEN=${HF_TOKEN_LOOKING_VALUE}`,
        authorization: AUTH_HEADER_VALUE,
    };
    const secretStopOutput = {
        stopped: true,
        diagnostic: `HF_TOKEN=${HF_TOKEN_LOOKING_VALUE}`,
        authorization: AUTH_HEADER_VALUE,
        nested: {
            HF_TOKEN: HF_TOKEN_LOOKING_VALUE,
            tokenValue: HF_TOKEN_LOOKING_VALUE,
        },
    };
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  stop)
    node -e 'const fs=require("fs"); const path=require("path"); const statePath=process.argv[1]; const payload=JSON.parse(process.argv[2]); fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(payload) + "\\n");' ${JSON.stringify(statePath)} ${JSON.stringify(JSON.stringify(secretState))}
    node -e 'process.stdout.write(process.argv[1] + "\\n")' ${JSON.stringify(JSON.stringify(secretStopOutput))}
    ;;
  status)
    echo '{"status":"running"}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    fs.chmodSync(scriptPath, 0o755);
    return { id: 'test', scriptPath };
}

test('startInstance fails fast when active instance lock is already held', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launcher-busy-'));
    try {
        const operationLogPath = path.join(runtimeDir, 'launcher-invoked.log');
        const lockPath = path.join(runtimeDir, 'active-instance.lock');
        fs.writeFileSync(lockPath, 'held\n', { mode: 0o600 });
        const scriptPath = path.join(runtimeDir, 'modelLauncher_test.sh');
        fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], "invoked\\n");' ${JSON.stringify(operationLogPath)}
echo '{"started":true}'
`);
        fs.chmodSync(scriptPath, 0o755);
        const launcher = { id: 'test', scriptPath };

        assert.throws(
            () => startInstance({
                runtimeDir,
                launcher,
                config: normalizeLaunchConfig({
                    launcherId: 'test',
                    instanceId: 'busy-primary',
                }),
            }),
            (err) => {
                assert.equal(err.code, 'INSTANCE_BUSY');
                assert.match(err.message, /active instance lock|busy/i);
                return true;
            },
        );
        assert.equal(fs.existsSync(operationLogPath), false, 'launcher must not run while active lock is held');
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('startInstance removes active instance lock after successful start', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launcher-lock-success-'));
    try {
        const launcher = writeLauncherScript(runtimeDir, '{"status":"running"}');
        const result = startInstance({
            runtimeDir,
            launcher,
            config: normalizeLaunchConfig({
                launcherId: 'test',
                instanceId: 'lock-success',
            }),
        });

        assert.equal(result.ok, true);
        assert.equal(fs.existsSync(path.join(runtimeDir, 'active-instance.lock')), false);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('startInstance removes active instance lock after launcher start failure', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launcher-lock-failure-'));
    try {
        const scriptPath = path.join(runtimeDir, 'modelLauncher_test.sh');
        fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  start)
    echo 'start failed intentionally' >&2
    exit 9
    ;;
  stop)
    echo '{"stopped":true}'
    ;;
  status)
    echo '{"status":"stopped"}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
        fs.chmodSync(scriptPath, 0o755);
        const launcher = { id: 'test', scriptPath };

        assert.throws(
            () => startInstance({
                runtimeDir,
                launcher,
                config: normalizeLaunchConfig({
                    launcherId: 'test',
                    instanceId: 'lock-failure',
                }),
            }),
            (err) => {
                assert.equal(err.code, 'START_FAILED');
                assert.match(err.message, /launcher start failed/);
                return true;
            },
        );
        assert.equal(fs.existsSync(path.join(runtimeDir, 'active-instance.lock')), false);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('startInstance clears stale active instance lock owned by a dead pid', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launcher-stale-lock-'));
    try {
        const lockPath = path.join(runtimeDir, 'active-instance.lock');
        fs.writeFileSync(lockPath, '999999999\n', { mode: 0o600 });
        const launcher = writeLauncherScript(runtimeDir, '{"status":"running"}');

        const result = startInstance({
            runtimeDir,
            launcher,
            config: normalizeLaunchConfig({
                launcherId: 'test',
                instanceId: 'stale-lock-primary',
            }),
        });

        assert.equal(result.ok, true);
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('safeJsonWrite preserves the previous file and removes temp files when rename fails', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-safe-json-'));
    try {
        const filePath = path.join(runtimeDir, 'instances', 'atomic-primary.json');
        safeJsonWrite(filePath, { version: 1 });
        const originalBytes = fs.readFileSync(filePath, 'utf8');
        const originalRenameSync = fs.renameSync;
        let renameAttempted = false;
        fs.renameSync = (from, to) => {
            if (to === filePath) {
                renameAttempted = true;
                assert.equal(fs.existsSync(from), true, 'staged temp file should exist before rename');
                throw new Error('simulated rename failure');
            }
            return originalRenameSync(from, to);
        };
        try {
            assert.throws(
                () => safeJsonWrite(filePath, { version: 2 }),
                /simulated rename failure/,
            );
        } finally {
            fs.renameSync = originalRenameSync;
        }

        assert.equal(renameAttempted, true, 'write should use rename into place');
        assert.equal(fs.readFileSync(filePath, 'utf8'), originalBytes);
        const leftovers = fs.readdirSync(path.dirname(filePath))
            .filter((name) => name.includes('.tmp-'));
        assert.deepEqual(leftovers, []);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('startInstance restarts a stale active instance instead of reusing it', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launcher-stale-'));
    try {
        const launcher = writeLauncherScript(runtimeDir, '{"status":"stopped"}');
        fs.mkdirSync(path.dirname(activePointerPath(runtimeDir)), { recursive: true });
        fs.writeFileSync(activePointerPath(runtimeDir), JSON.stringify({
            instanceId: 'chat-primary',
            launcherId: 'test',
            scriptPath: launcher.scriptPath,
        }));
        fs.mkdirSync(path.dirname(instanceStatePath(runtimeDir, 'chat-primary')), { recursive: true });
        fs.writeFileSync(instanceStatePath(runtimeDir, 'chat-primary'), JSON.stringify({
            instanceId: 'chat-primary',
            launcherId: 'test',
            scriptPath: launcher.scriptPath,
        }));

        const result = startInstance({
            runtimeDir,
            launcher,
            config: normalizeLaunchConfig({
                instanceId: 'chat-primary',
                launcherId: 'test',
            }),
        });

        assert.equal(result.ok, true);
        assert.equal(result.reused, false);
        assert.deepEqual(result.launcherStart, { started: true });
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('startInstance reuses an active instance only when launcher status is running', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launcher-running-'));
    try {
        const launcher = writeLauncherScript(runtimeDir, '{"status":"running"}');
        fs.mkdirSync(path.dirname(activePointerPath(runtimeDir)), { recursive: true });
        fs.writeFileSync(activePointerPath(runtimeDir), JSON.stringify({
            instanceId: 'chat-primary',
            launcherId: 'test',
            scriptPath: launcher.scriptPath,
        }));
        fs.mkdirSync(path.dirname(instanceStatePath(runtimeDir, 'chat-primary')), { recursive: true });
        fs.writeFileSync(instanceStatePath(runtimeDir, 'chat-primary'), JSON.stringify({
            instanceId: 'chat-primary',
            launcherId: 'test',
            scriptPath: launcher.scriptPath,
        }));

        const result = startInstance({
            runtimeDir,
            launcher,
            config: normalizeLaunchConfig({
                instanceId: 'chat-primary',
                launcherId: 'test',
            }),
        });

        assert.equal(result.ok, true);
        assert.equal(result.reused, true);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('startInstance writes normalized launch config with launcherId and startup fields only', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launcher-config-'));
    try {
        const scriptPath = path.join(runtimeDir, 'modelLauncher_test.sh');
        fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  start)
    node -e 'const fs=require("fs"); const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(JSON.stringify({config:cfg}));' "\${3:?missing config}"
    ;;
  stop)
    echo '{"stopped":true}'
    ;;
  status)
    echo '{"status":"running"}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
        fs.chmodSync(scriptPath, 0o755);
        const launcher = { id: 'test', scriptPath };

        const result = startInstance({
            runtimeDir,
            launcher,
            config: normalizeLaunchConfig({
                launcherId: 'test',
                instanceId: 'inst-primary',
                contextTokens: 4096,
                cpuThreads: 4,
                enableMetrics: true,
            }),
        });

        assert.equal(result.ok, true);
        assert.deepEqual(result.launcherStart.config, {
            launcherId: 'test',
            instanceId: 'inst-primary',
            contextTokens: 4096,
            cpuThreads: 4,
            enableMetrics: true,
        });
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('startInstance injects HF_TOKEN into launcher child env from secret file only', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launcher-secret-file-'));
    const previousSecretFile = process.env.PLOINKY_MODEL_SECRET_FILE;
    const previousHfToken = process.env.HF_TOKEN;
    try {
        const token = ['child', 'secret', 'token'].join('-');
        const secretPath = path.join(runtimeDir, 'secrets', 'hf_token');
        fs.mkdirSync(path.dirname(secretPath), { recursive: true });
        fs.writeFileSync(secretPath, `${token}\n`, { mode: 0o600 });
        process.env.PLOINKY_MODEL_SECRET_FILE = secretPath;
        delete process.env.HF_TOKEN;

        const scriptPath = path.join(runtimeDir, 'modelLauncher_test.sh');
        fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  start)
    node -e 'process.stdout.write(JSON.stringify({childHadToken: process.env.HF_TOKEN === process.argv[1]}));' ${JSON.stringify(token)}
    ;;
  stop)
    echo '{"stopped":true}'
    ;;
  status)
    echo '{"status":"running"}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
        fs.chmodSync(scriptPath, 0o755);
        const launcher = { id: 'test', scriptPath };

        const result = startInstance({
            runtimeDir,
            launcher,
            config: normalizeLaunchConfig({
                launcherId: 'test',
                instanceId: 'inst-secret-file',
            }),
        });

        assert.equal(result.ok, true);
        assert.equal(result.launcherStart.childHadToken, true);
        assert.equal(Object.hasOwn(process.env, 'HF_TOKEN'), false);

        const stateBytes = fs.readFileSync(instanceStatePath(runtimeDir, 'inst-secret-file'), 'utf8');
        const logBytes = fs.readFileSync(instanceLogPath(runtimeDir, 'inst-secret-file'), 'utf8');
        const envSummaryBytes = JSON.stringify(readRuntimeEnvSummary());
        for (const bytes of [stateBytes, logBytes, envSummaryBytes]) {
            assert.equal(bytes.includes(token), false);
            assert.equal(bytes.includes('HF_TOKEN'), false);
        }
    } finally {
        if (previousSecretFile === undefined) {
            delete process.env.PLOINKY_MODEL_SECRET_FILE;
        } else {
            process.env.PLOINKY_MODEL_SECRET_FILE = previousSecretFile;
        }
        if (previousHfToken === undefined) {
            delete process.env.HF_TOKEN;
        } else {
            process.env.HF_TOKEN = previousHfToken;
        }
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('launcher failure errors and logs redact secret names and token values', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launcher-redaction-'));
    try {
        const scriptPath = path.join(runtimeDir, 'modelLauncher_test.sh');
        fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  start)
    echo 'HF_TOKEN=${HF_TOKEN_LOOKING_VALUE} ${AUTH_HEADER_VALUE}' >&2
    exit 7
    ;;
  stop)
    echo '{"stopped":true}'
    ;;
  status)
    echo '{"status":"running"}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
        fs.chmodSync(scriptPath, 0o755);
        const launcher = { id: 'test', scriptPath };

        assert.throws(
            () => startInstance({
                runtimeDir,
                launcher,
                config: normalizeLaunchConfig({
                    launcherId: 'test',
                    instanceId: 'inst-redaction',
                }),
            }),
            (err) => {
                assert.match(err.message, /launcher start failed/);
                for (const leaked of ['HF_TOKEN', HF_TOKEN_LOOKING_VALUE, 'Authorization: Bearer']) {
                    assert.equal(err.message.includes(leaked), false, `error leaked ${leaked}`);
                }
                return true;
            },
        );

        const logBytes = fs.readFileSync(instanceLogPath(runtimeDir, 'inst-redaction'), 'utf8');
        for (const leaked of ['HF_TOKEN', HF_TOKEN_LOOKING_VALUE, 'Authorization: Bearer']) {
            assert.equal(logBytes.includes(leaked), false, `log leaked ${leaked}`);
        }
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('stopInstance preserves rich traceability when launcher stop rewrites minimal state', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-stop-traceability-'));
    try {
        const instanceId = 'trace-primary';
        const statePath = instanceStatePath(runtimeDir, instanceId);
        const launcher = writeMinimalStopStateLauncherScript(runtimeDir, statePath);
        const richRecord = {
            instanceId,
            launcherId: 'test',
            scriptPath: launcher.scriptPath,
            engine: 'llamacpp',
            modelId: 'planning-local-qwen2.5-0.5b-instruct',
            hfRepoId: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
            hfRevision: 'df5bf01389a39c743ab467d734bf501681e041c5',
            modelFiles: ['qwen2.5-0.5b-instruct-q4_k_m.gguf'],
            artifactPaths: ['/models/qwen2.5-0.5b-instruct-q4_k_m.gguf'],
            artifactDigests: {
                '/models/qwen2.5-0.5b-instruct-q4_k_m.gguf': {
                    type: 'file',
                    sha256: '5b9f3c4a01e2d6c7890abf1234567890abcdef1234567890abcdef1234567890',
                    sizeBytes: 123456,
                },
            },
            imageRef: 'assistos/llm-runtime:cpu-amd64',
            imageDigest: 'sha256:86b9b5f98eae0c01326e20c9d5d6f2651e7851d5d6f2651e7851d86b9b5f98ea',
            engineVersions: {
                engines: {
                    llamacpp: {
                        version: 'b4389',
                        commit: 'abc123',
                    },
                },
            },
            launchConfigPath: path.join(runtimeDir, 'launch-configs', `${instanceId}.json`),
            pid: 4242,
            port: 8080,
            startedAt: '2026-03-04T05:06:07.000Z',
            health: { status: 'healthy' },
            status: 'running',
            launcherStart: { pid: 4242, port: 8080 },
        };
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, `${JSON.stringify(richRecord, null, 2)}\n`);
        fs.mkdirSync(path.dirname(activePointerPath(runtimeDir)), { recursive: true });
        fs.writeFileSync(activePointerPath(runtimeDir), `${JSON.stringify({
            instanceId,
            launcherId: 'test',
            scriptPath: launcher.scriptPath,
            startedAt: richRecord.startedAt,
        })}\n`);

        const result = stopInstance({ runtimeDir, launcher, instanceId });

        assert.equal(result.ok, true);
        assert.deepEqual(result.stopped, { stopped: true, source: 'launcher' });
        assert.equal(fs.existsSync(activePointerPath(runtimeDir)), false);

        const stoppedRecord = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        assert.equal(stoppedRecord.status, 'stopped');
        assert.match(stoppedRecord.stoppedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(stoppedRecord.engine, richRecord.engine);
        assert.equal(stoppedRecord.modelId, richRecord.modelId);
        assert.equal(stoppedRecord.hfRepoId, richRecord.hfRepoId);
        assert.deepEqual(stoppedRecord.modelFiles, richRecord.modelFiles);
        assert.deepEqual(stoppedRecord.artifactPaths, richRecord.artifactPaths);
        assert.deepEqual(stoppedRecord.artifactDigests, richRecord.artifactDigests);
        assert.equal(stoppedRecord.imageDigest, richRecord.imageDigest);
        assert.deepEqual(stoppedRecord.engineVersions, richRecord.engineVersions);
        assert.equal(stoppedRecord.launchConfigPath, richRecord.launchConfigPath);
        assert.deepEqual(stoppedRecord.launcherStart, richRecord.launcherStart);
        assert.deepEqual(stoppedRecord.launcherStop, { stopped: true, source: 'launcher' });
        assert.equal(Object.hasOwn(stoppedRecord, 'minimalOnly'), false);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('stopInstance redacts secrets from launcherStop return value and persisted state', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-stop-redaction-'));
    try {
        const instanceId = 'secret-stop';
        const statePath = instanceStatePath(runtimeDir, instanceId);
        const launcher = writeSecretStopLauncherScript(runtimeDir, statePath);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, `${JSON.stringify({
            instanceId,
            launcherId: 'test',
            scriptPath: launcher.scriptPath,
            status: 'running',
            launcherStart: { started: true },
        }, null, 2)}\n`);

        const result = stopInstance({ runtimeDir, launcher, instanceId });
        const returned = JSON.stringify(result);
        const stateBytes = fs.readFileSync(statePath, 'utf8');
        const stoppedRecord = JSON.parse(stateBytes);

        assert.equal(result.ok, true);
        assert.equal(stoppedRecord.status, 'stopped');
        assert.equal(Object.hasOwn(stoppedRecord, 'launcherStop'), true);
        assert.equal(returned.includes('[REDACTED]'), true);
        assert.equal(JSON.stringify(stoppedRecord.launcherStop).includes('[REDACTED]'), true);
        for (const leaked of ['HF_TOKEN', HF_TOKEN_LOOKING_VALUE, 'Authorization: Bearer', AUTH_HEADER_VALUE]) {
            assert.equal(returned.includes(leaked), false, `stop result leaked ${leaked}`);
            assert.equal(stateBytes.includes(leaked), false, `state leaked ${leaked}`);
        }
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('stopInstance redacts model secret file token from launcher-rewritten state', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-stop-secret-file-redaction-'));
    const previousSecretFile = process.env.PLOINKY_MODEL_SECRET_FILE;
    const previousHfToken = process.env.HF_TOKEN;
    try {
        const token = ['stop', 'secret', 'token'].join('-');
        const secretPath = path.join(runtimeDir, 'secrets', 'hf_token');
        const statePath = instanceStatePath(runtimeDir, 'secret-stop-file');
        fs.mkdirSync(path.dirname(secretPath), { recursive: true });
        fs.writeFileSync(secretPath, token, { mode: 0o600 });
        process.env.PLOINKY_MODEL_SECRET_FILE = secretPath;
        delete process.env.HF_TOKEN;

        const scriptPath = path.join(runtimeDir, 'modelLauncher_stop_secret_file_state.sh');
        fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  stop)
    node -e 'const fs=require("fs"); const path=require("path"); const statePath=process.argv[1]; const payload={ instanceId: "secret-stop-file", launcherId: "test", status: "stopped-by-launcher", tokenValue: process.env.HF_TOKEN }; fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(payload) + "\\n"); process.stdout.write(JSON.stringify({ stopped: true, tokenValue: process.env.HF_TOKEN }));' ${JSON.stringify(statePath)}
    ;;
  status)
    echo '{"status":"running"}'
    ;;
  *)
    echo '{}'
    ;;
esac
`);
        fs.chmodSync(scriptPath, 0o755);
        const launcher = { id: 'test', scriptPath };

        const result = stopInstance({ runtimeDir, launcher, instanceId: 'secret-stop-file' });
        const stateBytes = fs.readFileSync(statePath, 'utf8');
        const returned = JSON.stringify(result);

        assert.equal(result.ok, true);
        assert.equal(returned.includes(token), false);
        assert.equal(stateBytes.includes(token), false);
        assert.equal(stateBytes.includes('HF_TOKEN'), false);
    } finally {
        if (previousSecretFile === undefined) {
            delete process.env.PLOINKY_MODEL_SECRET_FILE;
        } else {
            process.env.PLOINKY_MODEL_SECRET_FILE = previousSecretFile;
        }
        if (previousHfToken === undefined) {
            delete process.env.HF_TOKEN;
        } else {
            process.env.HF_TOKEN = previousHfToken;
        }
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('normalizeLaunchConfig rejects generation fields before launcher process execution', () => {
    assert.throws(
        () => normalizeLaunchConfig({
            launcherId: 'test',
            instanceId: 'inst-primary',
            temperature: 0.2,
        }),
        (err) => err instanceof LaunchConfigError && /forbidden generation field 'temperature'/.test(err.message),
    );
});
