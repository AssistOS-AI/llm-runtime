function readHeader(headers, name) {
    const direct = headers?.[name];
    const lower = headers?.[String(name).toLowerCase()];
    const value = Array.isArray(direct) ? direct[0] : direct || lower;
    return typeof value === 'string' ? value.trim() : '';
}

export function verifyRouterRequestFromHeaders(headers = {}, {
    replayCache,
    method,
    path,
    tool,
    rch,
} = {}) {
    if (readHeader(headers, 'authorization') !== 'Bearer fixture-valid-router-request') {
        return { ok: false, reason: 'missing router-request token' };
    }
    if (method !== 'POST') {
        return { ok: false, reason: 'method mismatch' };
    }
    if (path !== '/mcp') {
        return { ok: false, reason: 'path mismatch' };
    }
    if (!tool) {
        return { ok: false, reason: 'tool missing' };
    }
    if (readHeader(headers, 'x-fixture-rch') !== rch) {
        return { ok: false, reason: 'request hash mismatch' };
    }
    if (!replayCache || typeof replayCache.seen !== 'function' || typeof replayCache.remember !== 'function') {
        return { ok: false, reason: 'missing replay cache' };
    }
    const jti = readHeader(headers, 'x-fixture-jti');
    if (!jti) {
        return { ok: false, reason: 'jti missing' };
    }
    if (replayCache.seen(jti)) {
        return { ok: false, reason: 'jti has already been consumed' };
    }
    replayCache.remember(jti, 60_000);
    return {
        ok: true,
        payload: {
            typ: 'router-request',
            tool,
            rch,
            jti,
        },
    };
}

