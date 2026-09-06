#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MAX_GIT_BLOB_BYTES = 16 * 1024 * 1024;
const SAFE_DIST_PATH_PATTERN = /^(?:assets\/[A-Za-z0-9._-]+|build-provenance\.json|index\.html)$/;


const fail = (message) => {
    throw new Error(message);
};


const parseArguments = () => {
    const values = {};
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index];
        const value = process.argv[index + 1];
        if (key?.startsWith('--') !== true || value === undefined) {
            fail('Arguments must be --name value pairs.');
        }
        if (values[key] !== undefined) fail(`Duplicate argument: ${key}`);
        values[key] = value;
    }
    for (const required of ['--dplayer-repo', '--mpeg2toh264-repo', '--served-base-url', '--output']) {
        if (values[required] === undefined) fail(`Missing required argument: ${required}`);
    }
    return values;
};


const sha256 = (content) => createHash('sha256').update(content).digest('hex');


const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));


const gitOutput = (repo, ...arguments_) => execFileSync('git', ['-C', repo, ...arguments_], {
    encoding: 'utf8',
}).trim();


const requireCleanCommit = (repo, commit, name) => {
    if (COMMIT_PATTERN.test(commit) === false) fail(`${name} has an invalid commit.`);
    if (gitOutput(repo, 'rev-parse', '--verify', 'HEAD^{commit}') !== commit) {
        fail(`${name} checkout does not match its declared dist commit.`);
    }
    if (gitOutput(repo, 'status', '--porcelain=v1', '--untracked-files=normal') !== '') {
        fail(`${name} checkout is not clean.`);
    }
    const parents = gitOutput(repo, 'show', '-s', '--format=%P', commit).split(/\s+/);
    if (parents.length !== 1 || COMMIT_PATTERN.test(parents[0]) === false) {
        fail(`${name} dist commit must have exactly one source parent.`);
    }
    return parents[0];
};


const requireExactKeys = (value, keys, name) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${name} must be an object.`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${name} has unexpected fields.`);
};


const requireSafeDistPath = (path) => {
    if (SAFE_DIST_PATH_PATTERN.test(path) === false) fail(`Unsafe dist path: ${path}`);
    return path;
};


const fileRecord = (root, path) => {
    requireSafeDistPath(path);
    const absolute_path = resolve(root, path);
    const root_prefix = `${resolve(root)}${sep}`;
    if (absolute_path.startsWith(root_prefix) === false || statSync(absolute_path).isFile() === false) {
        fail(`Missing dist file: ${path}`);
    }
    const content = readFileSync(absolute_path);
    return Object.freeze({path, bytes: content.length, sha256: sha256(content), content});
};


const publicFileRecord = (record) => Object.freeze({
    path: record.path,
    bytes: record.bytes,
    sha256: record.sha256,
});


const findUnique = (content, pattern, name) => {
    const matches = [...new Set([...content.matchAll(pattern)].map((match) => match[1]))];
    if (matches.length !== 1) fail(`Expected exactly one ${name}; found ${matches.length}.`);
    return matches[0];
};


const extractPinnedCommit = (dependency, name) => {
    if (typeof dependency !== 'string') fail(`${name} dependency is unavailable.`);
    const match = dependency.match(/#([0-9a-f]{40})$/);
    if (match === null) fail(`${name} dependency is not pinned to a full commit.`);
    return match[1];
};


const requireInstalledGitBlob = (repo, commit, git_path, installed_path, name) => {
    const expected = execFileSync('git', ['-C', repo, 'show', `${commit}:${git_path}`], {
        maxBuffer: MAX_GIT_BLOB_BYTES,
    });
    const installed = readFileSync(installed_path);
    if (installed.equals(expected) === false) fail(`${name} does not match its declared Git blob.`);
    return Object.freeze({path: git_path, bytes: installed.length, sha256: sha256(installed)});
};


const distTreeRecord = (root) => {
    const entries = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, {withFileTypes: true}).sort((left, right) => {
            if (left.name < right.name) return -1;
            if (left.name > right.name) return 1;
            return 0;
        })) {
            const absolute_path = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                visit(absolute_path);
            } else if (entry.isFile()) {
                const path = relative(root, absolute_path).split(sep).join('/');
                const content = readFileSync(absolute_path);
                entries.push({path, bytes: content.length, sha256: sha256(content)});
            } else {
                fail(`Dist contains a non-file entry: ${entry.name}`);
            }
        }
    };
    visit(root);
    const digest_input = entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
    return Object.freeze({fileCount: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), sha256: sha256(digest_input)});
};


const fetchServedRecord = async (base_url, local_record, build_id) => {
    const url = new URL(`/${local_record.path}`, base_url);
    url.searchParams.set('provenance-check', build_id);
    const expected_origin = new URL(base_url).origin;
    const response = await fetch(url, {cache: 'no-store', redirect: 'follow'});
    if (response.ok === false) fail(`Served ${local_record.path} returned HTTP ${response.status}.`);
    if (new URL(response.url).origin !== expected_origin) fail(`Served ${local_record.path} redirected to another origin.`);
    const content = Buffer.from(await response.arrayBuffer());
    const served_hash = sha256(content);
    if (content.length !== local_record.bytes || served_hash !== local_record.sha256) {
        fail(`Served ${local_record.path} does not match the local dist file.`);
    }
    return Object.freeze({path: local_record.path, bytes: content.length, sha256: served_hash});
};


const arguments_ = parseArguments();
const script_path = fileURLToPath(import.meta.url);
const client_root = resolve(dirname(script_path), '..');
const repository_root = resolve(client_root, '..');
const dist_root = resolve(arguments_['--dist'] ?? resolve(client_root, 'dist'));
const dplayer_repo = resolve(arguments_['--dplayer-repo']);
const mpeg2toh264_repo = resolve(arguments_['--mpeg2toh264-repo']);

const provenance_record = fileRecord(dist_root, 'build-provenance.json');
const provenance = JSON.parse(provenance_record.content.toString('utf8'));
requireExactKeys(provenance, ['schemaVersion', 'mode', 'buildId', 'components'], 'build provenance');
requireExactKeys(provenance.components, ['konomiTV', 'dplayer', 'mpeg2toh264', 'starlette'], 'build provenance components');
if (provenance.schemaVersion !== 1 || !['DOGFOOD', 'DIAG'].includes(provenance.mode)) fail('Unsupported build provenance.');
for (const [name, commit] of Object.entries(provenance.components)) {
    if (COMMIT_PATTERN.test(commit) === false) fail(`Invalid ${name} provenance commit.`);
}
if (provenance.buildId !== provenance.components.konomiTV.slice(0, 7)) fail('buildId does not match the KonomiTV commit.');

if (gitOutput(repository_root, 'rev-parse', '--verify', 'HEAD^{commit}') !== provenance.components.konomiTV) {
    fail('KonomiTV checkout does not match build provenance.');
}
if (gitOutput(repository_root, 'status', '--porcelain=v1', '--untracked-files=normal') !== '') fail('KonomiTV checkout is not clean.');

const package_json_path = resolve(client_root, 'package.json');
const yarn_lock_path = resolve(client_root, 'yarn.lock');
const pyproject_path = resolve(repository_root, 'server/pyproject.toml');
const package_json = readJson(package_json_path);
if (extractPinnedCommit(package_json.dependencies?.dplayer, 'dplayer') !== provenance.components.dplayer) fail('DPlayer package pin mismatch.');
if (extractPinnedCommit(package_json.dependencies?.mpeg2toh264, 'mpeg2toh264') !== provenance.components.mpeg2toh264) fail('mpeg2toh264 package pin mismatch.');
const yarn_lock = readFileSync(yarn_lock_path, 'utf8');
for (const commit of [provenance.components.dplayer, provenance.components.mpeg2toh264]) {
    if (yarn_lock.includes(`#${commit}`) === false || yarn_lock.includes(`/tar.gz/${commit}`) === false) fail(`yarn.lock is missing ${commit}.`);
}
const pyproject = readFileSync(pyproject_path, 'utf8');
const starlette_match = pyproject.match(/^starlette\s*=\s*\{[^\r\n]*\brev\s*=\s*"([0-9a-f]{40})"/im);
if (starlette_match?.[1] !== provenance.components.starlette) fail('Starlette pin mismatch.');

const dplayer_source_commit = requireCleanCommit(dplayer_repo, provenance.components.dplayer, 'DPlayer');
const mpeg2toh264_source_commit = requireCleanCommit(mpeg2toh264_repo, provenance.components.mpeg2toh264, 'mpeg2toh264');
const installed_dplayer = requireInstalledGitBlob(
    dplayer_repo,
    provenance.components.dplayer,
    'dist/DPlayer.min.js',
    resolve(client_root, 'node_modules/dplayer/dist/DPlayer.min.js'),
    'Installed DPlayer',
);
const installed_mpeg_player = requireInstalledGitBlob(
    mpeg2toh264_repo,
    provenance.components.mpeg2toh264,
    'packages/player/dist/index.js',
    resolve(client_root, 'node_modules/mpeg2toh264/packages/player/dist/index.js'),
    'Installed mpeg2toh264 player',
);
const installed_mpeg_yadif = requireInstalledGitBlob(
    mpeg2toh264_repo,
    provenance.components.mpeg2toh264,
    'packages/yadif/dist/index.js',
    resolve(client_root, 'node_modules/mpeg2toh264/packages/yadif/dist/index.js'),
    'Installed mpeg2toh264 YADIF',
);

const installed_dplayer_text = readFileSync(resolve(client_root, 'node_modules/dplayer/dist/DPlayer.min.js'), 'utf8');
const installed_dplayer_version = readJson(resolve(client_root, 'node_modules/dplayer/package.json')).version;
if (typeof installed_dplayer_version !== 'string') fail('Installed DPlayer package version is unavailable.');
const expected_dplayer_banner = `DPlayer v${installed_dplayer_version} ${dplayer_source_commit.slice(0, 7)}`;
if (installed_dplayer_text.includes(expected_dplayer_banner) === false) fail('Installed DPlayer build banner does not identify its source commit.');

const installed_mpeg_module_path = resolve(client_root, 'node_modules/mpeg2toh264/packages/player/dist/index.js');
const installed_mpeg_module = await import(pathToFileURL(installed_mpeg_module_path).href);
if (typeof installed_mpeg_module.isLifecycleError !== 'function' ||
    typeof installed_mpeg_module.lifecycleNow !== 'function' ||
    typeof installed_mpeg_module.Mpeg2TsPlayer?.prototype.recordDiagnosticLifecycle !== 'function' ||
    Number.isSafeInteger(installed_mpeg_module.LIFECYCLE_EVENT_ID_MAX_LENGTH) === false ||
    installed_mpeg_module.LIFECYCLE_EVENT_ID_MAX_LENGTH <= 0 ||
    Number.isSafeInteger(installed_mpeg_module.LIFECYCLE_TRACE_CAPACITY) === false ||
    installed_mpeg_module.LIFECYCLE_TRACE_CAPACITY <= 0) {
    fail('Installed mpeg2toh264 does not expose the required lifecycle diagnostic API.');
}
const lifecycle_contract = Object.freeze({
    errorGuard: 'isLifecycleError',
    clock: 'lifecycleNow',
    recorder: 'Mpeg2TsPlayer.recordDiagnosticLifecycle',
    eventIdMaxLength: installed_mpeg_module.LIFECYCLE_EVENT_ID_MAX_LENGTH,
    traceCapacity: installed_mpeg_module.LIFECYCLE_TRACE_CAPACITY,
});

const index_record = fileRecord(dist_root, 'index.html');
const index_html = index_record.content.toString('utf8');
const entry_path = requireSafeDistPath(findUnique(index_html, /<script\b[^>]*\bsrc="\/?(assets\/index-[A-Za-z0-9_-]+\.js)"[^>]*><\/script>/g, 'entry asset'));
const entry_record = fileRecord(dist_root, entry_path);
const player_controller_path = requireSafeDistPath(findUnique(
    entry_record.content.toString('utf8'),
    /["'`]\/?(assets\/PlayerController-[A-Za-z0-9_-]+\.js)["'`]/g,
    'PlayerController asset reference',
));
const player_controller_record = fileRecord(dist_root, player_controller_path);
const mpeg_worker_name = findUnique(
    player_controller_record.content.toString('utf8'),
    /["'`](?:\/?assets\/)?(worker-[A-Za-z0-9._-]+\.js)["'`]/g,
    'mpeg2toh264 Worker asset reference',
);
const mpeg_worker_record = fileRecord(dist_root, `assets/${mpeg_worker_name}`);

const installed_mpeg_text = readFileSync(installed_mpeg_module_path, 'utf8');
const dependency_worker_path = findUnique(installed_mpeg_text, /["'`](assets\/worker-[A-Za-z0-9._-]+\.js)["'`]/g, 'installed mpeg2toh264 Worker reference');
const dependency_worker = requireInstalledGitBlob(
    mpeg2toh264_repo,
    provenance.components.mpeg2toh264,
    `packages/player/dist/${dependency_worker_path}`,
    resolve(client_root, `node_modules/mpeg2toh264/packages/player/dist/${dependency_worker_path}`),
    'Installed mpeg2toh264 Worker',
);
if (dependency_worker.sha256 !== mpeg_worker_record.sha256 || dependency_worker.bytes !== mpeg_worker_record.bytes) {
    fail('Generated mpeg2toh264 Worker does not match the pinned dependency Worker.');
}

const local_records = [provenance_record, index_record, entry_record, player_controller_record, mpeg_worker_record];
const served_records = [];
for (const record of local_records) {
    served_records.push(await fetchServedRecord(arguments_['--served-base-url'], record, provenance.buildId));
}

const tool_version = (path) => readJson(resolve(client_root, path)).version;
const manifest = Object.freeze({
    schemaVersion: 1,
    status: 'verified',
    provenance,
    sourceBinding: Object.freeze({
        konomiTV: Object.freeze({sourceCommit: provenance.components.konomiTV}),
        dplayer: Object.freeze({
            sourceCommit: dplayer_source_commit,
            distCommit: provenance.components.dplayer,
            bundleBanner: expected_dplayer_banner,
            runtime: installed_dplayer,
        }),
        mpeg2toh264: Object.freeze({
            sourceCommit: mpeg2toh264_source_commit,
            distCommit: provenance.components.mpeg2toh264,
            lifecycleContract: lifecycle_contract,
            playerRuntime: installed_mpeg_player,
            yadifRuntime: installed_mpeg_yadif,
            workerRuntime: dependency_worker,
        }),
        starlette: Object.freeze({sourceCommit: provenance.components.starlette}),
    }),
    buildEnvironment: Object.freeze({
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        yarn: execFileSync('corepack', ['yarn', '--version'], {encoding: 'utf8'}).trim(),
        vite: tool_version('node_modules/vite/package.json'),
        typescript: tool_version('node_modules/typescript/package.json'),
        vueTsc: tool_version('node_modules/vue-tsc/package.json'),
        inputs: Object.freeze({
            packageJsonSha256: sha256(readFileSync(package_json_path)),
            yarnLockSha256: sha256(readFileSync(yarn_lock_path)),
            pyprojectTomlSha256: sha256(readFileSync(pyproject_path)),
        }),
    }),
    dist: Object.freeze({
        treeHashFormat: 'sha256sum-lines-v1',
        tree: distTreeRecord(dist_root),
        localAssets: Object.freeze(local_records.map(publicFileRecord)),
        servedAssets: Object.freeze(served_records),
    }),
});

const output_path = resolve(arguments_['--output']);
writeFileSync(output_path, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'});
console.log(JSON.stringify({status: manifest.status, buildId: provenance.buildId, distTreeSha256: manifest.dist.tree.sha256}));
