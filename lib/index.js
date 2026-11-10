/**
 * 宿主半：注册 JSON 路由给浏览器端 fetch。
 *
 * 图片（同步）
 *   GET  /agnes/health        健康检查（模型、端点、key 状态、输出目录）
 *   POST /agnes/generate      { prompt, size, ratio } → 生成并落盘
 *
 * 视频（异步任务制）
 *   POST /agnes/video         { prompt, seconds, ratio } → 提交，立刻返回 { videoId }
 *   GET  /agnes/video?id=…    查询一次状态；completed 时顺带下载落盘并返回 filename
 *                             （下载结果按 videoId 缓存，反复轮询不会重复下载）
 *
 * 媒体
 *   GET  /agnes/media?name=…  把已生成的图片/视频流回浏览器，视频支持 Range
 *   GET  /agnes/image?name=…  兼容旧链接，等价于 /agnes/media
 *
 * 路由注册方式：webServer 可能晚于本插件就绪，所以既立刻试、
 * 也监听 internal/service 事件。
 */

import {
  MODEL, VIDEO_MODEL, VIDEO_SECONDS, VIDEO_RATIOS, VIDEO_SIZE,
  DEFAULT_BASE, SIZES, RATIOS, MAX_REF_IMAGES,
  generate, keyStatus, readMedia, resolvePaths, saveConfig,
  submitVideo, queryVideo, saveVideo,
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
            const body = await readJson(req);
            if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
              return sendJson(res, { ok: false, error: '提示词不能为空' }, 400);
            }
            const sub = await submitVideo({
              prompt: body.prompt,
              seconds: body.seconds,
              ratio: body.ratio,
            });
            return sendJson(res, { ok: true, videoId: sub.videoId, taskId: sub.taskId, model: sub.model });
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
