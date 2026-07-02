function hasValue(config, key) {
    return Object.prototype.hasOwnProperty.call(config || {}, key) && config[key] !== undefined && config[key] !== null;
}

function appendValue(args, flag, value) {
    args.push(flag, String(value));
}

function appendBoolean(args, flag, value) {
    if (value === true) args.push(flag);
}

function buildLlamaCppArgs(config = {}) {
    const args = [];
    if (hasValue(config, 'contextTokens')) appendValue(args, '--ctx-size', config.contextTokens);
    if (hasValue(config, 'concurrency')) appendValue(args, '--parallel', config.concurrency);
    if (hasValue(config, 'gpuLayers')) appendValue(args, '--n-gpu-layers', config.gpuLayers);
    if (hasValue(config, 'batchTokens')) appendValue(args, '--batch-size', config.batchTokens);
    if (hasValue(config, 'prefillChunkTokens')) appendValue(args, '--ubatch-size', config.prefillChunkTokens);
    if (hasValue(config, 'cpuThreads')) appendValue(args, '--threads', config.cpuThreads);
    if (hasValue(config, 'kvCachePrecision')) {
        appendValue(args, '--cache-type-k', config.kvCachePrecision);
        appendValue(args, '--cache-type-v', config.kvCachePrecision);
    }
    if (hasValue(config, 'flashAttention')) appendValue(args, '--flash-attn', config.flashAttention);
    if (hasValue(config, 'acceleratorReserveMiB')) {
        appendValue(args, '--fit', 'on');
        appendValue(args, '--fit-target', config.acceleratorReserveMiB);
    }
    if (Array.isArray(config.deviceIds) && config.deviceIds.length) {
        appendValue(args, '--device', config.deviceIds.join(','));
    }
    if (hasValue(config, 'splitMode')) appendValue(args, '--split-mode', config.splitMode);
    if (Array.isArray(config.tensorSplit) && config.tensorSplit.length) {
        appendValue(args, '--tensor-split', config.tensorSplit.join(','));
    }
    if (hasValue(config, 'mainGpu')) appendValue(args, '--main-gpu', config.mainGpu);
    return args;
}

function buildVllmArgs(config = {}) {
    const args = [];
    if (hasValue(config, 'contextTokens')) appendValue(args, '--max-model-len', config.contextTokens);
    if (hasValue(config, 'acceleratorMemoryFraction')) {
        appendValue(args, '--gpu-memory-utilization', config.acceleratorMemoryFraction);
    }
    if (hasValue(config, 'concurrency')) appendValue(args, '--max-num-seqs', config.concurrency);
    if (hasValue(config, 'batchTokens')) appendValue(args, '--max-num-batched-tokens', config.batchTokens);
    if (hasValue(config, 'kvCachePrecision')) appendValue(args, '--kv-cache-dtype', config.kvCachePrecision);
    if (hasValue(config, 'tensorParallelSize')) appendValue(args, '--tensor-parallel-size', config.tensorParallelSize);
    if (hasValue(config, 'cpuOffloadGiB')) appendValue(args, '--cpu-offload-gb', config.cpuOffloadGiB);
    return args;
}

function buildSGLangArgs(config = {}) {
    const args = [];
    if (hasValue(config, 'contextTokens')) appendValue(args, '--context-length', config.contextTokens);
    if (hasValue(config, 'acceleratorMemoryFraction')) {
        appendValue(args, '--mem-fraction-static', config.acceleratorMemoryFraction);
    }
    if (hasValue(config, 'concurrency')) appendValue(args, '--max-running-requests', config.concurrency);
    if (hasValue(config, 'prefillChunkTokens')) appendValue(args, '--chunked-prefill-size', config.prefillChunkTokens);
    if (hasValue(config, 'kvCachePrecision')) appendValue(args, '--kv-cache-dtype', config.kvCachePrecision);
    if (hasValue(config, 'tensorParallelSize')) appendValue(args, '--tp', config.tensorParallelSize);
    appendBoolean(args, '--enable-metrics', config.enableMetrics);
    return args;
}

function buildTensorRtLlmArgs(config = {}) {
    const args = [];
    if (hasValue(config, 'tensorParallelSize')) appendValue(args, '--tp_size', config.tensorParallelSize);
    if (hasValue(config, 'pipelineParallelSize')) appendValue(args, '--pp_size', config.pipelineParallelSize);
    if (hasValue(config, 'concurrency')) appendValue(args, '--max_batch_size', config.concurrency);
    if (hasValue(config, 'batchTokens')) appendValue(args, '--max_num_tokens', config.batchTokens);
    return args;
}

function buildOpenVinoConfig(config = {}) {
    const modelConfig = {};
    const pipelineConfig = {};

    if (Array.isArray(config.deviceIds) && config.deviceIds.length) {
        modelConfig.device = config.deviceIds.join(',');
    }
    if (hasValue(config, 'contextTokens')) {
        modelConfig.maxModelLen = config.contextTokens;
    }
    if (hasValue(config, 'concurrency')) {
        pipelineConfig.maxNumSeqs = config.concurrency;
    }
    if (hasValue(config, 'enableMetrics')) {
        pipelineConfig.metrics = { enabled: config.enableMetrics === true };
    }

    return {
        modelConfig,
        pipelineConfig,
    };
}

export {
    buildLlamaCppArgs,
    buildOpenVinoConfig,
    buildSGLangArgs,
    buildTensorRtLlmArgs,
    buildVllmArgs,
};
