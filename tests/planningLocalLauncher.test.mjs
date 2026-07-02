import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { validateLauncherDescribe } from '../shared/runtime-agent/lib/schemas.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const launcherPath = path.join(repoRoot, 'planning-local', 'modelLaunchers', 'modelLauncher_llama-cpp-cpu.sh');
const modelRepo = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const modelRevision = 'df5bf01389a39c743ab467d734bf501681e041c5';
const modelFile = 'qwen2.5-0.5b-instruct-q4_k_m.gguf';

function tmpDir(prefix = 'ploinky-planning-launcher-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runLauncher(args, env = {}) {
    return spawnSync(launcherPath, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function writeConfig(dir, config = {}) {
    const filePath = path.join(dir, 'launch-config.json');
    fs.writeFileSync(filePath, `${JSON.stringify({
        launcherId: 'llama-cpp-cpu',
        instanceId: 'planning-test',
        ...config,
    }, null, 2)}\n`);
    return filePath;
}

function pythonBinDirWithoutHf() {
    const binDir = tmpDir('ploinky-python-only-');
    const python = execFileSync('/bin/sh', ['-lc', 'command -v python3'], { encoding: 'utf8' }).trim();
    const bash = execFileSync('/bin/sh', ['-lc', 'command -v bash'], { encoding: 'utf8' }).trim();
    fs.symlinkSync(python, path.join(binDir, 'python3'));
    fs.symlinkSync(bash, path.join(binDir, 'bash'));
    return binDir;
}

test('describe returns the pinned llama.cpp CPU launcher contract', () => {
    const result = runLauncher(['describe']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');

    const described = JSON.parse(result.stdout);
    validateLauncherDescribe(described);
    assert.deepEqual({
        schemaVersion: described.schemaVersion,
        id: described.id,
        modelId: described.modelId,
        engine: described.engine,
        modelFormat: described.modelFormat,
        hfRepoId: described.hfRepoId,
        hfRevision: described.hfRevision,
        modelFiles: described.modelFiles,
        supportedAccelerators: described.supportedAccelerators,
        supportedPlatforms: described.supportedPlatforms,
    }, {
        schemaVersion: 1,
        id: 'llama-cpp-cpu',
        modelId: 'planning-local-qwen2.5-0.5b-instruct',
        engine: 'llamacpp',
        modelFormat: 'gguf',
        hfRepoId: modelRepo,
        hfRevision: modelRevision,
        modelFiles: [modelFile],
        supportedAccelerators: ['cpu'],
        supportedPlatforms: ['linux/amd64', 'linux/arm64'],
    });
    assert.ok(described.profiles.primary, 'primary profile must be described');
    assert.ok(described.profiles['long-context'], 'long-context profile must be described');
    assert.ok(described.resourceEstimates.cpu, 'CPU resource estimate must be described');
    assert.ok(described.configurableParameters.contextTokens, 'contextTokens must be configurable');
});

test('prepare downloads the GGUF artifact under PLOINKY_MODELS_DIR only', () => {
    const temp = tmpDir();
    const binDir = path.join(temp, 'bin');
    const modelsDir = path.join(temp, 'models');
    const runtimeDir = path.join(temp, 'runtime');
    const argsLog = path.join(temp, 'hf-args.json');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'hf'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "${argsLog}.lines"
local_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --local-dir) local_dir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
python3 - "$local_dir" "$@" <<'PY'
import json, pathlib, sys
lines = pathlib.Path(${JSON.stringify(`${argsLog}.lines`)}).read_text().splitlines()
pathlib.Path(${JSON.stringify(argsLog)}).write_text(json.dumps(lines))
local_dir = pathlib.Path(sys.argv[1])
local_dir.mkdir(parents=True, exist_ok=True)
(local_dir / ${JSON.stringify(modelFile)}).write_text('fake model')
PY
`);
    fs.chmodSync(path.join(binDir, 'hf'), 0o755);
    const configPath = writeConfig(temp);

    const result = runLauncher(['prepare', '--config', configPath], {
        PATH: `${binDir}:${process.env.PATH}`,
        PLOINKY_MODELS_DIR: modelsDir,
        PLOINKY_RUNTIME_DIR: runtimeDir,
    });

    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.modelPath, path.join(modelsDir, modelRepo, modelFile));
    assert.equal(fs.existsSync(path.join(modelsDir, modelRepo, modelFile)), true);
    assert.equal(fs.existsSync(path.join(runtimeDir, modelRepo, modelFile)), false);

    const hfArgs = JSON.parse(fs.readFileSync(argsLog, 'utf8'));
    assert.deepEqual(hfArgs.slice(0, 7), [
        'download',
        '--repo-id',
        modelRepo,
        '--revision',
        modelRevision,
        '--include',
        modelFile,
    ]);
});

test('prepare reports a clear missing hf tool error', () => {
    const temp = tmpDir();
    const binDir = pythonBinDirWithoutHf();
    const configPath = writeConfig(temp);

    const result = runLauncher(['prepare', '--config', configPath], {
        PATH: binDir,
        PLOINKY_MODELS_DIR: path.join(temp, 'models'),
        PLOINKY_RUNTIME_DIR: path.join(temp, 'runtime'),
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /required tool 'hf' not found/i);
});

test('prepare reports auth failures without leaking tokens', () => {
    const temp = tmpDir();
    const binDir = path.join(temp, 'bin');
    const hfTokenEnvName = ['HF', 'TOKEN'].join('_');
    const hfTokenPrefix = ['h', 'f', '_'].join('');
    const token = `${hfTokenPrefix}thisShouldNeverAppearInLauncherErrors123456789`;
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'hf'), `#!/usr/bin/env bash
echo "401 Unauthorized gated token ${token} sk-abcdefghijklmnopqrstuvwxyz123456" >&2
exit 1
`);
    fs.chmodSync(path.join(binDir, 'hf'), 0o755);
    const configPath = writeConfig(temp);

    const result = runLauncher(['prepare', '--config', configPath], {
        PATH: `${binDir}:${process.env.PATH}`,
        [hfTokenEnvName]: token,
        PLOINKY_MODELS_DIR: path.join(temp, 'models'),
        PLOINKY_RUNTIME_DIR: path.join(temp, 'runtime'),
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Hugging Face authentication failed/i);
    assert.equal(result.stderr.includes(hfTokenEnvName), false);
    assert.equal(result.stderr.includes(token), false);
    assert.equal(new RegExp(`${hfTokenPrefix}[A-Za-z0-9_=-]{8,}`).test(result.stderr), false);
    assert.equal(/sk-[A-Za-z0-9_=-]{16,}/.test(result.stderr), false);
});

test('dry-run start returns the llama-server command capture', () => {
    const temp = tmpDir();
    const configPath = writeConfig(temp, {
        contextTokens: 4096,
        concurrency: 2,
        batchTokens: 512,
        prefillChunkTokens: 128,
        acceleratorReserveMiB: 1024,
        kvCachePrecision: 'q8_0',
        gpuLayers: 35,
        deviceIds: ['0', '1'],
        splitMode: 'layer',
        tensorSplit: [1, 1],
        mainGpu: 0,
        flashAttention: 'auto',
        cpuThreads: 6,
    });

    const result = runLauncher(['start', '--config', configPath], {
        PLOINKY_LAUNCHER_DRY_RUN: '1',
        PLOINKY_RUNTIME_DIR: path.join(temp, 'runtime'),
    });

    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.dryRun, true);
    assert.deepEqual(response.command, [
        'llama-server',
        '--host', '0.0.0.0',
        '--port', '8080',
        '--model', '/models/artifacts/Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf',
        '--ctx-size', '4096',
        '--parallel', '2',
        '--n-gpu-layers', '35',
        '--batch-size', '512',
        '--ubatch-size', '128',
        '--threads', '6',
        '--cache-type-k', 'q8_0',
        '--cache-type-v', 'q8_0',
        '--flash-attn', 'auto',
        '--fit', 'on',
        '--fit-target', '1024',
        '--device', '0,1',
        '--split-mode', 'layer',
        '--tensor-split', '1,1',
        '--main-gpu', '0',
    ]);
});

test('start reports immediate llama-server failure without claiming running or leaking tokens', () => {
    const temp = tmpDir();
    const binDir = path.join(temp, 'bin');
    const modelsDir = path.join(temp, 'models');
    const runtimeDir = path.join(temp, 'runtime');
    const modelPath = path.join(modelsDir, modelRepo, modelFile);
    const secretName = ['HF', 'TOKEN'].join('_');
    const tokenPrefix = ['h', 'f', '_'].join('');
    const token = `${tokenPrefix}immediateFailureSecret123456789`;
    const authHeader = ['Authorization:', 'Bearer'].join(' ');
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(modelPath, 'fake model');
    fs.writeFileSync(path.join(binDir, 'llama-server'), `#!/usr/bin/env bash
echo "${secretName}=${token} ${authHeader} ${token} sk-abcdefghijklmnopqrstuvwxyz123456" >&2
exit 42
`);
    fs.chmodSync(path.join(binDir, 'llama-server'), 0o755);
    const configPath = writeConfig(temp);

    const result = runLauncher(['start', '--config', configPath], {
        PATH: `${binDir}:${process.env.PATH}`,
        PLOINKY_MODELS_DIR: modelsDir,
        PLOINKY_RUNTIME_DIR: runtimeDir,
        [secretName]: token,
    });

    assert.notEqual(result.status, 0);
    assert.notEqual(result.stdout.trim(), '');
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, false);
    assert.equal(response.instanceId, 'planning-test');
    assert.notEqual(response.status, 'running');
    assert.match(response.error, /llama-server exited during startup/i);

    const returnedText = `${result.stdout}\n${result.stderr}`;
    assert.equal(returnedText.includes(secretName), false);
    assert.equal(returnedText.includes(token), false);
    assert.equal(returnedText.includes(authHeader), false);
    assert.equal(new RegExp(`${tokenPrefix}[A-Za-z0-9_=-]{8,}`).test(returnedText), false);
    assert.equal(/sk-[A-Za-z0-9_=-]{16,}/.test(returnedText), false);

    assert.equal(fs.existsSync(path.join(runtimeDir, 'active-instance.json')), false);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'instances', 'planning-test.pid')), false);
    const statePath = path.join(runtimeDir, 'instances', 'planning-test.json');
    if (fs.existsSync(statePath)) {
        assert.notEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).status, 'running');
    }
});

test('launcher liveness inspects process state before writing running state', () => {
    const source = fs.readFileSync(launcherPath, 'utf8');
    const probeIndex = source.indexOf('probe_started_process "$instance_id" "$pid" "$log_file"');
    const stateIndex = source.indexOf('write_state "$instance_id" "running" "$pid"');

    assert.match(source, /ps\s+-p\s+"\$pid"\s+-o\s+stat=/);
    assert.match(source, /Z\*/);
    assert.ok(probeIndex >= 0, 'start path must probe liveness');
    assert.ok(stateIndex >= 0, 'start path must write running state only after probing');
    assert.ok(probeIndex < stateIndex, 'liveness probe must run before running state is persisted');
});

test('status and stop are idempotent for missing or already stopped instances', () => {
    const temp = tmpDir();
    const runtimeDir = path.join(temp, 'runtime');
    const env = {
        PLOINKY_MODELS_DIR: path.join(temp, 'models'),
        PLOINKY_RUNTIME_DIR: runtimeDir,
    };

    const missingStatus = runLauncher(['status', '--instance', 'missing-instance'], env);
    assert.equal(missingStatus.status, 0, missingStatus.stderr);
    assert.deepEqual(JSON.parse(missingStatus.stdout), {
        ok: true,
        instanceId: 'missing-instance',
        found: false,
        status: 'stopped',
    });

    const firstStop = runLauncher(['stop', '--instance', 'missing-instance'], env);
    const secondStop = runLauncher(['stop', '--instance', 'missing-instance'], env);
    assert.equal(firstStop.status, 0, firstStop.stderr);
    assert.equal(secondStop.status, 0, secondStop.stderr);
    assert.equal(JSON.parse(firstStop.stdout).status, 'stopped');
    assert.equal(JSON.parse(secondStop.stdout).status, 'stopped');

    const instanceDir = path.join(runtimeDir, 'instances');
    fs.mkdirSync(instanceDir, { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'stopped-instance.json'), JSON.stringify({
        launcherId: 'llama-cpp-cpu',
        instanceId: 'stopped-instance',
        status: 'stopped',
    }));

    const stoppedStatus = runLauncher(['status', '--instance', 'stopped-instance'], env);
    assert.equal(stoppedStatus.status, 0, stoppedStatus.stderr);
    assert.deepEqual(JSON.parse(stoppedStatus.stdout), {
        ok: true,
        instanceId: 'stopped-instance',
        found: true,
        status: 'stopped',
    });

    const stoppedStop = runLauncher(['stop', '--instance', 'stopped-instance'], env);
    assert.equal(stoppedStop.status, 0, stoppedStop.stderr);
    assert.deepEqual(JSON.parse(stoppedStop.stdout), {
        ok: true,
        instanceId: 'stopped-instance',
        found: true,
        status: 'stopped',
    });
});
