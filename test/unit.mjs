/**
 * dsh-agnes-create 单元 / 接线测试
 *
 *   node test/unit.mjs
 *
 * 分成三组：
 *   1. agnes.js  —— 纯逻辑与磁盘契约（参考图校验、提示词元数据、目录清单、任务表）
 *   2. client.js —— 面板 store 的接线（输出目录 / 提示词复制 / 关键帧 / 宿主任务）
 *   3. index.js  —— 路由注册与几个只读接口
 *
 * 全部离线：没有任何真实网络请求；会临时改写 history.json / tasks.json 并在结束时复原。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
import zlib from 'node:zlib';

// 目录名里有中文（研究），URL.pathname 会保留百分号编码，必须用 fileURLToPath 解码
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LIB = join(ROOT, 'lib');
const CONFIG_DIR = join(homedir(), '.dsh', 'agnes-create');
const HISTORY_FILE = join(CONFIG_DIR, 'history.json');
const TASKS_FILE = join(CONFIG_DIR, 'tasks.json');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PRESETS_FILE = join(CONFIG_DIR, 'presets.json');

let passed = 0;
const failures = [];

function record(name, err) {
  if (err) {
    failures.push({ name, err });
    console.log(`FAIL ${name}`);
    console.log(`     ${err && err.message ? err.message : err}`);
  } else {
    passed += 1;
    console.log(`ok   ${name}`);
  }
}

function test(name, fn) {
  try {
    fn();
    record(name, null);
  } catch (e) {
    record(name, e);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    record(name, null);
  } catch (e) {
    record(name, e);
  }
}

/* ------------------------------------------------------------------ */
/* 造图工具：最小的合法 PNG / JPEG                                     */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 造一张 2x2 的 RGB PNG；extra 里可以塞额外的块（用来模拟别人的元数据） */
function makePng(extra = []) {
  const w = 2;
  const h = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w; x += 1) {
      raw[off + 1 + x * 3] = 200;
      raw[off + 2 + x * 3] = 120 + y * 40;
      raw[off + 3 + x * 3] = 60 + x * 30;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** tEXt 块：key\0text */
function textChunk(key, text) {
  return chunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}

/** 最小 JPEG：SOI + APP0 + EOI（够 readEmbeddedPrompt 走一遍） */
function makeJpeg() {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0]),
    Buffer.from([0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff, 0xd9])]);
}

/* ------------------------------------------------------------------ */
/* 备份 / 复原用户数据，避免测试污染真实配置                             */
/* ------------------------------------------------------------------ */

const backups = new Map();

async function backup(file) {
  if (backups.has(file)) return;
  try {
    backups.set(file, await readFile(file));
  } catch {
    backups.set(file, null);
  }
}

async function restoreAll() {
  for (const [file, data] of backups) {
    try {
      if (data === null) await rm(file, { force: true });
      else await writeFile(file, data);
    } catch {
      /* 复原失败就算了，不掩盖测试结果 */
    }
  }
}

/* ================================================================== */
/* 1. agnes.js                                                         */
/* ================================================================== */

const A = await import(join(LIB, 'agnes.js'));

test('normalizeRefs：空值返回空数组', () => {
  assert.deepEqual(A.normalizeRefs(undefined), []);
  assert.deepEqual(A.normalizeRefs([]), []);
});

test('normalizeRefs：非数组报错', () => {
  assert.throws(() => A.normalizeRefs('data:image/png;base64,AAA'), /参考图必须是数组/);
});

test('normalizeRefs：放行 http(s) 与 data:image', () => {
  assert.deepEqual(A.normalizeRefs(['https://example.com/a.png']), ['https://example.com/a.png']);
  const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(A.normalizeRefs([dataUri]), [dataUri]);
});

test('normalizeRefs：拒绝 file:// 与 data:text，且提示第几张', () => {
  assert.throws(() => A.normalizeRefs(['https://ok/a.png', 'file:///tmp/a.png']), /第 2 张/);
  assert.throws(() => A.normalizeRefs(['data:text/plain;base64,AAA']), /第 1 张/);
});

test('normalizeRefs：超过 8 张报错并带数量', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `https://x/${i}.png`);
  assert.throws(() => A.normalizeRefs(nine), /最多 8 张，收到 9 张/);
});

test('safeName：去掉路径只留文件名，非法字符整条拒绝', () => {
  assert.equal(A.safeName('../../etc/passwd'), 'passwd');
  assert.equal(A.safeName('/tmp/agnes-ab.png'), 'agnes-ab.png');
  // 空壳 / 疑似穿越的输入返回 null，由调用方拒绝
  assert.equal(A.safeName('a b/c?.png'), null);
  assert.equal(A.safeName(''), null);
});

test('buildBody：response_format 在 extra_body 内、参考图进 extra_body.image', () => {
  const body = A.buildBody({ prompt: 'x', images: ['https://x/a.png'] });
  assert.equal(body.prompt, 'x');
  assert.equal(body.response_format, undefined);
  assert.equal(body.extra_body.response_format, 'url');
  assert.deepEqual(body.extra_body.image, ['https://x/a.png']);
});

test('kindOf：按扩展名区分图片 / 视频 / 其它', () => {
  assert.equal(A.kindOf('a.PNG'), 'image');
  assert.equal(A.kindOf('b.mp4'), 'video');
  assert.equal(A.kindOf('c.txt'), null, '不认识的后缀返回 null；调用方据此过滤');
});

await testAsync('embedPrompt：PNG 写入中文提示词并能读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-meta-'));
  const file = join(dir, 'a.png');
  await writeFile(file, makePng());
  const r = await A.embedPrompt(file, '一只坐在窗台上的橘猫，水彩风格');
  assert.equal(r.embedded, true);
  assert.equal(r.format, 'png');
  assert.equal(await A.readEmbeddedPrompt(file), '一只坐在窗台上的橘猫，水彩风格');
  await rm(dir, { recursive: true, force: true });
});

await testAsync('embedPrompt：重复写入不膨胀（旧块被替换）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-meta-'));
  const file = join(dir, 'a.png');
  await writeFile(file, makePng());
  await A.embedPrompt(file, '第一版提示词');
  const once = (await readFile(file)).length;
  await A.embedPrompt(file, '第二版提示词，比第一版长一点');
  const twice = (await readFile(file)).length;
  assert.equal(await A.readEmbeddedPrompt(file), '第二版提示词，比第一版长一点');
  assert.ok(twice >= once, '体积不该变小');
  // 只有在长度变化时才允许增长；相同长度必须一字节不差
  await A.embedPrompt(file, '第二版提示词，比第一版长一点');
  assert.equal((await readFile(file)).length, twice);
  await rm(dir, { recursive: true, force: true });
});

await testAsync('embedPrompt：不覆盖也不误读别人的 tEXt["prompt"]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-meta-'));
  const file = join(dir, 'comfy.png');
  const foreign = '{"115":{"class_type":"KSampler"}}';
  await writeFile(file, makePng([textChunk('prompt', foreign)]));
  assert.equal(await A.readEmbeddedPrompt(file), null, 'ComfyUI 的工作流 JSON 不该被当成提示词');
  await A.embedPrompt(file, '我的提示词');
  assert.equal(await A.readEmbeddedPrompt(file), '我的提示词');
  const buf = await readFile(file);
  assert.ok(buf.includes(Buffer.from(foreign, 'latin1')), '别人的元数据必须原样保留');
  await rm(dir, { recursive: true, force: true });
});

await testAsync('embedPrompt：空提示词与 webp 明确拒绝而不是抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-meta-'));
  const png = join(dir, 'a.png');
  await writeFile(png, makePng());
  assert.deepEqual(await A.embedPrompt(png, '   '), { embedded: false, reason: '没有提示词' });
  const webp = join(dir, 'a.webp');
  await writeFile(webp, Buffer.from('RIFFxxxxWEBPVP8 '));
  const r = await A.embedPrompt(webp, '提示词');
  assert.equal(r.embedded, false);
  assert.match(r.reason, /不支持/);
  await rm(dir, { recursive: true, force: true });
});

await testAsync('embedPrompt：JPEG 用带前缀的 COM 段，可读回且幂等', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-meta-'));
  const file = join(dir, 'a.jpg');
  await writeFile(file, makeJpeg());
  const r = await A.embedPrompt(file, '夕阳下的海边公路，胶片颗粒');
  assert.equal(r.embedded, true);
  assert.equal(r.format, 'jpeg');
  assert.equal(await A.readEmbeddedPrompt(file), '夕阳下的海边公路，胶片颗粒');
  const once = (await readFile(file)).length;
  await A.embedPrompt(file, '夕阳下的海边公路，胶片颗粒');
  assert.equal((await readFile(file)).length, once, '重复写入不该膨胀');
  await rm(dir, { recursive: true, force: true });
});

await testAsync('listLibrary：分类、两种字段名、按时间倒序、带提示词', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-lib-'));
  await writeFile(join(dir, 'old.png'), makePng());
  await writeFile(join(dir, 'clip.mp4'), Buffer.from('0000'));
  await new Promise((r) => setTimeout(r, 12));
  const withPrompt = join(dir, 'new.png');
  await writeFile(withPrompt, makePng());
  await A.embedPrompt(withPrompt, '后来画的那张');
  await writeFile(join(dir, 'notes.txt'), Buffer.from('x'));

  const files = await A.listLibrary(dir);
  assert.equal(files.length, 3, '只认图片与视频');
  assert.equal(files[0].filename, 'new.png');
  assert.equal(files[0].name, 'new.png', 'name 与 filename 都要给');
  assert.equal(files[0].kind, 'image');
  assert.equal(files[0].prompt, '后来画的那张');
  assert.equal(files[1].kind, 'video');
  assert.ok(files[0].mtime >= files[1].mtime, '按修改时间倒序');
  await rm(dir, { recursive: true, force: true });
});

await testAsync('历史：去重置顶、上限 24、清空', async () => {
  await backup(HISTORY_FILE);
  await A.clearHistory();
  for (let i = 0; i < 30; i += 1) {
    await A.appendHistory({ filename: `img-${i}.png`, kind: 'image', bytes: i, prompt: 'p' });
  }
  let { entries } = await A.readHistory();
  assert.equal(entries.length, A.HISTORY_MAX, '应该截断到 24');
  assert.equal(entries[0].filename, 'img-29.png', '最新的在最前');

  await A.appendHistory({ filename: 'img-0.png', kind: 'image' });
  ({ entries } = await A.readHistory());
  assert.equal(entries.length, A.HISTORY_MAX, '重复项不该增加条数');
  assert.equal(entries[0].filename, 'img-0.png', '重复项置顶');

  await A.clearHistory();
  ({ entries } = await A.readHistory());
  assert.equal(entries.length, 0);
});

test('任务表：sanitize 挡掉空 id，状态非法归一为 queued', async () => {
  await backup(TASKS_FILE);
  await A.writeTasks([{ id: 'v1', status: 'running' }, { status: 'queued' }, { id: 'v2', status: '乱写' }]);
  const tasks = await A.readTasks();
  assert.equal(tasks.length, 2, '没有 id 的条目应该被丢掉');
  const v2 = tasks.find((t) => t.id === 'v2');
  assert.equal(v2.status, 'queued');
});

/* 视频提交：三种模式（text / keyframe / reference）各自的请求体 */
const realFetch = globalThis.fetch;
let videoBodies = [];

function stubVideoFetch() {
  videoBodies = [];
  globalThis.fetch = async (url, init) => {
    videoBodies.push(JSON.parse(String(init && init.body)));
    const payload = JSON.stringify({ video_id: 'task_test_1' });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
  };
}

await testAsync('视频：默认纯文本，不带 images / first_frame', async () => {
  stubVideoFetch();
  const r = await A.submitVideo({ prompt: '一只猫' });
  assert.equal(r.mode, 'text');
  assert.equal(videoBodies[0].mode, 'text');
  assert.equal(videoBodies[0].images, undefined);
  assert.equal(videoBodies[0].first_frame, undefined);
  globalThis.fetch = realFetch;
});

await testAsync('视频：参考图走 reference，images 原样进 body', async () => {
  stubVideoFetch();
  const dataUri = 'data:image/png;base64,' + makePng().toString('base64');
  const r = await A.submitVideo({ prompt: '一只猫', referenceImages: [dataUri, dataUri] });
  assert.equal(r.mode, 'reference');
  assert.equal(videoBodies[0].mode, 'reference');
  assert.equal(videoBodies[0].images.length, 2);
  assert.equal(videoBodies[0].images[0], dataUri);
  globalThis.fetch = realFetch;
});

await testAsync('视频：参考图超过 5 张直接报错，不打上游', async () => {
  stubVideoFetch();
  const dataUri = 'data:image/png;base64,' + makePng().toString('base64');
  await assert.rejects(
    () => A.submitVideo({ prompt: '一只猫', referenceImages: new Array(6).fill(dataUri) }),
    /参考图最多 5 张/,
  );
  assert.equal(videoBodies.length, 0, '参数错不该发请求');
  globalThis.fetch = realFetch;
});

await testAsync('视频：首帧优先于参考图，不给 images', async () => {
  stubVideoFetch();
  const dataUri = 'data:image/png;base64,' + makePng().toString('base64');
  const r = await A.submitVideo({ prompt: '一只猫', firstFrame: dataUri, referenceImages: [dataUri] });
  assert.equal(r.mode, 'keyframe');
  assert.equal(videoBodies[0].mode, 'keyframe');
  assert.equal(videoBodies[0].first_frame, dataUri);
  assert.equal(videoBodies[0].images, undefined, 'keyframe 模式不该带参考图');
  globalThis.fetch = realFetch;
});

/* ================================================================== */
/* 2. client.js                                                        */
/* ================================================================== */

const cssText = [];

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
};

const documentStub = {
  head: { appendChild: (el) => cssText.push(el.textContent || '') },
  createElement: () => ({ dataset: {}, textContent: '', setAttribute() {} }),
  querySelectorAll: () => [],
  body: { appendChild() {} },
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (mod) => { captured = mod; } } };
globalThis.document = documentStub;
// Node 26 里 navigator 只有 getter，必须用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (t) => { globalThis.__clip = t; } } },
});

await import(join(LIB, 'client.js') + '?' + Date.now());
const clientMod = captured.factory((name) => (name === 'react' ? React : {}));

const slots = { inject() {}, register() {} };
const ctxStub = {
  get: (n) => (n === 'slots' ? slots : undefined),
  effect: () => () => {},
  on() {},
  reflect: { get: () => undefined },
};
clientMod.apply(ctxStub);

const createStore = clientMod.__internals.createStore;

test('client：apply 后样式已注入', () => {
  const all = cssText.join('\n');
  assert.ok(all.includes('.agn-lib-grid'), '缺少输出目录样式');
  assert.ok(all.includes('.agn-prompt'), '缺少提示词浮层样式');
  assert.ok(all.includes('.agn-presets'), '缺少提示词预设样式');
  assert.ok(all.includes('.agn-frame-from'), '缺少「＋ 结果」样式');
  assert.ok(all.includes('.agn-thumb video'), '视频缩略图样式缺失');
  const pointerNone = (all.match(/pointer-events:\s*none/g) || []).length;
  assert.ok(pointerNone >= 3, `缩略图里 <video> 必须不影响点击，实际只有 ${pointerNone} 处`);
});

test('store：方法齐全', () => {
  const s = createStore();
  for (const name of [
    'loadLibrary', 'toggleLibrary', 'setLibraryTab', 'showLibraryFile',
    'copyPrompt', 'pickFrame', 'setFrameFromFile', 'clearFrame',
    'toggleFramePick', 'setFrameFromResult', 'useResultAsFrame',
    'copyPath', 'reveal', 'downloadResult', 'cancel', 'resumeTasks',
    'loadHistory', 'run', 'clear',
  ]) {
    assert.equal(typeof s[name], 'function', `缺少 ${name}`);
  }
});

test('store：初始状态', () => {
  const s = createStore();
  const st = s.get();
  assert.equal(st.library, null);
  assert.equal(st.libraryOpen, false);
  assert.equal(st.libraryTab, 'image');
  assert.equal(st.vTaskId, null);
  assert.equal(st.vFirst, null);
  assert.equal(st.vLast, null);
  assert.equal(st.historyMax, 24);
});

/* --- 用假 fetch 驱动 store --- */
const libFiles = [
  { filename: 'a.png', name: 'a.png', kind: 'image', bytes: 100, prompt: '一只橘猫' },
  { filename: 'b.mp4', name: 'b.mp4', kind: 'video', bytes: 900, prompt: '' },
  { filename: 'c.jpg', name: 'c.jpg', kind: 'image', bytes: 200, prompt: '' },
];

let fetchCalls = [];
let taskState = { status: 'queued', progress: 0 };
let libVersion = 0;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  fetchCalls.push(method + ' ' + u);
  const json = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    blob: async () => ({ size: 10 }),
  });

  if (u.startsWith('/agnes/library')) {
    // libVersion 涨了以后多返回一张，用来验证生成完成后的静默刷新
    const files = libVersion === 0
      ? libFiles
      : libFiles.concat([{ filename: 'n.png', name: 'n.png', kind: 'image', bytes: 1, mtime: Date.now(), prompt: '新生成的' }]);
    return json({ ok: true, outDir: '/tmp/out', files, images: 2, videos: 1 });
  }
  if (u.startsWith('/agnes/generate')) {
    return json({ ok: true, filename: 'n.png', path: '/tmp/out/n.png', bytes: 1, mode: 'text2img', size: '1K', ratio: '1:1', refCount: 0 });
  }
  if (u.startsWith('/agnes/history')) {
    return json({ ok: true, entries: [], max: 24 });
  }
  if (u.startsWith('/agnes/tasks')) {
    return json({ ok: true, tasks: [{ id: 'v-live', status: 'running', progress: 30, prompt: '跑着的任务' }], active: 1, max: 50 });
  }
  if (u.startsWith('/agnes/task?id=')) {
    return json({ ok: true, task: { id: 'v-live', status: taskState.status, progress: taskState.progress, videoId: 'vid-1' } });
  }
  return json({ ok: false, error: '意外的请求 ' + u }, 500);
};

await testAsync('loadLibrary：展开拉列表并缓存', async () => {
  const s = createStore();
  fetchCalls = [];
  await s.toggleLibrary();
  assert.equal(s.get().libraryOpen, true);
  assert.equal(s.get().library.length, 3);
  const before = fetchCalls.length;
  await s.toggleLibrary();            // 收起
  await s.toggleLibrary();            // 再展开，应该走缓存
  assert.equal(fetchCalls.length, before, '已加载过就不该重复请求');
});

await testAsync('生成完成后静默刷新输出目录', async () => {
  const s = createStore();
  libVersion = 0;
  fetchCalls = [];
  await s.toggleLibrary();
  assert.equal(s.get().library.length, 3, '先加载 3 条');

  // 宿主那边多了一张新图；生成完成时 refreshLibrary 应该把它拉回来
  libVersion = 1;
  s.set({ prompt: '一只猫', mode: 'image' });
  await s.run();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(s.get().library.length, 4, '生成完成后目录清单应自动多出新文件');
  assert.equal(s.get().library[3].filename, 'n.png');
  assert.ok(
    fetchCalls.filter((c) => c === 'GET /agnes/library').length >= 2,
    '生成完成后应再次请求 /agnes/library'
  );
});

await testAsync('没展开过目录时，生成完成不偷偷拉清单', async () => {
  const s = createStore();
  libVersion = 1;
  fetchCalls = [];
  s.set({ prompt: '一只狗', mode: 'image' });
  await s.run();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(s.get().library, null, 'library 仍是 null');
  assert.equal(fetchCalls.filter((c) => c.includes('/agnes/library')).length, 0, '不该请求 /agnes/library');
});

await testAsync('setLibraryTab：非法值归一为 image', async () => {
  const s = createStore();
  s.setLibraryTab('video');
  assert.equal(s.get().libraryTab, 'video');
  s.setLibraryTab('乱写');
  assert.equal(s.get().libraryTab, 'image');
});

await testAsync('showLibraryFile：带 fromDisk 与提示词', async () => {
  const s = createStore();
  s.showLibraryFile(libFiles[0]);
  const r = s.get().result;
  assert.equal(r.kind, 'image');
  assert.equal(r.filename, 'a.png');
  assert.equal(r.prompt, '一只橘猫');
  assert.equal(r.fromDisk, true);

  s.showLibraryFile(libFiles[1]);
  assert.equal(s.get().result.kind, 'video');
});

await testAsync('copyPrompt：写剪贴板、去空白；空提示词不写', async () => {
  const s = createStore();
  globalThis.__clip = '';
  await s.copyPrompt('  一只橘猫  ');
  assert.equal(globalThis.__clip, '一只橘猫');
  assert.match(s.get().notice, /已复制/);

  globalThis.__clip = 'untouched';
  await s.copyPrompt('   ');
  assert.equal(globalThis.__clip, 'untouched', '只有空白字符时不该写剪贴板');
});

test('关键帧：从生成结果取图时忽略非图片条目', async () => {
  const s = createStore();
  await s.setFrameFromResult('first', { kind: 'video', filename: 'b.mp4' });
  assert.equal(s.get().vFirst, null);
  await s.setFrameFromResult('first', null);
  assert.equal(s.get().vFirst, null);
});

test('「＋ 结果」候选：当前结果区那张也算，和历史按文件名去重', () => {
  const { pickableImagesOf } = clientMod.__internals;
  const inHistory = { kind: 'image', filename: 'a.png' };

  // 1) 结果区是「输出目录」点出来的图，历史里没有它 —— 这才是用户踩到的场景
  const fromDisk = { kind: 'image', filename: 'disk.png', fromDisk: true };
  const only = pickableImagesOf({ history: [], result: fromDisk });
  assert.equal(only.length, 1, '历史为空时，当前结果也要能选');
  assert.equal(only[0].filename, 'disk.png');

  // 2) 结果和历史里是同一张，不能出现两份
  const dup = pickableImagesOf({ history: [inHistory], result: { ...inHistory } });
  assert.equal(dup.length, 1, '同一文件名只留一份');

  // 3) 结果不是图片（视频 / 空）时，只给历史
  assert.equal(pickableImagesOf({ history: [inHistory], result: { kind: 'video', filename: 'v.mp4' } }).length, 1);
  assert.equal(pickableImagesOf({ history: [inHistory], result: null }).length, 1);

  // 4) 历史里的视频不该混进来
  const withVideo = pickableImagesOf({ history: [{ kind: 'video', filename: 'v.mp4' }, inHistory], result: null });
  assert.equal(withVideo.length, 1);
  assert.equal(withVideo[0].filename, 'a.png');
});

await testAsync('setModel：切换顶部模型写进草稿并立刻落盘', async () => {
  const prevFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (data, status = 200) => ({
      ok: status >= 200 && status < 300, status,
      json: async () => data, blob: async () => ({ size: 1 }),
    });
    if (u.startsWith('/agnes/config')) {
      seen.push(JSON.parse(String(opts.body)));
      return json({
        ok: true,
        config: { keyFile: '/k', outDir: '/o', imageModel: 'agnes-image-2.1-flash', videoModel: 'agnes-video-2.5' },
        defaults: {}, stored: {},
      });
    }
    if (u.startsWith('/agnes/health')) return json({ ok: true, models: { image: [], video: [] } });
    return json({ ok: false, error: 'unexpected ' + u }, 500);
  };
  try {
    const s = createStore();
    await s.setModel('video', 'agnes-video-2.5');
    assert.equal(seen.length, 1, '切换模型应当立刻 POST /agnes/config');
    assert.equal(seen[0].videoModel, 'agnes-video-2.5', '请求体里应带上新模型');
    assert.equal(s.get().cfgDraft.videoModel, 'agnes-video-2.5');
    assert.match(s.get().notice, /已切换模型/);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

await testAsync('checkKey：成功后留下上游真实模型清单给顶部下拉用', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (data, status = 200) => ({
      ok: status >= 200 && status < 300, status,
      json: async () => data, blob: async () => ({ size: 1 }),
    });
    if (u.startsWith('/agnes/models')) {
      return json({
        ok: true,
        upstream: {
          models: ['agnes-image-2.5-flash', 'agnes-video-2.5-flash'],
          image: ['agnes-image-2.5-flash'],
          video: ['agnes-video-2.5-flash', 'agnes-video-2.5'],
        },
      });
    }
    return json({ ok: false }, 500);
  };
  try {
    const s = createStore();
    await s.checkKey();
    const st = s.get();
    assert.equal(st.checkResult && st.checkResult.ok, true, '连接正常应当有成功文案');
    assert.equal(st.upModels.video.length, 2, '上游视频模型清单要留下');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('cancel：没有宿主任务与有宿主任务给不同提示', () => {
  const s = createStore();
  s.cancel();
  assert.equal(s.get().busy, false, '空闲时调用应当无副作用');

  s.set({ busy: true, vTaskId: null });
  s.cancel();
  assert.equal(s.get().busy, false);
  assert.match(s.get().notice, /停止等待/);

  s.set({ busy: true, vTaskId: 'v1' });
  s.cancel();
  assert.equal(s.get().vTaskId, 'v1', '取消不该丢掉任务号，刷新还能接回');
  assert.match(s.get().notice, /宿主会继续推进/);
});

await testAsync('resumeTasks：挂载时接回运行中的视频任务', async () => {
  taskState = { status: 'completed', progress: 100 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (data) => ({ ok: true, status: 200, json: async () => data, blob: async () => ({ size: 1 }) });
    if (u.startsWith('/agnes/tasks')) {
      return json({ ok: true, tasks: [{ id: 'v-live', status: 'running', progress: 30, prompt: '跑着的任务' }], active: 1 });
    }
    if (u.startsWith('/agnes/task?id=')) {
      return json({ ok: true, task: { id: 'v-live', status: 'completed', progress: 100, videoId: 'vid-1', filename: 'vid.mp4', path: '/tmp/out/vid.mp4', bytes: 1234, ratio: '16:9', seconds: '5', mode: 'keyframe', prompt: '跑着的任务' } });
    }
    if (u.startsWith('/agnes/history')) return json({ ok: true, entries: [], max: 24 });
    return json({ ok: false });
  };
  const s = createStore();
  await s.resumeTasks();
  const st = s.get();
  assert.equal(st.mode, 'video');
  assert.equal(st.vTaskId, 'v-live');
  assert.equal(st.busy, false, '任务完成后应结束忙碌态');
  assert.equal(st.result && st.result.filename, 'vid.mp4');
});

/* ================================================================== */
/* 3. index.js                                                         */
/* ================================================================== */

await backup(TASKS_FILE);
await backup(HISTORY_FILE);
await A.writeTasks([]);

const routes = [];
const webServer = { register: (route) => { routes.push(route); return () => {}; } };
const effects = [];
const injectCalls = [];
const indexMod = await import(join(LIB, 'index.js'));
indexMod.apply({
  get: (n) => (n === 'webServer' ? webServer : undefined),
  effect: (fn) => { effects.push(fn); return () => {}; },
  on() {},
  // 真实的宿主会在这里回调并给出 sub.tools；桩里不回调，模拟「没有 tools 服务」的宿主。
  inject: (names) => { injectCalls.push(names); return () => {}; },
  reflect: { get: (n) => (n === 'webServer' ? webServer : undefined) },
});

test('样式：client.js 不给 style 传字符串（React 会抛错导致整块面板白屏）', async () => {
  const src = await readFile(join(LIB, 'client.js'), 'utf8');
  assert.equal(src.includes('style: "'), false, 'style 必须是对象，字符串会让 React 抛错');
});

test('工具：向宿主申请了 tools 服务（没有 tools 也不影响插件激活）', () => {
  assert.ok(
    injectCalls.some((names) => Array.isArray(names) && names.includes('tools')),
    'apply 时应 ctx.inject([\'tools\'])',
  );
});

test('路由：关键路径都已注册', () => {
  const paths = routes.map((r) => r.path);
  for (const p of [
    '/agnes/health', '/agnes/config', '/agnes/generate', '/agnes/video',
    '/agnes/tasks', '/agnes/task', '/agnes/task/cancel',
    '/agnes/history', '/agnes/library', '/agnes/reveal',
    '/agnes/media', '/agnes/image',
  ]) {
    assert.ok(paths.includes(p), `缺少路由 ${p}`);
  }
});

/* 简易的 req/res 桩 */
function fakeExchange(method, url, body) {
  const out = { status: 200, json: null };
  // readJson() 走的是 req.on('data') / req.on('end') 事件式读取，
  // 所以桩必须是真 EventEmitter：只给 asyncIterator 会让 readJson 永远挂着。
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  req.destroy = () => {};
  const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
  setImmediate(() => {
    if (payload !== null) req.emit('data', payload);
    req.emit('end');
  });
  const res = {
    setHeader() {},
    writeHead(code) { out.status = code; return res; },
    end(buf) { try { out.json = JSON.parse(String(buf)); } catch { out.json = null; } },
    write() {},
  };
  return { req, res, out };
}

async function callRoute(path, method = 'GET', body) {
  const route = routes.find((r) => r.path === String(path).split('?')[0]);
  assert.ok(route, `路由不存在 ${path}`);
  const { req, res, out } = fakeExchange(method, path, body);
  await route.handler(req, res);
  return out;
}

await testAsync('GET /agnes/tasks：返回任务列表', async () => {
  const out = await callRoute('/agnes/tasks');
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.ok(Array.isArray(out.json.tasks));
});

await testAsync('GET /agnes/tasks：错误方法 405', async () => {
  const out = await callRoute('/agnes/tasks', 'PUT');
  assert.equal(out.status, 405);
});

await testAsync('GET /agnes/task：不存在的任务 404', async () => {
  const out = await callRoute('/agnes/task?id=nope');
  assert.equal(out.status, 404);
  assert.match(out.json.error, /不存在/);
});

await testAsync('GET /agnes/library：返回目录清单', async () => {
  const out = await callRoute('/agnes/library');
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.ok(Array.isArray(out.json.files));
  assert.equal(typeof out.json.outDir, 'string');
});

await testAsync('GET /agnes/history：过滤输出目录里已不存在的条目', async () => {
  await A.clearHistory();
  await A.appendHistory({ filename: 'definitely-not-here-xyz.png', kind: 'image' });
  const out = await callRoute('/agnes/history');
  assert.equal(out.status, 200);
  assert.equal(out.json.entries.length, 0, '指向别处 / 已删除的文件应当被过滤掉');
});

/* ------------------------------------------------------------------ */
/* 模型切换 + 连通性探测（P1 第 9 项）                                  */
/* ------------------------------------------------------------------ */

await testAsync('模型：默认值、非法值拒绝、脏值回退', async () => {
  await backup(CONFIG_FILE);
  await rm(CONFIG_FILE, { force: true });

  const fresh = await A.resolvePaths();
  assert.equal(fresh.imageModel, A.IMAGE_MODELS[0], '没有配置时用内置默认图片模型');
  assert.equal(fresh.videoModel, A.VIDEO_MODELS[0], '没有配置时用内置默认视频模型');
  assert.equal(fresh.stored.imageModel, null);

  await assert.rejects(() => A.saveConfig({ imageModel: 'agnes-image-9.9' }), /不在可选范围内/);
  await assert.rejects(() => A.saveConfig({ videoModel: 'agnes-video-9.9' }), /不在可选范围内/);

  await A.saveConfig({ imageModel: 'agnes-image-2.1-flash', videoModel: 'agnes-video-2.5' });
  const saved = await A.resolvePaths();
  assert.equal(saved.imageModel, 'agnes-image-2.1-flash');
  assert.equal(saved.videoModel, 'agnes-video-2.5');
  assert.equal(saved.stored.imageModel, 'agnes-image-2.1-flash');

  // 配置文件被手改脏了也不该报错，直接当没写
  await writeFile(CONFIG_FILE, JSON.stringify({ imageModel: 'whatever' }) + '\n', 'utf8');
  await backup(CONFIG_FILE);
  const dirty = await A.resolvePaths();
  assert.equal(dirty.imageModel, A.IMAGE_MODELS[0]);
  assert.equal(dirty.stored.imageModel, null);
});

await testAsync('GET /agnes/models：Key 缺失 400、上游 200 分类、401 文案', async () => {
  await backup(CONFIG_FILE);
  const realFetch = globalThis.fetch;

  // 1) Key 文件不存在
  await A.saveConfig({ keyFile: join(tmpdir(), 'agnes-no-such-key.txt') });
  let out = await callRoute('/agnes/models');
  assert.equal(out.status, 400);
  assert.match(out.json.error, /没有找到 Key/);
  assert.deepEqual(out.json.fallback.image, A.IMAGE_MODELS);

  // 2) 上游正常：图片 / 视频分别归类
  const keyFile = join(tmpdir(), 'agnes-test-key.txt');
  await writeFile(keyFile, 'sk-test-only', 'utf8');
  await A.saveConfig({ keyFile });
  let seenUrl = '';
  globalThis.fetch = async (url) => {
    seenUrl = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'agnes-image-2.5-flash' },
          { id: 'agnes-image-2.1-flash' },
          { id: 'agnes-video-2.5-flash' },
          { id: 'agnes-2.5-pro' },
        ],
      }),
    };
  };
  try {
    out = await callRoute('/agnes/models');
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.match(seenUrl, /\/models$/);
    assert.deepEqual(out.json.upstream.image, ['agnes-image-2.5-flash', 'agnes-image-2.1-flash']);
    assert.deepEqual(out.json.upstream.video, ['agnes-video-2.5-flash']);
    assert.equal(out.json.upstream.models.length, 4, '文本模型也要回给前端');

    // 3) Key 失效
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    out = await callRoute('/agnes/models');
    assert.equal(out.status, 400);
    assert.match(out.json.error, /Key 无效或已过期/);
  } finally {
    globalThis.fetch = realFetch;
    await rm(keyFile, { force: true });
  }
});

await testAsync('POST /agnes/generate：请求体用配置里的图片模型', async () => {
  await backup(CONFIG_FILE);
  const realFetch = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'agnes-model-gen-'));
  const keyFile = join(dir, 'key.txt');
  await writeFile(keyFile, 'sk-test-only', 'utf8');
  await A.saveConfig({ keyFile, outDir: dir, imageModel: 'agnes-image-2.1-flash' });

  let seenBody = null;
  globalThis.fetch = async (url, init) => {
    seenBody = JSON.parse(init.body);
    const payload = JSON.stringify({ data: [{ b64_json: makePng().toString('base64') }] });
    return {
      ok: true,
      status: 200,
      text: async () => payload,
      json: async () => JSON.parse(payload),
    };
  };
  try {
    const out = await callRoute('/agnes/generate', 'POST', { prompt: '模型测试', size: '1K', ratio: '1:1' });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(seenBody.model, 'agnes-image-2.1-flash', '应该用配置里的模型而不是内置默认');
    assert.equal(out.json.mode, 'text2img');
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

/* ================================================================== */
/* 4. 自定义提示词预设 + 提示词扩写（0.11.0）                           */
/* ================================================================== */

await backup(PRESETS_FILE);
await rm(PRESETS_FILE, { force: true });

await testAsync('预设：没有文件时读回空列表', async () => {
  const out = await A.readPresets();
  assert.equal(out.presets.length, 0);
  assert.equal(out.file, PRESETS_FILE);
});

await testAsync('预设：坏文件静默回退为空列表', async () => {
  await writeFile(PRESETS_FILE, '{ 这不是 JSON');
  const out = await A.readPresets();
  assert.equal(out.presets.length, 0, '配置坏了也不能让面板报错');
});

await testAsync('预设：保存 → 同名覆盖并置顶 → 删除幂等', async () => {
  await A.savePreset({ label: '甲', text: '一条' });
  await A.savePreset({ label: '乙', text: '二条' });
  let out = await A.readPresets();
  assert.deepEqual(out.presets.map((p) => p.label), ['乙', '甲'], '新的在最前面');

  await A.savePreset({ label: '甲', text: '改过' });
  out = await A.readPresets();
  assert.deepEqual(out.presets.map((p) => p.label), ['甲', '乙'], '同名应置顶而不是多出一条');
  assert.equal(out.presets[0].text, '改过');

  await A.removePreset('乙');
  out = await A.readPresets();
  assert.deepEqual(out.presets.map((p) => p.label), ['甲']);

  await A.removePreset('不存在');
  out = await A.readPresets();
  assert.equal(out.presets.length, 1, '删不存在的名字应当成功且不改动列表');
});

await testAsync('预设：拒绝空名称 / 空内容', async () => {
  await assert.rejects(A.savePreset({ label: '   ', text: 'x' }), /预设需要名称和内容/);
  await assert.rejects(A.savePreset({ label: 'x', text: '   ' }), /预设需要名称和内容/);
  await assert.rejects(A.savePreset(null), /预设需要名称和内容/);
});

await testAsync('预设：名称截到 20 字、内容截到 600 字', async () => {
  const out = await A.savePreset({ label: 'a'.repeat(40), text: 'b'.repeat(900) });
  const first = out.presets[0];
  assert.equal(first.label.length, 20);
  assert.equal(first.text.length, 600);
});

await testAsync('预设：最多保留 40 条', async () => {
  for (let i = 0; i < 45; i += 1) {
    await A.savePreset({ label: `批量${i}`, text: `内容${i}` });
  }
  const out = await A.readPresets();
  assert.equal(out.presets.length, 40, '不能无限增长');
  assert.equal(out.presets[0].label, '批量44', '最新的在最前面');
});

await testAsync('扩写：200 时返回正文并剥掉引号', async () => {
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(String(init.body)) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '“一只橘猫端坐在窗台上，午后逆光，浅景深，35mm 定焦”' } }],
        usage: { total_tokens: 160 },
      }),
      text: async () => '',
    };
  };
  try {
    const out = await A.expandPrompt('一只橘猫', { key: 'sk-test-only' });
    assert.equal(out.prompt, '一只橘猫端坐在窗台上，午后逆光，浅景深，35mm 定焦', '首尾的引号要去掉');
    assert.equal(out.model, A.EXPAND_MODEL);
    assert.equal(seen.url, 'https://api.agnes-ai.cn/v1/chat/completions');
    assert.equal(seen.body.model, A.EXPAND_MODEL);
    assert.equal(seen.body.messages.length, 2);
    assert.equal(seen.body.messages[1].content, '一只橘猫');
    assert.ok(seen.body.messages[0].content.includes('图像提示词工程师'), '图片模式用图像那套 system');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await testAsync('扩写：视频模式换用镜头描述的 system', async () => {
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(String(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '镜头缓慢推近，橘猫抬头。' } }] }),
      text: async () => '',
    };
  };
  try {
    const out = await A.expandPrompt('橘猫抬头', { kind: 'video', key: 'sk-test-only' });
    assert.equal(out.prompt, '镜头缓慢推近，橘猫抬头。');
    assert.ok(seen.messages[0].content.includes('视频提示词工程师'), '视频模式用视频那套 system');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await testAsync('扩写：401 / 空正文 / 空输入 都给出可读错误', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
    await assert.rejects(A.expandPrompt('随便写点', { key: 'sk-test-only' }), /Key 无效或已过期（HTTP 401）/);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '   ' } }] }),
      text: async () => '',
    });
    await assert.rejects(A.expandPrompt('随便写点', { key: 'sk-test-only' }), /上游没有返回内容/);

    await assert.rejects(A.expandPrompt('   ', { key: 'sk-test-only' }), /先写一句想画什么/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await testAsync('客户端：预设与扩写的方法都已导出', () => {
  const s = createStore();
  for (const name of ['loadPresets', 'appendPreset', 'saveCurrentAsPreset', 'deletePreset', 'setPresetLabel', 'togglePresetForm', 'expandPrompt']) {
    assert.equal(typeof s[name], 'function', `缺少 ${name}`);
  }
  const st = s.get();
  assert.deepEqual(st.presets, []);
  assert.equal(st.presetFormOpen, false);
  assert.equal(st.expandBusy, false);
});

await testAsync('客户端：appendPreset 追加到已有一句之后，空提示词则直接填入', async () => {
  const s = createStore();
  s.appendPreset({ label: '内置', text: '水彩风格' });
  assert.equal(s.get().prompt, '水彩风格');
  s.set({ prompt: '一只橘猫，' });
  s.appendPreset({ label: '内置', text: '水彩风格' });
  assert.equal(s.get().prompt, '一只橘猫，水彩风格', '应去掉尾部的逗号再拼');
});

/* 收尾：停掉任务引擎、复原用户数据 */
for (const fn of effects) {
  try {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanup();
  } catch {
    /* 清理失败不影响结论 */
  }
}
await restoreAll();

console.log('');
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(' - ' + f.name);
  process.exit(1);
}
