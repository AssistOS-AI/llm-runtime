import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { DEFAULT_RUNTIME_PATHS } from './runtimeContract.mjs';
import { redactObject, redactString } from './redaction.mjs';

const DEFAULT_RUNTIME_DIR = DEFAULT_RUNTIME_PATHS.runtimeDir;
const DEFAULT_ENGINE_VERSIONS_LOCK_PATH = '/opt/ploinky/engineVersions.lock.json';
const DEFAULT_DIRECTORY_MANIFEST_THRESHOLD_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_DIRECTORY_MANIFEST_ENTRIES = 4096;
const DEFAULT_MAX_DIRECTORY_READ_ENTRIES = 4096;
const DEFAULT_MAX_HASHED_DIRECTORY_FILES = 128;
const DEFAULT_MAX_DIRECTORY_VISITED_DIRECTORIES = 1024;
const DEFAULT_MAX_DIRECTORY_VISITED_ENTRIES = 8192;
const DEFAULT_MAX_DIRECTORY_TRAVERSAL_DEPTH = 32;
const FLAT_ENGINE_LOCK_FIELDS = Object.freeze([
    'imageId',
    'platform',
    'supportedEngines',
    'lockfilePath',
    'llamaCppCommit',
    'llamaCppVersion',
    'vllmVersion',
    'sglangVersion',
    'tensorRtLlmVersion',
    'tensorrtLlmVersion',
    'tensorrtVersion',
    'openvinoModelServerVersion',
    'openvinoVersion',
    'cudaVersion',
    'rocmVersion',
    'vulkanVersion',
    'pythonVersion',
]);
const NESTED_RUNTIME_LOCK_FIELDS = Object.freeze([
    'node',
    'nodeVersion',
    'pythonVersion',
    'baseImage',
    'baseImageDigest',
    'cudaVersion',
    'rocmVersion',
    'vulkanVersion',
    'openvinoVersion',
]);
const NESTED_ENGINE_LOCK_FIELDS = Object.freeze([
    'version',
    'commit',
    'revision',
    'build',
    'buildId',
    'engineVersion',
    'engineCommit',
    'llamaCppCommit',
    'llamaCppVersion',
    'vllmVersion',
    'sglangVersion',
    'tensorRtLlmVersion',
    'tensorrtLlmVersion',
    'tensorrtVersion',
    'openvinoModelServerVersion',
    'openvinoVersion',
    'cudaVersion',
    'rocmVersion',
    'vulkanVersion',
    'pythonVersion',
]);

function parseJsonFile(filePath, label) {
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`${label} '${filePath}' is not valid JSON: ${redactString(err.message)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} '${filePath}' is not a JSON object`);
    }
    return parsed;
}

function readSelectedArchitecture(runtimeDir = DEFAULT_RUNTIME_DIR) {
    const filePath = path.join(runtimeDir, 'selected-architecture.json');
    if (!fs.existsSync(filePath)) {
        throw new Error(`runtime state missing: ${filePath}. The container was not started with hardware-aware LLM startup.`);
    }
    return redactObject(parseJsonFile(filePath, 'runtime state'));
}

function readSelectedArchitectureIfExists(runtimeDir = DEFAULT_RUNTIME_DIR) {
    const filePath = path.join(runtimeDir, 'selected-architecture.json');
    if (!fs.existsSync(filePath)) return null;
    return readSelectedArchitecture(runtimeDir);
}

function ensureRuntimeSubdir(runtimeDir, subdir) {
    const full = path.join(runtimeDir, subdir);
    fs.mkdirSync(full, { recursive: true });
    return full;
}

function selectedImageTraceability(selectedArchitecture) {
    const selected = selectedArchitecture && typeof selectedArchitecture === 'object' ? selectedArchitecture : {};
    const architecture = selected.architecture && typeof selected.architecture === 'object'
        ? selected.architecture
        : {};
    const image = selected.image && typeof selected.image === 'object'
        ? selected.image
        : {};
    return {
        imageRef: architecture.imageRef || image.ref || selected.imageRef || null,
        imageDigest: architecture.imageDigest || image.digest || selected.imageDigest || null,
    };
}

function safeLockValue(value) {
    if (value === null) return null;
    if (['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (Array.isArray(value) && value.every((entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))) {
        return [...value];
    }
    return undefined;
}

function pickLockFields(source, fields) {
    const out = {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
        const value = safeLockValue(source[field]);
        if (value !== undefined) out[field] = value;
    }
    return out;
}

function selectEngineVersions(lock, engine) {
    if (!lock || typeof lock !== 'object') return null;
    const out = {};
    const schemaVersion = safeLockValue(lock.schemaVersion);
    if (schemaVersion !== undefined) out.schemaVersion = schemaVersion;
    Object.assign(out, pickLockFields(lock, FLAT_ENGINE_LOCK_FIELDS));
    if (lock.image && typeof lock.image === 'object' && !Array.isArray(lock.image)) {
        out.image = {};
        for (const key of ['id', 'ref', 'digest', 'platform']) {
            const value = safeLockValue(lock.image[key]);
            if (value !== undefined) out.image[key] = value;
        }
        if (Object.keys(out.image).length === 0) delete out.image;
    }
    if (lock.runtime && typeof lock.runtime === 'object' && !Array.isArray(lock.runtime)) {
        const runtime = pickLockFields(lock.runtime, NESTED_RUNTIME_LOCK_FIELDS);
        if (Object.keys(runtime).length) out.runtime = runtime;
    }
    if (lock.engines && typeof lock.engines === 'object' && !Array.isArray(lock.engines)) {
        if (engine && lock.engines[engine] !== undefined) {
            const picked = pickLockFields(lock.engines[engine], NESTED_ENGINE_LOCK_FIELDS);
            if (Object.keys(picked).length) out.engines = { [engine]: picked };
        } else if (!engine) {
            const engines = {};
            for (const [engineId, engineLock] of Object.entries(lock.engines)) {
                const picked = pickLockFields(engineLock, NESTED_ENGINE_LOCK_FIELDS);
                if (Object.keys(picked).length) engines[engineId] = picked;
            }
            if (Object.keys(engines).length) out.engines = engines;
        }
    }
    return Object.keys(out).length ? redactObject(out) : null;
}

function readEngineVersionsLock(options = {}) {
    const filePath = options.engineVersionsPath || DEFAULT_ENGINE_VERSIONS_LOCK_PATH;
    if (!filePath || !fs.existsSync(filePath)) return null;
    const lock = parseJsonFile(filePath, 'engine versions lock');
    return selectEngineVersions(lock, options.engine);
}

function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(1024 * 1024);
        while (true) {
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function normalizedMtimeMs(stat) {
    return Math.trunc(stat.mtimeMs);
}

function digestFile(filePath, stat) {
    return {
        type: 'file',
        algorithm: 'sha256',
        sha256: hashFile(filePath),
        size: stat.size,
        mtimeMs: normalizedMtimeMs(stat),
    };
}

function directoryManifestEntryLimit(options = {}) {
    if (Number.isInteger(options.maxDirectoryManifestEntries)) {
        return Math.max(0, options.maxDirectoryManifestEntries);
    }
    return DEFAULT_MAX_DIRECTORY_MANIFEST_ENTRIES;
}

function directoryTraversalLimits(options = {}, maxManifestEntries = DEFAULT_MAX_DIRECTORY_MANIFEST_ENTRIES) {
    const maxVisitedDirectories = Number.isInteger(options.maxDirectoryVisitedDirectories)
        ? Math.max(1, options.maxDirectoryVisitedDirectories)
        : DEFAULT_MAX_DIRECTORY_VISITED_DIRECTORIES;
    const maxVisitedEntries = Number.isInteger(options.maxDirectoryVisitedEntries)
        ? Math.max(0, options.maxDirectoryVisitedEntries)
        : DEFAULT_MAX_DIRECTORY_VISITED_ENTRIES;
    const maxTraversalDepth = Number.isInteger(options.maxDirectoryTraversalDepth)
        ? Math.max(0, options.maxDirectoryTraversalDepth)
        : DEFAULT_MAX_DIRECTORY_TRAVERSAL_DEPTH;
    const readEntryLimit = Number.isInteger(options.maxDirectoryReadEntries)
        ? Math.max(0, options.maxDirectoryReadEntries)
        : Math.max(DEFAULT_MAX_DIRECTORY_READ_ENTRIES, maxManifestEntries + 1);
    return {
        maxTraversalDepth,
        maxVisitedDirectories,
        maxVisitedEntries,
        readEntryLimit,
    };
}

function readBoundedDirEntries(dirPath, limit) {
    const entries = [];
    let proofEntryRead = 0;
    let truncated = false;
    if (limit <= 0) {
        return { entries, proofEntryRead, truncated: true };
    }
    const dir = fs.opendirSync(dirPath);
    try {
        while (true) {
            const entry = dir.readSync();
            if (!entry) break;
            if (entries.length >= limit) {
                proofEntryRead = 1;
                truncated = true;
                break;
            }
            entries.push(entry);
        }
    } finally {
        dir.closeSync();
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, proofEntryRead, truncated };
}

function collectDirectoryFiles(rootDir, options = {}) {
    const maxManifestEntries = directoryManifestEntryLimit(options);
    const limits = directoryTraversalLimits(options, maxManifestEntries);
    const files = [];
    let visitedFileCount = 0;
    let visitedDirectoryCount = 0;
    let visitedEntryCount = 0;
    let visitedBytes = 0;
    let truncated = false;
    const truncationReasons = new Set();
    const stack = [];
    const markTruncated = (reason) => {
        truncated = true;
        truncationReasons.add(reason);
    };

    if (maxManifestEntries === 0) {
        markTruncated('manifest-entry-cap');
        return {
            files,
            maxManifestEntries,
            ...limits,
            truncated,
            truncationReasons: Array.from(truncationReasons).sort(),
            visitedBytes,
            visitedDirectoryCount: 1,
            visitedEntryCount,
            visitedFileCount,
        };
    }

    const pushDirectory = (dirPath, depth) => {
        if (visitedDirectoryCount >= limits.maxVisitedDirectories) {
            markTruncated('max-visited-directories');
            return;
        }
        if (depth > limits.maxTraversalDepth) {
            markTruncated('max-traversal-depth');
            return;
        }
        visitedDirectoryCount += 1;
        const remainingEntryBudget = limits.maxVisitedEntries - visitedEntryCount;
        if (remainingEntryBudget <= 0) {
            markTruncated('max-visited-entries');
            return;
        }
        const readLimit = Math.min(limits.readEntryLimit, remainingEntryBudget);
        const { entries, proofEntryRead, truncated: readTruncated } = readBoundedDirEntries(dirPath, readLimit);
        visitedEntryCount += entries.length + proofEntryRead;
        if (readTruncated) {
            markTruncated(readLimit >= remainingEntryBudget ? 'max-visited-entries' : 'directory-entry-read-cap');
        }
        stack.push({
            dirPath,
            entries,
            index: 0,
            depth,
        });
    };

    pushDirectory(rootDir, 0);

    while (stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.index >= frame.entries.length) {
            stack.pop();
            continue;
        }
        const entry = frame.entries[frame.index];
        frame.index += 1;
        const fullPath = path.join(frame.dirPath, entry.name);
        if (entry.isDirectory()) {
            pushDirectory(fullPath, frame.depth + 1);
            continue;
        }
        if (!entry.isFile()) continue;
        const stat = fs.statSync(fullPath);
        visitedFileCount += 1;
        visitedBytes += stat.size;
        if (files.length < maxManifestEntries) {
            files.push({
                fullPath,
                relativePath: path.relative(rootDir, fullPath).split(path.sep).join('/'),
                stat,
            });
            continue;
        }
        markTruncated('manifest-entry-cap');
        break;
    }

    return {
        files,
        maxManifestEntries,
        ...limits,
        truncated,
        truncationReasons: Array.from(truncationReasons).sort(),
        visitedBytes,
        visitedDirectoryCount,
        visitedEntryCount,
        visitedFileCount,
    };
}

function digestDirectory(dirPath, options = {}) {
    const traversal = collectDirectoryFiles(dirPath, options);
    const { files } = traversal;
    const totalBytes = traversal.visitedBytes;
    const threshold = Number.isFinite(options.directoryManifestThresholdBytes)
        ? options.directoryManifestThresholdBytes
        : DEFAULT_DIRECTORY_MANIFEST_THRESHOLD_BYTES;
    const maxHashes = Number.isInteger(options.maxHashedDirectoryFiles)
        ? Math.max(0, options.maxHashedDirectoryFiles)
        : DEFAULT_MAX_HASHED_DIRECTORY_FILES;
    const shouldHashAll = !traversal.truncated && totalBytes <= threshold;
    const manifest = files.map((entry, index) => {
        const item = {
            path: entry.relativePath,
            size: entry.stat.size,
            mtimeMs: normalizedMtimeMs(entry.stat),
        };
        if (shouldHashAll || index < maxHashes) {
            item.sha256 = hashFile(entry.fullPath);
        }
        return item;
    });
    const digestInput = traversal.truncated
        ? {
            manifest,
            maxManifestEntries: traversal.maxManifestEntries,
            truncated: true,
            truncationReasons: traversal.truncationReasons,
            visitedEntryCount: traversal.visitedEntryCount,
            visitedFileCount: traversal.visitedFileCount,
        }
        : manifest;
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify(digestInput))
        .digest('hex');
    return {
        type: 'directory-manifest',
        algorithm: 'sha256',
        sha256: digest,
        fileCount: traversal.visitedFileCount,
        totalBytes,
        totalBytesComplete: !traversal.truncated,
        manifestEntryCount: manifest.length,
        maxManifestEntries: traversal.maxManifestEntries,
        maxTraversalDepth: traversal.maxTraversalDepth,
        maxVisitedDirectories: traversal.maxVisitedDirectories,
        maxVisitedEntries: traversal.maxVisitedEntries,
        readEntryLimit: traversal.readEntryLimit,
        truncated: traversal.truncated,
        truncationReasons: traversal.truncationReasons,
        visitedDirectoryCount: traversal.visitedDirectoryCount,
        visitedEntryCount: traversal.visitedEntryCount,
        visitedFileCount: traversal.visitedFileCount,
        manifest,
    };
}

function digestArtifactPath(artifactPath, options = {}) {
    const stat = fs.statSync(artifactPath);
    if (stat.isFile()) return digestFile(artifactPath, stat);
    if (stat.isDirectory()) return digestDirectory(artifactPath, options);
    return {
        type: 'unsupported',
        mode: stat.mode,
    };
}

function digestArtifactPaths(artifactPaths = [], options = {}) {
    const out = {};
    for (const artifactPath of artifactPaths) {
        if (typeof artifactPath !== 'string' || !artifactPath) continue;
        try {
            out[artifactPath] = digestArtifactPath(artifactPath, options);
        } catch (err) {
            out[artifactPath] = {
                type: 'unavailable',
                error: redactString(err.message),
            };
        }
    }
    return out;
}

export {
    DEFAULT_ENGINE_VERSIONS_LOCK_PATH,
    DEFAULT_MAX_DIRECTORY_MANIFEST_ENTRIES,
    DEFAULT_MAX_DIRECTORY_READ_ENTRIES,
    DEFAULT_MAX_DIRECTORY_TRAVERSAL_DEPTH,
    DEFAULT_MAX_DIRECTORY_VISITED_DIRECTORIES,
    DEFAULT_MAX_DIRECTORY_VISITED_ENTRIES,
    DEFAULT_RUNTIME_DIR,
    digestArtifactPath,
    digestArtifactPaths,
    ensureRuntimeSubdir,
    readEngineVersionsLock,
    readSelectedArchitecture,
    readSelectedArchitectureIfExists,
    selectedImageTraceability,
};
