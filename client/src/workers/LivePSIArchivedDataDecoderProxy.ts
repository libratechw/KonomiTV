
import * as Comlink from 'comlink';

import type { ILivePSIArchivedDataDecoderConstructor } from '@/workers/LivePSIArchivedDataDecoder';


// LivePSIArchivedDataDecoder を Web Worker 上で動作させるためのラッパー
// Comlink を経由し、Web Worker とメインスレッド間でオブジェクトをやり取りする
// ラップ元と同じファイルに定義すると Webpack から Circler Dependency として警告されブラウザの挙動が不安定になるため、別ファイルに定義している
const worker = new Worker(new URL('./LivePSIArchivedDataDecoder.ts', import.meta.url), {type: 'module'});
const LivePSIArchivedDataDecoderProxy = Comlink.wrap<ILivePSIArchivedDataDecoderConstructor>(worker);
export default LivePSIArchivedDataDecoderProxy;
