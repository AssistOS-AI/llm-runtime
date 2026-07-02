const REDACTED_NAMES = new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_TOKEN',
    'API_KEY',
    'AXIOLOGIC_API_KEY',
    'GEMINI_API_KEY',
    'HUGGING_FACE_HUB_TOKEN',
    'HUGGINGFACE_TOKEN',
    'HUGGINGFACEHUB_API_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_API_TOKEN',
    'OPENAI_TOKEN',
    'OPENROUTER_API_KEY',
    'PLOINKY_AGENT_API_KEY',
    'PLOINKY_DERIVED_MASTER_KEY',
    'PLOINKY_MASTER_KEY',
]);

const SECRET_VALUE_PATTERNS = [
    /Authorization:\s*Bearer\s+[^\s"',}\\\]]+/gi,
    /hf_[A-Za-z0-9][A-Za-z0-9_-]{7,}/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /Bearer\s+[A-Za-z0-9._-]{16,}/g,
];

const REDACTED_VALUE = '[REDACTED]';
const ENV_NAME_TOKEN_RE = /\b[A-Z][A-Z0-9_]{2,}\b/g;

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function secretValuesFromEnv(env = process.env) {
    const values = [];
    for (const [name, value] of Object.entries(env || {})) {
        if (!shouldRedactEnvName(name) || typeof value !== 'string' || value.length < 4) continue;
        values.push(value);
    }
    return values.sort((a, b) => b.length - a.length);
}

function redactValue(value, options = {}) {
    if (typeof value !== 'string') return value;
    const env = options.env || process.env;
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
        out = out.replace(pattern, REDACTED_VALUE);
    }
    for (const secret of secretValuesFromEnv(env)) {
        out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED_VALUE);
    }
    out = out.replace(ENV_NAME_TOKEN_RE, (candidate) => (
        shouldRedactEnvName(candidate) ? REDACTED_VALUE : candidate
    ));
    return out;
}

function shouldRedactEnvName(name) {
    if (typeof name !== 'string' || !name) return false;
    const upper = name.toUpperCase();
    return REDACTED_NAMES.has(upper)
        || /(^|_)(SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|CREDENTIALS)($|_)/.test(upper)
        || upper.includes('API_KEY')
        || upper.includes('APIKEY')
        || upper.includes('PRIVATE_KEY')
        || upper.includes('MASTER_KEY')
        || upper.includes('ENCRYPTION_KEY')
        || upper.includes('JWT_SECRET');
}

function redactEnv(env) {
    const out = {};
    for (const [name, value] of Object.entries(env || {})) {
        if (shouldRedactEnvName(name)) {
            out[name] = REDACTED_VALUE;
        } else {
            out[name] = redactValue(value);
        }
    }
    return out;
}

function redactObject(value, options = {}, seen = new WeakSet()) {
    if (typeof value === 'string') return redactValue(value, options);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return REDACTED_VALUE;
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((entry) => redactObject(entry, options, seen));
    }

    const dropSecretKeys = options.dropSecretKeys !== false;
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (shouldRedactEnvName(key)) {
            if (!dropSecretKeys) out[key] = REDACTED_VALUE;
            continue;
        }
        out[key] = redactObject(entry, options, seen);
    }
    return out;
}

function redactString(value, options = {}) {
    return redactValue(value, options);
}

export {
    REDACTED_NAMES,
    REDACTED_VALUE,
    redactEnv,
    redactObject,
    redactString,
    redactValue,
    secretValuesFromEnv,
    shouldRedactEnvName,
};
