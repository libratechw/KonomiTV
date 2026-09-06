
import type { Mpeg2TsPlayer } from 'mpeg2toh264/player';


type PlaybackTarget = Readonly<{
    playbackMode: 'Live' | 'Video';
    mediaTitle: string;
    mediaIdentifier: string;
}>;


export const ensurePublicPlaybackDiagnosticSession = (_target: PlaybackTarget, _initial_quality: string | null): void => {};


export const clearPublicPlaybackDiagnosticSession = (): void => {};


export const recordPublicPlaybackDiagnosticContext = (_player: Mpeg2TsPlayer, _quality: string | null): boolean => false;


export const appendMpeg2ToH264DiagnosticError = (
    _error: Error,
    _quality: string | null,
    _playback_position: number,
): void => {};
