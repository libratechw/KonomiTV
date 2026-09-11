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
assert.match(
    source,
    /if \(should_autoplay_live === true\) \{\s*await Utils\.sleep\(15\);[\s\S]*?再生開始までに時間が掛かっています/,
    'the live startup watchdog must not restart a deliberately paused generation',
);
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
        buffered: {length: 1, end() { return 10; }},
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
        live_user_paused: false,
        live_internal_pause_owner: null,
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

// A paused Idling reconstruction must never invoke an explicit startup path or temporarily mute its replacement video.
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
        assert.equal(fixture.controller.live_startup_temporary_mute_owner, null, `${initialType} paused restart must not own a temporary mute`);
        assert.equal(fixture.video.muted, false, `${initialType} paused restart must not change mute state`);
        assert.equal(fixture.playerStore.is_loading, false, `${initialType} paused restart must clear loading`);
        assert.equal(fixture.playerStore.is_video_buffering, false, `${initialType} paused restart must clear buffering`);
        assert.equal(fixture.playerStore.is_background_display, false, `${initialType} paused restart must clear background`);
        if (initialType === 'mpeg2toh264') assert.equal(fixture.timers.length, 0, 'paused Original restart must not arm a startup timeout');
        await fixture.video.oncanplay?.();
        assert.equal(fixture.video.playbackRate, 1, `${initialType} paused restart must not leave the playback rate stopped`);
        assert.equal(fixture.restartEvents.length, 0, `${initialType} paused restart must not arm a restart timer`);
    } finally {
        fixture.restore();
    }
}

// An autoplaying MPEGTS generation releases its temporary mute after readiness and restores normal audio and UI state.
{
    const fixture = makeFixture({initialType: 'mpegts', initialReadyState: 4});
    try {
        // The fixture resolves startup sleeps immediately, so allow the readyState fallback and fade-in to finish.
        for (let index = 0; index < 30; index++) await Promise.resolve();
        assert.equal(fixture.controller.live_startup_temporary_mute_owner, null, 'MPEGTS readiness releases temporary mute ownership');
        assert.equal(fixture.video.muted, false, 'MPEGTS readiness restores unmuted audio');
        assert.equal(fixture.playerStore.is_loading, false, 'MPEGTS readiness clears loading');
        assert.equal(fixture.playerStore.is_background_display, false, 'MPEGTS readiness clears background');
    } finally {
        fixture.restore();
    }
}

// User pause is the only pause carried into an Idling reconstruction; internal errors and manual restarts keep autoplay.
{
    const helperStart = source.indexOf('private shouldAutoplayLiveAfterRestart(should_preserve_live_user_pause: boolean): boolean {');
    const helperBodyStart = source.indexOf('{', helperStart) + 1;
    const helperEnd = source.indexOf('\n    }\n\n\n    /**', helperBodyStart);
    assert.ok(helperStart >= 0 && helperEnd > helperBodyStart, 'live restart intent helper must exist');
    const shouldAutoplayLiveAfterRestart = new Function(
        `return function shouldAutoplayLiveAfterRestart(should_preserve_live_user_pause) {${stripTypeScript(source.slice(helperBodyStart, helperEnd))}};`,
    )();
    const errorStart = source.indexOf('private markLivePlaybackError(video: HTMLVideoElement): void {');
    const errorBodyStart = source.indexOf('{', errorStart) + 1;
    const errorEnd = source.indexOf('\n    }\n\n\n    /**', errorBodyStart);
    assert.ok(errorStart >= 0 && errorEnd > errorBodyStart, 'live error pause marker must exist');
    const markLivePlaybackError = new Function(
        `return function markLivePlaybackError(video) {${stripTypeScript(source.slice(errorBodyStart, errorEnd))}};`,
    )();

    const stateStart = source.indexOf('const playback_event_player = this.player;');
    const stateEndMarker = "this.player.on('pause', on_play_or_pause);";
    const stateEnd = source.indexOf(stateEndMarker, stateStart);
    assert.ok(stateStart >= 0 && stateEnd > stateStart, 'live pause-state handler must exist');
    const callbacks = {};
    const video = makeVideo(() => Promise.resolve());
    const controller = {
        player: {video, setting: {hide() {}}, on(name, callback) { callbacks[name] = callback; }},
        playback_mode: 'Live',
        live_user_paused: false,
        live_internal_pause_owner: null,
        markLivePlaybackPauseAsInternal(pausedVideo) { this.live_internal_pause_owner = pausedVideo; },
        setControlDisplayTimer() {},
    };
    new Function('player_store', stripTypeScript(source.slice(stateStart, stateEnd + stateEndMarker.length))).call(
        controller,
        {is_loading: false, is_video_buffering: true, is_video_paused: false},
    );

    video.paused = true;
    callbacks.pause();
    assert.equal(controller.live_user_paused, true, 'ordinary pause records user intent');
    assert.equal(shouldAutoplayLiveAfterRestart.call(controller, true), false, 'Idling preserves user pause');
    assert.equal(shouldAutoplayLiveAfterRestart.call(controller, false), true, 'manual restart ignores preserved pause');

    controller.live_user_paused = true;
    markLivePlaybackError.call(controller, video);
    callbacks.pause();
    assert.equal(controller.live_user_paused, false, 'internal error pause is not user intent');
    assert.equal(controller.live_internal_pause_owner, null, 'internal pause ownership is consumed once');
    assert.equal(shouldAutoplayLiveAfterRestart.call(controller, true), true, 'Idling after internal error keeps recovery autoplay');
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

    // A queued recovery must not resume a deliberately paused live stream.
    const userPausedVideo = makeVideo(() => Promise.resolve());
    const userPausedController = {
        player: {video: userPausedVideo, pause() { this.video.pause(); }},
        playback_mode: 'Live',
        live_user_paused: true,
        destroying: false,
        destroyed: false,
    };
    await recoverPlayback.call(userPausedController);
    assert.equal(userPausedVideo.pauseCalls, 0);
    assert.equal(userPausedVideo.playCalls, 0);
}

console.log('PASS live playback generation: pause intent, startup generations, timers, mute, and recovery isolation');
