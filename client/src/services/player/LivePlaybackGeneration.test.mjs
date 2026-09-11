import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const stripTypeScript = code => ts.transpileModule(code, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
}).outputText;

const source = process.env.PLAYER_CONTROLLER_GIT_REV ?
    execFileSync('git', [
        'show', `${process.env.PLAYER_CONTROLLER_GIT_REV}:client/src/services/player/PlayerController.ts`,
    ], {encoding: 'utf8'}) :
    readFileSync(new URL('./PlayerController.ts', import.meta.url), 'utf8');
const blockStart = source.indexOf('const on_init_or_quality_change = async (is_initialization: boolean) => {');
const blockEndMarker = "this.player.on('quality_start', () => on_init_or_quality_change(false));";
const blockEnd = source.indexOf(blockEndMarker, blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart, 'live startup block must exist');

const registerLiveStartup = new Function(
    'should_autoplay_live_on_initialization',
    'player_store', 'channels_store', 'PlayerUtils', 'Utils', 'mpegts', 'Hls', 'OfflineVideos', 'assert',
    stripTypeScript(source.slice(blockStart, blockEnd + blockEndMarker.length)),
);

function makeVideo(play) {
    return {
        playCalls: 0,
        pauseCalls: 0,
        paused: true,
        muted: false,
        readyState: 0,
        playbackRate: 1,
        volume: 1,
        oncanplay: null,
        oncanplaythrough: null,
        buffered: {length: 0, end() { return 0; }},
        currentTime: 0,
        play() {
            this.playCalls++;
            return play();
        },
        pause() {
            this.pauseCalls++;
            this.paused = true;
        },
    };
}

function makeFixture({initialType, initialPlay, initialReadyState = 0, shouldAutoplayLive = true}) {
    const callbacks = {};
    const restartEvents = [];
    const timers = [];
    const mpegtsPlugin = {on(name, callback) { callbacks[`mpegts:${name}`] = callback; }};
    const originalPlugin = new EventTarget();
    const video = makeVideo(initialPlay ?? (() => Promise.resolve()));
    video.readyState = initialReadyState;
    const player = {
        type: initialType,
        video,
        plugins: initialType === 'mpeg2toh264' ? {mpeg2toh264: originalPlugin} : {mpegts: mpegtsPlugin},
        container: {classList: {contains() { return true; }}},
        user: {get() { return 1; }},
        on(name, callback) { callbacks[name] = callback; },
        play() { return this.video.play(); },
        pause() { this.video.pause(); },
        notice() {},
    };
    const controller = {
        player,
        player_managers: [],
        playback_mode: 'Live',
        destroying: false,
        destroyed: false,
        live_startup_temporary_mute_owner: null,
        live_playback_buffer_seconds: 4,
        getPlaybackBufferSeconds() { return 4; },
        recoverPlayback() {},
    };
    const playerStore = {
        live_stream_status: 'ONAir',
        is_video_buffering: true,
        event_emitter: {emit(name, data) { restartEvents.push({name, data}); }},
    };
    const previousWindow = globalThis.window;
    const previousNavigator = globalThis.navigator;
    const previousLocalStorage = globalThis.localStorage;
    globalThis.window = {
        setTimeout(callback) {
            const timer = {callback, cleared: false};
            timers.push(timer);
            return timers.length;
        },
        clearTimeout(id) {
            if (timers[id - 1]) timers[id - 1].cleared = true;
        },
    };
    Object.defineProperty(globalThis, 'navigator', {value: {onLine: true}, configurable: true});
    globalThis.localStorage = {getItem() { return null; }};
    registerLiveStartup.call(
        controller,
        shouldAutoplayLive,
        playerStore,
        {channel: {current: {is_radiochannel: false}}},
        {generatePlayerBackgroundURL() { return 'fixture'; }},
        {sleep: () => Promise.resolve(), waitUntilOnline: () => Promise.resolve(), mathFloor: value => value},
        {Events: {ERROR: 'error', MEDIA_INFO: 'media-info'}},
        {Events: {}},
        {},
        assert,
    );
    return {
        callbacks,
        controller,
        originalPlugin,
        player,
        playerStore,
        restartEvents,
        timers,
        video,
        restore() {
            globalThis.window = previousWindow;
            Object.defineProperty(globalThis, 'navigator', {value: previousNavigator, configurable: true});
            globalThis.localStorage = previousLocalStorage;
        },
    };
}

// A paused live restart must not call any explicit startup path for the replacement video.
for (const initialType of ['mpegts', 'mpeg2toh264']) {
    const fixture = makeFixture({
        initialType,
        initialReadyState: 4,
        shouldAutoplayLive: false,
        initialPlay: () => Promise.reject(new Error('paused restart must not play')),
    });
    try {
        await Promise.resolve();
        assert.equal(fixture.video.playCalls, 0, `${initialType} paused restart must not play`);
        assert.equal(fixture.video.paused, true, `${initialType} paused restart must stay paused`);
        if (initialType === 'mpeg2toh264') {
            assert.equal(fixture.timers.length, 0, 'paused Original restart must not arm a startup timeout');
            assert.equal(fixture.playerStore.is_loading, false);
            assert.equal(fixture.playerStore.is_video_buffering, false);
            assert.equal(fixture.playerStore.is_background_display, false);
        }
    } finally {
        fixture.restore();
    }
}

// The restart-only intent must not leak into a later user-initiated quality change.
{
    const fixture = makeFixture({initialType: 'mpegts', initialReadyState: 4, shouldAutoplayLive: false});
    try {
        assert.equal(fixture.video.playCalls, 0);
        const switchedVideo = makeVideo(() => Promise.resolve());
        switchedVideo.readyState = 4;
        fixture.player.video = switchedVideo;
        await fixture.callbacks.quality_start();
        assert.equal(switchedVideo.playCalls, 1, 'quality change must retain its existing startup behavior');
    } finally {
        fixture.restore();
    }
}

// An old 1080p startup completion must not replace the new Original readiness handler.
{
    let resolveOldPlay;
    const oldPlay = new Promise(resolve => { resolveOldPlay = resolve; });
    const fixture = makeFixture({initialType: 'mpegts', initialPlay: () => oldPlay});
    try {
        const oldVideo = fixture.video;
        const newVideo = makeVideo(() => Promise.resolve());
        fixture.player.type = 'mpeg2toh264';
        fixture.player.video = newVideo;
        fixture.player.plugins = {mpeg2toh264: fixture.originalPlugin};
        await fixture.callbacks.quality_start();
        const originalCanPlay = newVideo.oncanplay;
        assert.equal(typeof originalCanPlay, 'function');

        resolveOldPlay();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(newVideo.oncanplay, originalCanPlay, 'old startup must not overwrite the Original handler');
        assert.equal(newVideo.playbackRate, 1, 'old startup must not change the new video state');

        originalCanPlay();
        for (const timer of fixture.timers) if (timer.cleared === false) timer.callback();
        assert.equal(fixture.restartEvents.length, 0, 'successful current Original startup must not restart');
        assert.equal(oldVideo.oncanplay, null);
    } finally {
        fixture.restore();
    }
}

// A genuinely stalled current Original generation must retain the existing one-shot restart behavior.
{
    const fixture = makeFixture({initialType: 'mpeg2toh264'});
    try {
        assert.equal(fixture.timers.length, 1);
        for (const timer of fixture.timers) if (timer.cleared === false) timer.callback();
        assert.equal(fixture.restartEvents.length, 1);
        assert.equal(fixture.restartEvents[0].name, 'PlayerRestartRequired');
        assert.match(fixture.restartEvents[0].data.message, /再生開始までに時間が掛かっています/);
    } finally {
        fixture.restore();
    }
}

// recoverPlayback() must abandon an old video after its first asynchronous wait.
{
    const methodStart = source.indexOf('private async recoverPlayback(): Promise<void> {');
    const bodyStart = source.indexOf('{', methodStart) + 1;
    const methodEnd = source.indexOf('\n    }\n\n\n    /**', bodyStart);
    assert.ok(methodStart >= 0 && methodEnd > bodyStart, 'recoverPlayback method must exist');
    const recoverSource = stripTypeScript(
        `async function recoverPlayback() {${source.slice(bodyStart, methodEnd)}}`,
    );
    const recoverPlayback = new Function(
        'usePlayerStore', 'Utils', 'assert', `return (${recoverSource});`,
    )(() => ({is_video_buffering: true}), {sleep: () => firstWait}, assert);
    let resumeFirstWait;
    const firstWait = new Promise(resolve => { resumeFirstWait = resolve; });
    const oldVideo = makeVideo(() => Promise.resolve());
    const controller = {
        player: {video: oldVideo, pause() { this.video.pause(); }},
        playback_mode: 'Live',
        destroying: false,
        destroyed: false,
    };
    const pending = recoverPlayback.call(controller);
    const newVideo = makeVideo(() => Promise.resolve());
    controller.player.video = newVideo;
    resumeFirstWait();
    await pending;
    assert.equal(oldVideo.pauseCalls, 0);
    assert.equal(oldVideo.playCalls, 0);
    assert.equal(oldVideo.playbackRate, 1);
    assert.equal(newVideo.pauseCalls, 0);
    assert.equal(newVideo.playCalls, 0);
    assert.equal(newVideo.playbackRate, 1);
}

console.log('PASS live playback generation: stale startup/recovery isolation and current timeout');
