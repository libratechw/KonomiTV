
import {
    isLifecycleError,
    lifecycleNow,
    type LifecycleTraceDetail,
    type LifecycleTraceEntry,
    type LifecycleTraceSnapshot,
    type Mpeg2TsPlayer,
} from 'mpeg2toh264/player';
import { shallowRef } from 'vue';

import { normalizePublicPlaybackQuality, public_build_provenance } from '@/utils/DiagnosticProvenance';
import {
    appendPublicPlaybackDiagnosticError,
    createPublicPlaybackDiagnosticSessionState,
    isSamePublicPlaybackDiagnosticTarget,
    type PublicPlaybackDiagnosticHeader,
    type PublicPlaybackDiagnosticSession,
} from '@/utils/DiagnosticSession';

type LifecycleTraceReference = Readonly<{
    eventId: string;
    frozenAt: number;
    trace: LifecycleTraceSnapshot;
}>;
type ClientFacts = Readonly<{
    deviceFamily: string;
    os: string;
    browser: string;
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
}>;

export type PublicPlaybackDiagnosticTarget = Readonly<{
    playbackMode: 'Live' | 'Video';
    mediaTitle: string;
    mediaIdentifier: string;
}>;


export const public_playback_diagnostic_session = shallowRef<PublicPlaybackDiagnosticSession | null>(null);


const normalizeVersion = (version: string | undefined): string | null => {
    if (version === undefined) return null;
    return version.replaceAll('_', '.');
};


/**
 * footerに表示してよい端末情報だけを抽出する。
 * User-Agent文字列そのものやApple端末のモデルは、返り値にも保持しない。
 */
const captureClientFacts = (): ClientFacts => {
    const user_agent = navigator.userAgent;
    let device_family = 'Unknown device';
    let os = 'OS version unavailable';

    const ios_version = normalizeVersion(user_agent.match(/\bOS ([0-9_]+)/)?.[1]);
    if (/\biPhone\b|\biPod\b/.test(user_agent)) {
        device_family = 'iPhone / iPod touch';
        os = ios_version === null ? 'iOS version unavailable' : `iOS ${ios_version}`;
    } else if (/\biPad\b/.test(user_agent) || (/\bMacintosh\b/.test(user_agent) && navigator.maxTouchPoints > 1)) {
        device_family = 'iPad';
        // desktop-class UAではmacOSの偽装versionをiPadOSのversionとして扱わない。
        os = ios_version === null ? 'iPadOS version unavailable' : `iPadOS ${ios_version}`;
    } else {
        const android_version = normalizeVersion(user_agent.match(/\bAndroid ([0-9._]+)/)?.[1]);
        const chrome_os_version = normalizeVersion(user_agent.match(/\bCrOS [^ ]+ ([0-9.]+)/)?.[1]);
        const windows_version = normalizeVersion(user_agent.match(/\bWindows NT ([0-9.]+)/)?.[1]);
        const macos_version = normalizeVersion(user_agent.match(/\bMac OS X ([0-9_]+)/)?.[1]);
        if (android_version !== null) {
            device_family = /\bMobile\b/.test(user_agent) ? 'Android phone' : 'Android tablet';
            os = `Android ${android_version}`;
        } else if (chrome_os_version !== null) {
            device_family = 'ChromeOS device';
            os = `ChromeOS ${chrome_os_version}`;
        } else if (windows_version !== null) {
            device_family = 'Windows PC';
            os = `Windows NT ${windows_version}`;
        } else if (macos_version !== null) {
            device_family = 'Mac';
            os = `macOS ${macos_version}`;
        } else if (/\bLinux\b/.test(user_agent)) {
            device_family = 'Linux device';
            os = 'Linux version unavailable';
        }
    }

    const browser_candidates: ReadonlyArray<readonly [RegExp, string]> = [
        [/\bEdgiOS\/([0-9.]+)/, 'Edge iOS'],
        [/\bEdgA?\/([0-9.]+)/, 'Edge'],
        [/\bCriOS\/([0-9.]+)/, 'Chrome iOS'],
        [/\bFxiOS\/([0-9.]+)/, 'Firefox iOS'],
        [/\bSamsungBrowser\/([0-9.]+)/, 'Samsung Internet'],
        [/\bOPR\/([0-9.]+)/, 'Opera'],
        [/\bChrome\/([0-9.]+)/, 'Chrome'],
        [/\bFirefox\/([0-9.]+)/, 'Firefox'],
        [/\bVersion\/([0-9.]+).*\bSafari\//, 'Safari'],
    ];
    let browser = 'Browser version unavailable';
    for (const [pattern, name] of browser_candidates) {
        const version = normalizeVersion(user_agent.match(pattern)?.[1]);
        if (version !== null) {
            browser = `${name} ${version}`;
            break;
        }
    }

    const viewport_width = Math.max(0, Math.round(window.innerWidth));
    const viewport_height = Math.max(0, Math.round(window.innerHeight));
    const device_pixel_ratio = Number.isFinite(window.devicePixelRatio) ?
        Number(window.devicePixelRatio.toFixed(2)) : 0;
    return Object.freeze({
        deviceFamily: device_family,
        os,
        browser,
        viewportWidth: viewport_width,
        viewportHeight: viewport_height,
        devicePixelRatio: device_pixel_ratio,
    });
};


const normalizeDisplayText = (value: string, fallback: string): string => {
    const normalized = value.trim();
    return normalized === '' ? fallback : normalized;
};


const readErrorMessage = (error: Error): string => {
    try {
        return normalizeDisplayText(error.message, 'Error message unavailable');
    } catch {
        return 'Error message unavailable';
    }
};


const TRACE_DETAIL_FIELDS = [
    ['qualitySwitchGeneration', 'qs'],
    ['fromQualityIndex', 'from'],
    ['toQualityIndex', 'to'],
    ['currentVideo', 'current'],
    ['reason', 'reason'],
    ['attachment', 'attachment'],
    ['hadAttachment', 'attached'],
    ['stoppedGeneration', 'stopped-generation'],
] as const;


const compactTraceValue = (value: string | number | boolean | null): string => {
    if (value === null) return 'null';
    return String(value).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 40);
};


/**
 * Screenshotだけでも、原因候補のeventとsourcecloseが失敗したplayer世代に
 * 属するかを判定できる最小限のtrace identityを表示する。
 */
const formatTraceEntry = (
    label: 'first' | 'close',
    entry: LifecycleTraceEntry,
    failure_entry: LifecycleTraceEntry,
    frozen_at: number,
): string => {
    const relation = [
        `p:${entry.playerInstance === failure_entry.playerInstance ? 'same' : 'other'}`,
        `g:${entry.generation === failure_entry.generation ? 'same' : 'other'}`,
        `v:${entry.videoId === failure_entry.videoId ? 'same' : 'other'}`,
    ].join(' ');
    const details = TRACE_DETAIL_FIELDS.flatMap(([field, alias]) => {
        const value = entry.detail[field];
        return value === undefined ? [] : [`${alias}=${compactTraceValue(value)}`];
    });
    const age = Math.max(0, Math.round(frozen_at - entry.at));
    return [
        `${label} ${entry.event}`,
        `${entry.scope}/${entry.mediaSourceOwner}/${entry.mediaSourceClass ?? 'class-unavailable'}`,
        relation,
        `age=${age}ms`,
        ...details,
    ].join(' · ');
};


const summarizeLifecycleTrace = (trace: LifecycleTraceSnapshot): readonly string[] => {
    const failure_entry = [...trace.entries].reverse().find((entry) => entry.event === 'player-fail') ?? trace.entries.at(-1);
    if (failure_entry === undefined) return [];

    const lines: string[] = [];
    if (trace.firstCritical !== null) {
        lines.push(formatTraceEntry('first', trace.firstCritical, failure_entry, trace.frozenAt));
    }
    const source_close = [...trace.entries].reverse().find((entry) => entry.event === 'mediasource-sourceclose');
    if (source_close !== undefined && source_close.sequence !== trace.firstCritical?.sequence) {
        lines.push(formatTraceEntry('close', source_close, failure_entry, trace.frozenAt));
    }
    return lines;
};


/**
 * mpeg2toh264自身のguardが完全性を確認したsnapshotだけを採用する。
 */
const getLifecycleTraceReference = (error: Error): LifecycleTraceReference | null => {
    if (isLifecycleError(error) === false) return null;
    return Object.freeze({
        eventId: error.lifecycleEventId,
        frozenAt: error.lifecycleTrace.frozenAt,
        trace: error.lifecycleTrace,
    });
};


/**
 * 公開診断buildの再生対象・build・client情報を1回だけ固定する。
 * 同じ対象のPlayerController再起動では既存errorを維持する。
 */
export const ensurePublicPlaybackDiagnosticSession = (
    target: PublicPlaybackDiagnosticTarget,
    initial_quality: string | null,
): void => {
    if (public_build_provenance === null) return;
    if (public_playback_diagnostic_session.value !== null && isSamePublicPlaybackDiagnosticTarget(
        public_playback_diagnostic_session.value,
        target.playbackMode,
        target.mediaIdentifier,
    )) return;

    const facts = captureClientFacts();
    const header: PublicPlaybackDiagnosticHeader = {
        mode: public_build_provenance.mode,
        buildId: public_build_provenance.buildId,
        buildRevision: public_build_provenance.components.konomiTV,
        mpeg2toh264Revision: public_build_provenance.components.mpeg2toh264,
        playbackMode: target.playbackMode,
        mediaTitle: normalizeDisplayText(target.mediaTitle, 'Title unavailable'),
        mediaIdentifier: normalizeDisplayText(target.mediaIdentifier, 'Identifier unavailable'),
        startedAt: lifecycleNow(),
        initialQuality: normalizePublicPlaybackQuality(initial_quality),
        deviceFamily: facts.deviceFamily,
        os: facts.os,
        browser: facts.browser,
        viewportWidth: facts.viewportWidth,
        viewportHeight: facts.viewportHeight,
        devicePixelRatio: facts.devicePixelRatio,
    };
    public_playback_diagnostic_session.value = createPublicPlaybackDiagnosticSessionState(true, header);
};


/**
 * 視聴離脱、録画の自然終了、新しい再生対象への移行時に前sessionを破棄する。
 */
export const clearPublicPlaybackDiagnosticSession = (): void => {
    public_playback_diagnostic_session.value = null;
};


/**
 * mpeg2toh264のlifecycle ring bufferへ、公開可能なclient contextを記録する。
 */
export const recordPublicPlaybackDiagnosticContext = (player: Mpeg2TsPlayer, quality: string | null): boolean => {
    if (public_build_provenance === null) return false;

    const facts = captureClientFacts();
    const detail: LifecycleTraceDetail = Object.freeze({
        buildId: public_build_provenance.buildId,
        deviceFamily: facts.deviceFamily,
        os: facts.os,
        browser: facts.browser,
        cssViewport: `${facts.viewportWidth}x${facts.viewportHeight}`,
        devicePixelRatio: facts.devicePixelRatio,
        quality: normalizePublicPlaybackQuality(quality),
    });
    player.recordDiagnosticLifecycle('konomitv-client-context', detail, Object.freeze({
        at: lifecycleNow(),
        critical: false,
    }));
    return true;
};


/**
 * mpeg2toh264 errorの内容・時刻・再生位置・traceを受信時点で固定し、sessionへ追加する。
 * lifecycle interfaceがある場合は、ring bufferと同じevent ID・frozen trace objectを保持する。
 */
export const appendMpeg2ToH264DiagnosticError = (
    error: Error,
    quality: string | null,
    playback_position: number,
): void => {
    if (public_build_provenance === null || public_playback_diagnostic_session.value === null) return;

    const lifecycle_reference = getLifecycleTraceReference(error);
    public_playback_diagnostic_session.value = appendPublicPlaybackDiagnosticError(public_playback_diagnostic_session.value, {
        occurredAt: lifecycle_reference?.frozenAt ?? lifecycleNow(),
        playbackPosition: playback_position,
        quality: normalizePublicPlaybackQuality(quality),
        message: readErrorMessage(error),
        eventId: lifecycle_reference?.eventId ?? null,
        lifecycleTrace: lifecycle_reference?.trace ?? null,
        traceSummary: lifecycle_reference === null ? [] : summarizeLifecycleTrace(lifecycle_reference.trace),
    });
};
