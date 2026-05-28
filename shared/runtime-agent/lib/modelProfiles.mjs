import { validateAgentModelProfiles } from './schemas.mjs';

function loadProfiles(rawJson, knownLauncherIds) {
    return validateAgentModelProfiles(rawJson, knownLauncherIds);
}

function listProfiles(doc) {
    if (!doc?.profiles) return [];
    return doc.profiles.map((profile) => ({
        id: profile.id,
        description: profile.description || '',
        candidateCount: Array.isArray(profile.candidates) ? profile.candidates.length : 0,
    }));
}

function describeProfile(doc, profileId) {
    if (!doc?.profiles) return null;
    return doc.profiles.find((profile) => profile.id === profileId) || null;
}

function applyPriorityOverrides(doc, overrides = []) {
    if (!doc?.profiles) return doc;
    const cloned = JSON.parse(JSON.stringify(doc));
    for (const override of overrides) {
        if (!override || typeof override !== 'object') continue;
        const profile = cloned.profiles.find((p) => p.id === override.profileId);
        if (!profile) continue;
        const knownLaunchers = new Set(profile.candidates.map((c) => c.launcher));
        if (!Array.isArray(override.order)) continue;
        for (const launcherName of override.order) {
            if (!knownLaunchers.has(launcherName)) {
                throw new Error(`priority override references unknown launcher '${launcherName}' for profile '${profile.id}'`);
            }
        }
        const ordered = [];
        for (const launcherName of override.order) {
            const cand = profile.candidates.find((c) => c.launcher === launcherName);
            if (cand) ordered.push(cand);
        }
        // Keep any unlisted candidates at the tail in original order.
        for (const cand of profile.candidates) {
            if (!override.order.includes(cand.launcher)) ordered.push(cand);
        }
        profile.candidates = ordered;
    }
    return cloned;
}

function selectCandidate(profile, hardware) {
    if (!profile || !Array.isArray(profile.candidates)) return null;
    const families = new Set(hardware?.acceleratorFamilies || ['cpu']);
    for (const candidate of profile.candidates) {
        const required = Array.isArray(candidate.requiredAccelerators) && candidate.requiredAccelerators.length
            ? candidate.requiredAccelerators
            : ['cpu'];
        if (required.every((acc) => families.has(acc))) {
            return candidate;
        }
    }
    return null;
}

export {
    applyPriorityOverrides,
    describeProfile,
    listProfiles,
    loadProfiles,
    selectCandidate,
};
