/**
 * Agnes 出图内核 —— 被宿主插件（lib/index.js）和 CLI（agnes-image.mjs）共用。
 *
 * 文档：https://www.agnes-ai.com/zh-Hans/docs/agnes-image-25-flash
 *
 * 硬约束（别改错，都是文档里写死的坑）：
 *   · POST {base}/images/generations
 *   · 文生图必填 model / prompt / size
 *   · response_format 只能放 extra_body 内，放顶层会报错
 *   · 图生图输入放 extra_body.image（URL 或 data URI）
 *
 * API Key 永远从文件读，不进代码、不进日志。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

export const MODEL = 'agnes-image-2.5-flash';
export const DEFAULT_BASE = 'https://api.agnes-ai.cn/v1'; // 中国站

/* ==========================================================================
   可配置路径：Key 文件位置 / 输出目录
   --------------------------------------------------------------------------
   优先级：显式传参 > 已保存配置 > 环境变量 > 内置默认。
   配置存于 ~/.dsh/agnes-image/config.json，由面板里的「设置」卡片写入。
   ========================================================================== */

export const CONFIG_DIR = join(homedir(), '.dsh', 'agnes-image');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const DEFAULT_KEY_FILE = join(homedir(), '.agnes-key.txt');
export const DEFAULT_OUT_DIR = join(homedir(), 'Desktop', 'Agnes出图');

/** 兼容旧引用（skill / CLI 用它展示默认值）。生效值请用 resolvePaths()。 */
export const KEY_FILE = process.env.AGNES_KEY_FILE || DEFAULT_KEY_FILE;
export const OUT_DIR = process.env.AGNES_OUT_DIR || DEFAULT_OUT_DIR;

export const TIMEOUT_MS = 300_000; // 文档建议 60s–360s

export const SIZES = ['1K', '2K', '3K', '4K'];
export const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

/** 把开头的 ~ 展开成家目录；其余原样返回。 */
export function expandHome(p) {
  const s = String(p ?? '').trim();
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

/**
 * 解析生效配置。
 * 配置文件不存在或内容损坏时一律退回默认值 —— 配置坏了不该把插件拖死。
 */
export async function resolvePaths() {
  let stored = {};
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) stored = raw;
  } catch { /* 无配置文件或解析失败 → 用默认 */ }

  const storedKey = typeof stored.keyFile === 'string' && stored.keyFile.trim() !== ''
    ? expandHome(stored.keyFile) : null;
  const storedOut = typeof stored.outDir === 'string' && stored.outDir.trim() !== ''
    ? expandHome(stored.outDir) : null;

  return {
    keyFile: storedKey ?? (process.env.AGNES_KEY_FILE || DEFAULT_KEY_FILE),
    outDir: storedOut ?? (process.env.AGNES_OUT_DIR || DEFAULT_OUT_DIR),
    configFile: CONFIG_FILE,
    defaults: { keyFile: DEFAULT_KEY_FILE, outDir: DEFAULT_OUT_DIR },
    stored: { keyFile: storedKey, outDir: storedOut },
  };
}

/**
 * 保存配置，只覆盖传进来的字段；传 null 表示清除该字段、回退默认。
 * 校验：必须是绝对路径；输出目录立刻创建 —— 写不进去现在报错，
 * 而不是等到出图时才失败。
 */
export async function saveConfig(patch = {}) {
  const current = await resolvePaths();

  const next = {
    keyFile: patch.keyFile === undefined ? current.stored.keyFile : patch.keyFile,
    outDir: patch.outDir === undefined ? current.stored.outDir : patch.outDir,
  };

  for (const [field, label] of [['keyFile', 'Key 文件路径'], ['outDir', '输出目录']]) {
    const v = next[field];
    if (v === null) continue; // 允许清空回默认
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`${label}不能为空`);
    const expanded = expandHome(v);
    if (!expanded.startsWith('/')) throw new Error(`${label}必须是绝对路径（或以 ~/ 开头）`);
    next[field] = expanded;
  }

  await mkdir(next.outDir ?? current.outDir, { recursive: true });

  const payload = {};
  if (typeof next.keyFile === 'string') payload.keyFile = next.keyFile;
  if (typeof next.outDir === 'string') payload.outDir = next.outDir;

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  return resolvePaths();
}

/** 读 Key。不传 file 则按当前配置解析。 */
export async function readKey(file) {
  const target = file ?? (await resolvePaths()).keyFile;
  let raw;
  try {
    raw = await readFile(target, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`找不到 key 文件：${target}。把 Key 写进该文件（只放 key 本身，不要带 "Bearer"）。`);
    }
    throw e;
  }
  const key = raw.trim();
  if (!key) throw new Error(`key 文件是空的：${target}`);
  if (/^bearer\s+/i.test(key)) throw new Error('key 文件里不要带 "Bearer " 前缀');
  return key;
}

export async function keyStatus(file) {
  const target = file ?? (await resolvePaths()).keyFile;
  try {
    const key = await readKey(target);
    return { present: true, file: target, length: key.length, masked: key.slice(0, 3) + '***' + key.slice(-3) };
  } catch (e) {
    return { present: false, file: target, error: e.message };
  }
}

export function buildBody({ prompt, size = '1K', ratio = '1:1', model = MODEL, fmt = 'url', images = [] }) {
  const body = {
    model,
    prompt,
    size,
    ratio,
    // 文档明确要求：response_format 只能在 extra_body 内
    extra_body: { response_format: fmt === 'b64' ? 'b64_json' : 'url' },
  };
  if (images.length > 0) body.extra_body.image = images;
  return body;
}

async function post({ baseUrl, key, body }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/images/generations`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const detail = e.name === 'TimeoutError' ? `超时（${TIMEOUT_MS / 1000}s）` : `${e.name}: ${e.message}`;
    throw new Error(`请求失败 — ${detail}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}，响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg = payload?.error?.message || payload?.message || text.slice(0, 300);
    throw new Error(`HTTP ${res.status} — ${msg}`);
  }
  const item = payload?.data?.[0];
  if (!item) throw new Error(`响应缺少 data[0]：${text.slice(0, 300)}`);
  return { payload, item };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/** 只允许安全的文件名，防止路径穿越。 */
export function safeName(name) {
  const b = basename(String(name || ''));
  return /^[A-Za-z0-9._-]+$/.test(b) ? b : null;
}

/**
 * 生成一张图并落盘。
 * @returns {Promise<{ok:true, filename:string, path:string, bytes:number, transport:string,
 *                    elapsedSec:number, size:string, ratio:string, model:string,
 *                    revisedPrompt:string|null, remoteUrl:string|null}>}
 */
export async function generate({
  prompt,
  size = '1K',
  ratio = '1:1',
  model = MODEL,
  baseUrl = DEFAULT_BASE,
  fmt = 'url',
  images = [],
  outDir,
  filename,
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('prompt 不能为空');
  if (!SIZES.includes(size)) throw new Error(`size 必须是 ${SIZES.join(' / ')}`);
  if (!RATIOS.includes(ratio)) throw new Error(`ratio 必须是 ${RATIOS.join(' / ')}`);

  const key = await readKey();
  const started = Date.now();

  let { payload, item } = await post({ baseUrl, key, body: buildBody({ prompt, size, ratio, model, fmt, images }) });

  const dir = outDir ?? (await resolvePaths()).outDir;
  const name = filename || `agnes-${stamp()}.png`;
  const path = join(dir, name);
  await mkdir(dir, { recursive: true });

  let buf;
  let transport;
  let remoteUrl = item.url || null;

  if (fmt === 'url' && item.url) {
    try {
      const r = await fetch(item.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) throw new Error(`下载返回 HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
      if (buf.length === 0) throw new Error('下载到 0 字节');
      transport = 'url → 下载';
    } catch (e) {
      // 存储域名不可达时自动回退 base64，避免白跑一次
      ({ payload, item } = await post({
        baseUrl, key, body: buildBody({ prompt, size, ratio, model, fmt: 'b64', images }),
      }));
      if (!item.b64_json) throw new Error(`回退 b64 后仍无 b64_json（原下载错误：${e.message}）`);
      buf = Buffer.from(item.b64_json, 'base64');
      transport = `url 失败(${e.message}) → b64 回退`;
      remoteUrl = null;
    }
  } else if (item.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64');
    transport = item.url ? 'b64（服务端附带 url）' : 'b64';
  } else if (item.url) {
    const r = await fetch(item.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`下载返回 HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
    transport = 'url → 下载';
  } else {
    throw new Error('响应里既没有 url 也没有 b64_json');
  }

  if (!buf || buf.length === 0) throw new Error('图片数据为空');
  await writeFile(path, buf);

  return {
    ok: true,
    filename: name,
    path,
    bytes: buf.length,
    transport,
    elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
    size,
    ratio,
    model,
    revisedPrompt: item.revised_prompt ?? null,
    remoteUrl,
  };
}

/* ==========================================================================
   媒体读取（图片 + 视频）
   ========================================================================== */
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

export async function readMedia(name, outDir) {
  const safe = safeName(name);
  if (safe === null) throw new Error('非法文件名');
  const dir = outDir ?? (await resolvePaths()).outDir;
  const path = join(dir, safe);
  const buf = await readFile(path);
  const dot = safe.lastIndexOf('.');
  const ext = dot < 0 ? '' : safe.slice(dot).toLowerCase();
  return { path, buf, mime: MIME[ext] ?? 'application/octet-stream' };
}

/** 兼容旧调用：只取字节。 */
export async function readImage(name, outDir) {
  const { path, buf } = await readMedia(name, outDir);
  return { path, buf };
}

/* ==========================================================================
   视频（agnes-video-2.5-flash）
   --------------------------------------------------------------------------
   和图片的「一次请求就出结果」完全不同，这是异步任务制：

     POST {base}/videos                      → 提交，拿 video_id
     GET  {origin}/agnesapi?video_id=...     → 轮询，status=completed 时取顶层 url

   ⚠ /agnesapi 挂在域名根上，不在 /v1 之下，所以必须从 baseUrl 剥出 origin。

   Flash 专属硬约束（违反直接 400，且不产生费用）：
     · size 只能是字符串 "720P"
     · seconds 是字符串 "4"–"12"
     · 不支持 videos 输入
   ========================================================================== */

export const VIDEO_MODEL = 'agnes-video-2.5-flash';
export const VIDEO_SECONDS = ['4', '5', '6', '7', '8', '9', '10', '11', '12'];
export const VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
export const VIDEO_SIZE = '720P';
export const VIDEO_TIMEOUT_MS = 600_000;

/** 从 baseUrl 剥出域名根：/agnesapi 不在 /v1 下。 */
export function apiOrigin(baseUrl = DEFAULT_BASE) {
  return new URL(baseUrl).origin;
}

/** 提交文生视频任务，返回 video_id。队列满(503)/限流(429) 会自动重试。 */
export async function submitVideo({
  prompt,
  seconds = '5',
  ratio = '16:9',
  model = VIDEO_MODEL,
  baseUrl = DEFAULT_BASE,
  retries = 3,
  retryDelayMs = 15_000,
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await submitVideoOnce({ prompt, seconds, ratio, model, baseUrl });
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      // 只有队列满/限流才值得重试；参数错、鉴权错重试无用
      const retriable = /\b503\b|\b429\b|队列已满|rate limit/i.test(msg);
      if (!retriable || attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw lastError ?? new Error('提交任务失败');
}

async function submitVideoOnce({ prompt, seconds, ratio, model, baseUrl }) {
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('prompt 不能为空');
  const sec = String(seconds);
  if (!VIDEO_SECONDS.includes(sec)) {
    throw new Error(`seconds 必须是字符串 "${VIDEO_SECONDS[0]}"–"${VIDEO_SECONDS[VIDEO_SECONDS.length - 1]}"`);
  }
  if (!VIDEO_RATIOS.includes(ratio)) throw new Error(`aspect_ratio 必须是 ${VIDEO_RATIOS.join(' / ')}`);

  const key = await readKey();
  const url = `${baseUrl.replace(/\/+$/, '')}/videos`;
  const body = {
    model,
    prompt,
    seconds: sec,
    mode: 'text',
    size: VIDEO_SIZE,   // Flash 只认 720P
    aspect_ratio: ratio,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const detail = e.name === 'TimeoutError' ? `超时（${TIMEOUT_MS / 1000}s）` : `${e.name}: ${e.message}`;
    throw new Error(`提交任务失败 — ${detail}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}，响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg = payload?.detail || payload?.error?.message || payload?.message || text.slice(0, 300);
    throw new Error(`HTTP ${res.status} — ${msg}`);
  }

  // 文档：id / task_id 是任务 ID，video_id 才是查询用的
  const videoId = payload?.video_id ?? payload?.id ?? payload?.task_id;
  if (typeof videoId !== 'string' || videoId === '') {
    throw new Error(`响应里没有 video_id：${text.slice(0, 300)}`);
  }
  return { videoId, taskId: payload?.task_id ?? null, model, baseUrl };
}

/** 查询一次任务状态。429/503 属于瞬时限流，自动退避重试。 */
export async function queryVideo({
  videoId,
  model = VIDEO_MODEL,
  baseUrl = DEFAULT_BASE,
  key,
  retries = 2,
  retryDelayMs = 4_000,
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await queryVideoOnce({ videoId, model, baseUrl, key });
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      // 实测查询接口会返回 429「查询过于频繁」，这里的重试是必须的
      const retriable = /\b429\b|\b503\b|频繁|队列已满|rate limit/i.test(msg);
      if (!retriable || attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
    }
  }
  throw lastError ?? new Error('查询任务失败');
}

async function queryVideoOnce({ videoId, model, baseUrl, key }) {
  if (typeof videoId !== 'string' || videoId === '') throw new Error('缺少 videoId');
  const k = key ?? (await readKey());

  const url = new URL(`${apiOrigin(baseUrl)}/agnesapi`);
  url.searchParams.set('video_id', videoId);
  url.searchParams.set('model_name', model);

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${k}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const detail = e.name === 'TimeoutError' ? `超时（${TIMEOUT_MS / 1000}s）` : `${e.name}: ${e.message}`;
    throw new Error(`查询任务失败 — ${detail}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}，响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg = payload?.detail || payload?.error?.message || text.slice(0, 300);
    throw new Error(`HTTP ${res.status} — ${msg}`);
  }

  return {
    status: String(payload?.status ?? 'pending'),
    progress: Number(payload?.progress ?? 0) || 0,
    url: typeof payload?.url === 'string' && payload.url !== '' ? payload.url : null,
    error: payload?.error ?? null,
    seconds: payload?.seconds ?? null,
  };
}

/** 把已完成的视频下载到本地。 */
export async function saveVideo({ url, outDir, filename } = {}) {
  if (typeof url !== 'string' || url === '') throw new Error('缺少视频地址');
  const dir = outDir ?? (await resolvePaths()).outDir;
  const name = filename || `agnes-video-${stamp()}.mp4`;
  const path = join(dir, name);
  await mkdir(dir, { recursive: true });

  const res = await fetch(url, { signal: AbortSignal.timeout(VIDEO_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`下载视频返回 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('视频下载到 0 字节');
  await writeFile(path, buf);

  return { filename: name, path, bytes: buf.length };
}
