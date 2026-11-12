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

import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

export const MODEL = 'agnes-image-2.5-flash';
export const DEFAULT_BASE = 'https://api.agnes-ai.cn/v1'; // 中国站

/** 画图模型候选：上游 /models 目前只列出这两个图像模型（2.0 已下架）。 */
export const IMAGE_MODELS = ['agnes-image-2.5-flash', 'agnes-image-2.1-flash'];
/** 视频模型候选。 */
export const VIDEO_MODELS = ['agnes-video-2.5-flash', 'agnes-video-2.5'];

/* ==========================================================================
   可配置路径：Key 文件位置 / 输出目录
   --------------------------------------------------------------------------
   优先级：显式传参 > 已保存配置 > 环境变量 > 内置默认。
   配置存于 ~/.dsh/agnes-image/config.json，由面板里的「设置」卡片写入。
   ========================================================================== */

export const CONFIG_DIR = join(homedir(), '.dsh', 'agnes-create');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
/** 旧目录：包名改名前配置存在 ~/.dsh/agnes-image/，读的时候回退，写只写新路径。 */
export const LEGACY_CONFIG_FILE = join(homedir(), '.dsh', 'agnes-image', 'config.json');
/** 生成历史落盘位置（面板重启后仍能看到最近的结果）。 */
export const HISTORY_FILE = join(CONFIG_DIR, 'history.json');
export const DEFAULT_KEY_FILE = join(homedir(), '.agnes-key.txt');
export const DEFAULT_OUT_DIR = join(homedir(), 'Desktop', 'Agnes出图');

/** 兼容旧引用（skill / CLI 用它展示默认值）。生效值请用 resolvePaths()。 */
export const KEY_FILE = process.env.AGNES_KEY_FILE || DEFAULT_KEY_FILE;
export const OUT_DIR = process.env.AGNES_OUT_DIR || DEFAULT_OUT_DIR;

export const TIMEOUT_MS = 300_000; // 文档建议 60s–360s

export const SIZES = ['1K', '2K', '3K', '4K'];
export const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

/** 图生图 / 多图合成：一次最多几张参考图。文档没写上限，8 张是面板与请求体的安全值。 */
export const MAX_REF_IMAGES = 8;

/** data URI 只接受图片 MIME，其余一律拒绝（防止把任意 base64 塞进上游请求）。 */
const DATA_URI_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

/**
 * 校验并规整参考图数组。
 * 文档要求 extra_body.image 里是「公共图像 URL 或 Data URI Base64」，
 * 所以这里只放行 http(s) 与 data:image 两种，别的直接报错而不是透传给上游。
 */
export function normalizeRefs(images, limit = MAX_REF_IMAGES) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error('参考图必须是数组');
  if (images.length > limit) {
    throw new Error(`参考图最多 ${limit} 张，收到 ${images.length} 张`);
  }
  return images.map((value, i) => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`第 ${i + 1} 张参考图不是有效字符串`);
    }
    const s = value.trim();
    if (/^https?:\/\//i.test(s)) return s;
    if (DATA_URI_RE.test(s)) return s;
    const kind = s.slice(0, 30).replace(/\s+/g, ' ');
    throw new Error(`第 ${i + 1} 张参考图只接受 http(s) 链接或 data:image/…;base64，收到：${kind}`);
  });
}

/** 把开头的 ~ 展开成家目录；其余原样返回。 */
export function expandHome(p) {
  const s = String(p ?? '').trim();
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

/** 只接受候选表里的模型名：配置里写了乱七八糟的值就当没写，回退默认。 */
function pickModel(value, choices) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return choices.includes(name) ? name : null;
}

/**
 * 解析生效配置。
 * 配置文件不存在或内容损坏时一律退回默认值 —— 配置坏了不该把插件拖死。
 */
export async function resolvePaths() {
  let stored = {};
  let configFile = CONFIG_FILE;
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) stored = raw;
  } catch {
    // 新路径没有 → 读旧路径（改名前的配置），迁移到新目录
    try {
      const raw = JSON.parse(await readFile(LEGACY_CONFIG_FILE, 'utf8'));
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        stored = raw;
        configFile = CONFIG_FILE;
        // 直接写文件，别调 saveConfig()：saveConfig 内部会先 resolvePaths()，
        // 而此刻新配置还没落盘，于是又走到这里 —— 无限递归。
        const migrated = {};
        if (typeof raw.keyFile === 'string' && raw.keyFile.trim() !== '') migrated.keyFile = raw.keyFile.trim();
        if (typeof raw.outDir === 'string' && raw.outDir.trim() !== '') migrated.outDir = raw.outDir.trim();
        if (typeof raw.imageModel === 'string') migrated.imageModel = raw.imageModel;
        if (typeof raw.videoModel === 'string') migrated.videoModel = raw.videoModel;
        await mkdir(CONFIG_DIR, { recursive: true });
        await writeFile(CONFIG_FILE, JSON.stringify(migrated, null, 2) + '\n', 'utf8');
      }
    } catch { /* 旧配置也没有 → 用默认 */ }
  }

  const storedKey = typeof stored.keyFile === 'string' && stored.keyFile.trim() !== ''
    ? expandHome(stored.keyFile) : null;
  const storedOut = typeof stored.outDir === 'string' && stored.outDir.trim() !== ''
    ? expandHome(stored.outDir) : null;

  const storedImageModel = pickModel(stored.imageModel, IMAGE_MODELS);
  const storedVideoModel = pickModel(stored.videoModel, VIDEO_MODELS);

  return {
    keyFile: storedKey ?? (process.env.AGNES_KEY_FILE || DEFAULT_KEY_FILE),
    outDir: storedOut ?? (process.env.AGNES_OUT_DIR || DEFAULT_OUT_DIR),
    imageModel: storedImageModel ?? MODEL,
    videoModel: storedVideoModel ?? VIDEO_MODEL,
    configFile,
    legacyConfigFile: LEGACY_CONFIG_FILE,
    historyFile: HISTORY_FILE,
    defaults: {
      keyFile: DEFAULT_KEY_FILE,
      outDir: DEFAULT_OUT_DIR,
      imageModel: MODEL,
      videoModel: VIDEO_MODEL,
    },
    stored: {
      keyFile: storedKey,
      outDir: storedOut,
      imageModel: storedImageModel,
      videoModel: storedVideoModel,
    },
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
    imageModel: patch.imageModel === undefined ? current.stored.imageModel : patch.imageModel,
    videoModel: patch.videoModel === undefined ? current.stored.videoModel : patch.videoModel,
  };

  for (const [field, label, choices] of [
    ['imageModel', '图片模型', IMAGE_MODELS],
    ['videoModel', '视频模型', VIDEO_MODELS],
  ]) {
    const v = next[field];
    if (v === null) continue; // 清空 = 回退默认
    if (typeof v !== 'string' || !choices.includes(v.trim())) {
      throw new Error(`${label}不在可选范围内：${choices.join(' / ')}`);
    }
    next[field] = v.trim();
  }

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
  if (typeof next.imageModel === 'string') payload.imageModel = next.imageModel;
  if (typeof next.videoModel === 'string') payload.videoModel = next.videoModel;

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  return resolvePaths();
}

/* ==========================================================================
   生成历史（落盘）
   --------------------------------------------------------------------------
   面板重启 / 切面板 / 关掉再打开都能看到最近生成的东西。
   只存可序列化的标量字段：文件本体在磁盘上，这里只有描述信息。
   ========================================================================== */

export const HISTORY_MAX = 24;

/** 只保留白名单里的标量字段，防止把乱七八糟的东西写进磁盘。 */
function sanitizeHistoryEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.filename === 'string' ? raw.filename.trim() : '';
  if (name === '') return null;
  const kind = raw.kind === 'video' ? 'video' : 'image';
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    filename: basename(name),
    kind,
    bytes: num(raw.bytes),
    size: str(raw.size),
    ratio: str(raw.ratio),
    seconds: str(raw.seconds),
    path: str(raw.path),
    mode: str(raw.mode),
    refCount: num(raw.refCount),
    elapsedSec: num(raw.elapsedSec),
    wallSec: str(raw.wallSec),
    prompt: str(raw.prompt)?.slice(0, 500) ?? null,
    createdAt: str(raw.createdAt) ?? new Date().toISOString(),
  };
}

export async function readHistory() {
  try {
    const raw = JSON.parse(await readFile(HISTORY_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.entries) ? raw.entries : []);
    const entries = list.map(sanitizeHistoryEntry).filter((x) => x !== null);
    return { entries: entries.slice(0, HISTORY_MAX), file: HISTORY_FILE };
  } catch {
    return { entries: [], file: HISTORY_FILE };
  }
}

/** 追加一条到历史最前面（按 filename 去重）。返回最新的完整列表。 */
export async function appendHistory(entry) {
  const clean = sanitizeHistoryEntry(entry);
  if (clean === null) throw new Error('历史记录缺少 filename');
  const { entries } = await readHistory();
  const next = [clean, ...entries.filter((x) => x.filename !== clean.filename)].slice(0, HISTORY_MAX);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { entries: next, file: HISTORY_FILE };
}

export async function clearHistory() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, '[]\n', 'utf8');
  return { entries: [], file: HISTORY_FILE };
}

/* ==========================================================================
   自定义提示词预设
   --------------------------------------------------------------------------
   内置的 6 个风格 chip 写死在客户端（纯展示，不用存）；用户自己存的走这里，
   落到 ~/.dsh/agnes-create/presets.json —— 跨会话、重启都还在。
   同名视为覆盖（存两次同一名字不会出现两条）。
   ========================================================================== */

export const PRESETS_FILE = join(CONFIG_DIR, 'presets.json');
export const PRESET_MAX = 40;
export const PRESET_LABEL_MAX = 20;
export const PRESET_TEXT_MAX = 600;

function sanitizePreset(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const label = typeof raw.label === 'string' ? raw.label.trim().replace(/\s+/g, ' ') : '';
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (label === '' || text === '') return null;
  return { label: label.slice(0, PRESET_LABEL_MAX), text: text.slice(0, PRESET_TEXT_MAX) };
}

export async function readPresets() {
  try {
    const raw = JSON.parse(await readFile(PRESETS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.presets) ? raw.presets : []);
    const seen = new Set();
    const presets = [];
    for (const item of list) {
      const clean = sanitizePreset(item);
      if (clean === null || seen.has(clean.label)) continue;
      seen.add(clean.label);
      presets.push(clean);
    }
    return { presets: presets.slice(0, PRESET_MAX), file: PRESETS_FILE };
  } catch {
    return { presets: [], file: PRESETS_FILE };
  }
}

/** 存一条预设（同名覆盖并置顶）。返回最新列表。 */
export async function savePreset(entry) {
  const clean = sanitizePreset(entry);
  if (clean === null) throw new Error('预设需要名称和内容');
  const { presets } = await readPresets();
  const next = [clean, ...presets.filter((p) => p.label !== clean.label)].slice(0, PRESET_MAX);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(PRESETS_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { presets: next, file: PRESETS_FILE };
}

/** 删一条预设。名字不存在时也返回成功（幂等），列表不变。 */
export async function removePreset(label) {
  const name = typeof label === 'string' ? label.trim() : '';
  if (name === '') throw new Error('缺少预设名称');
  const { presets } = await readPresets();
  const next = presets.filter((p) => p.label !== name);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(PRESETS_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { presets: next, file: PRESETS_FILE };
}

/* ==========================================================================
   视频任务（落盘 + 宿主侧轮询）
   --------------------------------------------------------------------------
   从前轮询在前端，刷新 / 关面板 / 崩溃就丢；现在任务表在宿主进程里，
   写进 tasks.json，应用重启后把「排队中 / 生成中」的任务重新接管。
   ========================================================================== */

export const TASKS_FILE = join(CONFIG_DIR, 'tasks.json');
export const TASK_MAX = 50;

/** 还在跑、需要继续轮询的状态。 */
export const TASK_ACTIVE = ['queued', 'running'];

const TASK_STATUS = ['queued', 'running', 'completed', 'failed', 'cancelled'];

function sanitizeTask(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
  const status = TASK_STATUS.includes(raw.status) ? raw.status : 'queued';
  return {
    id,
    kind: 'video',
    status,
    progress: num(raw.progress) ?? 0,
    videoId: str(raw.videoId),
    mode: raw.mode === 'keyframe' ? 'keyframe' : 'text',
    prompt: str(raw.prompt)?.slice(0, 500) ?? null,
    seconds: str(raw.seconds),
    ratio: str(raw.ratio),
    seed: num(raw.seed),
    filename: str(raw.filename),
    path: str(raw.path),
    bytes: num(raw.bytes),
    error: str(raw.error),
    createdAt: str(raw.createdAt) ?? new Date().toISOString(),
    updatedAt: str(raw.updatedAt) ?? new Date().toISOString(),
  };
}

export async function readTasks() {
  try {
    const raw = JSON.parse(await readFile(TASKS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : []);
    return list.map(sanitizeTask).filter((x) => x !== null).slice(0, TASK_MAX);
  } catch {
    return [];
  }
}

export async function writeTasks(tasks) {
  const list = (Array.isArray(tasks) ? tasks : []).map(sanitizeTask).filter((x) => x !== null).slice(0, TASK_MAX);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TASKS_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
  return list;
}

/** 读 Key。不传 file 则按当前配置解析。 */
/**
 * 问上游要模型清单，用来做「测试连接」和填下拉选项。
 * 顺带区分三种失败：Key 不对（401/403）、额度/限流（429）、网络或服务异常。
 */
export async function listModels({ baseUrl = DEFAULT_BASE, key } = {}) {
  const k = key ?? (await readKey());
  if (!k) throw new Error('没有找到 API Key，先确认 Key 文件路径');
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${k}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`连不上上游：${e && e.message ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('Key 无效或已过期（HTTP ' + res.status + '）');
  if (res.status === 429) throw new Error('上游限流（HTTP 429），稍后再试');
  if (!res.ok) throw new Error('上游返回 HTTP ' + res.status);

  const payload = await res.json().catch(() => null);
  const rows = payload && Array.isArray(payload.data) ? payload.data : [];
  const ids = rows.map((r) => (r && typeof r.id === 'string' ? r.id : '')).filter(Boolean);
  return {
    models: ids,
    image: ids.filter((id) => id.startsWith('agnes-image-')),
    video: ids.filter((id) => id.startsWith('agnes-video-')),
  };
}

/* ==========================================================================
   提示词扩写（借上游文本模型）
   --------------------------------------------------------------------------
   实测契约（2026-11-12）：POST /v1/chat/completions，OpenAI 兼容；
   model=agnes-2.5-flash 可用，正文在 choices[0].message.content，约 160 tokens/次。
   图片与视频的扩写侧重不同，所以按 kind 换系统提示。
   ========================================================================== */

export const EXPAND_MODEL = 'agnes-2.5-flash';
export const EXPAND_MAX_INPUT = 1000;
export const EXPAND_MAX_OUTPUT = 1200;
export const EXPAND_TIMEOUT_MS = 60_000;

const EXPAND_SYSTEM_IMAGE =
  '你是图像提示词工程师。把用户给的简短想法扩写成一段具体的画面描述：'
  + '补上主体外观与动作、环境细节、光线方向与质感、镜头视角与构图。'
  + '只输出这一段中文描述，不要解释，不要分点，不要加引号，不要写「提示词：」这类前缀。';

const EXPAND_SYSTEM_VIDEO =
  '你是视频提示词工程师。把用户给的简短想法扩写成一段可执行的视频描述：'
  + '包含主体动作的推进、镜头运动（推拉摇移或固定）、景别变化、光线与氛围，'
  + '时长按 5 秒左右的节奏来写，不要出现分镜编号或时间码。'
  + '只输出这一段中文描述，不要解释，不要分点，不要加引号。';

/** 把一句话扩写成一段提示词。kind: 'image' | 'video'。 */
export async function expandPrompt(prompt, { kind = 'image', model = EXPAND_MODEL, key, baseUrl = DEFAULT_BASE } = {}) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (text === '') throw new Error('先写一句想画什么，再来扩写');
  if (text.length > EXPAND_MAX_INPUT) throw new Error(`提示词太长（上限 ${EXPAND_MAX_INPUT} 字）`);
  const k = key ?? (await readKey());
  if (!k) throw new Error('没有找到 API Key，先确认 Key 文件路径');

  const system = kind === 'video' ? EXPAND_SYSTEM_VIDEO : EXPAND_SYSTEM_IMAGE;
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(EXPAND_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`连不上上游：${e && e.message ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('Key 无效或已过期（HTTP ' + res.status + '）');
  if (res.status === 429) throw new Error('上游限流（HTTP 429），稍后再试');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`上游返回 HTTP ${res.status}${body ? '：' + body.slice(0, 120) : ''}`);
  }

  const payload = await res.json().catch(() => null);
  const content = payload && payload.choices && payload.choices[0]
    ? payload.choices[0].message && payload.choices[0].message.content
    : '';
  // 有的模型会自带一对引号或收尾换行，剥掉再返回
  const out = (typeof content === 'string' ? content : '')
    .trim()
    .replace(/^[「“"'`]+/, '')
    .replace(/[」”"'`]+$/, '')
    .trim();
  if (out === '') throw new Error('上游没有返回内容，再试一次');
  return { prompt: out.slice(0, EXPAND_MAX_OUTPUT), model, usage: (payload && payload.usage) || null };
}

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

  // 有参考图 → 图生图 / 多图合成；没有 → 纯文生图。校验在发请求之前做完。
  const refs = normalizeRefs(images);

  const key = await readKey();
  const started = Date.now();

  let { payload, item } = await post({ baseUrl, key, body: buildBody({ prompt, size, ratio, model, fmt, images: refs }) });

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

  // 把提示词写进图片自身，之后从磁盘上任意时候读回来都知道这张图是怎么来的。
  // 失败不影响出图结果：元数据只是附加值。
  const meta = await embedPrompt(path, prompt);

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
    // 有参考图 = 图生图 / 多图合成；没有 = 文生图。面板据此显示模式。
    mode: refs.length > 0 ? 'img2img' : 'text2img',
    refCount: refs.length,
    promptMeta: meta,
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
   把提示词写进图片文件本身
   --------------------------------------------------------------------------
   直接改文件结构，不依赖任何三方库：

     PNG → 插入 iTXt 块（keyword="prompt"，UTF-8，中文安全）
     JPEG → SOI 之后插入 COM 段（原始 UTF-8 字节）
     其它格式（webp/gif/mp4…）→ 不支持，跳过

   这样图片被拷到别处、被历史记录忘掉之后，提示词依然跟着文件走。
   ========================================================================== */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 用自己的命名空间，别用通用名 "prompt"：ComfyUI / A1111 也往 tEXt 里写 prompt，
// 那是工作流 JSON，混进来会被当成提示词显示成一堆花括号。
const META_KEYWORD = 'dsh-agnes-prompt';
const META_PREFIX = 'dsh-agnes-prompt: ';
const LIB_MAX = 200;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 按 PNG 规范拼一个块：长度 + 类型 + 数据 + CRC(类型+数据)。 */
function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/** 把整张 PNG 切成块序列，方便插入 / 覆盖 / 查找。 */
function pngChunks(buf) {
  const out = [];
  let off = PNG_SIG.length;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const end = off + 12 + len;
    if (end > buf.length || len < 0) break;
    out.push({ type, start: off, end });
    off = end;
    if (type === 'IEND') break;
  }
  return out;
}

/** 组一个 iTXt 块（不做压缩，关键字固定 prompt）。 */
function itxtChunk(text) {
  const data = Buffer.concat([
    Buffer.from(META_KEYWORD, 'latin1'),
    Buffer.from([0]),      // 关键字结束
    Buffer.from([0, 0]),   // 压缩标志 0 / 压缩方法 0
    Buffer.from([0]),      // 语言标签（空）
    Buffer.from([0]),      // 翻译关键字（空）
    Buffer.from(text, 'utf8'),
  ]);
  return pngChunk('iTXt', data);
}

/**
 * 从 PNG 里读 prompt：优先取我们自己写的 iTXt，其次兼容 tEXt。
 * 旧的 0.7.0 早期版本用的是通用关键字 "prompt"，只在 iTXt 里认它——
 * ComfyUI / A1111 写的是 tEXt["prompt"]（工作流 JSON），不能当提示词读出来。
 */
function readPngPrompt(buf) {
  let legacy = null;
  for (const c of pngChunks(buf)) {
    if (c.type === 'iTXt') {
      const data = buf.subarray(c.start + 8, c.end - 4);
      const keyEnd = data.indexOf(0);
      if (keyEnd < 0) continue;
      const key = data.toString('latin1', 0, keyEnd);
      const text = data.subarray(keyEnd + 5); // 跳关键字\0 + 压缩标志\0 + 方法\0 + 语言\0 + 翻译\0
      if (key === META_KEYWORD) return text.toString('utf8').replace(/\0+$/, '');
      if (key === 'prompt' && legacy === null) legacy = text.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (c.type === 'tEXt') {
      const data = buf.subarray(c.start + 8, c.end - 4);
      const keyEnd = data.indexOf(0);
      if (keyEnd < 0) continue;
      if (data.toString('latin1', 0, keyEnd) !== META_KEYWORD) continue;
      return data.toString('latin1', keyEnd + 1).replace(/\0+$/, '');
    }
  }
  return legacy;
}

/** 重写 PNG：删掉旧的 prompt 块，把新的插在 IEND 之前。 */
function withPngPrompt(buf, text) {
  const chunks = pngChunks(buf);
  const keep = [];
  for (const c of chunks) {
    if (c.type !== 'iTXt' && c.type !== 'tEXt') { keep.push(c); continue; }
    const data = buf.subarray(c.start + 8, c.end - 4);
    const keyEnd = data.indexOf(0);
    const key = keyEnd < 0 ? '' : data.toString('latin1', 0, keyEnd);
    if (key !== META_KEYWORD) keep.push(c); // 别人的元数据原样保留
  }
  const iend = keep.find((c) => c.type === 'IEND');
  const parts = [PNG_SIG];
  for (const c of keep) {
    if (c === iend) parts.push(itxtChunk(text));
    parts.push(buf.subarray(c.start, c.end));
  }
  if (iend === undefined) parts.push(itxtChunk(text));
  return Buffer.concat(parts);
}

function isPng(buf) {
  return buf.length > 12 && buf.subarray(0, 8).equals(PNG_SIG);
}

function isJpeg(buf) {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** JPEG：在 SOI 之后插一个 COM 段（已存在就替换）。 */
function withJpegPrompt(buf, text) {
  const seg = (() => {
    // COM 段没有关键字位置，用前缀标记所有权，避免覆盖/误读相机或别家写的注释
    const payload = Buffer.from(META_PREFIX + text, 'utf8');
    const head = Buffer.alloc(4);
    head[0] = 0xff; head[1] = 0xfe;              // COM
    head.writeUInt16BE(payload.length + 2, 2);   // 长度包含自身 2 字节
    return Buffer.concat([head, payload]);
  })();
  // 先看 SOI 后面是不是已经有一个 COM，是就换掉
  if (buf.length > 6 && buf[2] === 0xff && buf[3] === 0xfe) {
    const len = buf.readUInt16BE(4);
    return Buffer.concat([buf.subarray(0, 2), seg, buf.subarray(4 + len)]);
  }
  return Buffer.concat([buf.subarray(0, 2), seg, buf.subarray(2)]);
}

function readJpegPrompt(buf) {
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break;
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI 之后不再有段
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) break;
    if (marker === 0xfe) {
      const text = buf.toString('utf8', off + 4, off + 2 + len).replace(/\0+$/, '');
      // 只认自己写的（带前缀）；别人的 COM 注释原样留着，不当提示词
      if (!text.startsWith(META_PREFIX)) return null;
      return text.slice(META_PREFIX.length);
    }
    off += 2 + len;
  }
  return null;
}

/**
 * 把提示词写进图片文件。失败不抛（元数据只是附加价值，不该影响出图）。
 * @returns {Promise<{embedded:boolean, format?:string, reason?:string}>}
 */
export async function embedPrompt(filePath, prompt) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (text === '') return { embedded: false, reason: '没有提示词' };
  try {
    const buf = await readFile(filePath);
    let next = null;
    let format = null;
    if (isPng(buf)) { next = withPngPrompt(buf, text); format = 'png'; }
    else if (isJpeg(buf)) { next = withJpegPrompt(buf, text); format = 'jpeg'; }
    else return { embedded: false, reason: '该格式不支持写入元数据' };
    if (next !== null && next.length > 0) await writeFile(filePath, next);
    return { embedded: true, format };
  } catch (e) {
    return { embedded: false, reason: e.message };
  }
}

/** 从图片文件里读回提示词；读不到返回 null。 */
export async function readEmbeddedPrompt(filePath) {
  try {
    const buf = await readFile(filePath);
    if (isPng(buf)) return readPngPrompt(buf);
    if (isJpeg(buf)) return readJpegPrompt(buf);
    return null;
  } catch {
    return null;
  }
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);

export function kindOf(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/** 文件还在不在（历史里可能有被删掉或被挪走的文件）。 */
export async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

/**
 * 列出输出目录里已有的图片 / 视频，供面板「加载输出目录」用。
 * prompt 优先从文件元数据读，读不到就留 null（前端可再看历史）。
 */
export async function listLibrary(outDir) {
  const entries = await readdir(outDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const kind = kindOf(ent.name);
    if (kind === null) continue;
    const full = join(outDir, ent.name);
    let info = null;
    try { info = await stat(full); } catch { continue; }
    files.push({
      filename: ent.name,
      name: ent.name,        // 面板侧沿用自己的 name，两种叫法都给出
      kind,
      bytes: info.size,
      mtime: info.mtimeMs,
      path: full,
    });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const top = files.slice(0, LIB_MAX);
  // 只给最新的若干张读元数据，避免目录很大时逐个开文件拖慢面板
  for (const f of top.slice(0, 60)) {
    if (f.kind !== 'image') continue;
    const prompt = await readEmbeddedPrompt(f.path);
    if (prompt !== null) f.prompt = prompt;
  }
  return top;
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

/** 视频 reference 模式的参考图上限（上游文档：images 最多 5 张）。 */
export const MAX_VIDEO_REF_IMAGES = 5;
export const VIDEO_TIMEOUT_MS = 600_000;

/** 从 baseUrl 剥出域名根：/agnesapi 不在 /v1 下。 */
export function apiOrigin(baseUrl = DEFAULT_BASE) {
  return new URL(baseUrl).origin;
}

/**
 * 提交视频任务，返回 video_id。队列满(503)/限流(429) 会自动重试。
 *
 * 三种模式（由是否给关键帧决定，不用调用方自己传 mode）：
 *   - 纯文本 prompt                → mode: 'text'
 *   - 给 firstFrame / lastFrame    → mode: 'keyframe'（两者至少一个）
 *
 * 关键帧接受公网 http(s) 图片 URL，也接受 data:image/... 的 base64 —— 后者
 * 已实测被上游接受，所以本地磁盘里的图片可以直接当首帧，不用先传到公网。
 */
export async function submitVideo({
  prompt,
  seconds = '5',
  ratio = '16:9',
  model = VIDEO_MODEL,
  baseUrl = DEFAULT_BASE,
  seed = null,
  firstFrame = null,
  lastFrame = null,
  referenceImages = [],
  retries = 3,
  retryDelayMs = 15_000,
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await submitVideoOnce({ prompt, seconds, ratio, model, baseUrl, seed, firstFrame, lastFrame, referenceImages });
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

/** 单个关键帧校验：只放行 http(s) 与 data:image，空值归为 null。 */
function normalizeFrame(frame, label) {
  if (frame === null || frame === undefined || frame === '') return null;
  const refs = normalizeRefs([frame]); // 复用参考图校验：单张也要过同一套 URL/data URI 白名单
  if (refs.length !== 1) throw new Error(`${label}无效`);
  return refs[0];
}

/** seed 校验：允许空；给了就必须是非负整数。 */
function normalizeSeed(seed) {
  if (seed === null || seed === undefined || seed === '') return null;
  const n = typeof seed === 'number' ? seed : Number(String(seed).trim());
  if (!Number.isInteger(n) || n < 0) throw new Error('seed 必须是非负整数');
  return n;
}

async function submitVideoOnce({
  prompt,
  seconds,
  ratio,
  model,
  baseUrl,
  seed,
  firstFrame,
  lastFrame,
  referenceImages = [],
}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('prompt 不能为空');
  const sec = String(seconds);
  if (!VIDEO_SECONDS.includes(sec)) {
    throw new Error(`seconds 必须是字符串 "${VIDEO_SECONDS[0]}"–"${VIDEO_SECONDS[VIDEO_SECONDS.length - 1]}"`);
  }
  if (!VIDEO_RATIOS.includes(ratio)) throw new Error(`aspect_ratio 必须是 ${VIDEO_RATIOS.join(' / ')}`);

  const first = normalizeFrame(firstFrame, '首帧图');
  const last = normalizeFrame(lastFrame, '尾帧图');
  const refs = normalizeRefs(referenceImages, MAX_VIDEO_REF_IMAGES);
  // 关键帧优先：给了首/尾帧就是 keyframe；否则有参考图走 reference；都没有才是纯文本
  const mode = first !== null || last !== null ? 'keyframe' : refs.length > 0 ? 'reference' : 'text';
  const seedValue = normalizeSeed(seed);

  const key = await readKey();
  const url = `${baseUrl.replace(/\/+$/, '')}/videos`;
  const body = {
    model,
    prompt,
    seconds: sec,
    mode,
    size: VIDEO_SIZE,   // Flash 只认 720P
    aspect_ratio: ratio,
  };
  if (mode === 'keyframe') {
    if (first !== null) body.first_frame = first;
    if (last !== null) body.last_frame = last;
  }
  if (mode === 'reference') body.images = refs;
  if (seedValue !== null) body.seed = seedValue;

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
  return { videoId, taskId: payload?.task_id ?? null, model, baseUrl, mode };
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
