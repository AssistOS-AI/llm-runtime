const REDACTED_NAMES = new Set([
    'HF_TOKEN',
    'HUGGINGFACE_TOKEN',
    'HUGGINGFACEHUB_API_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'PLOINKY_MASTER_KEY',
    'PLOINKY_DERIVED_MASTER_KEY',
]);

const SECRET_VALUE_PATTERNS = [
    /hf_[A-Za-z0-9]{16,}/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /Bearer\s+[A-Za-z0-9._-]{16,}/g,
];

function redactValue(value) {
    if (typeof value !== 'string') return value;
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
        out = out.replace(pattern, '[REDACTED]');
    }
    return out;
}

function redactEnv(env) {
    const out = {};
    for (const [name, value] of Object.entries(env || {})) {
        if (REDACTED_NAMES.has(name)) {
            out[name] = '[REDACTED]';
        } else {
            out[name] = redactValue(value);
        }
    }
    return out;
}

function redactString(value) {
    return redactValue(value);
}

export {
    REDACTED_NAMES,
    redactEnv,
    redactString,
    redactValue,
};
