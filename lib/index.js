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
  DEFAULT_BASE, SIZES, RATIOS, MAX_REF_IMAGES, HISTORY_MAX,
  generate, keyStatus, readMedia, resolvePaths, saveConfig, safeName,
  submitVideo, queryVideo, saveVideo,
  readHistory, appendHistory, clearHistory,
  listLibrary, fileExists,
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

  const registerRoutes = (value) => {
    if (registered) return;
    const webServer = value ?? ctx.reflect.get('webServer', false);
    if (webServer === undefined) return;
    registered = true;

    /** videoId → 已下载的本地结果，避免每次轮询重复下载几十 MB */
    const downloaded = new Map();

    addRoute(webServer, {
      kind: 'exact',
      path: '/agnes/health',
      handler: async (req, res) => {
        try {
          const cfg = await resolvePaths();
          const k = await keyStatus(cfg.keyFile);
          sendJson(res, {
            ok: true,
            model: MODEL,
            videoModel: VIDEO_MODEL,
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
              config: { keyFile: cfg.keyFile, outDir: cfg.outDir },
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

          const cfg = await saveConfig(patch);
          sendJson(res, {
            ok: true,
            config: { keyFile: cfg.keyFile, outDir: cfg.outDir },
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
          const result = await generate({
            prompt: body.prompt,
            size: body.size,
            ratio: body.ratio,
            model: body.model,
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
            const sub = await submitVideo({
              prompt: body.prompt,
              seconds: body.seconds,
              ratio: body.ratio,
              // 关键帧 / 种子：有就传，没有内核会退回纯文生视频
              seed: body.seed,
              firstFrame: body.firstFrame,
              lastFrame: body.lastFrame,
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
