import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_RUNTIME_DIR = '/runtime';

function readSelectedArchitecture(runtimeDir = DEFAULT_RUNTIME_DIR) {
    const filePath = path.join(runtimeDir, 'selected-architecture.json');
    if (!fs.existsSync(filePath)) {
        throw new Error(`runtime state missing: ${filePath}. The container was not started with hardware-aware LLM startup.`);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`runtime state '${filePath}' is not valid JSON: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`runtime state '${filePath}' is not a JSON object`);
    }
    return parsed;
}

function ensureRuntimeSubdir(runtimeDir, subdir) {
    const full = path.join(runtimeDir, subdir);
    fs.mkdirSync(full, { recursive: true });
    return full;
}

export {
    DEFAULT_RUNTIME_DIR,
    ensureRuntimeSubdir,
    readSelectedArchitecture,
};
