
import * as Comlink from 'comlink';

import type { ICaptureCompositorConstructor } from '@/workers/CaptureCompositor';


// CaptureCompositor を Web Worker 上で動作させるためのラッパー
// CaptureCompositor 側がクラスを直接 expose するため、モジュールの exports を再度 expose する
// ComlinkWorker は使わず、通常の Worker を wrap して静的メソッドとコンストラクターを公開する
const CaptureCompositorProxy = Comlink.wrap<ICaptureCompositorConstructor>(
    new Worker(new URL('./CaptureCompositor.ts', import.meta.url), {type: 'module'}),
);
export default CaptureCompositorProxy;
