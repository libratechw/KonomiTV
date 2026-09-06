
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';
import { comlink } from 'vite-plugin-comlink';
import { VitePWA } from 'vite-plugin-pwa';
import vuetify, { transformAssetUrls } from 'vite-plugin-vuetify';


type PublicBuildMode = 'DOGFOOD' | 'DIAG';
type PublicBuildProvenance = Readonly<{
    schemaVersion: 1;
    mode: PublicBuildMode;
    buildId: string;
    components: Readonly<{
        konomiTV: string;
        dplayer: string;
        mpeg2toh264: string;
        starlette: string;
    }>;
}>;


/**
 * Git URL dependencyから、固定された40桁のcommitを取り出す。
 * 公開provenanceを有効にしたbuildでは、branchやtagのように内容が動く参照は受け付けない。
 */
const extractPinnedCommit = (dependency_name: string, dependency: unknown): string => {
    if (typeof dependency !== 'string') {
        throw new Error(`Public build provenance requires a Git commit pin for ${dependency_name}.`);
    }
    const match = dependency.match(/#([0-9a-f]{40})$/i);
    if (match === null) {
        throw new Error(`Public build provenance requires a 40-character Git commit pin for ${dependency_name}.`);
    }
    return match[1].toLowerCase();
};


/**
 * 診断・dogfood buildで画面と配備manifestへ投影する公開provenanceを生成する。
 * 値の正本はKonomiTVのGit HEADと各依存pinで、同じオブジェクトを画面と生成manifestの両方へ使う。
 */
const createPublicBuildProvenance = (): PublicBuildProvenance | null => {
    const mode = process.env.KONOMITV_PUBLIC_BUILD_MODE;
    if (mode === undefined || mode === '') return null;
    if (mode !== 'DOGFOOD' && mode !== 'DIAG') {
        throw new Error('KONOMITV_PUBLIC_BUILD_MODE must be DOGFOOD or DIAG.');
    }

    // commitされていないsourceから、別のcommitを名乗る診断bundleを作らない。
    const repository_root = fileURLToPath(new URL('../', import.meta.url));
    const worktree_changes = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
        cwd: repository_root,
        encoding: 'utf8',
    }).trim();
    if (worktree_changes !== '') {
        throw new Error('Public build provenance requires a clean worktree.');
    }

    const konomi_tv_commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd: repository_root,
        encoding: 'utf8',
    }).trim().toLowerCase();
    if (/^[0-9a-f]{40}$/.test(konomi_tv_commit) === false) {
        throw new Error('Failed to resolve the KonomiTV source commit for public build provenance.');
    }

    // Client dependencyのcommitはpackage.jsonのpinを正本とする。
    const package_json = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
        dependencies?: Record<string, unknown>;
    };
    const dplayer_commit = extractPinnedCommit('dplayer', package_json.dependencies?.dplayer);
    const mpeg2toh264_commit = extractPinnedCommit('mpeg2toh264', package_json.dependencies?.mpeg2toh264);

    // Server dependencyのcommitはpyproject.tomlのpinを正本とする。
    const pyproject_toml = readFileSync(new URL('../server/pyproject.toml', import.meta.url), 'utf8');
    const starlette_match = pyproject_toml.match(/^starlette\s*=\s*\{[^\r\n]*\brev\s*=\s*"([0-9a-f]{40})"/im);
    if (starlette_match === null) {
        throw new Error('Public build provenance requires a 40-character Git commit pin for starlette.');
    }

    return Object.freeze({
        schemaVersion: 1,
        mode,
        buildId: konomi_tv_commit.slice(0, 7),
        components: Object.freeze({
            konomiTV: konomi_tv_commit,
            dplayer: dplayer_commit,
            mpeg2toh264: mpeg2toh264_commit,
            starlette: starlette_match[1].toLowerCase(),
        }),
    });
};


const public_build_provenance = createPublicBuildProvenance();
const publicBuildProvenancePlugin = (): Plugin => ({
    name: 'konomitv-public-build-provenance',
    generateBundle() {
        if (public_build_provenance === null) return;
        this.emitFile({
            type: 'asset',
            fileName: 'build-provenance.json',
            source: `${JSON.stringify(public_build_provenance, null, 2)}\n`,
        });
    },
});


// Vite の設定
// https://vitejs.dev/config/
export default defineConfig({
    // バージョン情報をビルド時に埋め込む
    // ref: https://stackoverflow.com/a/68093777/17124142
    define: {
        'process.env': {},  // これがないと assert がエラーになる
        'import.meta.env.KONOMITV_VERSION': JSON.stringify(process.env.npm_package_version),
        'import.meta.env.KONOMITV_PUBLIC_BUILD_PROVENANCE': JSON.stringify(public_build_provenance),
    },
    // ビルドの設定
    build: {
        chunkSizeWarningLimit: 3 * 1024 * 1024,  // 3MB に緩和
        rollupOptions: {
            output: {
                assetFileNames: (assetInfo) => {
                    // フォントファイルのみ、ハッシュを付けずに assets/fonts/ に出力する
                    if (['.ttf', '.eot', '.woff', '.woff2'].some((ext) => assetInfo.name?.endsWith(ext))) {
                        return 'assets/fonts/[name][extname]';
                    }
                    return 'assets/[name].[hash][extname]';
                },
            },
        },
    },
    resolve: {
        alias: {'@': fileURLToPath(new URL('./src', import.meta.url))},
        extensions: ['.js', '.json', '.jsx', '.mjs', '.ts', '.tsx', '.vue'],
    },
    // mpeg2toh264 は配布済みの Worker を import.meta.url から解決するため、依存関係の事前バンドルから除外する
    // エントリーポイントだけを .vite/deps/ へ移動すると相対 URL の起点が変わり、同梱 Worker を取得できなくなる
    optimizeDeps: {
        exclude: [
            'mpeg2toh264/player',
            'mpeg2toh264/yadif',
        ],
    },
    // SASS / SCSS の設定
    css: {
        preprocessorOptions: {
            scss: {
                // 共通の mixin を読み込む
                // ref: https://qiita.com/nanohanabuttobasu/items/f73ed978cc10d8bcaa59
                additionalData: '@import "@/styles/mixin.scss";',
            },
        },
    },
    // 開発用サーバーの設定
    server: {
        host: '0.0.0.0',
        port: 7011,
        strictPort: true,
        allowedHosts: true,
    },
    preview: {
        host: '0.0.0.0',
        port: 7011,
        strictPort: true,
        allowedHosts: true,
    },
    // プラグインの設定
    plugins: [
        publicBuildProvenancePlugin(),
        comlink(),
        vue({
            template: {
                transformAssetUrls: transformAssetUrls,
            },
        }),
        // https://github.com/vuetifyjs/vuetify-loader/tree/master/packages/vite-plugin#readme
        vuetify({
            autoImport: true,
            styles: {
                configFile: 'src/styles/settings.scss',
            }
        }),
        // ref: https://vite-pwa-org.netlify.app/guide/
        VitePWA({
            // Service Worker の登録方法
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'sw.ts',
            registerType: 'prompt',  // PWA の更新前にユーザーに確認する
            injectRegister: 'auto',
            // PWA のキャッシュに含めるファイル
            includeAssets: [
                'assets/**',
            ],
            // manifest.json の内容
            manifest: {
                name: 'KonomiTV',
                short_name: 'KonomiTV',
                start_url: '.',
                display: 'standalone',
                theme_color: '#0D0807',
                background_color: '#1E1310',
                lang: 'ja',
                icons: [
                    {
                        src: '/assets/images/icons/icon-192px.png',
                        sizes: '192x192',
                        type: 'image/png',
                    },
                    {
                        src: '/assets/images/icons/icon-512px.png',
                        sizes: '512x512',
                        type: 'image/png',
                    },
                    {
                        src: '/assets/images/icons/icon-maskable-192px.png',
                        sizes: '192x192',
                        type: 'image/png',
                        purpose: 'maskable',
                    },
                    {
                        src: '/assets/images/icons/icon-maskable-512px.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable',
                    }
                ]
            },
            // 独自 Service Worker へ注入する事前キャッシュの設定
            injectManifest: {
                maximumFileSizeToCacheInBytes: 1024 * 1024 * 15,  // 15MB
            },
        }),
    ],
    // Web Worker 上のプラグインの設定
    worker: {
        plugins: () => [
            comlink(),
        ]
    }
});
