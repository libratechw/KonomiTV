
type PublicBuildProvenance = NonNullable<ImportMetaEnv['KONOMITV_PUBLIC_BUILD_PROVENANCE']>;


const embedded_public_build_provenance = import.meta.env.KONOMITV_PUBLIC_BUILD_PROVENANCE;
export const public_build_provenance: PublicBuildProvenance | null = embedded_public_build_provenance === null ? null : Object.freeze({
    ...embedded_public_build_provenance,
    components: Object.freeze({...embedded_public_build_provenance.components}),
});


export const normalizePublicPlaybackQuality = (quality: string | null): string => {
    if (quality === null) return 'Quality unavailable';
    const normalized = quality.replace(/\s+/g, ' ').trim().slice(0, 80);
    return normalized === '' ? 'Quality unavailable' : normalized;
};


export const formatPublicBuildLabel = (quality: string | null): string | null => {
    if (public_build_provenance === null) return null;
    return `${public_build_provenance.mode} ${public_build_provenance.buildId} · ${normalizePublicPlaybackQuality(quality)}`;
};
