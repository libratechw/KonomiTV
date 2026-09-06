
import {
    isLifecycleError,
    lifecycleNow,
    type LifecycleTraceDetail,
    type LifecycleTraceSnapshot,
    type Mpeg2TsPlayer,
} from 'mpeg2toh264/player';

import { dayjs } from '@/utils';

type PublicBuildProvenance = NonNullable<ImportMetaEnv['KONOMITV_PUBLIC_BUILD_PROVENANCE']>;
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

export type Mpeg2ToH264DiagnosticNotice = Readonly<{
    message: string;
    eventId: string | null;
    lifecycleTrace: LifecycleTraceSnapshot | null;
}>;


const embedded_public_build_provenance = import.meta.env.KONOMITV_PUBLIC_BUILD_PROVENANCE;
export const public_build_provenance: PublicBuildProvenance | null = embedded_public_build_provenance === null ? null : Object.freeze({
    ...embedded_public_build_provenance,
    components: Object.freeze({...embedded_public_build_provenance.components}),
});


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


const normalizeQuality = (quality: string | null): string => {
    if (quality === null) return 'Quality unavailable';
    const normalized = quality.replace(/\s+/g, ' ').trim().slice(0, 80);
    return normalized === '' ? 'Quality unavailable' : normalized;
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


export const formatPublicBuildLabel = (quality: string | null): string | null => {
    if (public_build_provenance === null) return null;
    return `${public_build_provenance.mode} ${public_build_provenance.buildId} · ${normalizeQuality(quality)}`;
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
        quality: normalizeQuality(quality),
    });
    player.recordDiagnosticLifecycle('konomitv-client-context', detail, Object.freeze({
        at: lifecycleNow(),
        critical: false,
    }));
    return true;
};


/**
 * DPlayer既存noticeの本文へ追加する、受信時点で固定した公開診断footerを生成する。
 * lifecycle interfaceがある場合は、ring bufferと同じevent ID・frozen traceを参照する。
 */
export const createMpeg2ToH264DiagnosticNotice = (
    error: Error,
    quality: string | null,
): Mpeg2ToH264DiagnosticNotice | null => {
    if (public_build_provenance === null) return null;

    const lifecycle_reference = getLifecycleTraceReference(error);
    const event_id = lifecycle_reference?.eventId ?? null;
    const frozen_at = lifecycle_reference?.frozenAt ?? lifecycleNow();
    const facts = captureClientFacts();
    const quality_snapshot = normalizeQuality(quality);
    const footer = [
        `${public_build_provenance.mode} ${public_build_provenance.buildId} · m2h ${public_build_provenance.components.mpeg2toh264.slice(0, 7)} · event ${event_id ?? 'unavailable'}`,
        `${dayjs(frozen_at).tz('Asia/Tokyo').format('YYYY-MM-DD HH:mm:ss.SSS [JST]')} · ${facts.deviceFamily} · ${facts.os} · ${facts.browser}`,
        `${facts.viewportWidth}x${facts.viewportHeight} CSS viewport · DPR ${facts.devicePixelRatio} · ${quality_snapshot}`,
    ].join('\n');
    return Object.freeze({
        message: `Error: ${error.message}\n${footer}`,
        eventId: event_id,
        lifecycleTrace: lifecycle_reference?.trace ?? null,
    });
};
