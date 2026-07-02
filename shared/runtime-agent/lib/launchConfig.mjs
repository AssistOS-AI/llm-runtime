import {
    FORBIDDEN_GENERATION_FIELDS,
    STARTUP_FIELD_NAMES,
} from './runtimeContract.mjs';
import {
    INSTANCE_ID_RE,
    LAUNCHER_NAME_RE,
    PROFILE_ID_RE,
} from './schemas.mjs';

class LaunchConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LaunchConfigError';
        this.code = 'LLM_RUNTIME_LAUNCH_CONFIG_INVALID';
    }
}

const STARTUP_FIELDS = new Set(STARTUP_FIELD_NAMES);
const FORBIDDEN_FIELDS = new Set(FORBIDDEN_GENERATION_FIELDS);
const POSITIVE_INTEGER_FIELDS = new Set([
    'contextTokens',
    'concurrency',
    'batchTokens',
    'prefillChunkTokens',
    'acceleratorReserveMiB',
    'tensorParallelSize',
    'pipelineParallelSize',
    'cpuThreads',
]);
const NON_NEGATIVE_INTEGER_FIELDS = new Set(['gpuLayers', 'mainGpu']);
const BOOLEAN_FIELDS = new Set(['enableMetrics']);
const FLASH_ATTENTION_POLICIES = new Set(['on', 'off', 'auto']);
const SPLIT_MODES = new Set(['none', 'layer', 'row']);

function ensureObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new LaunchConfigError('launch config: expected object');
    }
}

function rejectInvalidKeys(config) {
    for (const key of Object.keys(config)) {
        if (FORBIDDEN_FIELDS.has(key)) {
            throw new LaunchConfigError(`launch config: forbidden generation field '${key}'`);
        }
        if (!STARTUP_FIELDS.has(key)) {
            throw new LaunchConfigError(`launch config: unknown field '${key}'`);
        }
    }
}

function requirePositiveInteger(value, key) {
    if (!Number.isInteger(value) || value < 1) {
        throw new LaunchConfigError(`launch config.${key}: expected positive integer`);
    }
}

function requireNonNegativeInteger(value, key) {
    if (!Number.isInteger(value) || value < 0) {
        throw new LaunchConfigError(`launch config.${key}: expected non-negative integer`);
    }
}

function requireNonNegativeNumber(value, key) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new LaunchConfigError(`launch config.${key}: expected non-negative number`);
    }
}

function validateStartupValue(key, value) {
    if (key === 'launcherId') {
        if (!LAUNCHER_NAME_RE.test(String(value || ''))) {
            throw new LaunchConfigError('launch config.launcherId invalid');
        }
        return;
    }
    if (key === 'instanceId') {
        if (!INSTANCE_ID_RE.test(String(value || ''))) {
            throw new LaunchConfigError('launch config.instanceId invalid');
        }
        return;
    }
    if (key === 'profile') {
        if (!PROFILE_ID_RE.test(String(value || ''))) {
            throw new LaunchConfigError('launch config.profile invalid');
        }
        return;
    }
    if (POSITIVE_INTEGER_FIELDS.has(key)) {
        requirePositiveInteger(value, key);
        return;
    }
    if (NON_NEGATIVE_INTEGER_FIELDS.has(key)) {
        requireNonNegativeInteger(value, key);
        return;
    }
    if (key === 'acceleratorMemoryFraction') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
            throw new LaunchConfigError('launch config.acceleratorMemoryFraction: expected number > 0 and <= 1');
        }
        return;
    }
    if (key === 'kvCachePrecision') {
        if (typeof value !== 'string' || !value.trim() || value.length > 64) {
            throw new LaunchConfigError('launch config.kvCachePrecision: expected non-empty string up to 64 characters');
        }
        return;
    }
    if (key === 'deviceIds') {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
            throw new LaunchConfigError('launch config.deviceIds: expected array of non-empty strings');
        }
        if (new Set(value).size !== value.length) {
            throw new LaunchConfigError('launch config.deviceIds: expected unique non-empty strings');
        }
        return;
    }
    if (key === 'splitMode') {
        if (!SPLIT_MODES.has(value)) {
            throw new LaunchConfigError('launch config.splitMode: expected one of none, layer, row');
        }
        return;
    }
    if (key === 'tensorSplit') {
        if (
            !Array.isArray(value)
            || value.length === 0
            || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0)
        ) {
            throw new LaunchConfigError('launch config.tensorSplit: expected non-empty array of positive numbers');
        }
        return;
    }
    if (key === 'cpuOffloadGiB') {
        requireNonNegativeNumber(value, key);
        return;
    }
    if (key === 'flashAttention') {
        if (!FLASH_ATTENTION_POLICIES.has(value)) {
            throw new LaunchConfigError('launch config.flashAttention: expected one of on, off, auto');
        }
        return;
    }
    if (BOOLEAN_FIELDS.has(key) && typeof value !== 'boolean') {
        throw new LaunchConfigError(`launch config.${key}: expected boolean`);
    }
}

function normalizeLaunchConfig(config) {
    ensureObject(config);
    rejectInvalidKeys(config);
    if (!Object.prototype.hasOwnProperty.call(config, 'launcherId')) {
        throw new LaunchConfigError('launch config.launcherId is required');
    }
    if (!Object.prototype.hasOwnProperty.call(config, 'instanceId')) {
        throw new LaunchConfigError('launch config.instanceId is required');
    }

    const normalized = {};
    for (const key of STARTUP_FIELD_NAMES) {
        if (!Object.prototype.hasOwnProperty.call(config, key) || config[key] === undefined) continue;
        validateStartupValue(key, config[key]);
        normalized[key] = Array.isArray(config[key]) ? [...config[key]] : config[key];
    }
    return normalized;
}

export {
    LaunchConfigError,
    normalizeLaunchConfig,
};
