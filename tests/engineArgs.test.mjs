import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildLlamaCppArgs,
    buildOpenVinoConfig,
    buildSGLangArgs,
    buildTensorRtLlmArgs,
    buildVllmArgs,
} from '../shared/runtime-agent/lib/engineArgs.mjs';

test('llama.cpp args map normalized startup fields to llama-server flags', () => {
    assert.deepEqual(buildLlamaCppArgs({
        contextTokens: 8192,
        concurrency: 4,
        gpuLayers: 35,
        batchTokens: 1024,
        prefillChunkTokens: 256,
        acceleratorReserveMiB: 1024,
        kvCachePrecision: 'q8_0',
        cpuThreads: 8,
        flashAttention: 'auto',
        deviceIds: ['0', '1'],
        splitMode: 'layer',
        tensorSplit: [1, 1],
        mainGpu: 0,
    }), [
        '--ctx-size', '8192',
        '--parallel', '4',
        '--n-gpu-layers', '35',
        '--batch-size', '1024',
        '--ubatch-size', '256',
        '--threads', '8',
        '--cache-type-k', 'q8_0',
        '--cache-type-v', 'q8_0',
        '--flash-attn', 'auto',
        '--fit', 'on',
        '--fit-target', '1024',
        '--device', '0,1',
        '--split-mode', 'layer',
        '--tensor-split', '1,1',
        '--main-gpu', '0',
    ]);
});

test('vLLM args map normalized startup fields to vllm serve flags', () => {
    assert.deepEqual(buildVllmArgs({
        contextTokens: 8192,
        acceleratorMemoryFraction: 0.82,
        concurrency: 16,
        batchTokens: 4096,
        kvCachePrecision: 'fp8',
        tensorParallelSize: 2,
        cpuOffloadGiB: 4.5,
    }), [
        '--max-model-len', '8192',
        '--gpu-memory-utilization', '0.82',
        '--max-num-seqs', '16',
        '--max-num-batched-tokens', '4096',
        '--kv-cache-dtype', 'fp8',
        '--tensor-parallel-size', '2',
        '--cpu-offload-gb', '4.5',
    ]);
});

test('SGLang args map normalized startup fields to server flags', () => {
    assert.deepEqual(buildSGLangArgs({
        contextTokens: 32768,
        acceleratorMemoryFraction: 0.7,
        concurrency: 12,
        prefillChunkTokens: 2048,
        kvCachePrecision: 'fp8_e5m2',
        tensorParallelSize: 4,
        enableMetrics: true,
    }), [
        '--context-length', '32768',
        '--mem-fraction-static', '0.7',
        '--max-running-requests', '12',
        '--chunked-prefill-size', '2048',
        '--kv-cache-dtype', 'fp8_e5m2',
        '--tp', '4',
        '--enable-metrics',
    ]);
});

test('TensorRT-LLM args map normalized startup fields to launch flags', () => {
    assert.deepEqual(buildTensorRtLlmArgs({
        tensorParallelSize: 2,
        pipelineParallelSize: 3,
        concurrency: 32,
        batchTokens: 8192,
    }), [
        '--tp_size', '2',
        '--pp_size', '3',
        '--max_batch_size', '32',
        '--max_num_tokens', '8192',
    ]);
});

test('OpenVINO config is deterministic and uses only normalized startup fields', () => {
    assert.deepEqual(buildOpenVinoConfig({
        deviceIds: ['GPU.1', 'GPU.0'],
        contextTokens: 4096,
        concurrency: 8,
        enableMetrics: true,
    }), {
        modelConfig: {
            device: 'GPU.1,GPU.0',
            maxModelLen: 4096,
        },
        pipelineConfig: {
            maxNumSeqs: 8,
            metrics: {
                enabled: true,
            },
        },
    });
});
