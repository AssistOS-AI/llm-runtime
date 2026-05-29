const REDACTED_NAMES = new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_TOKEN',
    'API_KEY',
    'AXIOLOGIC_API_KEY',
    'GEMINI_API_KEY',
    'HF_TOKEN',
    'HUGGING_FACE_HUB_TOKEN',
    'HUGGINGFACE_TOKEN',
    'HUGGINGFACEHUB_API_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_API_TOKEN',
    'OPENAI_TOKEN',
    'OPENROUTER_API_KEY',
    'PLOINKY_DERIVED_MASTER_KEY',
    'PLOINKY_MASTER_KEY',
    'SOUL_GATEWAY_API_KEY',
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
    shouldRedactEnvName,
};
