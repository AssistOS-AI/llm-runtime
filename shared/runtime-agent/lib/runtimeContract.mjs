const DEFAULT_RUNTIME_PATHS = Object.freeze({
    hfHome: '/models/hf-cache',
    modelsDir: '/models/artifacts',
    derivedDir: '/models/derived',
    runtimeDir: '/runtime',
    launchersDir: '/workspace/modelLaunchers',
});

const DEFAULT_RUNTIME_PORTS = Object.freeze({
    mcp: 9000,
    inference: 8080,
});

const DEFAULT_RUNTIME_ENV = Object.freeze({
    HF_HOME: DEFAULT_RUNTIME_PATHS.hfHome,
    PLOINKY_MODELS_DIR: DEFAULT_RUNTIME_PATHS.modelsDir,
    PLOINKY_DERIVED_DIR: DEFAULT_RUNTIME_PATHS.derivedDir,
    PLOINKY_RUNTIME_DIR: DEFAULT_RUNTIME_PATHS.runtimeDir,
    PLOINKY_LAUNCHERS_DIR: DEFAULT_RUNTIME_PATHS.launchersDir,
    PLOINKY_MCP_PORT: String(DEFAULT_RUNTIME_PORTS.mcp),
    PLOINKY_INFERENCE_PORT: String(DEFAULT_RUNTIME_PORTS.inference),
});

const STARTUP_FIELD_NAMES = Object.freeze([
    'launcherId',
    'instanceId',
    'profile',
    'contextTokens',
    'concurrency',
    'batchTokens',
    'prefillChunkTokens',
    'acceleratorMemoryFraction',
    'acceleratorReserveMiB',
    'kvCachePrecision',
    'gpuLayers',
    'tensorParallelSize',
    'pipelineParallelSize',
    'deviceIds',
    'splitMode',
    'tensorSplit',
    'mainGpu',
    'cpuThreads',
    'cpuOffloadGiB',
    'flashAttention',
    'enableMetrics',
]);

const FORBIDDEN_GENERATION_FIELDS = Object.freeze([
    'temperature',
    'topP',
    'top_p',
    'maxTokens',
    'max_tokens',
    'responseFormat',
    'response_format',
    'tools',
    'toolChoice',
    'tool_choice',
    'stream',
    'messages',
    'stop',
    'presencePenalty',
    'presence_penalty',
    'frequencyPenalty',
    'frequency_penalty',
]);

const VALID_LAUNCHER_ENGINES = Object.freeze([
    'llamacpp',
    'vllm',
    'sglang',
    'trtllm',
    'openvino',
]);

const MCP_TOOL_NAMES = Object.freeze([
    'runtime.describe',
    'launchers.list',
    'launchers.describe',
    'launchers.prepare',
    'launchers.start',
    'instance.status',
    'instance.stop',
    'instance.logs',
]);

function positivePort(value, fallback) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function runtimePathsFromEnv(env = process.env) {
    return {
        hfHome: env.HF_HOME || DEFAULT_RUNTIME_PATHS.hfHome,
        modelsDir: env.PLOINKY_MODELS_DIR || DEFAULT_RUNTIME_PATHS.modelsDir,
        derivedDir: env.PLOINKY_DERIVED_DIR || DEFAULT_RUNTIME_PATHS.derivedDir,
        runtimeDir: env.PLOINKY_RUNTIME_DIR || DEFAULT_RUNTIME_PATHS.runtimeDir,
        launchersDir: env.PLOINKY_LAUNCHERS_DIR || DEFAULT_RUNTIME_PATHS.launchersDir,
    };
}

function runtimePortsFromEnv(env = process.env) {
    return {
        mcp: positivePort(env.PLOINKY_MCP_PORT, DEFAULT_RUNTIME_PORTS.mcp),
        inference: positivePort(env.PLOINKY_INFERENCE_PORT, DEFAULT_RUNTIME_PORTS.inference),
    };
}

function runtimeEnvFromEnv(env = process.env) {
    const paths = runtimePathsFromEnv(env);
    const ports = runtimePortsFromEnv(env);
    return {
        HF_HOME: paths.hfHome,
        PLOINKY_MODELS_DIR: paths.modelsDir,
        PLOINKY_DERIVED_DIR: paths.derivedDir,
        PLOINKY_RUNTIME_DIR: paths.runtimeDir,
        PLOINKY_LAUNCHERS_DIR: paths.launchersDir,
        PLOINKY_MCP_PORT: String(ports.mcp),
        PLOINKY_INFERENCE_PORT: String(ports.inference),
    };
}

export {
    DEFAULT_RUNTIME_ENV,
    DEFAULT_RUNTIME_PATHS,
    DEFAULT_RUNTIME_PORTS,
    FORBIDDEN_GENERATION_FIELDS,
    MCP_TOOL_NAMES,
    STARTUP_FIELD_NAMES,
    VALID_LAUNCHER_ENGINES,
    runtimeEnvFromEnv,
    runtimePathsFromEnv,
    runtimePortsFromEnv,
};
