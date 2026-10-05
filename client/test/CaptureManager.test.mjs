import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/services/player/managers/CaptureManager.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(mode, failingSide) {
    const bitmap = () => ({ closed: 0, close() { this.closed++; } });
    const images = { video: bitmap(), caption: bitmap(), superimpose: bitmap() };
    const notices = [], errors = [], saves = [], composites = [];
    const settings = { capture_caption_mode: mode, capture_save_mode: 'Browser', capture_copy_to_clipboard: false };
    const exports = {};
    runInNewContext(javascript, {
        exports, setTimeout: (callback) => callback(),
        console: { log() {}, error: (...args) => errors.push(args) },
        createImageBitmap: () => failingSide === 'video' ? Promise.reject(new Error('video')) : Promise.resolve(images.video),
        require(name) {
            if (name === 'assert') return require(name);
            if (name === 'comlink') return { transfer: (value) => value };
            if (name === 'mpeg2toh264/yadif') return { Deinterlacer: class {} };
            if (name === '@/stores/ChannelsStore') return { default: () => ({}) };
            if (name === '@/stores/PlayerStore') return { default: () => ({ event_emitter: { emit() {} } }) };
            if (name === '@/stores/SettingsStore') return { default: () => ({ settings }) };
            if (name === '@/utils') return { default: {
                time: () => 1, mathFloor: value => value, downloadBlobData: (...args) => saves.push(args),
            } };
            if (name === '@/workers/CaptureCompositorProxy') return { default: class {
                constructor(options) { composites.push(options); this.options = options; }
                async composite() {
                    return { capture_normal: this.options.caption === null || mode !== 'CompositingCaption' ? 'video' : null,
                        capture_caption: mode !== 'VideoOnly' && this.options.caption !== null ? 'caption' : null };
                }
            } };
            return {};
        },
    });
    const snapshot = (side) => () => failingSide === side || failingSide === 'both'
        ? Promise.reject(new Error(side)) : Promise.resolve({ image: images[side], text: side, present: true });
    const player = { video: { videoWidth: 1920, videoHeight: 1080 }, plugins: {
        aribb24Caption: { snapshot: snapshot('caption') }, aribb24Superimpose: { snapshot: snapshot('superimpose') },
    }, notice: (message) => notices.push(message) };
    const Manager = exports.default;
    Manager.generateCaptureFilename = () => 'capture';
    const manager = new Manager(player, 'Video');
    manager.addHighlight = () => {};
    manager.removeHighlight = () => {};
    manager.createCaptureExifData = text => ({ caption_text: text });
    return { manager, images, notices, errors, saves, composites };
}

for (const mode of ['VideoOnly', 'CompositingCaption', 'Both']) {
    for (const side of ['caption', 'superimpose', 'both']) {
        test(`${mode}: preserves video when ${side} snapshot fails`, async () => {
            const f = fixture(mode, side);
            await f.manager.captureAndSave(false);
            assert.equal(f.composites.length, 1);
            const options = f.composites[0];
            assert.equal(options.caption === null, side !== 'superimpose');
            assert.equal(options.superimpose === null, side !== 'caption');
            assert.ok(f.saves.length > 0);
            assert.ok(f.notices.some(message => message.includes('取得に失敗')));
            assert.ok(!f.notices.includes('キャプチャに失敗しました。'));
            assert.equal(f.errors.length, side === 'both' ? 2 : 1);
            assert.equal(f.images.video.closed, 1);
            assert.equal(f.images.caption.closed, side === 'caption' || side === 'both' ? 0 : 1);
            assert.equal(f.images.superimpose.closed, side === 'superimpose' || side === 'both' ? 0 : 1);
        });
    }
}

test('video acquisition failure still aborts capture and releases successful subtitle snapshots', async () => {
    const f = fixture('Both', 'video');
    await f.manager.captureAndSave(false);
    assert.equal(f.composites.length, 0);
    assert.equal(f.saves.length, 0);
    assert.deepEqual(f.notices, ['キャプチャに失敗しました。']);
    assert.equal(f.images.caption.closed, 1);
    assert.equal(f.images.superimpose.closed, 1);
});
