import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    activePointerPath,
    instanceStatePath,
    startInstance,
} from '../shared/runtime-agent/lib/launcherProcess.mjs';

function writeLauncherScript(dir, statusResponse) {
    const scriptPath = path.join(dir, 'modelLauncher_fake.sh');
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
    return { id: 'fake', scriptPath };
}

test('startInstance restarts a stale active instance instead of reusing it', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launcher-stale-'));
    try {
        const launcher = writeLauncherScript(runtimeDir, '{"status":"stopped"}');
        fs.mkdirSync(path.dirname(activePointerPath(runtimeDir)), { recursive: true });
        fs.writeFileSync(activePointerPath(runtimeDir), JSON.stringify({
            instanceId: 'chat-primary',
            launcher: 'fake',
            scriptPath: launcher.scriptPath,
        }));
        fs.mkdirSync(path.dirname(instanceStatePath(runtimeDir, 'chat-primary')), { recursive: true });
        fs.writeFileSync(instanceStatePath(runtimeDir, 'chat-primary'), JSON.stringify({
            instanceId: 'chat-primary',
            launcher: 'fake',
            scriptPath: launcher.scriptPath,
        }));

        const result = startInstance({
            runtimeDir,
            launcher,
            config: {
                instanceId: 'chat-primary',
                launcher: 'fake',
                parameters: {},
            },
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
            launcher: 'fake',
            scriptPath: launcher.scriptPath,
        }));
        fs.mkdirSync(path.dirname(instanceStatePath(runtimeDir, 'chat-primary')), { recursive: true });
        fs.writeFileSync(instanceStatePath(runtimeDir, 'chat-primary'), JSON.stringify({
            instanceId: 'chat-primary',
            launcher: 'fake',
            scriptPath: launcher.scriptPath,
        }));

        const result = startInstance({
            runtimeDir,
            launcher,
            config: {
                instanceId: 'chat-primary',
                launcher: 'fake',
                parameters: {},
            },
        });

        assert.equal(result.ok, true);
        assert.equal(result.reused, true);
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});
