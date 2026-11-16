// 一次性构建：把 dsh-context 依赖的 React / UI primitives 打成离线浏览器资源。
// 需要 DSH_CONTEXT_SRC 指向已安装依赖的 dsh-context 源码目录（默认读取本机缓存）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const here = path.dirname(new URL(import.meta.url).pathname);
const hub = path.resolve(here, '..');
const src = process.env.DSH_CONTEXT_SRC || path.join(os.homedir(), '.cache/dsh-context-agenthub.MeGOCB');
const entry = path.join(hub, 'web/context-panel/runtime-entry.js');
const outdir = path.join(hub, 'web/context-panel');

if (!fs.existsSync(src)) throw new Error(`dsh-context source not found: ${src}`);
const requireFromSrc = createRequire(path.join(src, 'package.json'));
const esbuild = requireFromSrc('esbuild-wasm');
await esbuild.initialize({});
const result = await esbuild.build({
  stdin: {
    contents: fs.readFileSync(entry, 'utf8'),
    resolveDir: src,
    sourcefile: entry,
  },
  bundle: true,
  write: false,
  outdir,
  entryNames: 'vendor',
  assetNames: 'assets/[name]-[hash]',
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
  define: {
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
});
for (const file of result.outputFiles) {
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.contents);
  console.log(`${path.relative(outdir, file.path)}  ${file.contents.length}B`);
}
