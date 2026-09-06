#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';


const script_directory = dirname(fileURLToPath(import.meta.url));
const source_path = resolve(script_directory, '../src/utils/DiagnosticSession.ts');
const source = readFileSync(source_path, 'utf8');
const player_controller_source = readFileSync(resolve(script_directory, '../src/services/player/PlayerController.ts'), 'utf8');
const watch_component_source = readFileSync(resolve(script_directory, '../src/components/Watch/Watch.vue'), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: source_path,
    reportDiagnostics: true,
});
if ((compiled.diagnostics ?? []).length > 0) {
    throw new Error(ts.formatDiagnostics(compiled.diagnostics, {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => script_directory,
        getNewLine: () => '\n',
    }));
}
const diagnostic_session = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);


const header = (overrides = {}) => ({
    mode: 'DIAG',
    buildId: '123abcd',
    buildRevision: '123abcdef0123456789012345678901234567890',
    mpeg2toh264Revision: '456abcdef0123456789012345678901234567890',
    playbackMode: 'Video',
    mediaTitle: 'Recorded programme',
    mediaIdentifier: 'recorded:42',
    startedAt: 1_788_624_000_000,
    initialQuality: 'Original (MPEG-2)',
    deviceFamily: 'iPad',
    os: 'iPadOS 18.6',
    browser: 'Safari 18.6',
    viewportWidth: 1180,
    viewportHeight: 820,
    devicePixelRatio: 2,
    ...overrides,
});


const lifecycle_trace = Object.freeze({
    eventId: 'm2h-a-b-c-d',
    frozenAt: 1_788_624_001_000,
    firstCritical: null,
    entries: Object.freeze([]),
});


test('normal build does not create diagnostic session state', () => {
    assert.equal(diagnostic_session.createPublicPlaybackDiagnosticSessionState(false, header()), null);
});


test('session snapshots its header and begins with no errors', () => {
    const input_header = header();
    const session = diagnostic_session.createPublicPlaybackDiagnosticSessionState(true, input_header);
    input_header.mediaTitle = 'Changed after creation';

    assert.equal(session.header.mediaTitle, 'Recorded programme');
    assert.equal(session.errorCount, 0);
    assert.deepEqual(session.errors, []);
    assert.equal(Object.isFrozen(session), true);
    assert.equal(Object.isFrozen(session.header), true);
    assert.equal(Object.isFrozen(session.errors), true);
});


test('error append snapshots time, position, content, quality, ID, and frozen trace reference', () => {
    const session = diagnostic_session.createPublicPlaybackDiagnosticSessionState(true, header());
    const trace_summary = ['first quality-switch-start', 'close mediasource-sourceclose'];
    const next = diagnostic_session.appendPublicPlaybackDiagnosticError(session, {
        occurredAt: 1_788_624_001_000,
        playbackPosition: 83.125,
        quality: 'Original (MPEG-2)',
        message: 'conversion failed',
        eventId: lifecycle_trace.eventId,
        lifecycleTrace: lifecycle_trace,
        traceSummary: trace_summary,
    });
    trace_summary[0] = 'changed after append';

    assert.equal(next.errorCount, 1);
    assert.deepEqual(next.errors[0], {
        sequence: 1,
        occurredAt: 1_788_624_001_000,
        playbackPosition: 83.125,
        quality: 'Original (MPEG-2)',
        message: 'conversion failed',
        eventId: 'm2h-a-b-c-d',
        lifecycleTrace: lifecycle_trace,
        traceSummary: ['first quality-switch-start', 'close mediasource-sourceclose'],
    });
    assert.equal(next.errors[0].lifecycleTrace, lifecycle_trace);
    assert.equal(Object.isFrozen(next.errors[0]), true);
    assert.equal(Object.isFrozen(next.errors[0].traceSummary), true);
});


test('multiple errors remain in receipt order without mutating the previous snapshot', () => {
    const empty = diagnostic_session.createPublicPlaybackDiagnosticSessionState(true, header());
    const first = diagnostic_session.appendPublicPlaybackDiagnosticError(empty, {
        occurredAt: 200,
        playbackPosition: 10,
        quality: 'Original (MPEG-2)',
        message: 'first',
        eventId: 'm2h-1-1-1-1',
        lifecycleTrace: lifecycle_trace,
        traceSummary: [],
    });
    const second = diagnostic_session.appendPublicPlaybackDiagnosticError(first, {
        occurredAt: 300,
        playbackPosition: 11,
        quality: 'Original (MPEG-2)',
        message: 'second',
        eventId: 'm2h-2-2-2-2',
        lifecycleTrace: lifecycle_trace,
        traceSummary: [],
    });

    assert.deepEqual(first.errors.map((error) => error.message), ['first']);
    assert.deepEqual(second.errors.map((error) => error.message), ['first', 'second']);
    assert.deepEqual(second.errors.map((error) => error.sequence), [1, 2]);
    assert.equal(second.errorCount, 2);
    assert.equal(second.header, empty.header);
});


test('unavailable playback position and lifecycle remain explicit', () => {
    const session = diagnostic_session.createPublicPlaybackDiagnosticSessionState(true, header());
    const next = diagnostic_session.appendPublicPlaybackDiagnosticError(session, {
        occurredAt: 400,
        playbackPosition: Number.NaN,
        quality: '720p',
        message: 'plain error',
        eventId: null,
        lifecycleTrace: null,
        traceSummary: [],
    });

    assert.equal(next.errors[0].playbackPosition, null);
    assert.equal(next.errors[0].eventId, null);
    assert.equal(next.errors[0].lifecycleTrace, null);
});


test('same-target check preserves only an exact playback mode and media identity match', () => {
    const session = diagnostic_session.createPublicPlaybackDiagnosticSessionState(true, header());

    assert.equal(diagnostic_session.isSamePublicPlaybackDiagnosticTarget(session, 'Video', 'recorded:42'), true);
    assert.equal(diagnostic_session.isSamePublicPlaybackDiagnosticTarget(session, 'Video', 'recorded:43'), false);
    assert.equal(diagnostic_session.isSamePublicPlaybackDiagnosticTarget(session, 'Live', 'recorded:42'), false);
});


test('a new playback session starts empty after the previous target accumulated errors', () => {
    const old_session = diagnostic_session.createPublicPlaybackDiagnosticSessionState(true, header());
    const old_with_error = diagnostic_session.appendPublicPlaybackDiagnosticError(old_session, {
        occurredAt: 500,
        playbackPosition: 20,
        quality: 'Original (MPEG-2)',
        message: 'old target error',
        eventId: null,
        lifecycleTrace: null,
        traceSummary: [],
    });
    const new_session = diagnostic_session.createPublicPlaybackDiagnosticSessionState(true, header({
        playbackMode: 'Live',
        mediaTitle: 'Live channel',
        mediaIdentifier: 'channel:gr011',
    }));

    assert.equal(old_with_error.errorCount, 1);
    assert.equal(new_session.header.mediaTitle, 'Live channel');
    assert.equal(new_session.header.mediaIdentifier, 'channel:gr011');
    assert.equal(new_session.errorCount, 0);
    assert.deepEqual(new_session.errors, []);
});


test('natural recorded playback end clears before replay creates a same-target session', () => {
    const playback_handler_start = player_controller_source.indexOf('private setupVideoPlaybackHandler(): void');
    const playback_handler_end = player_controller_source.indexOf('\n    /**', playback_handler_start + 1);
    const playback_handler = player_controller_source.slice(playback_handler_start, playback_handler_end);

    assert.notEqual(playback_handler_start, -1);
    assert.notEqual(playback_handler_end, -1);
    assert.match(playback_handler, /this\.player\.on\('play', \(\) => \{[\s\S]*?this\.ensurePublicPlaybackDiagnosticSession\(\);[\s\S]*?on_play_or_pause\(\);[\s\S]*?\}\);/);
    assert.match(playback_handler, /if \(this\.playback_mode === 'Video'\) \{[\s\S]*?this\.player\.on\('ended', \(\) => \{[\s\S]*?clearPublicPlaybackDiagnosticSession\(\);[\s\S]*?\}\);[\s\S]*?\}/);

    const previous = diagnostic_session.createPublicPlaybackDiagnosticSessionState(true, header());
    const with_error = diagnostic_session.appendPublicPlaybackDiagnosticError(previous, {
        occurredAt: 600,
        playbackPosition: 120,
        quality: 'Original (MPEG-2)',
        message: 'previous playback error',
        eventId: null,
        lifecycleTrace: null,
        traceSummary: [],
    });
    const after_ended = null;
    const replay = after_ended ?? diagnostic_session.createPublicPlaybackDiagnosticSessionState(true, header());

    assert.equal(with_error.errorCount, 1);
    assert.equal(replay.header.mediaIdentifier, with_error.header.mediaIdentifier);
    assert.equal(replay.errorCount, 0);
    assert.deepEqual(replay.errors, []);
});


test('leaving the watch screen clears diagnostics before resetting shared player state', () => {
    const before_unmount_start = watch_component_source.indexOf('beforeUnmount() {');
    const before_unmount_end = watch_component_source.indexOf('\n    }', before_unmount_start);
    const before_unmount = watch_component_source.slice(before_unmount_start, before_unmount_end);

    assert.notEqual(before_unmount_start, -1);
    assert.notEqual(before_unmount_end, -1);
    assert.ok(before_unmount.indexOf('clearPublicPlaybackDiagnosticSession();') < before_unmount.indexOf('this.playerStore.stopWatching();'));
});
