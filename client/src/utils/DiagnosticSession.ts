
import type { LifecycleTraceSnapshot } from 'mpeg2toh264/player';


export type PublicPlaybackDiagnosticHeader = Readonly<{
    mode: 'DOGFOOD' | 'DIAG';
    buildId: string;
    buildRevision: string;
    mpeg2toh264Revision: string;
    playbackMode: 'Live' | 'Video';
    mediaTitle: string;
    mediaIdentifier: string;
    startedAt: number;
    initialQuality: string;
    deviceFamily: string;
    os: string;
    browser: string;
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
}>;

export type PublicPlaybackDiagnosticError = Readonly<{
    sequence: number;
    occurredAt: number;
    playbackPosition: number | null;
    quality: string;
    message: string;
    eventId: string | null;
    lifecycleTrace: LifecycleTraceSnapshot | null;
    traceSummary: readonly string[];
}>;

export type PublicPlaybackDiagnosticSession = Readonly<{
    header: PublicPlaybackDiagnosticHeader;
    errorCount: number;
    errors: readonly PublicPlaybackDiagnosticError[];
}>;

export type PublicPlaybackDiagnosticErrorInput = Omit<PublicPlaybackDiagnosticError, 'sequence' | 'playbackPosition' | 'traceSummary'> & Readonly<{
    playbackPosition: number;
    traceSummary: readonly string[];
}>;


/**
 * 診断build用の再生セッションを作る。通常buildではstate自体を作らない。
 */
export const createPublicPlaybackDiagnosticSessionState = (
    is_enabled: boolean,
    header: PublicPlaybackDiagnosticHeader,
): PublicPlaybackDiagnosticSession | null => {
    if (is_enabled === false) return null;

    return Object.freeze({
        header: Object.freeze({...header}),
        errorCount: 0,
        errors: Object.freeze([]),
    });
};


/**
 * 現在のsessionが同じ再生対象のものかを判定する。
 * PlayerControllerだけの再起動では同じsessionを維持し、番組・チャンネル切替では作り直すために使う。
 */
export const isSamePublicPlaybackDiagnosticTarget = (
    session: PublicPlaybackDiagnosticSession,
    playback_mode: 'Live' | 'Video',
    media_identifier: string,
): boolean => session.header.playbackMode === playback_mode && session.header.mediaIdentifier === media_identifier;


/**
 * mpeg2toh264 errorを受信順に追加し、既存snapshotを変更せず新しいsnapshotを返す。
 */
export const appendPublicPlaybackDiagnosticError = (
    session: PublicPlaybackDiagnosticSession,
    input: PublicPlaybackDiagnosticErrorInput,
): PublicPlaybackDiagnosticSession => {
    const playback_position = Number.isFinite(input.playbackPosition) ? input.playbackPosition : null;
    const error = Object.freeze({
        sequence: session.errorCount + 1,
        occurredAt: input.occurredAt,
        playbackPosition: playback_position,
        quality: input.quality,
        message: input.message,
        eventId: input.eventId,
        lifecycleTrace: input.lifecycleTrace,
        traceSummary: Object.freeze([...input.traceSummary]),
    });
    const errors = Object.freeze([...session.errors, error]);
    return Object.freeze({
        header: session.header,
        errorCount: errors.length,
        errors,
    });
};
