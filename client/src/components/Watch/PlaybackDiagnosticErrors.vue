<template>
    <section v-if="session !== null && session.errorCount > 0" ref="panel"
        class="playback-diagnostic-errors" aria-live="polite" aria-label="Playback diagnostic errors">
        <header class="playback-diagnostic-errors__header">
            <strong>{{ session.header.mode }} {{ session.header.buildId }} · Errors {{ session.errorCount }}</strong>
            <span>{{ session.header.mediaTitle }} · {{ session.header.mediaIdentifier }}</span>
            <span>
                build {{ shortRevision(session.header.buildRevision) }} ·
                m2h {{ shortRevision(session.header.mpeg2toh264Revision) }} ·
                {{ session.header.playbackMode }} · {{ session.header.initialQuality }}
            </span>
            <span>
                {{ session.header.deviceFamily }} · {{ session.header.os }} · {{ session.header.browser }} ·
                {{ session.header.viewportWidth }}x{{ session.header.viewportHeight }} CSS ·
                DPR {{ session.header.devicePixelRatio }}
            </span>
            <span>session {{ formatTime(session.header.startedAt) }}</span>
        </header>
        <ol class="playback-diagnostic-errors__list">
            <li v-for="error in session.errors" :key="error.sequence" class="playback-diagnostic-errors__item">
                <strong>#{{ error.sequence }} · {{ formatTime(error.occurredAt) }} · {{ formatPosition(error.playbackPosition) }}</strong>
                <span>{{ error.quality }} · event {{ error.eventId ?? 'unavailable' }}</span>
                <span class="playback-diagnostic-errors__message">Error: {{ error.message }}</span>
                <span v-for="(summary, summary_index) in error.traceSummary" :key="`${error.sequence}-${summary_index}`"
                    class="playback-diagnostic-errors__trace">
                    {{ summary }}
                </span>
            </li>
        </ol>
    </section>
</template>
<script setup lang="ts">

import { nextTick, ref, watch } from 'vue';

import { dayjs } from '@/utils';
import { public_playback_diagnostic_session as session } from '@/utils/PlaybackDiagnostics';


const panel = ref<HTMLElement | null>(null);


// 新しいerrorを受信したら共通headerを残したまま最新項目まで移動し、異常を見落とさないようにする。
watch(() => session.value?.errorCount ?? 0, async (error_count) => {
    if (error_count === 0) return;
    await nextTick();
    panel.value?.scrollTo({top: panel.value.scrollHeight});
});


const shortRevision = (revision: string): string => revision.slice(0, 7);


const formatTime = (timestamp: number): string => dayjs(timestamp).tz('Asia/Tokyo').format('YYYY-MM-DD HH:mm:ss.SSS [JST]');


const formatPosition = (position: number | null): string => {
    if (position === null) return 'position unavailable';

    const milliseconds = Math.max(0, Math.round(position * 1000));
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
    const seconds = Math.floor(milliseconds % 60_000 / 1000);
    const fraction = milliseconds % 1000;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:` +
        `${seconds.toString().padStart(2, '0')}.${fraction.toString().padStart(3, '0')}`;
};

</script>
<style lang="scss" scoped>

.playback-diagnostic-errors {
    position: absolute;
    top: 74px;
    left: 18px;
    width: min(720px, calc(100% - 104px));
    max-height: min(42%, 320px);
    overflow: auto;
    color: #FFFFFF;
    background: rgba(18, 13, 14, 0.9);
    border: 1px solid rgba(255, 111, 106, 0.85);
    border-radius: 6px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
    font-size: 11px;
    line-height: 1.45;
    overscroll-behavior: contain;
    z-index: 9;

    @include tablet-vertical {
        top: 68px;
        left: 12px;
        width: calc(100% - 24px);
        max-height: 44%;
    }
    @include smartphone-horizontal {
        top: 68px;
        left: 10px;
        width: calc(100% - 20px);
        max-height: 46%;
        font-size: 10px;
    }
    @include smartphone-vertical {
        top: 54px;
        left: 8px;
        width: calc(100% - 16px);
        max-height: 44%;
        font-size: 10px;
    }

    &__header {
        display: flex;
        position: sticky;
        top: 0;
        flex-direction: column;
        gap: 1px;
        padding: 7px 9px;
        background: rgba(37, 25, 27, 0.98);
        border-bottom: 1px solid rgba(255, 255, 255, 0.25);
        overflow-wrap: anywhere;
        z-index: 1;
    }

    &__list {
        display: flex;
        flex-direction: column;
        padding: 0;
        margin: 0;
        list-style: none;
    }

    &__item {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 7px 9px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.18);
        overflow-wrap: anywhere;

        &:last-child {
            border-bottom: 0;
        }
    }

    &__message {
        color: #FFB5B2;
        white-space: pre-wrap;
    }

    &__trace {
        color: #D9D9D9;
    }
}

</style>
