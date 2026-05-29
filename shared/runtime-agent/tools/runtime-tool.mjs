import http from 'node:http';

const CONTROL_HOST = process.env.PLOINKY_LLM_INTERNAL_HOST || '127.0.0.1';
const CONTROL_PORT = Number(process.env.PLOINKY_LLM_CONTROL_PORT || process.env.PLOINKY_LLM_RUNTIME_PORT || 9002);
const TOOL_NAME_RE = /^(runtime|modelProfiles|launchers|instance)\.[a-zA-Z][a-zA-Z0-9]*$/;
const ID_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]|[.](?=[a-zA-Z0-9_-])){0,127}$/;

function readStdinJson() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new Error(`invalid JSON payload: ${err.message}`));
            }
        });
        process.stdin.on('error', reject);
    });
}

function requestJson({ method = 'GET', path, body }) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (payload !== null) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = http.request({
            host: CONTROL_HOST,
            port: CONTROL_PORT,
            method,
            path,
            headers,
            timeout: 120_000,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try {
                    parsed = text ? JSON.parse(text) : {};
                } catch (_) {
                    parsed = { text };
                }
                resolve({ status: res.statusCode || 0, body: parsed });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('runtime control service timeout'));
        });
        if (payload !== null) req.write(payload);
        req.end();
    });
}

function requireId(input, names) {
    for (const name of names) {
        const value = input?.[name];
        if (typeof value === 'string' && ID_RE.test(value)) return value;
    }
    throw new Error(`missing or invalid ${names[0]}`);
}

function prioritiesToOverrides(input) {
    if (Array.isArray(input?.overrides)) {
        return { overrides: input.overrides };
    }
    const profileId = requireId(input, ['profileId']);
    const priorities = Array.isArray(input?.priorities) ? input.priorities : [];
    const order = priorities
        .filter((entry) => entry && typeof entry === 'object')
        .filter((entry) => entry.enabled !== false)
        .map((entry) => ({
            launcher: String(entry.launcherId || entry.launcher || ''),
            priority: Number.isFinite(entry.priority) ? entry.priority : 0,
        }))
        .filter((entry) => ID_RE.test(entry.launcher))
        .sort((a, b) => b.priority - a.priority)
        .map((entry) => entry.launcher);
    return { overrides: [{ profileId, order }] };
}

function mapToolToRequest(toolName, input) {
    switch (toolName) {
        case 'runtime.describe':
            return { method: 'GET', path: '/runtime/describe' };
        case 'runtime.health':
            return { method: 'GET', path: '/health' };
        case 'runtime.logs':
            return { method: 'GET', path: '/runtime/logs' };
        case 'modelProfiles.list':
            return { method: 'GET', path: '/runtime/profiles' };
        case 'modelProfiles.describe': {
            const profileId = requireId(input, ['profileId', 'id']);
            return { method: 'GET', path: `/runtime/profiles/${encodeURIComponent(profileId)}` };
        }
        case 'modelProfiles.setPriorities':
            return { method: 'POST', path: '/runtime/profiles/priorities', body: prioritiesToOverrides(input) };
        case 'modelProfiles.resetPriorities':
            return { method: 'DELETE', path: '/runtime/profiles/priorities' };
        case 'launchers.list':
            return { method: 'GET', path: '/runtime/launchers' };
        case 'launchers.describe': {
            const launcherId = requireId(input, ['launcherId', 'launcher', 'id']);
            return { method: 'GET', path: `/runtime/launchers/${encodeURIComponent(launcherId)}` };
        }
        case 'launchers.prepare': {
            const launcher = requireId(input, ['launcherId', 'launcher']);
            return {
                method: 'POST',
                path: '/runtime/launchers/prepare',
                body: {
                    launcher,
                    instanceId: input?.instanceId,
                    parameters: input?.parameters || input?.normalizedParameters || {},
                },
            };
        }
        case 'launchers.start': {
            const launcher = requireId(input, ['launcherId', 'launcher']);
            return {
                method: 'POST',
                path: '/runtime/launchers/start',
                body: {
                    launcher,
                    instanceId: input?.instanceId,
                    parameters: input?.parameters || input?.normalizedParameters || {},
                },
            };
        }
        case 'instance.status': {
            const instanceId = requireId(input, ['instanceId', 'id']);
            return { method: 'GET', path: `/runtime/instances/${encodeURIComponent(instanceId)}` };
        }
        case 'instance.stop': {
            const instanceId = requireId(input, ['instanceId', 'id']);
            return { method: 'DELETE', path: `/runtime/instances/${encodeURIComponent(instanceId)}` };
        }
        case 'instance.logs': {
            const instanceId = requireId(input, ['instanceId', 'id']);
            return { method: 'GET', path: `/runtime/instances/${encodeURIComponent(instanceId)}/logs` };
        }
        default:
            throw new Error(`unsupported tool '${toolName}'`);
    }
}

async function main() {
    const payload = await readStdinJson();
    const toolName = process.env.TOOL_NAME || payload.tool;
    if (typeof toolName !== 'string' || !TOOL_NAME_RE.test(toolName)) {
        throw new Error('missing or invalid TOOL_NAME');
    }
    const input = payload.input && typeof payload.input === 'object' ? payload.input : {};
    const request = mapToolToRequest(toolName, input);
    const response = await requestJson(request);
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`${toolName} failed with HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    }
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
}

main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
});
