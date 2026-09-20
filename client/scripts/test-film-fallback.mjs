import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// 製品の failure handler 自体を抽出する。GPU → CPU の選択をテスト側へ複製しない。
const source = fs.readFileSync('src/services/player/PlayerController.ts', 'utf8');
const file = ts.createSourceFile('PlayerController.ts', source, ts.ScriptTarget.Latest, true);
const handlers = [];
function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(file) === 'deinterlacer' &&
        node.expression.name.text === 'addEventListener' &&
        node.arguments[0]?.text === 'failure') {
        handlers.push(node.arguments[1].getText(file));
    }
    ts.forEachChild(node, visit);
}
visit(file);
assert.equal(handlers.length, 1);
const js = ts.transpileModule(`const handler = ${handlers[0]};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const changes = [];
let film = true;
let autoFilm = false;
const deinterlacer = {
    get film() { return film; },
    set film(value) { film = value; changes.push(['film', value]); },
    get autoFilm() { return autoFilm; },
    set autoFilm(value) { autoFilm = value; changes.push(['autoFilm', value]); },
};
const handler = new Function('deinterlacer', 'console', `${js}\nreturn handler;`)(deinterlacer, { warn() {} });
handler({ detail: 'film detection failed: incomplete float framebuffer' });
assert.deepEqual(changes, [['film', false], ['autoFilm', true]]);
assert.equal(autoFilm, true);
// 遅れて届く旧GPU failureや、CPU側のfailureで再切替・無限retryを起こさない。
handler({ detail: 'film detection failed: old notification' });
handler({ detail: 'autoFilm analysis unavailable: CPU allocation failed' });
assert.equal(changes.length, 2);
film = true;
handler({ detail: 'the deinterlacer WebGL context was lost' });
assert.equal(changes.length, 2);
console.log('actual PlayerController film failure selection: pass');
