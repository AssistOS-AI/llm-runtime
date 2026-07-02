import { VALID_LAUNCHER_ENGINES } from './runtimeContract.mjs';

const PROFILE_ID_RE = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const LAUNCHER_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]|[.](?=[a-zA-Z0-9_-])){0,127}$/;
const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACCELERATOR_FAMILIES = new Set(['cpu', 'nvidia-cuda', 'amd-rocm', 'vulkan', 'intel-openvino']);
const PLATFORMS = new Set(['linux/amd64', 'linux/arm64']);

class ProfileValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProfileValidationError';
        this.code = 'LLM_RUNTIME_PROFILE_INVALID';
    }
}

class LauncherDescribeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LauncherDescribeError';
        this.code = 'LLM_RUNTIME_LAUNCHER_DESCRIBE_INVALID';
    }
}

function ensureObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProfileValidationError(`${label}: expected object`);
    }
}

function ensureArray(value, label, minItems = 0) {
    if (!Array.isArray(value)) throw new ProfileValidationError(`${label}: expected array`);
    if (value.length < minItems) throw new ProfileValidationError(`${label}: requires at least ${minItems} item(s)`);
}

function rejectUnknownKeys(value, allowed, label) {
    for (const key of Object.keys(value || {})) {
        if (!allowed.has(key)) {
            throw new ProfileValidationError(`${label}: unknown field '${key}'`);
        }
    }
}

function validateAgentModelProfiles(doc, knownLauncherIds = null) {
    ensureObject(doc, 'agent-models.json');
    rejectUnknownKeys(doc, new Set(['schemaVersion', 'profiles']), 'agent-models.json');
    if (doc.schemaVersion !== 1) throw new ProfileValidationError('agent-models.json.schemaVersion must be 1');
    ensureArray(doc.profiles, 'agent-models.json.profiles');

    const seenIds = new Set();
    for (const profile of doc.profiles) {
        ensureObject(profile, 'profile');
        rejectUnknownKeys(profile, new Set(['id', 'description', 'candidates']), `profile`);
        if (!PROFILE_ID_RE.test(String(profile.id || ''))) {
            throw new ProfileValidationError(`profile.id '${profile.id}' is invalid`);
        }
        if (seenIds.has(profile.id)) {
            throw new ProfileValidationError(`duplicate profile id '${profile.id}'`);
        }
        seenIds.add(profile.id);
        ensureArray(profile.candidates, `profile '${profile.id}'.candidates`, 1);
        for (const candidate of profile.candidates) {
            ensureObject(candidate, `profile '${profile.id}' candidate`);
            rejectUnknownKeys(candidate, new Set(['launcher', 'priority', 'requiredAccelerators']), `candidate`);
            if (!LAUNCHER_NAME_RE.test(String(candidate.launcher || ''))) {
                throw new ProfileValidationError(`profile '${profile.id}' candidate.launcher invalid`);
            }
            if (knownLauncherIds && !knownLauncherIds.has(candidate.launcher)) {
                throw new ProfileValidationError(
                    `profile '${profile.id}' references unknown launcher '${candidate.launcher}'`
                );
            }
            if (candidate.priority !== undefined) {
                if (!Number.isInteger(candidate.priority) || candidate.priority < 0 || candidate.priority > 1000) {
                    throw new ProfileValidationError(`profile '${profile.id}' candidate.priority invalid`);
                }
            }
            if (candidate.requiredAccelerators !== undefined) {
                ensureArray(candidate.requiredAccelerators, `candidate.requiredAccelerators`);
                for (const acc of candidate.requiredAccelerators) {
                    if (!ACCELERATOR_FAMILIES.has(acc)) {
                        throw new ProfileValidationError(`candidate.requiredAccelerators: '${acc}' is unsupported`);
                    }
                }
            }
        }
    }
    return doc;
}

function validateLauncherDescribe(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new LauncherDescribeError('describe output: expected JSON object');
    }
    const allowed = new Set([
        'schemaVersion',
        'id',
        'modelId',
        'engine',
        'modelFormat',
        'hfRepoId',
        'hfRevision',
        'modelFiles',
        'supportedAccelerators',
        'supportedPlatforms',
        'configurableParameters',
        'profiles',
        'resourceEstimates',
    ]);
    for (const key of Object.keys(doc)) {
        if (!allowed.has(key)) throw new LauncherDescribeError(`describe output: unknown field '${key}'`);
    }
    if (doc.schemaVersion !== 1) throw new LauncherDescribeError('describe.schemaVersion must be 1');
    if (!LAUNCHER_NAME_RE.test(String(doc.id || ''))) throw new LauncherDescribeError('describe.id invalid');
    for (const field of ['modelId', 'modelFormat', 'hfRepoId', 'hfRevision']) {
        if (typeof doc[field] !== 'string' || !doc[field].trim()) {
            throw new LauncherDescribeError(`describe.${field} missing`);
        }
    }
    if (!VALID_LAUNCHER_ENGINES.includes(doc.engine)) {
        throw new LauncherDescribeError(`describe.engine must be one of ${VALID_LAUNCHER_ENGINES.join(', ')}`);
    }
    if (!Array.isArray(doc.modelFiles) || doc.modelFiles.length === 0) {
        throw new LauncherDescribeError('describe.modelFiles must list at least one file');
    }
    for (const modelFile of doc.modelFiles) {
        if (typeof modelFile !== 'string' || !modelFile.trim()) {
            throw new LauncherDescribeError('describe.modelFiles entries must be non-empty strings');
        }
    }
    if (!Array.isArray(doc.supportedAccelerators) || doc.supportedAccelerators.length === 0) {
        throw new LauncherDescribeError('describe.supportedAccelerators must list at least one family');
    }
    for (const acc of doc.supportedAccelerators) {
        if (!ACCELERATOR_FAMILIES.has(acc)) throw new LauncherDescribeError(`describe.supportedAccelerators: '${acc}' unsupported`);
    }
    if (!Array.isArray(doc.supportedPlatforms) || doc.supportedPlatforms.length === 0) {
        throw new LauncherDescribeError('describe.supportedPlatforms must list at least one platform');
    }
    for (const plat of doc.supportedPlatforms) {
        if (!PLATFORMS.has(plat)) {
            throw new LauncherDescribeError(`describe.supportedPlatforms: '${plat}' unsupported`);
        }
    }
    for (const field of ['configurableParameters', 'profiles', 'resourceEstimates']) {
        if (!doc[field] || typeof doc[field] !== 'object' || Array.isArray(doc[field])) {
            throw new LauncherDescribeError(`describe.${field} must be object`);
        }
    }
    return doc;
}

function validateInstanceId(value) {
    return INSTANCE_ID_RE.test(String(value || ''));
}

function validateLauncherName(value) {
    return LAUNCHER_NAME_RE.test(String(value || ''));
}

export {
    ACCELERATOR_FAMILIES,
    INSTANCE_ID_RE,
    LAUNCHER_NAME_RE,
    LauncherDescribeError,
    PLATFORMS,
    PROFILE_ID_RE,
    ProfileValidationError,
    validateAgentModelProfiles,
    validateInstanceId,
    validateLauncherDescribe,
    validateLauncherName,
};
