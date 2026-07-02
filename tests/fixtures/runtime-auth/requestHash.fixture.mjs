function canonicalJson(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function computeRchTool({ method, path, tool, arguments: args }) {
    return canonicalJson({
        method: String(method ?? ''),
        path: String(path ?? ''),
        tool: String(tool ?? ''),
        arguments: args === undefined || args === null ? {} : args,
    });
}

