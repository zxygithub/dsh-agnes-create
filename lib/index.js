/**
 * 宿主半：注册 JSON 路由给浏览器端 fetch。
 *
 * 图片（同步）
 *   GET  /agnes/health        健康检查（模型、端点、key 状态、输出目录）
 *   POST /agnes/generate      { prompt, size, ratio } → 生成并落盘
 *
 * 视频（异步任务制）
 *   POST /agnes/video         { prompt, seconds, ratio, seed?, firstFrame?, lastFrame? }
 *                             提交，立刻返回 { videoId }
 *                             给了 firstFrame/lastFrame 就自动走 keyframe 模式
 *   GET  /agnes/video?id=…    查询一次状态；completed 时顺带下载落盘并返回 filename
 *                             （下载结果按 videoId 缓存，反复轮询不会重复下载）
 *
 * 历史（宿主侧持久化，跨会话/重启都还在）
 *   GET    /agnes/history     读回最近若干条
 *   POST   /agnes/history     追加一条（生成完成后由前端调用）
 *   DELETE /agnes/history     清空
 *
 * 自定义提示词预设（宿主落盘，跨会话/重启都在）
 *   GET    /agnes/presets     读回全部
 *   POST   /agnes/presets     { label, text } → 存一条（同名覆盖并置顶）
 *   DELETE /agnes/presets     ?label=… → 删一条
 *
 * 提示词扩写（借上游文本模型 agnes-2.5-flash）
 *   POST /agnes/expand        { prompt, kind } → { prompt } 扩写后的描述
 *
 * 结果收尾
 *   POST /agnes/reveal        { name } → 在访达里显示该文件（只能是输出目录内的文件）
 *
 * 媒体
 *   GET  /agnes/media?name=…  把已生成的图片/视频流回浏览器，视频支持 Range
 *   GET  /agnes/image?name=…  兼容旧链接，等价于 /agnes/media
 *
 * 路由注册方式：webServer 可能晚于本插件就绪，所以既立刻试、
 * 也监听 internal/service 事件。
 */

import { execFile } from 'node:child_process';
import { basename, join, resolve as resolvePath } from 'node:path';

import {
  MODEL, VIDEO_MODEL, VIDEO_SECONDS, VIDEO_RATIOS, VIDEO_SIZE,
  DEFAULT_BASE, SIZES, RATIOS, MAX_REF_IMAGES, MAX_VIDEO_REF_IMAGES, HISTORY_MAX,
  generate, keyStatus, readKey, readMedia, resolvePaths, saveConfig, safeName,
  submitVideo, queryVideo, saveVideo,
  readHistory, appendHistory, clearHistory,
  listLibrary, fileExists,
  listModels, IMAGE_MODELS, VIDEO_MODELS,
  readTasks, writeTasks, TASK_ACTIVE, TASK_MAX,
  readPresets, savePreset, removePreset, PRESET_MAX,
  expandPrompt, EXPAND_MODEL,
} from './agnes.js';

export const name = 'dsh-agnes-create';

/** 普通 JSON 请求（配置、视频）1 MB 够用。 */
const BODY_LIMIT = 1_000_000;

/** 图生图的参考图走 base64 data URI，必须单独放宽到 32 MB：
 *  8 张 × 前端下采样后的约 300–600 KB，base64 膨胀 4/3，再留足余量。 */
const REF_BODY_LIMIT = 32 * 1024 * 1024;

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function readJson(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > limit) {
        aborted = true;
        reject(new Error(`请求体过大（上限 ${(limit / 1024 / 1024).toFixed(0)} MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function errMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

/** 支持 Range 的媒体响应，视频拖动进度条需要它。 */
function sendMedia(req, res, buf, mime) {
  const range = req.headers.range;
  const m = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;

  if (m === null) {
    res.writeHead(200, {
      'content-type': mime,
      'content-length': String(buf.length),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return;
  }

  const total = buf.length;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null) {
    // bytes=-N：最后 N 字节
    start = Math.max(0, total - (end ?? 0));
    end = total - 1;
  } else if (end === null) {
    end = total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.writeHead(416, { 'content-range': `bytes */${total}` });
    res.end();
    return;
  }
  end = Math.min(end, total - 1);
  const slice = buf.subarray(start, end + 1);
  res.writeHead(206, {
    'content-type': mime,
    'content-length': String(slice.length),
    'content-range': `bytes ${start}-${end}/${total}`,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : slice);
}

export function apply(ctx) {
  let registered = false;
  /** webServer.register 的返回值是「移除该路由」的 disposer，必须收好：
   *  插件卸载/热重载时若不清理，路由会留在服务器表里，重新启用就会
   *  「duplicate exact route」而激活失败（实测踩过）。 */
  const routeDisposers = [];

  const addRoute = (webServer, route) => {
    routeDisposers.push(webServer.register(route));
  };

  /* ==========================================================================
     视频任务引擎
     --------------------------------------------------------------------------
     以前是前端每 6 秒问一次上游；刷新、切面板、崩掉、重启都会丢进度。
     现在任务表在宿主进程里，落盘到 ~/.dsh/agnes-create/tasks.json，
     应用重启后把「排队中 / 生成中」的任务重新接管继续轮询。
     ========================================================================== */

  /** videoId → 已下载的本地结果，避免每次轮询重复下载几十 MB */
  const downloaded = new Map();

  const POLL_INTERVAL_MS = 6000;
  /** 单个任务最多跟踪 40 分钟，超了就判失败，免得永远挂着 */
  const TASK_DEADLINE_MS = 40 * 60 * 1000;

  /** id → 任务。内存是权威副本，磁盘只是持久化镜像。 */
  const tasks = new Map();
  /** 正在查询中的 id：防止上一轮还没回来就又发一轮 */
  const inflight = new Set();
  let ticker = null;
  let engineStarted = false;

  const nowIso = () => new Date().toISOString();

  const persistTasks = async () => {
    try {
      const list = [...tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      await writeTasks(list);
    } catch {
      // 落盘失败不影响内存里的任务，下一轮会再试
    }
  };

  const patchTask = (id, patch) => {
    const cur = tasks.get(id);
    if (cur === undefined) return null;
    const next = { ...cur, ...patch, updatedAt: nowIso() };
    tasks.set(id, next);
    return next;
  };

  const isActiveTask = (task) => TASK_ACTIVE.includes(task.status);

  /** 查一次上游，把结果写回任务；限流 / 网络错误不判死，留给下一轮。 */
  const pollTaskOnce = async (task) => {
    if (task.videoId === null || inflight.has(task.id)) return;
    inflight.add(task.id);
    try {
      const st = await queryVideo({ videoId: task.videoId });

      if (st.status === 'completed') {
        let saved = downloaded.get(task.videoId);
        if (saved === undefined) {
          if (st.url === null) throw new Error('任务已完成但没有返回视频地址');
          saved = await saveVideo({ url: st.url });
          downloaded.set(task.videoId, saved);
        }
        patchTask(task.id, {
          status: 'completed',
          progress: 100,
          filename: saved.filename,
          path: saved.path,
          bytes: saved.bytes,
          error: null,
        });
        // 生成完顺手记一条历史，和面板里的记录保持一致
        try {
          await appendHistory({
            filename: saved.filename,
            kind: 'video',
            bytes: saved.bytes,
            path: saved.path,
            size: VIDEO_SIZE,
            ratio: task.ratio,
            seconds: st.seconds ?? task.seconds,
            mode: task.mode,
            prompt: task.prompt,
            createdAt: nowIso(),
          });
        } catch {
          // 历史写失败不影响任务本身
        }
      } else if (st.status === 'failed') {
        patchTask(task.id, { status: 'failed', error: st.error ?? '生成失败' });
      } else if (Date.now() - Date.parse(task.createdAt) > TASK_DEADLINE_MS) {
        patchTask(task.id, { status: 'failed', error: '等待超时（40 分钟）' });
      } else {
        patchTask(task.id, {
          status: 'running',
          progress: typeof st.progress === 'number' ? st.progress : task.progress,
        });
      }

      await persistTasks();
    } catch {
      // 单次查询失败（429 / 503 / 网络抖动）保持原状，下一轮继续
    } finally {
      inflight.delete(task.id);
    }
  };

  const tickAll = async () => {
    const active = [...tasks.values()].filter(isActiveTask);
    for (const task of active) {
      await pollTaskOnce(task);
    }
  };

  const startEngine = () => {
    if (engineStarted) return;
    engineStarted = true;
    void (async () => {
      try {
        const saved = await readTasks();
        for (const task of saved) {
          if (tasks.has(task.id)) continue;
          // 重启前还在跑的，标记成 running 继续跟踪
          tasks.set(task.id, isActiveTask(task) ? { ...task, status: 'running' } : task);
        }
        if (saved.length > 0) await persistTasks();
      } catch {
        // 读不回来就当没有旧任务
      }
      ticker = setInterval(() => {
        void tickAll();
      }, POLL_INTERVAL_MS);
      void tickAll();
    })();
  };

  ctx.effect(
    () => () => {
      if (ticker !== null) {
        clearInterval(ticker);
        ticker = null;
      }
      engineStarted = false;
    },
    'dsh-agnes-create: task engine',
  );

  startEngine();

  /**
   * 新建一个视频任务：提交给上游 + 记进任务表。
   * HTTP 路由和模型工具走同一条路径，免得两边的字段慢慢长歪。
   */
  const enqueueVideoTask = async (params) => {
    const cfg = await resolvePaths();
    const sub = await submitVideo({
      prompt: params.prompt,
      seconds: params.seconds,
      ratio: params.ratio,
      model: params.model ?? cfg.videoModel,
      seed: params.seed,
      firstFrame: params.firstFrame,
      lastFrame: params.lastFrame,
      referenceImages: params.referenceImages,
    });
    const id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const task = {
      id,
      kind: 'video',
      status: 'queued',
      progress: 0,
      videoId: sub.videoId,
      mode: sub.mode,
      prompt: params.prompt,
      seconds: typeof params.seconds === 'string' ? params.seconds : null,
      ratio: typeof params.ratio === 'string' ? params.ratio : null,
      seed: typeof params.seed === 'number' ? params.seed : null,
      filename: null,
      path: null,
      bytes: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    tasks.set(id, task);
    // 只留最近 TASK_MAX 条：先扔最老的、已经结束的
    if (tasks.size > TASK_MAX) {
      const done = [...tasks.values()]
        .filter((t) => !isActiveTask(t))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      while (tasks.size > TASK_MAX && done.length > 0) {
        const victim = done.shift();
        tasks.delete(victim.id);
      }
    }
    await persistTasks();
    return task;
  };

  /* ==========================================================================
     模型工具：让 agent 在对话里直接出图 / 出视频
     --------------------------------------------------------------------------
     `tools` 是可选服务（纯终端 profile 没有），所以走 ctx.inject 条件注入；
     SDK 用动态 import —— 宿主没提供 @deepseek-ai/dsh-tools 时只是少这组工具，
     面板和路由照常工作，插件不会因此激活失败。
     ========================================================================== */
  const registerAgentTools = () => {
    // 老宿主 / 测试桩可能没有 ctx.inject：没有就不注册，面板照常可用
    if (typeof ctx.inject !== 'function') return;
    ctx.inject(['tools'], (sub) => {
      if (sub === null || sub === undefined || sub.tools === undefined) return;
      let disposed = false;
      ctx.effect(() => () => {
        disposed = true;
      });

      void import('@deepseek-ai/dsh-tools')
        .then(({ defineTool }) => {
          if (disposed) return;
          const textOutput = {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          };

          const disposables = [
            sub.tools.register(
              defineTool({
                name: 'agnes_image',
                description:
                  '用 Agnes 图像模型（agnes-image-2.5-flash）生成或改写一张图。支持文生图与图生图/多图合成：给 images 就是参考图（最多 8 张，http(s) 链接或 data:image/…;base64）。图片保存在本机输出目录，返回文件路径、大小与生成方式。',
                parameters: {
                  prompt: { type: 'string', required: true, description: '画面描述，越具体越好（主体、风格、光线、构图）。' },
                  size: { type: 'string', enum: SIZES, description: '分辨率档位，默认 1K。' },
                  ratio: { type: 'string', enum: RATIOS, description: '画幅比例，默认 1:1。' },
                  images: {
                    type: 'array',
                    items: { type: 'string' },
                    description: `参考图，最多 ${MAX_REF_IMAGES} 张。只接受 http(s) 链接或 data:image/…;base64，本地图请先转成 data URI。`,
                  },
                },
                output: textOutput,
                timeoutMs: 360_000,
                async execute(args) {
                  const cfg = await resolvePaths();
                  const r = await generate({
                    prompt: args.prompt,
                    size: args.size,
                    ratio: args.ratio,
                    images: args.images,
                    model: cfg.imageModel,
                  });
                  return [
                    `已生成图片：${r.path}`,
                    `文件：${r.filename}（${Math.round(r.bytes / 1024)} KB）`,
                    `模式：${r.mode}${r.refCount > 0 ? `（参考图 ${r.refCount} 张）` : ''}`,
                    `耗时：${r.elapsedSec}s`,
                  ].join('\n');
                },
              }),
            ),

            sub.tools.register(
              defineTool({
                name: 'agnes_video',
                description:
                  '提交一个 Agnes 视频生成任务（agnes-video-2.5-flash，720P，4–12 秒）。立刻返回任务号，不会阻塞等待；进度用 agnes_video_status 查。三种模式自动选择：给 first_frame / last_frame 走关键帧（图生视频），只给 reference_images 走参考生视频（最多 5 张），都不给是纯文生视频。图片同样接受 http(s) 与 data:image/…;base64。',
                parameters: {
                  prompt: { type: 'string', required: true, description: '视频内容描述，包含镜头运动与氛围更好。' },
                  seconds: { type: 'string', enum: VIDEO_SECONDS, description: '时长（秒），默认 5。' },
                  ratio: { type: 'string', enum: VIDEO_RATIOS, description: '画幅比例，默认 16:9。' },
                  seed: { type: 'number', description: '可选的非负整数种子，同提示词 + 同 seed 更容易复现。' },
                  first_frame: { type: 'string', description: '首帧图片（http(s) 或 data:image/…;base64）。给了就走图生视频。' },
                  last_frame: { type: 'string', description: '尾帧图片，与 first_frame 至少给一个才走关键帧模式。' },
                  reference_images: {
                    type: 'array',
                    items: { type: 'string' },
                    description: `参考图，最多 ${MAX_VIDEO_REF_IMAGES} 张（参考风格 / 主体 / 构图，不是起止画面）。已给关键帧时不生效。`,
                  },
                },
                output: textOutput,
                timeoutMs: 120_000,
                async execute(args) {
                  const task = await enqueueVideoTask({
                    prompt: args.prompt,
                    seconds: args.seconds,
                    ratio: args.ratio,
                    seed: args.seed,
                    firstFrame: args.first_frame,
                    lastFrame: args.last_frame,
                    referenceImages: args.reference_images,
                  });
                  return [
                    `已提交视频任务：${task.id}`,
                    `上游任务：${task.videoId}`,
                    `模式：${task.mode}`,
                    '宿主会在后台轮询并在完成后自动下载到输出目录；用 agnes_video_status 查进度。',
                  ].join('\n');
                },
              }),
            ),

            sub.tools.register(
              defineTool({
                name: 'agnes_video_status',
                description:
                  '查询 Agnes 视频任务进度。给 task_id 查单个任务（含完成后的文件路径）；不给就列出最近的任务与正在跑的数量。',
                parameters: {
                  task_id: { type: 'string', description: 'agnes_video 返回的任务号，例如 vmwdik0rakuix。' },
                },
                output: textOutput,
                timeoutMs: 30_000,
                async execute(args) {
                  if (typeof args.task_id === 'string' && args.task_id !== '') {
                    let task = tasks.get(args.task_id);
                    if (task === undefined) {
                      // 引擎还没回灌完时，退回去读一次磁盘
                      const saved = await readTasks().catch(() => []);
                      task = saved.find((t) => t.id === args.task_id);
                    }
                    if (task === undefined) return `没有这个任务：${args.task_id}`;
                    const lines = [
                      `任务：${task.id}`,
                      `状态：${task.status}（${task.progress ?? 0}%）`,
                      `模式：${task.mode}`,
                      `提示词：${task.prompt}`,
                    ];
                    if (task.filename !== null && task.filename !== undefined) {
                      lines.push(`文件：${task.path ?? task.filename}`);
                    }
                    if (task.error !== null && task.error !== undefined) lines.push(`错误：${task.error}`);
                    return lines.join('\n');
                  }
                  const list = [...tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
                  if (list.length === 0) return '还没有视频任务。';
                  const active = list.filter(isActiveTask).length;
                  return [
                    `共 ${list.length} 个任务，其中 ${active} 个正在跑：`,
                    ...list
                      .slice(0, 10)
                      .map((t) => `- ${t.id} ${t.status} ${t.progress ?? 0}%  ${t.prompt.slice(0, 40)}`),
                  ].join('\n');
                },
              }),
            ),
          ];

          ctx.effect(() => () => {
            for (const dispose of disposables) {
              try {
                dispose();
              } catch {
                // 已经卸载过就算了
              }
            }
          });
        })
        .catch(() => {
          // 宿主没有 @deepseek-ai/dsh-tools：模型侧少了三个工具，面板不受影响
        });
    });
  };

  registerAgentTools();

  const registerRoutes = (value) => {
    if (registered) return;
    const webServer = value ?? ctx.reflect.get('webServer', false);
    if (webServer === undefined) return;
    registered = true;

    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/health',
      handler: async (req, res) => {
        try {
          const cfg = await resolvePaths();
          const k = await keyStatus(cfg.keyFile);
          sendJson(res, {
            ok: true,
            model: cfg.imageModel,
            videoModel: cfg.videoModel,
            models: {
              image: IMAGE_MODELS,
              video: VIDEO_MODELS,
              current: { image: cfg.imageModel, video: cfg.videoModel },
            },
            endpoint: `${DEFAULT_BASE}/images/generations`,
            videoEndpoint: `${DEFAULT_BASE}/videos`,
            keyFile: cfg.keyFile,
            key: k,                 // 只有 present/length/masked，没有明文
            outDir: cfg.outDir,
            configFile: cfg.configFile,
            defaults: cfg.defaults,
            sizes: SIZES,
            ratios: RATIOS,
            maxRefImages: MAX_REF_IMAGES,   // 图生图 / 多图合成的参考图上限
            videoSizes: [VIDEO_SIZE],
            videoSeconds: VIDEO_SECONDS,
            videoRatios: VIDEO_RATIOS,
          });
        } catch (e) {
          sendJson(res, { ok: false, error: errMessage(e) }, 500);
        }
      },
    });

    /* ---------- 配置：Key 文件路径 / 输出目录 ---------- */
    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const cfg = await resolvePaths();
            return sendJson(res, {
              ok: true,
              config: { keyFile: cfg.keyFile, outDir: cfg.outDir, imageModel: cfg.imageModel, videoModel: cfg.videoModel },
              stored: cfg.stored,
              defaults: cfg.defaults,
              configFile: cfg.configFile,
              key: await keyStatus(cfg.keyFile),
            });
          }
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: '需要 GET 或 POST' }, 405);

          const body = await readJson(req);
          const patch = {};
          // 空字符串 = 清除该项、回退默认
          if (Object.prototype.hasOwnProperty.call(body, 'keyFile')) {
            patch.keyFile = typeof body.keyFile === 'string' && body.keyFile.trim() === '' ? null : body.keyFile;
          }
          if (Object.prototype.hasOwnProperty.call(body, 'outDir')) {
            patch.outDir = typeof body.outDir === 'string' && body.outDir.trim() === '' ? null : body.outDir;
          }
          for (const field of ['imageModel', 'videoModel']) {
            if (Object.prototype.hasOwnProperty.call(body, field)) {
              patch[field] = typeof body[field] === 'string' && body[field].trim() === '' ? null : body[field];
            }
          }

          const cfg = await saveConfig(patch);
          sendJson(res, {
            ok: true,
            config: { keyFile: cfg.keyFile, outDir: cfg.outDir, imageModel: cfg.imageModel, videoModel: cfg.videoModel },
            stored: cfg.stored,
            defaults: cfg.defaults,
            configFile: cfg.configFile,
            key: await keyStatus(cfg.keyFile),
          });
        } catch (e) {
          // 校验失败属于用户输入问题，用 400 区分于 500 的服务端异常
          sendJson(res, { ok: false, error: errMessage(e) }, 400);
        }
      },
    });

    /* ---------- 模型清单 / 连通性测试 ---------- */
    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/models',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') return sendJson(res, { ok: false, error: '需要 GET' }, 405);
          const cfg = await resolvePaths();
          const k = await keyStatus(cfg.keyFile);
          if (!k.present) {
            return sendJson(res, {
              ok: false,
              error: `没有找到 Key 文件：${cfg.keyFile}`,
              key: k,
              configured: { image: cfg.imageModel, video: cfg.videoModel },
              fallback: { image: IMAGE_MODELS, video: VIDEO_MODELS },
            }, 400);
          }
          const live = await listModels({ baseUrl: DEFAULT_BASE, key: await readKey(cfg.keyFile) });
          sendJson(res, {
            ok: true,
            key: k,
            upstream: live,
            configured: { image: cfg.imageModel, video: cfg.videoModel },
            fallback: { image: IMAGE_MODELS, video: VIDEO_MODELS },
          });
        } catch (e) {
          const msg = errMessage(e);
          const status = /Key 无效|没有找到|连不上/.test(msg) ? 400 : 500;
          sendJson(res, { ok: false, error: msg }, status);
        }
      },
    });

    /* ---------- 图片 ---------- */
    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/generate',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, { ok: false, error: '需要 POST' }, 405);
        try {
          const body = await readJson(req, REF_BODY_LIMIT);
          if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
            return sendJson(res, { ok: false, error: '提示词不能为空' }, 400);
          }
          const cfg = await resolvePaths();
          const result = await generate({
            prompt: body.prompt,
            size: body.size,
            ratio: body.ratio,
            model: body.model || cfg.imageModel,
            // 图生图 / 多图合成：参考图数组（data URI 或 http(s) 链接）。
            // 校验在内核 normalizeRefs 里做，这里只负责透传。
            images: body.images,
          });
          sendJson(res, { ...result, kind: 'image' });
        } catch (e) {
          // 参考图参数不合法属于用户输入问题，用 400 区分于上游 500
          const msg = errMessage(e);
          const status = /参考图|images|prompt|size 必须|ratio 必须/.test(msg) ? 400 : 500;
          sendJson(res, { ok: false, error: msg }, status);
        }
      },
    });

    /* ---------- 视频：提交 ---------- */
    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/video',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://dsh.local');

          // POST = 提交任务
          if (req.method === 'POST') {
            // 关键帧是 base64 data URI，1 MB 装不下，所以和参考图共用 32 MB 上限
            const body = await readJson(req, REF_BODY_LIMIT);
            if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
              return sendJson(res, { ok: false, error: '提示词不能为空' }, 400);
            }
            const cfg = await resolvePaths();
            const sub = await submitVideo({
              prompt: body.prompt,
              seconds: body.seconds,
              ratio: body.ratio,
              model: cfg.videoModel,
              // 关键帧 / 种子：有就传，没有内核会退回纯文生视频
              seed: body.seed,
              firstFrame: body.firstFrame,
              lastFrame: body.lastFrame,
              // 参考图（mode:reference）：最多 5 张，本地图同样以 data URI 直传
              referenceImages: body.referenceImages,
            });
            return sendJson(res, {
              ok: true,
              videoId: sub.videoId,
              taskId: sub.taskId,
              model: sub.model,
              mode: sub.mode,
            });
          }

          // GET = 查询一次状态
          if (req.method !== 'GET') return sendJson(res, { ok: false, error: '需要 GET 或 POST' }, 405);

          const videoId = url.searchParams.get('id') || '';
          if (videoId === '') return sendJson(res, { ok: false, error: '缺少 id' }, 400);

          const st = await queryVideo({ videoId });

          if (st.status !== 'completed') {
            return sendJson(res, {
              ok: true,
              status: st.status,
              progress: st.progress,
              error: st.error,
            });
          }

          // 已完成：下载一次并记住
          let saved = downloaded.get(videoId);
          if (saved === undefined) {
            if (st.url === null) throw new Error('任务已完成但没有返回视频地址');
            saved = await saveVideo({ url: st.url });
            downloaded.set(videoId, saved);
          }

          sendJson(res, {
            ok: true,
            kind: 'video',
            status: 'completed',
            progress: 100,
            videoId,
            filename: saved.filename,
            path: saved.path,
            bytes: saved.bytes,
            seconds: st.seconds,
          });
        } catch (e) {
          sendJson(res, { ok: false, error: errMessage(e) }, 500);
        }
      },
    });

    /* ---------- 视频任务：提交 / 列表 / 单个 / 取消 ---------- */
    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/tasks',
      handler: async (req, res) => {
        try {
          // POST = 新建任务：提交给上游后立刻返回，后续由宿主轮询
          if (req.method === 'POST') {
            const body = await readJson(req, REF_BODY_LIMIT);
            if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
              return sendJson(res, { ok: false, error: '提示词不能为空' }, 400);
            }
            const cfg = await resolvePaths();
            void cfg;
            const task = await enqueueVideoTask({
              prompt: body.prompt,
              seconds: body.seconds,
              ratio: body.ratio,
              model: cfg.videoModel,
              seed: body.seed,
              firstFrame: body.firstFrame,
              lastFrame: body.lastFrame,
              // 参考图（mode:reference）：最多 5 张，本地图同样以 data URI 直传
              referenceImages: body.referenceImages,
            });
            return sendJson(res, { ok: true, task });
          }

          if (req.method !== 'GET') return sendJson(res, { ok: false, error: '需要 GET 或 POST' }, 405);

          const list = [...tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
          return sendJson(res, {
            ok: true,
            tasks: list,
            active: list.filter((t) => isActiveTask(t)).length,
            max: TASK_MAX,
          });
        } catch (e) {
          sendJson(res, { ok: false, error: errMessage(e) }, 500);
        }
      },
    });

    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/task',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') return sendJson(res, { ok: false, error: '需要 GET' }, 405);
          const url = new URL(req.url, 'http://dsh.local');
          const id = url.searchParams.get('id') || '';
          const task = tasks.get(id);
          if (task === undefined) return sendJson(res, { ok: false, error: '任务不存在' }, 404);
          sendJson(res, { ok: true, task });
        } catch (e) {
          sendJson(res, { ok: false, error: errMessage(e) }, 500);
        }
      },
    });

    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/task/cancel',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: '需要 POST' }, 405);
          const body = await readJson(req);
          const id = typeof body.id === 'string' ? body.id : '';
          const task = tasks.get(id);
          if (task === undefined) return sendJson(res, { ok: false, error: '任务不存在' }, 404);
          // 上游没有取消接口，这里只停本地跟踪：已生成的文件不会丢，额度照样算
          const next = patchTask(id, { status: 'cancelled', error: null });
          await persistTasks();
          sendJson(res, { ok: true, task: next });
        } catch (e) {
          sendJson(res, { ok: false, error: errMessage(e) }, 500);
        }
      },
    });

    /* ---------- 历史记录（落盘，跨会话保留） ---------- */
    /* 历史里可能留着指向旧输出目录的记录（比如曾经把 outDir 改到别处）。
       这里只把「文件此刻确实还在当前输出目录里」的条目交给界面，
       顺手把过滤后的列表写回磁盘，免得陈旧记录一直躺在文件里。 */
    const liveHistory = async () => {
      const { entries } = await readHistory();
      const { outDir } = await resolvePaths();
      const keep = [];
      for (const entry of entries) {
        if (await fileExists(join(outDir, entry.filename))) keep.push(entry);
      }
      if (keep.length !== entries.length) {
        try {
          await clearHistory();
          // appendHistory 是置顶语义，倒序写回才能保持原有顺序
          for (let i = keep.length - 1; i >= 0; i -= 1) await appendHistory(keep[i]);
        } catch {
          // 写回失败不影响本次返回
        }
      }
      return keep;
    };

    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/history',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const entries = await liveHistory();
            const { file } = await readHistory();
            return sendJson(res, { ok: true, entries, file, max: HISTORY_MAX });
          }
          if (req.method === 'POST') {
            // 单条追加：前端每生成一张图/一段视频就来记一笔
            const body = await readJson(req);
            await appendHistory(body);
            const entries = await liveHistory();
            return sendJson(res, { ok: true, entries, max: HISTORY_MAX });
          }
          if (req.method === 'DELETE') {
            await clearHistory();
            return sendJson(res, { ok: true, entries: [], max: HISTORY_MAX });
          }
          return sendJson(res, { ok: false, error: '需要 GET / POST / DELETE' }, 405);
        } catch (e) {
          sendJson(res, { ok: false, error: errMessage(e) }, 400);
        }
      },
    });

    /* ---------- 自定义提示词预设 ---------- */
    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/presets',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const { presets, file } = await readPresets();
            return sendJson(res, { ok: true, presets, file, max: PRESET_MAX });
          }
          if (req.method === 'POST') {
            const body = await readJson(req);
            const { presets } = await savePreset({ label: body.label, text: body.text });
            return sendJson(res, { ok: true, presets, max: PRESET_MAX });
          }
          if (req.method === 'DELETE') {
            const label = new URL(req.url, 'http://dsh.local').searchParams.get('label') || '';
            const { presets } = await removePreset(label);
            return sendJson(res, { ok: true, presets, max: PRESET_MAX });
          }
          return sendJson(res, { ok: false, error: '需要 GET / POST / DELETE' }, 405);
        } catch (e) {
          sendJson(res, { ok: false, error: errMessage(e) }, 400);
        }
      },
    });

    /* ---------- 提示词扩写 ---------- */
    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/expand',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: '需要 POST' }, 405);
          const body = await readJson(req);
          const kind = body.kind === 'video' ? 'video' : 'image';
          const { prompt, model } = await expandPrompt(body.prompt, { kind });
          sendJson(res, { ok: true, prompt, model: model || EXPAND_MODEL });
        } catch (e) {
          sendJson(res, { ok: false, error: errMessage(e) }, 400);
        }
      },
    });

    /* ---------- 输出目录清单：把已经存在的图/视频捞回界面 ---------- */
    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/library',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') return sendJson(res, { ok: false, error: '需要 GET' }, 405);
          const { outDir } = await resolvePaths();
          const files = await listLibrary(outDir);
          sendJson(res, {
            ok: true,
            outDir,
            files,
            images: files.filter((f) => f.kind === 'image').length,
            videos: files.filter((f) => f.kind === 'video').length,
          });
        } catch (e) {
          sendJson(res, { ok: false, error: errMessage(e) }, 500);
        }
      },
    });

    /* ---------- 在访达里显示结果文件 ---------- */
    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/reveal',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: '需要 POST' }, 405);
          const body = await readJson(req);
          // safeName 只放行 [A-Za-z0-9._-]，顺带挡住路径穿越
          const safe = safeName(typeof body.name === 'string' ? body.name : '');
          if (safe === null) return sendJson(res, { ok: false, error: '非法文件名' }, 400);
          const { outDir } = await resolvePaths();
          const abs = resolvePath(outDir, safe);
          // 双保险：解析后必须仍在输出目录里
          if (!abs.startsWith(resolvePath(outDir) + '/')) {
            return sendJson(res, { ok: false, error: '文件不在输出目录内' }, 400);
          }
          await new Promise((resolve, reject) => {
            execFile('open', ['-R', abs], (err) => (err ? reject(err) : resolve()));
          });
          sendJson(res, { ok: true, path: abs });
        } catch (e) {
          sendJson(res, { ok: false, error: errMessage(e) }, 500);
        }
      },
    });

    /* ---------- 媒体（图片 + 视频） ---------- */
    const mediaHandler = async (req, res) => {
      try {
        const name = new URL(req.url, 'http://dsh.local').searchParams.get('name') || '';
        const { buf, mime } = await readMedia(name);
        sendMedia(req, res, buf, mime);
      } catch (e) {
        sendJson(res, { ok: false, error: errMessage(e) }, 404);
      }
    };

    addRoute(webServer, { kind: 'exact', path: '/agnes/media', handler: mediaHandler });
    addRoute(webServer, { kind: 'exact', path: '/agnes/image', handler: mediaHandler });
  };

  registerRoutes(undefined);
  ctx.on('internal/service', (svc, value) => {
    if (svc === 'webServer') registerRoutes(value);
  });

  // 卸载/热重载时把路由摘掉。不摘的话路由会留在服务器表里，
  // 重新启用时会撞 "duplicate exact route" 而激活失败。
  ctx.effect(() => () => {
    for (const dispose of routeDisposers.splice(0)) {
      try { dispose(); } catch { /* 路由可能已被移除 */ }
    }
    registered = false;
  }, 'dsh-agnes-create: route cleanup');
}
