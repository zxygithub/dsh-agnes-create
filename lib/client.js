window.__ModuleLoader__.load({
  id: "dsh-agnes-create",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const ID = "dsh-agnes-create";
    const CSS_ID = "dsh-agnes-create";
    const SIZE_OPTIONS = ["1K", "2K", "3K", "4K"];
    const RATIO_OPTIONS = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"];
    // 视频：Flash 固定 720P，seconds 是字符串 "4"–"12"
    const VIDEO_SECONDS = ["4", "5", "6", "7", "8", "9", "10", "11", "12"];
    const VIDEO_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
    /* 与宿主 agnes.js 的 HISTORY_MAX 保持一致：首屏先按 24 条渲染，
       loadHistory() 回来后以宿主返回的 max 为准 */
    const HISTORY_MAX = 24;
    const POLL_MS = 6000;
    const VIDEO_DEADLINE_MS = 15 * 60 * 1000;
    // 图生图：一次最多 8 张参考图（与宿主 MAX_REF_IMAGES 保持一致）
    const MAX_REFS = 8;

    /** 视频 reference 模式的参考图上限（上游：images 最多 5 张） */
    const MAX_VREFS = 5;
    // 发给上游前先下采样：长边 1280 足够模型识别，base64 也压得住
    const REF_MAX_EDGE = 1280;
    const REF_QUALITY = 0.88;
    const REF_PNG_KEEP_BYTES = 800 * 1024;

    /**
     * 提示词预设：点一下把风格描述追加到当前提示词末尾。
     * 刻意写成「可叠加的风格后缀」，而不是整段替换——用户已经写好的主体不会被冲掉。
     */
    const PROMPT_PRESETS = [
      { label: "写实摄影", text: "写实摄影风格，自然光，浅景深，35mm 镜头，细节丰富" },
      { label: "水彩", text: "水彩画风格，纸纹质感，柔和晕染，留白构图" },
      { label: "3D 渲染", text: "3D 渲染风格，柔光棚拍，材质清晰，背景简洁" },
      { label: "海报", text: "平面海报构图，大面积留白，主体突出，配色克制" },
      { label: "夜景霓虹", text: "夜景霓虹灯光，湿润地面反光，氛围浓烈" },
      { label: "极简", text: "极简构图，单一主体，纯净背景，柔和渐变光" },
    ];

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ---------- 样式 ---------- */
    const CSS = `
      .agn-root { display: flex; flex-direction: column; gap: 12px; padding: 20px 24px; height: 100%;
                  box-sizing: border-box; overflow: auto; font-size: 13px; }
      .agn-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
      .agn-title { font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
      .agn-meta { font-size: 12px; color: var(--dsw-alias-label-secondary, #888); }
      /* 标题栏里的模型下拉：长得像一行说明文字，但可以点开换模型 */
      .agn-model { font: inherit; font-size: 12px; line-height: 1.4; padding: 1px 4px;
                   max-width: 220px; cursor: pointer; border-radius: 6px;
                   color: var(--dsw-alias-label-secondary, #888); background: transparent;
                   border: 1px solid transparent; }
      .agn-model:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2, #ddd); }
      .agn-model:disabled { opacity: .6; cursor: not-allowed; }
      .agn-card { border: 1px solid var(--dsw-alias-border-l2, #e3e3e3); border-radius: 10px;
                  padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
      .agn-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #666); }
      .agn-textarea { width: 100%; box-sizing: border-box; min-height: 84px; resize: vertical;
                      font: inherit; line-height: 1.6; padding: 8px 10px; border-radius: 8px;
                      color: var(--dsw-alias-label-primary, inherit);
                      background: var(--dsw-alias-bg-layer-2, #fafafa);
                      border: 1px solid var(--dsw-alias-border-l2, #ddd); outline: none; }
      .agn-textarea:focus { border-color: var(--dsw-alias-state-business-primary, #4b7bec); }
      .agn-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .agn-select { font: inherit; padding: 5px 8px; border-radius: 8px; cursor: pointer;
                    color: var(--dsw-alias-label-primary, inherit);
                    background: var(--dsw-alias-bg-layer-2, #fafafa);
                    border: 1px solid var(--dsw-alias-border-l2, #ddd); }
      .agn-btn { font: inherit; font-weight: 600; padding: 7px 18px; border-radius: 8px; cursor: pointer;
                 border: 1px solid var(--dsw-alias-button-primary-fill, #4b7bec);
                 background: var(--dsw-alias-button-primary-fill, #4b7bec);
                 color: var(--dsw-alias-label-primary-foreground, #fff); }
      .agn-btn:disabled { opacity: .45; cursor: not-allowed; }
      .agn-err { color: var(--dsw-alias-state-error-primary, #d33); white-space: pre-wrap;
                 word-break: break-word; font-size: 12px; }
      .agn-ok { color: var(--dsw-alias-state-success-primary, #2a2); font-size: 12px; }

      /* 图片/视频 模式切换 */
      .agn-modes { display: flex; gap: 6px; }
      .agn-mode { font: inherit; font-size: 12px; padding: 4px 14px; border-radius: 999px;
                  cursor: pointer; border: 1px solid var(--dsw-alias-border-l2, #ddd);
                  background: transparent; color: var(--dsw-alias-label-secondary, #666); }
      .agn-mode-on { background: var(--dsw-alias-button-primary-fill, #4b7bec);
                     border-color: transparent;
                     color: var(--dsw-alias-label-primary-foreground, #fff); }
      .agn-mode:disabled { opacity: .45; cursor: not-allowed; }

      /* 进度条 */
      .agn-bar { height: 6px; border-radius: 3px; overflow: hidden;
                 background: var(--dsw-alias-bg-layer-2, #eee); }
      .agn-bar-fill { height: 100%; width: 0;
                      background: var(--dsw-alias-button-primary-fill, #4b7bec);
                      transition: width .3s ease; }

      /* 媒体展示区 */
      .agn-shot { position: relative; border-radius: 10px;
                  border: 1px solid var(--dsw-alias-border-l2, #e3e3e3);
                  background: var(--dsw-alias-bg-layer-2, #fafafa); overflow: hidden;
                  display: flex; align-items: center; justify-content: center; min-height: 120px; }
      .agn-shot img, .agn-shot video { display: block; max-width: 100%; height: auto; }
      .agn-shot-big { max-height: 62vh; }
      .agn-shot-big img, .agn-shot-big video { max-height: 62vh; object-fit: contain; }
      .agn-shot-msg { padding: 18px; font-size: 12px; text-align: center; line-height: 1.7;
                      color: var(--dsw-alias-label-secondary, #888); }

      /* 悬停浮现的提示词：贴在媒体底部，默认透明，鼠标进来才出现 */
      .agn-prompt { position: absolute; left: 0; right: 0; bottom: 0;
                    display: flex; align-items: flex-end; gap: 8px; padding: 8px 10px;
                    background: linear-gradient(to top, rgba(0,0,0,.62), rgba(0,0,0,0));
                    opacity: 0; transition: opacity .16s ease; pointer-events: none; }
      .agn-shot:hover .agn-prompt { opacity: 1; pointer-events: auto; }
      .agn-prompt-text { flex: 1 1 auto; min-width: 0; font-size: 11px; line-height: 1.5;
                         color: #fff; display: -webkit-box; -webkit-line-clamp: 3;
                         -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
      .agn-prompt-copy { flex: none; font: inherit; font-size: 11px; line-height: 1.3;
                         padding: 2px 8px; border-radius: 5px; cursor: pointer;
                         color: #fff; background: rgba(255,255,255,.18);
                         border: 1px solid rgba(255,255,255,.45); }
      .agn-prompt-copy:hover { background: rgba(255,255,255,.3); }

      /* 输出目录清单 */
      .agn-lib { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
      .agn-lib-tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .agn-lib-grid { display: flex; gap: 8px; flex-wrap: wrap;
                      max-height: 300px; overflow-y: auto; padding: 2px; }
      .agn-lib-item { position: relative; width: 84px; height: 84px; border-radius: 8px;
                      padding: 0; overflow: hidden; cursor: pointer; flex: none;
                      border: 2px solid var(--dsw-alias-border-l2, #e3e3e3);
                      background: var(--dsw-alias-bg-layer-2, #fafafa); }
      .agn-lib-item:hover { border-color: var(--dsw-alias-state-business-primary, #4b7bec); }
      .agn-lib-item img, .agn-lib-item video { width: 100%; height: 100%;
                       object-fit: cover; display: block; pointer-events: none; }
      .agn-lib-badge { position: absolute; left: 4px; bottom: 4px; font-size: 10px;
                       line-height: 1.4; padding: 0 5px; border-radius: 4px;
                       color: #fff; background: rgba(0,0,0,.55); }
      .agn-lib-empty { font-size: 12px; line-height: 1.6;
                       color: var(--dsw-alias-label-secondary, #888); }

      /* 历史缩略图 */
      .agn-hist { display: flex; flex-direction: column; gap: 6px; }
      .agn-hist-strip { display: flex; gap: 8px; flex-wrap: wrap; }
      .agn-thumb { position: relative; width: 84px; height: 84px; border-radius: 8px; padding: 0;
                   overflow: hidden; cursor: pointer; flex: none;
                   border: 2px solid var(--dsw-alias-border-l2, #e3e3e3);
                   background: var(--dsw-alias-bg-layer-2, #fafafa); }
      .agn-thumb-on { border-color: var(--dsw-alias-state-business-primary, #4b7bec); }
      /* 缩略图里放 <video> 取首帧；pointer-events: none 让点击继续落到外层按钮上
         （video 属于可交互内容，套在 button 里会吃掉点击） */
      .agn-thumb img, .agn-thumb video { width: 100%; height: 100%;
                     object-fit: cover; display: block; pointer-events: none; }
      /* ▶ 只是角标，压在首帧上；别挡点击，也别把首帧盖住 */
      .agn-thumb-play { position: absolute; inset: 0; display: flex; align-items: center;
                        justify-content: center; font-size: 20px; line-height: 1;
                        color: #fff; text-shadow: 0 1px 4px rgba(0, 0, 0, .75);
                        pointer-events: none; background: rgba(0, 0, 0, .12); }
      .agn-thumb-cap { position: absolute; left: 0; right: 0; bottom: 0; font-size: 10px;
                       text-align: center; padding: 1px 0;
                       color: var(--dsw-alias-label-primary-foreground, #fff);
                       background: rgba(0, 0, 0, .45); }

      /* 设置卡片 */
      .agn-field { display: flex; flex-direction: column; gap: 4px; }
      .agn-input { font: inherit; font-size: 12px; padding: 6px 9px; border-radius: 8px;
                   box-sizing: border-box; width: 100%; outline: none;
                   color: var(--dsw-alias-label-primary, inherit);
                   background: var(--dsw-alias-bg-layer-2, #fafafa);
                   border: 1px solid var(--dsw-alias-border-l2, #ddd);
                   font-family: var(--ds-font-family-code, ui-monospace, monospace); }
      .agn-input:focus { border-color: var(--dsw-alias-state-business-primary, #4b7bec); }
      .agn-input:disabled { opacity: .5; }
      .agn-note { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
      .agn-okline { font-size: 12px; color: var(--dsw-alias-state-success-primary, #2a2); }

      .agn-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #888); line-height: 1.6; }
      .agn-code { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px;
                  word-break: break-all; }

      /* 参考图（图生图 / 多图合成） */
      .agn-refs { display: flex; flex-direction: column; gap: 8px; }
      .agn-ref-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .agn-ref-strip { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .agn-ref { position: relative; width: 72px; height: 72px; border-radius: 8px; overflow: hidden;
                 flex: none; border: 1px solid var(--dsw-alias-border-l2, #e3e3e3);
                 background: var(--dsw-alias-bg-layer-2, #fafafa); }
      .agn-ref img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .agn-ref-del { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px;
                     border: none; border-radius: 50%; cursor: pointer; padding: 0;
                     font-size: 11px; line-height: 18px; text-align: center;
                     color: #fff; background: rgba(0, 0, 0, .6); }
      .agn-ref-del:hover { background: rgba(0, 0, 0, .8); }
      .agn-ref-add { width: 72px; height: 72px; border-radius: 8px; cursor: pointer; flex: none;
                     font: inherit; font-size: 11px; line-height: 1.35; padding: 4px;
                     color: var(--dsw-alias-label-secondary, #666); background: transparent;
                     border: 1px dashed var(--dsw-alias-border-l2, #ccc); }
      .agn-ref-add:disabled { opacity: .45; cursor: not-allowed; }
      .agn-ref-pick { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px; border-radius: 8px;
                      border: 1px solid var(--dsw-alias-border-l2, #e3e3e3);
                      background: var(--dsw-alias-bg-layer-2, #fafafa); }
      .agn-ref-pick button { width: 56px; height: 56px; padding: 0; border-radius: 6px;
                             overflow: hidden; cursor: pointer; flex: none;
                             border: 1px solid var(--dsw-alias-border-l2, #ddd); background: transparent; }
      .agn-ref-pick img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .agn-tag { font-size: 11px; padding: 2px 8px; border-radius: 999px;
                 background: var(--dsw-alias-bg-layer-2, #f1f1f1);
                 color: var(--dsw-alias-label-secondary, #555); }

      /* 提示词预设 */
      .agn-presets { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
      .agn-preset { font: inherit; font-size: 11px; line-height: 1.4; padding: 2px 9px;
                    border-radius: 999px; cursor: pointer;
                    color: var(--dsw-alias-label-secondary, #555); background: transparent;
                    border: 1px solid var(--dsw-alias-border-l2, #ddd); }
      .agn-preset:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary, #4b7bec);
                                         color: var(--dsw-alias-state-business-primary, #4b7bec); }
      .agn-preset:disabled { opacity: .45; cursor: not-allowed; }

      /* 视频关键帧（图生视频） */
      .agn-frames { display: flex; flex-direction: column; gap: 8px; }
      .agn-frames-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; }
      .agn-frame { display: flex; flex-direction: column; gap: 4px; flex: none; }
      .agn-frame-cap { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
      .agn-frame-box { position: relative; width: 72px; height: 72px; border-radius: 8px;
                       overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, #e3e3e3);
                       background: var(--dsw-alias-bg-layer-2, #fafafa); }
      .agn-frame-box img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .agn-frame-add { width: 72px; height: 72px; border-radius: 8px; cursor: pointer;
                       font: inherit; font-size: 11px; line-height: 1.35; padding: 4px;
                       color: var(--dsw-alias-label-secondary, #666); background: transparent;
                       border: 1px dashed var(--dsw-alias-border-l2, #ccc); }
      .agn-frame-add:disabled { opacity: .45; cursor: not-allowed; }
      /* 「＋ 结果」：从已生成的图片里挑一张当关键帧 */
      .agn-frame-from { width: 72px; font: inherit; font-size: 11px; line-height: 1.4;
                        padding: 2px 0; border-radius: 6px; cursor: pointer;
                        color: var(--dsw-alias-label-secondary, #555); background: transparent;
                        border: 1px solid var(--dsw-alias-border-l2, #ddd); }
      .agn-frame-from:hover:not(:disabled) {
                        border-color: var(--dsw-alias-state-business-primary, #4b7bec);
                        color: var(--dsw-alias-state-business-primary, #4b7bec); }
      .agn-frame-from:disabled { opacity: .45; cursor: not-allowed; }
      .agn-frame .agn-ref-pick { margin-top: 2px; }
      .agn-seed { width: 72px; }

      /* 结果收尾动作 */
      .agn-acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
      .agn-act { font: inherit; font-size: 11px; line-height: 1.4; padding: 3px 10px;
                 border-radius: 6px; cursor: pointer;
                 color: var(--dsw-alias-label-secondary, #555); background: transparent;
                 border: 1px solid var(--dsw-alias-border-l2, #ddd); }
      .agn-act:hover { border-color: var(--dsw-alias-state-business-primary, #4b7bec);
                       color: var(--dsw-alias-state-business-primary, #4b7bec); }
      .agn-act-on { border-color: var(--dsw-alias-state-business-primary, #4b7bec);
                    color: var(--dsw-alias-state-business-primary, #4b7bec); }
      /* 「测试连接」的结果行：和按钮之间留一点距离 */
      .agn-check { margin-top: 6px; }
      .agn-notice { font-size: 12px; color: var(--dsw-alias-state-success-primary, #2a2);
                    line-height: 1.6; }
    `;

    function ensureCss() {
      const tags = document.querySelectorAll('style[data-plugin-css="' + CSS_ID + '"]');
      const style = tags[0] || document.createElement("style");
      for (let i = 1; i < tags.length; i += 1) tags[i].remove();
      style.dataset.plugin = "dsh-agnes-create";
      style.dataset.pluginCss = CSS_ID;
      style.textContent = CSS;
      if (!style.isConnected) document.head.appendChild(style);
    }

    function srcOf(name) {
      return "/agnes/media?name=" + encodeURIComponent(name);
    }

    /* 「＋ 结果」的候选：最近生成的图片 + 当前结果区那张（按文件名去重）。
       从「输出目录」点出来的图只进了结果区、没进历史，只翻历史会漏掉它，
       于是刚在眼前看到的那张图反而选不进参考图 / 关键帧。 */
    function pickableImagesOf(state) {
      const history = (Array.isArray(state.history) ? state.history : []).filter((h) => h.kind === "image");
      const cur = state.result;
      if (cur === null || cur === undefined || cur.kind !== "image") return history;
      if (typeof cur.filename !== "string" || cur.filename === "") return history;
      if (history.some((h) => h.filename === cur.filename)) return history;
      return [cur].concat(history);
    }

    /* 视频生成方式：宿主回来的 mode 只可能是这三种之一，其余一律当纯文本 */
    function modeOf(mode) {
      if (mode === "keyframe") return "keyframe";
      if (mode === "reference") return "reference";
      return "text";
    }

    /* ==========================================================================
       参考图预处理（图生图）
       --------------------------------------------------------------------------
       两个来源最终都归一成 data URI：
         · 本地文件  —— <input type="file"> 给的 File
         · 生成结果  —— /agnes/media 取回 Blob
       先按长边 1280 下采样再编码，否则一张 4K PNG 的 base64 就有十几 MB，
       宿主请求体和上游都要跟着炸。
       ========================================================================== */

    let refSeq = 0;
    const nextRefId = () => "ref-" + (refSeq += 1) + "-" + Date.now();

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error("读取图片失败"));
        fr.readAsDataURL(blob);
      });
    }

    /** 编码一次 canvas；toBlob 回调可能是 null（极端尺寸/内存不足） */
    function canvasToBlob(canvas, type, quality) {
      return new Promise((resolve) => {
        try {
          canvas.toBlob((b) => resolve(b), type, quality);
        } catch {
          resolve(null);
        }
      });
    }

    /**
     * 把任意图片 Blob 压成适合上传的 data URI。
     * PNG 优先保留（多图合成常带透明通道），但超过阈值就退回 JPEG。
     */
    async function shrinkImage(blob) {
      if (!(blob instanceof Blob) || blob.size === 0) throw new Error("图片是空的");

      let bitmap;
      try {
        bitmap = await createImageBitmap(blob);
      } catch {
        // 极少数格式解码不了：小图原样上传，大图明确报错而不是偷偷传十几 MB
        if (blob.size <= REF_PNG_KEEP_BYTES) {
          return { src: await blobToDataUrl(blob), bytes: blob.size, shrunk: false };
        }
        throw new Error("无法解码这张图片（试试 PNG/JPEG/WebP）");
      }

      const longest = Math.max(bitmap.width, bitmap.height) || 1;
      const scale = Math.min(1, REF_MAX_EDGE / longest);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx === null) {
        if (typeof bitmap.close === "function") bitmap.close();
        return { src: await blobToDataUrl(blob), bytes: blob.size, shrunk: false };
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      if (typeof bitmap.close === "function") bitmap.close();

      const wantPng = blob.type === "image/png";
      let out = await canvasToBlob(canvas, wantPng ? "image/png" : "image/jpeg", REF_QUALITY);
      if (out === null) throw new Error("图片编码失败");
      if (wantPng && out.size > REF_PNG_KEEP_BYTES) {
        const jpeg = await canvasToBlob(canvas, "image/jpeg", REF_QUALITY);
        if (jpeg !== null && jpeg.size < out.size) out = jpeg;
      }

      return { src: await blobToDataUrl(out), bytes: out.size, shrunk: scale < 1 };
    }

    /* ==========================================================================
       状态仓库（放组件外面：main slot 切换会卸载组件，状态必须独立存活）
       ========================================================================== */
    const GLOBAL_KEY = "__dshAgnesCreateStore";

    function createStore() {
      const listeners = new Set();
      const state = {
        prompt: "",
        mode: "image",        // image | video
        size: "1K",
        ratio: "1:1",
        vSeconds: "5",
        vRatio: "16:9",
        busy: false,
        error: "",
        result: null,
        history: [],          // 最新在前，元素带 kind: 'image' | 'video'
        startedAt: 0,
        elapsed: 0,
        vProgress: 0,
        vStatus: "",
        videoId: null,
        vTaskId: null,
        health: null,
        healthRequested: false,

        /* ---- 可配置项：Key 文件路径 / 输出目录 ---- */
        cfg: null,              // 生效配置 { keyFile, outDir }
        cfgDefaults: null,
        cfgStored: null,
        cfgDraft: { keyFile: "", outDir: "", imageModel: "", videoModel: "" },
        cfgOpen: false,
        cfgSaving: false,
        cfgError: "",
        cfgNotice: "",
        checking: false,        // 正在测连通性
        checkResult: null,      // { ok, text, detail }
        upModels: null,         // 连接测试拿到的上游真实模型清单 { image: [], video: [] }

        /* ---- 图生图参考图 ---- */
        refs: [],               // { id, name, src(dataURI), bytes, from: 'local' | 'result' }
        refsBusy: false,
        refsError: "",
        refPickOpen: false,
        /* ---- 视频参考图（reference 模式，最多 5 张） ---- */
        vRefs: [],
        vRefsBusy: false,
        vRefsError: "",
        vRefPickOpen: false,

        /* ---- 视频关键帧（可选）：本地图直接当首帧 / 尾帧 ---- */
        vFirst: null,           // { src(dataURI), name, bytes }
        vLast: null,
        vSeed: "",              // 空串 = 不传 seed
        frameBusy: false,       // 正在压缩关键帧图片
        framePick: "",          // '' | 'first' | 'last'：本地文件选择器的目标
        framePickFrom: "",      // '' | 'first' | 'last'：生成结果选择面板的目标

        /* ---- 历史：宿主落盘，刷新/重启后还在 ---- */
        historyMax: HISTORY_MAX,
        historyLoaded: false,
        notice: "",             // 一次性操作反馈（复制路径、打开访达…）

        /* ---- 输出目录清单：把磁盘上已有的图/视频捞回来看 ---- */
        library: null,          // null = 还没加载过；[] = 加载过但是空
        libraryOpen: false,
        libraryTab: "image",    // 'image' | 'video'
        libraryBusy: false,
        libraryError: "",
        copiedKey: "",          // 刚刚复制了哪一条的提示词（用于显示「已复制」）
      };

      const snapshot = () => ({ ...state, history: state.history.slice() });
      const notify = () => {
        for (const fn of Array.from(listeners)) {
          try { fn(); } catch { /* 单个订阅者出错不拖垮其它 */ }
        }
      };
      const set = (patch) => {
        Object.assign(state, patch);
        notify();
      };
      /** 基于当前状态计算补丁：避免「读旧值再写回」导致的覆盖。 */
      const update = (fn) => {
        const patch = fn(state);
        if (patch !== null && patch !== undefined) Object.assign(state, patch);
        notify();
      };

      let timer = null;
      let runToken = 0;

      const stopTimer = () => {
        if (timer !== null) { clearInterval(timer); timer = null; }
      };
      const startTimer = () => {
        stopTimer();
        timer = setInterval(() => {
          if (state.busy) set({ elapsed: (Date.now() - state.startedAt) / 1000 });
        }, 1000);
      };

      const pushResult = (entry) => {
        set({ result: entry, history: [entry, ...state.history].slice(0, state.historyMax) });
        // 顺手落盘：/agnes/history 是唯一真相，写失败也不影响本次展示
        void appendHistory(entry);
        // 新文件已经写进输出目录了，目录清单开着的话跟着变（没加载过就不去打扰）
        void refreshLibrary();
      };

      /* ---------- 历史（宿主持久化） ---------- */
      async function loadHistory() {
        try {
          const res = await fetch("/agnes/history");
          if (!res.ok) {
            // 旧版宿主没有这条路由：保持空历史即可，不要报错吓人
            set({ historyLoaded: true });
            return;
          }
          const data = await res.json();
          if (!data || data.ok !== true) {
            set({ historyLoaded: true });
            return;
          }
          const entries = Array.isArray(data.entries) ? data.entries : [];
          const max = typeof data.max === "number" && data.max > 0 ? data.max : HISTORY_MAX;
          update((prev) => ({
            history: entries,
            historyMax: max,
            historyLoaded: true,
            // 主预览默认显示最新一条；已经有结果时不动它
            result: prev.result === null ? (entries[0] || null) : prev.result,
          }));
        } catch {
          set({ historyLoaded: true });
        }
      }

      async function appendHistory(entry) {
        try {
          const res = await fetch("/agnes/history", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(entry),
          });
          if (!res.ok) return;
          const data = await res.json();
          if (!data || data.ok !== true) return;
          // 只有宿主确实回了列表才覆盖本地：宁可用旧列表，也不要把界面清空
          if (!Array.isArray(data.entries)) return;
          update((prev) => ({
            history: data.entries,
            historyMax: typeof data.max === "number" && data.max > 0 ? data.max : prev.historyMax,
          }));
        } catch { /* 落盘失败不影响当前结果展示 */ }
      }

      async function loadHealth() {
        if (state.healthRequested) return;
        state.healthRequested = true;
        try {
          const res = await fetch("/agnes/health");
          set({ health: await res.json() });
        } catch {
          set({ health: { ok: false, error: "宿主路由不可达" } });
        }
      }

      /* ---------- 配置读写 ---------- */
      async function loadConfig() {
        try {
          const res = await fetch("/agnes/config");
          // 宿主半还没重启时这条路由不存在：给出可操作的提示，而不是一句“读取失败”
          if (res.status === 404) {
            set({ cfgError: "配置接口尚未就绪：需要完全重启应用（只重载窗口不够）" });
            return;
          }
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || "读取配置失败");
          set({
            cfg: data.config,
            cfgDefaults: data.defaults,
            cfgStored: data.stored,
            cfgDraft: {
              keyFile: data.config.keyFile,
              outDir: data.config.outDir,
              imageModel: data.config.imageModel || "",
              videoModel: data.config.videoModel || "",
            },
            cfgError: "",
          });
        } catch (e) {
          set({ cfgError: e && e.message ? e.message : String(e) });
        }
      }

      async function saveConfig() {
        if (state.cfgSaving) return;
        set({ cfgSaving: true, cfgError: "", cfgNotice: "" });
        try {
          const res = await fetch("/agnes/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              keyFile: state.cfgDraft.keyFile,
              outDir: state.cfgDraft.outDir,
              // 空串 = 回退到内置默认模型
              imageModel: state.cfgDraft.imageModel,
              videoModel: state.cfgDraft.videoModel,
            }),
          });
          if (res.status === 404) throw new Error("配置接口尚未就绪：需要完全重启应用（只重载窗口不够）");
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || "保存失败");
          set({
            cfg: data.config,
            cfgDefaults: data.defaults,
            cfgStored: data.stored,
            cfgDraft: {
              keyFile: data.config.keyFile,
              outDir: data.config.outDir,
              imageModel: data.config.imageModel || "",
              videoModel: data.config.videoModel || "",
            },
            cfgNotice: "已保存",
          });
          // 路径变了，key 是否存在/目录是否可写都要重新算
          try {
            set({ health: await (await fetch("/agnes/health")).json() });
          } catch { /* 健康信息刷新失败不影响保存结果 */ }
        } catch (e) {
          set({ cfgError: e && e.message ? e.message : String(e) });
        } finally {
          set({ cfgSaving: false });
        }
      }

      /** 测一下 Key 能不能连上游：顺便把上游真实的模型名单拉回来 */
      async function checkKey() {
        if (state.checking) return;
        set({ checking: true, checkResult: null, cfgError: "" });
        try {
          const res = await fetch("/agnes/models");
          const data = await res.json().catch(() => ({}));
          if (res.status === 404) {
            throw new Error("模型探测接口尚未就绪：需要完全重启应用（只重载窗口不够）");
          }
          if (!res.ok || !data || data.ok !== true) {
            throw new Error((data && data.error) || ("探测失败：HTTP " + res.status));
          }
          const up = data.upstream || {};
          const imgs = Array.isArray(up.image) ? up.image.length : 0;
          const vids = Array.isArray(up.video) ? up.video.length : 0;
          set({
            checking: false,
            // 把上游真实清单留下：顶部的模型下拉优先用它，比内置清单更可信
            upModels: {
              image: Array.isArray(up.image) ? up.image : [],
              video: Array.isArray(up.video) ? up.video : [],
            },
            checkResult: {
              ok: true,
              text: "连接正常：上游可用 " + imgs + " 个图片模型、" + vids + " 个视频模型",
              detail: ""
            },
          });
        } catch (e) {
          set({
            checking: false,
            checkResult: { ok: false, text: e && e.message ? e.message : String(e), detail: "" },
          });
        }
      }

      /* ---------- 图片：一次请求就出结果 ---------- */
      async function runImage(token, prompt) {
        const refs = state.refs;
        const payload = {
          prompt,
          size: state.size,
          ratio: state.ratio,
          // 有参考图就是图生图 / 多图合成；宿主原样透传给上游的 extra_body.image
          ...(refs.length > 0 ? { images: refs.map((r) => r.src) } : {}),
        };
        const res = await fetch("/agnes/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "生成失败");
        if (token !== runToken) return;
        pushResult({ ...data, kind: "image", prompt, wallSec: ((Date.now() - state.startedAt) / 1000).toFixed(1) });
      }

      /* ---------- 参考图（图生图） ---------- */

      const refsFull = () => state.refs.length >= MAX_REFS;

      /**
       * 参考图操作串行化。
       *
       * 之前用 `if (state.refsBusy) return` 做互斥：一旦某个操作正在跑
       * （读生成结果要 fetch + 解码，可能几百毫秒），这期间用户的另一次添加
       * 会被**静默丢弃**——点了没反应，看起来就像"刚加的图不见了"。
       * 现在改成排队执行：不丢单，也不会出现两个操作互相覆盖 refs。
       */
      let refQueue = Promise.resolve();
      function queueRefOp(task) {
        const run = refQueue.then(task, task);
        // 单个操作失败不能卡死后面的队列
        refQueue = run.catch(() => {});
        return run;
      }

      /** 来源一：本地磁盘文件（可多选）。返回 Promise，调用方可等它读完再清空 input。 */
      function addRefsFromFiles(files) {
        const list = Array.from(files || []).filter(
          (f) => f && String(f.type || "").startsWith("image/")
        );
        if (list.length === 0) {
          set({ refsError: "没有可用的图片文件（需要 PNG / JPEG / WebP / GIF）" });
          return Promise.resolve();
        }

        return queueRefOp(async () => {
          set({ refsBusy: true, refsError: "" });
          const added = [];
          const failed = [];
          try {
            for (const file of list) {
              if (state.refs.length + added.length >= MAX_REFS) {
                failed.push("超出 " + MAX_REFS + " 张上限");
                break;
              }
              try {
                // 先把文件读进内存再继续：即使 input.value 被清空，读也不会断
                const r = await shrinkImage(file);
                added.push({
                  id: nextRefId(),
                  name: file.name || "本地图片",
                  src: r.src,
                  bytes: r.bytes,
                  from: "local",
                });
              } catch (e) {
                failed.push((file.name || "图片") + "：" + (e && e.message ? e.message : String(e)));
              }
            }
            if (added.length > 0) {
              // 用 update 基于最新状态追加，杜绝覆盖别的来源刚加进来的图
              update((prev) => ({ refs: prev.refs.concat(added) }));
            }
            set({
              refsError: failed.length > 0 ? failed.join("；") : "",
              refPickOpen: false,
            });
          } finally {
            set({ refsBusy: false });
          }
        });
      }

      /** 来源二：生成结果里的图片（通过 /agnes/media 取回再下采样） */
      function addRefFromResult(entry) {
        if (!entry || entry.kind !== "image" || !entry.filename) return Promise.resolve();
        if (refsFull()) {
          set({ refsError: "参考图最多 " + MAX_REFS + " 张" });
          return Promise.resolve();
        }

        return queueRefOp(async () => {
          set({ refsBusy: true, refsError: "" });
          try {
            const res = await fetch(srcOf(entry.filename));
            if (!res.ok) throw new Error("读取生成结果失败：HTTP " + res.status);
            const blob = await res.blob();
            const r = await shrinkImage(blob);
            update((prev) => ({
              refs: prev.refs.concat([{
                id: nextRefId(),
                name: entry.filename,
                src: r.src,
                bytes: r.bytes,
                from: "result",
              }]),
              refPickOpen: false,
            }));
          } catch (e) {
            set({ refsError: e && e.message ? e.message : String(e) });
          } finally {
            set({ refsBusy: false });
          }
        });
      }

      function removeRef(id) {
        if (state.busy) return;
        update((prev) => ({ refs: prev.refs.filter((r) => r.id !== id), refsError: "" }));
      }

      function clearRefs() {
        if (state.busy) return;
        set({ refs: [], refsError: "", refPickOpen: false });
      }

      function toggleRefPick() {
        if (state.busy) return;
        set({ refPickOpen: !state.refPickOpen, refsError: "" });
      }

      /* ---------- 视频参考图（reference 模式，≤5 张） ---------- */
      const vRefsFull = () => state.vRefs.length >= MAX_VREFS;

      function addVRefsFromFiles(files) {
        const list = Array.from(files || []).filter(
          (f) => f && String(f.type || "").startsWith("image/")
        );
        if (list.length === 0) {
          set({ vRefsError: "没有可用的图片文件（需要 PNG / JPEG / WebP / GIF）" });
          return Promise.resolve();
        }

        return queueRefOp(async () => {
          set({ vRefsBusy: true, vRefsError: "" });
          const added = [];
          const failed = [];
          try {
            for (const file of list) {
              if (state.vRefs.length + added.length >= MAX_VREFS) {
                failed.push("超出 " + MAX_VREFS + " 张上限");
                break;
              }
              try {
                const r = await shrinkImage(file);
                added.push({
                  id: nextRefId(),
                  name: file.name || "本地图片",
                  src: r.src,
                  bytes: r.bytes,
                  from: "local",
                });
              } catch (e) {
                failed.push((file.name || "图片") + "：" + (e && e.message ? e.message : String(e)));
              }
            }
            if (added.length > 0) {
              update((prev) => ({ vRefs: prev.vRefs.concat(added) }));
            }
            set({
              vRefsError: failed.length > 0 ? failed.join("；") : "",
              vRefPickOpen: false,
            });
          } finally {
            set({ vRefsBusy: false });
          }
        });
      }

      function addVRefFromResult(entry) {
        if (!entry || entry.kind !== "image" || !entry.filename) return Promise.resolve();
        if (vRefsFull()) {
          set({ vRefsError: "参考图最多 " + MAX_VREFS + " 张" });
          return Promise.resolve();
        }

        return queueRefOp(async () => {
          set({ vRefsBusy: true, vRefsError: "" });
          try {
            const res = await fetch(srcOf(entry.filename));
            if (!res.ok) throw new Error("读取生成结果失败：HTTP " + res.status);
            const blob = await res.blob();
            const r = await shrinkImage(blob);
            update((prev) => ({
              vRefs: prev.vRefs.concat([{
                id: nextRefId(),
                name: entry.filename,
                src: r.src,
                bytes: r.bytes,
                from: "result",
              }]),
              vRefPickOpen: false,
            }));
          } catch (e) {
            set({ vRefsError: e && e.message ? e.message : String(e) });
          } finally {
            set({ vRefsBusy: false });
          }
        });
      }

      function removeVRef(id) {
        if (state.busy) return;
        update((prev) => ({ vRefs: prev.vRefs.filter((r) => r.id !== id), vRefsError: "" }));
      }

      function clearVRefs() {
        if (state.busy) return;
        set({ vRefs: [], vRefsError: "", vRefPickOpen: false });
      }

      function toggleVRefPick() {
        if (state.busy) return;
        set({ vRefPickOpen: !state.vRefPickOpen, vRefsError: "" });
      }

      /* ---------- 视频关键帧（首帧 / 尾帧，本地图直接当帧） ---------- */
      const frameField = (which) => (which === "last" ? "vLast" : "vFirst");

      function pickFrame(which) {
        if (state.busy || state.frameBusy) return;
        set({ framePick: which, error: "" });
      }

      async function setFrameFromFile(which, file) {
        set({ frameBusy: true, error: "" });
        try {
          // 和参考图走同一套下采样：长边 1280、PNG 优先，既省上行又不会糊
          const r = await shrinkImage(file);
          set({
            [frameField(which)]: { src: r.src, name: file.name || "关键帧", bytes: r.bytes },
            framePick: "",
          });
        } catch (e) {
          set({ framePick: "", error: e && e.message ? e.message : String(e) });
        } finally {
          set({ frameBusy: false });
        }
      }

      function clearFrame(which) {
        if (state.busy) return;
        set({ [frameField(which)]: null, framePickFrom: "" });
      }

      /* 把「生成结果」里的图直接当关键帧：和本地图完全同一条链路（blob → 下采样 → data URI） */
      function toggleFramePick(which) {
        if (state.busy || state.frameBusy) return;
        set({ framePickFrom: state.framePickFrom === which ? "" : which, error: "" });
      }

      async function setFrameFromResult(which, entry) {
        if (!entry || entry.kind !== "image" || !entry.filename) return;
        if (state.busy || state.frameBusy) return;
        set({ frameBusy: true, error: "" });
        try {
          const res = await fetch(srcOf(entry.filename));
          if (!res.ok) throw new Error("读取生成结果失败：HTTP " + res.status);
          const blob = await res.blob();
          const r = await shrinkImage(blob);
          set({
            [frameField(which)]: { src: r.src, name: entry.filename, bytes: r.bytes },
            framePickFrom: "",
          });
        } catch (e) {
          set({ framePickFrom: "", error: e && e.message ? e.message : String(e) });
        } finally {
          set({ frameBusy: false });
        }
      }

      /* 结果区的一键设置：只在「结果本身是图片」时有意义 */
      function useResultAsFrame(which) {
        const cur = state.result;
        if (cur === null || cur.kind !== "image") return;
        return setFrameFromResult(which, cur);
      }

      /* ---------- 结果收尾动作：复制路径 / 访达显示 / 下载 ---------- */
      async function copyPath() {
        const cur = state.result;
        if (cur === null) return;
        const text = cur.path || "";
        try {
          await navigator.clipboard.writeText(text);
          set({ notice: "路径已复制" });
        } catch {
          set({ notice: "复制失败，可手动复制：" + text });
        }
      }

      async function reveal() {
        const cur = state.result;
        if (cur === null) return;
        try {
          const res = await fetch("/agnes/reveal", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: cur.filename }),
          });
          const data = await res.json().catch(() => ({}));
          set({
            notice: data && data.ok === true
              ? "已在访达中显示"
              : "打开失败：" + ((data && data.error) || "HTTP " + res.status),
          });
        } catch (e) {
          set({ notice: "打开失败：" + (e && e.message ? e.message : String(e)) });
        }
      }

      function downloadResult() {
        const cur = state.result;
        if (cur === null) return;
        const a = document.createElement("a");
        a.href = srcOf(cur.filename);
        a.download = cur.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        set({ notice: "已开始下载" });
      }

      /** 停掉等待：让在途的轮询/请求结果失效（宿主的任务照常跑，文件会正常落盘） */
      function cancel() {
        if (!state.busy) return;
        const hadTask = state.vTaskId !== null;
        runToken += 1;
        stopTimer();
        set({
          busy: false, vStatus: "", vProgress: 0,
          notice: hadTask
            ? "已停止跟踪；宿主会继续推进，刷新面板还能接回进度，文件也会照常落盘"
            : "已停止等待；服务端任务可能仍在跑",
        });
      }

      /* ---------- 输出目录：把磁盘上已经有的图/视频捞回来 ---------- */
      async function copyPrompt(text) {
        const t = typeof text === "string" ? text.trim() : "";
        if (t === "") return;
        try {
          await navigator.clipboard.writeText(t);
          set({ notice: "提示词已复制", copiedKey: t });
        } catch {
          set({ notice: "复制失败，可手动选中复制" });
        }
      }

      async function loadLibrary() {
        if (state.libraryBusy) return;
        set({ libraryBusy: true, libraryError: "" });
        try {
          const res = await fetch("/agnes/library");
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data || data.ok !== true) {
            throw new Error((data && data.error) || "HTTP " + res.status);
          }
          const files = Array.isArray(data.files) ? data.files : [];
          set({
            library: files,
            libraryOpen: true,
            libraryBusy: false,
            libraryError: "",
          });
          const images = files.filter((f) => f.kind === "image").length;
          if (images === 0) {
            const videos = files.filter((f) => f.kind === "video").length;
            if (videos > 0) set({ libraryTab: "video" });
          }
        } catch (e) {
          set({
            libraryBusy: false,
            libraryOpen: true,
            libraryError: e && e.message ? e.message : String(e),
          });
        }
      }

      /**
       * 静默刷新输出目录清单：生成完成后新文件已经落盘，列表要跟着更新。
       * 只在清单已经加载过时才拉（没展开过就别偷偷把面板撑开），失败保留旧清单。
       */
      async function refreshLibrary() {
        if (state.library === null || state.libraryBusy) return;
        try {
          const res = await fetch("/agnes/library");
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data || data.ok !== true) return;
          if (!Array.isArray(data.files)) return;
          update(() => ({ library: data.files, libraryError: "" }));
        } catch {
          // 刷新失败保留旧清单，不打扰用户
        }
      }

      function toggleLibrary() {
        if (state.libraryOpen) {
          set({ libraryOpen: false });
          return;
        }
        // 没加载过就先拉一次；已经有清单则直接展开
        if (state.library === null) return loadLibrary();
        set({ libraryOpen: true });
      }

      function setLibraryTab(tab) {
        set({ libraryTab: tab === "video" ? "video" : "image" });
      }

      /** 点磁盘上的文件：直接放进结果区看，不经过生成流程 */
      function showLibraryFile(file) {
        if (!file || !file.name) return;
        if (state.busy) return;
        set({
          result: {
            kind: file.kind === "video" ? "video" : "image",
            filename: file.name,
            path: file.path || "",
            bytes: file.bytes || 0,
            prompt: typeof file.prompt === "string" ? file.prompt : "",
            fromDisk: true,
          },
          error: "",
          notice: "",
        });
      }

      /* ---------- 视频：交给宿主任务队列，面板只负责看进度 ---------- */
      // 提交后 video_id 由宿主保管：关面板、刷新页面、重启应用都不影响任务继续推进。
      async function watchTask(token, taskId, fallback) {
        const deadline = Date.now() + VIDEO_DEADLINE_MS;
        let transientFails = 0;

        for (;;) {
          await sleep(POLL_MS);
          if (token !== runToken) return;

          let st;
          try {
            const r = await fetch("/agnes/task?id=" + encodeURIComponent(taskId));
            st = r.ok ? await r.json() : { ok: false, error: "查询任务失败：HTTP " + r.status };
          } catch (e) {
            st = { ok: false, error: "网络错误：" + (e && e.message ? e.message : String(e)) };
          }

          if (!st.ok) {
            const msg = String(st.error || "查询任务失败");
            // 宿主自己会重试上游；这里只在本地接口抖动时容忍几次
            if (/\b429\b|\b503\b|频繁|队列已满|网络错误|timeout/i.test(msg)) {
              transientFails += 1;
              if (transientFails > 8) throw new Error(msg);
              set({ vStatus: "重试中…" });
              await sleep(Math.min(30000, 3000 * transientFails));
              continue;
            }
            throw new Error(msg);
          }

          transientFails = 0;
          if (token !== runToken) return;

          const task = st.task || {};
          set({
            vStatus: task.status ? String(task.status) : "",
            vProgress: typeof task.progress === "number" ? task.progress : 0,
            videoId: task.videoId || fallback.videoId || null,
          });

          if (task.status === "completed") {
            pushResult({
              kind: "video",
              filename: task.filename,
              path: task.path,
              bytes: task.bytes,
              size: "720P",
              ratio: task.ratio || fallback.ratio,
              seconds: task.seconds || fallback.seconds,
              transport: "宿主任务",
              mode: modeOf(task.mode || fallback.mode),
              seed: task.seed === null || task.seed === undefined ? undefined : task.seed,
              prompt: task.prompt || fallback.prompt,
              wallSec: ((Date.now() - state.startedAt) / 1000).toFixed(1),
            });
            return;
          }
          if (task.status === "failed") throw new Error(task.error || "视频生成失败");
          if (task.status === "cancelled") throw new Error("任务已取消");
          if (Date.now() > deadline) {
            throw new Error("等待超时（15 分钟）；宿主仍在推进，稍后刷新还能看到结果");
          }
        }
      }

      async function runVideo(token, prompt) {
        set({ vStatus: "提交中…", vProgress: 0, videoId: null, vTaskId: null });

        const seedText = String(state.vSeed).trim();
        const seedValue = seedText === "" ? null : Number(seedText);
        if (seedValue !== null && !(Number.isInteger(seedValue) && seedValue >= 0)) {
          throw new Error("seed 需要非负整数（也可以留空）");
        }

        // 关键帧直接发 data URI：上游已实测接受 base64，本地图片不用先传图床
        const subRes = await fetch("/agnes/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt,
            seconds: state.vSeconds,
            ratio: state.vRatio,
            seed: seedValue,
            firstFrame: state.vFirst !== null ? state.vFirst.src : null,
            lastFrame: state.vLast !== null ? state.vLast.src : null,
            // 参考图（reference 模式）：有首/尾帧时上游会用 keyframe，参考图自动让位
            referenceImages: state.vRefs.map((r) => r.src),
          }),
        });
        const sub = await subRes.json();
        if (!sub.ok) throw new Error(sub.error || "提交失败");
        if (token !== runToken) return;

        const task = sub.task || {};
        if (!task.id) throw new Error("宿主没有返回任务号");
        set({ videoId: task.videoId || null, vTaskId: task.id, vStatus: "排队中…" });

        await watchTask(token, task.id, {
          prompt,
          ratio: state.vRatio,
          seconds: state.vSeconds,
          mode: task.mode,
          videoId: task.videoId,
        });
      }

      /* 面板重新挂载时把宿主上还在跑的任务接回来：刷新页面不会让进度消失 */
      async function resumeTasks() {
        if (state.busy) return;
        try {
          const r = await fetch("/agnes/tasks");
          if (!r.ok) return;
          const data = await r.json();
          if (!data || data.ok !== true || !Array.isArray(data.tasks)) return;
          const active = data.tasks.find((t) => t.status === "queued" || t.status === "running");
          if (!active || state.busy) return;

          const token = ++runToken;
          const created = Date.parse(active.createdAt);
          set({
            mode: "video",
            busy: true,
            error: "",
            notice: "",
            startedAt: Number.isFinite(created) ? created : Date.now(),
            elapsed: 0,
            vFirst: null,
            vLast: null,
            videoId: active.videoId || null,
            vTaskId: active.id,
            vStatus: active.status,
            vProgress: typeof active.progress === "number" ? active.progress : 0,
            prompt: state.prompt.trim() === "" ? String(active.prompt || "") : state.prompt,
          });
          startTimer();
          try {
            await watchTask(token, active.id, {
              prompt: active.prompt,
              ratio: active.ratio || state.vRatio,
              seconds: active.seconds || state.vSeconds,
              mode: active.mode,
              videoId: active.videoId,
            });
          } catch (e) {
            if (token === runToken) set({ error: e && e.message ? e.message : String(e) });
          } finally {
            if (token === runToken) {
              stopTimer();
              set({ busy: false, elapsed: (Date.now() - state.startedAt) / 1000 });
            }
          }
        } catch {
          // 旧宿主没有 /agnes/tasks：静默跳过，不打扰用户
        }
      }

      async function run() {
        if (state.busy || state.refsBusy) return;
        const prompt = state.prompt.trim();
        if (prompt === "") return;

        const token = ++runToken;
        const mode = state.mode;
        set({
          busy: true, error: "", startedAt: Date.now(), elapsed: 0,
          vProgress: 0, vStatus: mode === "video" ? "提交中…" : "",
        });
        startTimer();

        try {
          if (mode === "video") await runVideo(token, prompt);
          else await runImage(token, prompt);
        } catch (e) {
          if (token === runToken) set({ error: e && e.message ? e.message : String(e) });
        } finally {
          if (token === runToken) {
            stopTimer();
            set({ busy: false, elapsed: (Date.now() - state.startedAt) / 1000 });
          }
        }
      }

      return {
        get: snapshot,
        raw: () => state,
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        set,
        loadHealth,
        loadConfig,
        loadHistory,
        saveConfig,
        setCfgDraft(field, value) {
          set({ cfgDraft: { ...state.cfgDraft, [field]: value }, cfgNotice: "" });
        },

        /* 顶部标题栏直接换模型：先写进草稿，再立刻落盘（不然刷新就回退了） */
        async setModel(kind, value) {
          if (state.busy || state.cfgSaving) return;
          const field = kind === "video" ? "videoModel" : "imageModel";
          set({ cfgDraft: { ...state.cfgDraft, [field]: value }, cfgNotice: "", cfgError: "" });
          await saveConfig();
          if (state.cfgError === "") {
            set({ notice: "已切换模型：" + (value === "" ? "内置默认" : value) });
          }
        },
        toggleCfg() { set({ cfgOpen: !state.cfgOpen }); },
        checkKey,
        run,
        /* ---- 参考图动作 ---- */
        addRefsFromFiles,
        addRefFromResult,
        removeRef,
        clearRefs,
        toggleRefPick,
        /* ---- 视频参考图（reference 模式，≤5 张） ---- */
        addVRefsFromFiles,
        addVRefFromResult,
        removeVRef,
        clearVRefs,
        toggleVRefPick,
        /* ---- 视频关键帧 ---- */
        pickFrame,
        setFrameFromFile,
        clearFrame,
        toggleFramePick,
        setFrameFromResult,
        useResultAsFrame,
        /* ---- 视频任务（宿主侧推进，刷新可接回） ---- */
        resumeTasks,
        /* ---- 结果收尾 ---- */
        copyPath,
        reveal,
        downloadResult,
        cancel,
        copyPrompt,
        /* ---- 输出目录清单 ---- */
        loadLibrary,
        toggleLibrary,
        setLibraryTab,
        showLibraryFile,
        maxRefs: MAX_REFS,
        maxVRefs: MAX_VREFS,
        /** 切换主预览到历史里的某一张 */
        show(entry) { set({ result: entry }); },
        /**
         * 清空界面上的生成结果。删的是界面状态和宿主持久化的历史记录，
         * 不删磁盘文件、不动提示词和参数。进行中的请求不清。
         */
        clear() {
          if (state.busy) return;
          set({ result: null, history: [], error: "", notice: "" });
          // 宿主是历史的真源；这里的 DELETE 失败也不该打断界面
          void fetch("/agnes/history", { method: "DELETE" }).catch(() => {});
        },
        dispose() {
          stopTimer();
          runToken += 1;
          listeners.clear();
        },
      };
    }

    function getStore() {
      let s = globalThis[GLOBAL_KEY];
      if (!s) { s = createStore(); globalThis[GLOBAL_KEY] = s; }
      return s;
    }

    /* ---------- 媒体显示：视频直接用 <video>，图片带加载兜底 ---------- */
    function MediaBox({ entry, big, onCopyPrompt }) {
      const isVideo = entry !== null && entry.kind === "video";
      const name = entry === null ? null : entry.filename;

      const [src, setSrc] = React.useState(name === null ? null : srcOf(name));
      const [failed, setFailed] = React.useState(false);
      const [triedBlob, setTriedBlob] = React.useState(false);
      const objUrlRef = React.useRef(null);

      React.useEffect(() => {
        setSrc(name === null ? null : srcOf(name));
        setFailed(false);
        setTriedBlob(false);
        return () => {
          if (objUrlRef.current !== null) {
            try { URL.revokeObjectURL(objUrlRef.current); } catch { /* ignore */ }
            objUrlRef.current = null;
          }
        };
      }, [name]);

      if (entry === null || name === null) {
        return React.createElement("div", { className: "agn-shot" },
          React.createElement("div", { className: "agn-shot-msg" }, "还没有生成结果"));
      }

      const onError = async () => {
        if (isVideo || triedBlob) { setFailed(true); return; }
        setTriedBlob(true);
        try {
          const res = await fetch(srcOf(name));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const buf = await res.arrayBuffer();
          if (buf.byteLength === 0) throw new Error("0 字节");
          const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
          objUrlRef.current = url;
          setSrc(url);
        } catch {
          setFailed(true);
        }
      };

      if (failed) {
        return React.createElement("div", { className: "agn-shot" },
          React.createElement("div", { className: "agn-shot-msg" },
            "已生成，但界面加载失败。\n文件路径：",
            React.createElement("span", { className: "agn-code" }, entry.path || name)));
      }

      const promptText = typeof entry.prompt === "string" ? entry.prompt.trim() : "";

      return React.createElement("div", { className: "agn-shot" + (big ? " agn-shot-big" : "") },
        isVideo
          ? React.createElement("video", {
              src,
              controls: true,
              playsInline: true,
              preload: "metadata",
              onError: () => setFailed(true),
            })
          : React.createElement("img", { src, alt: "生成结果", onError }),
        /* 鼠标移上去才浮出来的一层：显示当初的提示词，带一键复制 */
        promptText === ""
          ? null
          : React.createElement("div", { className: "agn-prompt" },
              React.createElement("div", { className: "agn-prompt-text", title: promptText }, promptText),
              React.createElement("button", {
                type: "button", className: "agn-prompt-copy",
                title: "复制这段提示词",
                onClick: (e) => {
                  e.stopPropagation();
                  if (typeof onCopyPrompt === "function") onCopyPrompt(promptText);
                },
              }, "复制"))
      );
    }

    /* ---------- 侧栏图标 ---------- */
    function Glyph(props) {
      const size = typeof props.size === "number" ? props.size : 18;
      return React.createElement(
        "svg",
        {
          width: size, height: size, viewBox: "0 0 24 24", fill: "none",
          stroke: "currentColor", strokeWidth: props.active ? 2 : 1.7,
          strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
        },
        React.createElement("rect", { key: "b", x: 2.5, y: 6.5, width: 19, height: 14, rx: 3 }),
        React.createElement("circle", { key: "c", cx: 12, cy: 13.5, r: 4 }),
        React.createElement("path", { key: "t", d: "M8.5 6.5 9.6 4.2h4.8l1.1 2.3" })
      );
    }

    /* ---------- 主页面 ---------- */
    function Panel() {
      const store = getStore();
      const [s, setSnap] = React.useState(() => store.get());

      React.useEffect(() => {
        setSnap(store.get());
        const off = store.subscribe(() => setSnap(store.get()));
        return () => { off(); };
      }, []);

      React.useEffect(() => {
        store.loadHealth();
        store.loadConfig();
        store.loadHistory();
        // 上次没跑完的视频任务：宿主还在推进，接回进度
        store.resumeTasks();
      }, []);

      const busy = s.busy;
      const isVideo = s.mode === "video";
      const key = s.health && s.health.key ? s.health.key : null;
      const keyBad = key !== null && key.present !== true;
      const shown = s.result;
      const hasRefs = s.refs.length > 0;
      const refsFull = s.refs.length >= MAX_REFS;
      const vRefsFull = s.vRefs.length >= MAX_VREFS;
      const imageHistory = s.history.filter((h) => h.kind === "image");
      const pickableImages = pickableImagesOf(s);
      const libraryAll = s.library || [];
      const libraryImages = libraryAll.filter((f) => f.kind !== "video");
      const libraryVideos = libraryAll.filter((f) => f.kind === "video");
      const libraryShown = s.libraryTab === "video" ? libraryVideos : libraryImages;
      const fileInput = React.useRef(null);
      const frameInput = React.useRef(null);
      const vRefInput = React.useRef(null);

      const onKeyDown = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); store.run(); }
      };

      const buttonLabel = busy
        ? (isVideo ? "生成视频… " : (hasRefs ? "图生图中… " : "生成中… ")) + (s.elapsed > 0 ? s.elapsed.toFixed(0) + "s" : "")
        : (isVideo ? "生成视频" : (hasRefs ? "图生图" : "生成"));

      const modeBtn = (mode, text) => React.createElement("button", {
        key: mode,
        type: "button",
        className: "agn-mode" + (s.mode === mode ? " agn-mode-on" : ""),
        disabled: busy,
        onClick: () => store.set({ mode }),
      }, text);

      /* ---- 参数区：图片走档位+宽高比，视频走秒数+画幅（720P 固定） ---- */
      const params = isVideo
        ? [
            React.createElement("span", { key: "l1", className: "agn-label" }, "时长"),
            React.createElement("select", {
              key: "s1", className: "agn-select", value: s.vSeconds, disabled: busy,
              onChange: (e) => store.set({ vSeconds: e.target.value }),
            }, VIDEO_SECONDS.map((x) => React.createElement("option", { key: x, value: x }, x + " 秒"))),
            React.createElement("span", { key: "l2", className: "agn-label" }, "画幅"),
            React.createElement("select", {
              key: "s2", className: "agn-select", value: s.vRatio, disabled: busy,
              onChange: (e) => store.set({ vRatio: e.target.value }),
            }, VIDEO_RATIOS.map((x) => React.createElement("option", { key: x, value: x }, x))),
            React.createElement("span", { key: "m", className: "agn-meta" }, "720P"),
            React.createElement("span", { key: "l3", className: "agn-label" }, "种子"),
            React.createElement("input", {
              key: "s3", type: "text", inputMode: "numeric", className: "agn-seed",
              value: s.vSeed, disabled: busy, placeholder: "随机",
              title: "固定 seed 可让同一提示词出片更稳定；留空由服务端随机",
              onChange: (e) => store.set({ vSeed: e.target.value }),
            }),
          ]
        : [
            React.createElement("span", { key: "l1", className: "agn-label" }, "尺寸"),
            React.createElement("select", {
              key: "s1", className: "agn-select", value: s.size, disabled: busy,
              onChange: (e) => store.set({ size: e.target.value }),
            }, SIZE_OPTIONS.map((x) => React.createElement("option", { key: x, value: x }, x))),
            React.createElement("span", { key: "l2", className: "agn-label" }, "比例"),
            React.createElement("select", {
              key: "s2", className: "agn-select", value: s.ratio, disabled: busy,
              onChange: (e) => store.set({ ratio: e.target.value }),
            }, RATIO_OPTIONS.map((x) => React.createElement("option", { key: x, value: x }, x))),
          ];

      const resultLabel = shown === null
        ? "生成结果（还没有）"
        : (shown.kind === "video" ? "生成结果 · 视频" : "生成结果 · 图片");

      /* 视频缩略图：放一个真的 <video>，浏览器会解码出首帧当封面。
         #t=0.1 是媒体片段定位，避免第一帧偶尔是黑场；muted + playsInline
         保证不会被自动播放策略拦掉，也不会突然出声。 */
      const videoThumb = (name) => React.createElement("video", {
        src: srcOf(name) + "#t=0.1",
        preload: "metadata",
        muted: true,
        playsInline: true,
        tabIndex: -1,
      });

      /* 关键帧小格：有图显示缩略图 + ×，无图显示「＋ 本地」；
         下方固定一行「＋ 结果」，从已经生成过的图片里挑一张 */
      const frameSlot = (which, label, cur) => React.createElement("div", { className: "agn-frame" },
        React.createElement("div", { className: "agn-frame-cap" }, label),
        cur !== null
          ? React.createElement("div", { className: "agn-frame-box" },
              React.createElement("img", { src: cur.src, alt: label }),
              React.createElement("button", {
                type: "button", className: "agn-ref-del", title: "移除" + label,
                disabled: busy,
                onClick: () => store.clearFrame(which),
              }, "×"))
          : React.createElement("button", {
              type: "button", className: "agn-frame-add",
              disabled: busy || s.frameBusy,
              title: "从本地磁盘选择" + label + "图片（PNG / JPEG / WebP / GIF）",
              onClick: () => {
                store.pickFrame(which);
                const el = frameInput.current;
                if (el !== null) el.click();
              },
            }, "＋ 本地"),
        React.createElement("button", {
          type: "button", className: "agn-frame-from",
          disabled: busy || s.frameBusy || pickableImages.length === 0,
          title: pickableImages.length === 0
            ? "还没有生成过图片，先出一张图再来选"
            : "从生成结果里挑一张当" + label,
          onClick: () => store.toggleFramePick(which),
        }, s.framePickFrom === which ? "收起" : "＋ 结果"),
        s.framePickFrom === which
          ? React.createElement("div", { className: "agn-ref-pick agn-frame-pick" },
              pickableImages.map((h) => React.createElement("button", {
                key: h.filename, type: "button", title: h.filename,
                disabled: busy || s.frameBusy,
                onClick: () => store.setFrameFromResult(which, h),
              }, React.createElement("img", { src: srcOf(h.filename), alt: h.filename }))))
          : null
      );

      return React.createElement("div", { className: "agn-root" },
        /* 隐藏的文件选择器：由「＋ 本地图片」按钮触发，支持多选 */
        React.createElement("input", {
          ref: fileInput,
          type: "file",
          accept: "image/png,image/jpeg,image/webp,image/gif",
          multiple: true,
          style: { display: "none" },
          onChange: (e) => {
            const el = e.target;
            const files = el.files;
            // 关键：等文件真正读完再清空 input。
            // 之前是「发起读取后立刻 el.value = ''」，Chromium 下会把刚选的文件
            // 的底层数据一起释放，读取中途失败 → 这一次添加被整单丢掉。
            Promise.resolve(store.addRefsFromFiles(files))
              .catch(() => {})
              .finally(() => { try { el.value = ""; } catch { /* input 可能已卸载 */ } });
          },
        }),

        /* 隐藏的关键帧选择器：首帧 / 尾帧共用，靠 store.framePick 区分目标 */
        React.createElement("input", {
          ref: frameInput,
          type: "file",
          accept: "image/png,image/jpeg,image/webp,image/gif",
          style: { display: "none" },
          onChange: (e) => {
            const el = e.target;
            const file = el.files && el.files[0];
            const which = s.framePick === "last" ? "last" : "first";
            Promise.resolve(store.setFrameFromFile(which, file))
              .catch(() => {})
              .finally(() => { try { el.value = ""; } catch { /* input 可能已卸载 */ } });
          },
        }),

        /* 隐藏的视频参考图选择器（reference 模式，最多 5 张） */
        React.createElement("input", {
          ref: vRefInput,
          type: "file",
          accept: "image/png,image/jpeg,image/webp,image/gif",
          multiple: true,
          style: { display: "none" },
          onChange: (e) => {
            const el = e.target;
            const files = el.files;
            Promise.resolve(store.addVRefsFromFiles(files))
              .catch(() => {})
              .finally(() => { try { el.value = ""; } catch { /* input 可能已卸载 */ } });
          },
        }),

        React.createElement("div", { className: "agn-head" },
          React.createElement("span", { className: "agn-title" }, "Agnes 创作"),
          (() => {
            const kind = isVideo ? "video" : "image";
            const cur = isVideo
              ? (s.cfgDraft.videoModel || (s.health && s.health.videoModel) || "agnes-video-2.5-flash")
              : (s.cfgDraft.imageModel || (s.health && s.health.model) || "agnes-image-2.5-flash");
            /* 选项优先用连接测试拿到的上游真实清单，没有就退回内置清单 */
            const fromUp = s.upModels && Array.isArray(s.upModels[kind]) ? s.upModels[kind] : null;
            const fromHealth = s.health && s.health.models && Array.isArray(s.health.models[kind])
              ? s.health.models[kind]
              : [];
            let list = fromUp !== null && fromUp.length > 0 ? fromUp : fromHealth;
            if (list.length < 2) {
              /* 只有一个模型时给下拉没有意义，直接显示名字 */
              return React.createElement("span", { className: "agn-meta" }, cur);
            }
            list = list.slice();
            if (list.indexOf(cur) === -1) list.unshift(cur);
            return React.createElement("select", {
              className: "agn-model",
              value: cur,
              disabled: busy || s.cfgSaving,
              title: "切换" + (isVideo ? "视频" : "图片") + "模型（立刻保存到配置）",
              onChange: (e) => store.setModel(kind, e.target.value),
            }, list.map((m) => React.createElement("option", { key: m, value: m }, m)));
          })()
        ),

        React.createElement("div", { className: "agn-card" },
          React.createElement("div", { className: "agn-modes" },
            modeBtn("image", "图片"),
            modeBtn("video", "视频")
          ),

          /* ---- 视频关键帧（图生视频）：本地图片直接当首帧/尾帧，留空即纯文生视频 ---- */
          isVideo
            ? React.createElement("div", { className: "agn-frames" },
                React.createElement("div", { className: "agn-ref-head" },
                  React.createElement("span", { className: "agn-label" }, "关键帧"),
                  React.createElement("span", { className: "agn-hint" },
                    s.vFirst !== null || s.vLast !== null ? "图生视频" : "留空 = 纯文生视频"),
                  s.frameBusy ? React.createElement("span", { className: "agn-hint" }, "处理中…") : null
                ),
                React.createElement("div", { className: "agn-frames-row" },
                  frameSlot("first", "首帧", s.vFirst),
                  frameSlot("last", "尾帧", s.vLast)
                )
              )
            : null,

          /* ---- 参考图（图生图 / 多图合成）：本地文件 + 生成结果两种来源 ---- */
          !isVideo
            ? React.createElement("div", { className: "agn-refs" },
                React.createElement("div", { className: "agn-ref-head" },
                  React.createElement("span", { className: "agn-label" }, "参考图"),
                  React.createElement("span", { className: "agn-tag" },
                    s.refs.length + " / " + MAX_REFS),
                  s.refsBusy ? React.createElement("span", { className: "agn-hint" }, "处理中…") : null,
                  s.refs.length > 0
                    ? React.createElement("button", {
                        type: "button", className: "agn-btn-ghost", disabled: busy,
                        onClick: () => store.clearRefs(),
                      }, "清空参考图")
                    : null
                ),
                React.createElement("div", { className: "agn-ref-strip" },
                  s.refs.map((r) => React.createElement("div", {
                    key: r.id,
                    className: "agn-ref",
                    title: r.name + "  ·  " + (r.bytes / 1024).toFixed(0) + " KB  ·  " +
                      (r.from === "result" ? "来自生成结果" : "来自本地"),
                  },
                    React.createElement("img", { src: r.src, alt: r.name }),
                    React.createElement("button", {
                      type: "button", className: "agn-ref-del",
                      title: "移除这张参考图",
                      disabled: busy,
                      onClick: () => store.removeRef(r.id),
                    }, "×")
                  )),
                  React.createElement("button", {
                    type: "button", className: "agn-ref-add",
                    disabled: busy || refsFull,
                    title: "从本地磁盘选择一个或多个图片（PNG / JPEG / WebP / GIF）",
                    onClick: () => {
                      const el = fileInput.current;
                      if (el !== null) el.click();
                    },
                  }, "＋ 本地图片"),
                  React.createElement("button", {
                    type: "button", className: "agn-ref-add",
                    disabled: busy || refsFull || pickableImages.length === 0,
                    title: pickableImages.length === 0 ? "还没有生成过图片" : "从「生成结果」里挑一张",
                    onClick: () => store.toggleRefPick(),
                  }, "＋ 生成结果")
                ),

                /* 从生成结果挑图：只列图片（视频不能当参考图） */
                s.refPickOpen
                  ? React.createElement("div", { className: "agn-ref-pick" },
                      pickableImages.length === 0
                        ? React.createElement("span", { className: "agn-hint" }, "还没有生成过图片")
                        : pickableImages.map((h) => React.createElement("button", {
                            key: "pick-" + h.filename,
                            type: "button",
                            title: h.filename,
                            onClick: () => store.addRefFromResult(h),
                          }, React.createElement("img", {
                            src: srcOf(h.filename), alt: h.filename, loading: "lazy",
                          })))
                    )
                  : null,

                React.createElement("div", { className: "agn-note" },
                  hasRefs
                    ? "将按参考图重绘（" + s.refs.length + " 张" +
                      (s.refs.length > 1 ? "，多图合成" : "") + "）——提示词写「想怎么改」"
                    : "不加参考图 = 纯文生图；加 1 张 = 图生图；加多张 = 多图合成"),
                s.refsError !== "" ? React.createElement("div", { className: "agn-err" }, s.refsError) : null
              )
            : null,

          /* ---- 视频参考图（reference 模式，≤5 张）：给风格 / 主体参考，不是首帧 ---- */
          isVideo
            ? React.createElement("div", { className: "agn-refs" },
                React.createElement("div", { className: "agn-ref-head" },
                  React.createElement("span", { className: "agn-label" }, "参考图"),
                  React.createElement("span", { className: "agn-tag" },
                    s.vRefs.length + " / " + MAX_VREFS),
                  s.vRefsBusy ? React.createElement("span", { className: "agn-hint" }, "处理中…") : null,
                  s.vRefs.length > 0
                    ? React.createElement("button", {
                        type: "button", className: "agn-btn-ghost", disabled: busy,
                        onClick: () => store.clearVRefs(),
                      }, "清空参考图")
                    : null
                ),
                React.createElement("div", { className: "agn-ref-strip" },
                  s.vRefs.map((r) => React.createElement("div", {
                    key: r.id,
                    className: "agn-ref",
                    title: r.name + "  ·  " + (r.bytes / 1024).toFixed(0) + " KB  ·  " +
                      (r.from === "result" ? "来自生成结果" : "来自本地"),
                  },
                    React.createElement("img", { src: r.src, alt: r.name }),
                    React.createElement("button", {
                      type: "button", className: "agn-ref-del",
                      title: "移除这张参考图",
                      disabled: busy,
                      onClick: () => store.removeVRef(r.id),
                    }, "×")
                  )),
                  React.createElement("button", {
                    type: "button", className: "agn-ref-add",
                    disabled: busy || vRefsFull,
                    title: "从本地磁盘选择一个或多个图片（PNG / JPEG / WebP / GIF）",
                    onClick: () => {
                      const el = vRefInput.current;
                      if (el !== null) el.click();
                    },
                  }, "＋ 本地"),
                  React.createElement("button", {
                    type: "button", className: "agn-ref-add",
                    disabled: busy || vRefsFull || pickableImages.length === 0,
                    title: pickableImages.length === 0 ? "还没有生成过图片" : "从「生成结果」里挑一张",
                    onClick: () => store.toggleVRefPick(),
                  }, "＋ 结果")
                ),
                s.vRefPickOpen
                  ? React.createElement("div", { className: "agn-ref-pick" },
                      pickableImages.length === 0
                        ? React.createElement("span", { className: "agn-hint" }, "还没有生成过图片")
                        : pickableImages.map((h) => React.createElement("button", {
                            key: "vpick-" + h.filename,
                            type: "button",
                            title: h.filename,
                            onClick: () => store.addVRefFromResult(h),
                          }, React.createElement("img", {
                            src: srcOf(h.filename), alt: h.filename, loading: "lazy",
                          })))
                    )
                  : null,
                React.createElement("div", { className: "agn-note" },
                  s.vRefs.length > 0
                    ? (s.vFirst !== null || s.vLast !== null
                        ? "已给关键帧，本次按首尾帧生成，参考图不生效"
                        : "将按参考图生成（" + s.vRefs.length + " 张）——参考风格 / 主体 / 构图")
                    : "可选：给上游 1–5 张参考图；留空 = 纯文本生视频"),
                s.vRefsError !== "" ? React.createElement("div", { className: "agn-err" }, s.vRefsError) : null
              )
            : null,

          React.createElement("div", { className: "agn-label" }, "提示词"),
          React.createElement("div", { className: "agn-presets" },
            PROMPT_PRESETS.map((preset) => React.createElement("button", {
              key: preset.label,
              type: "button",
              className: "agn-preset",
              disabled: busy,
              title: "追加到提示词末尾：" + preset.text,
              onClick: () => store.set({
                prompt: s.prompt.trim() === ""
                  ? preset.text
                  : s.prompt.replace(/[\s，,；;。.]+$/, "") + "，" + preset.text,
              }),
            }, preset.label))
          ),
          React.createElement("textarea", {
            className: "agn-textarea",
            value: s.prompt,
            placeholder: isVideo
              ? "描述镜头与动作：主体 + 动作 + 镜头运动 + 光线氛围…\n（Cmd/Ctrl + Enter 生成）"
              : "描述你想要的画面：主体 + 场景 + 风格 + 光照 + 构图 + 质量…\n（Cmd/Ctrl + Enter 生成）",
            onChange: (e) => store.set({ prompt: e.target.value }),
            onKeyDown,
            disabled: busy,
          }),
          React.createElement("div", { className: "agn-row" },
            params,
            React.createElement("button", {
              className: "agn-btn", type: "button",
              disabled: busy || s.refsBusy || s.prompt.trim() === "" || keyBad,
              onClick: () => store.run(),
            }, buttonLabel),
            /* 视频是异步任务，等待可能很长：给出真正的「停止等待」而不是让用户干等 */
            busy
              ? React.createElement("button", {
                  className: "agn-btn-ghost", type: "button",
                  title: isVideo
                    ? "停止等待（服务端任务可能仍在跑，已生成的文件不会丢）"
                    : "放弃这次等待（请求已发出，结果可能仍会落盘）",
                  onClick: () => store.cancel(),
                }, "取消")
              : null
          ),

          /* 视频是异步任务：给出阶段与百分比，避免只看到一个跳动的秒数 */
          busy && isVideo
            ? React.createElement("div", null,
                React.createElement("div", { className: "agn-bar" },
                  React.createElement("div", {
                    className: "agn-bar-fill",
                    style: { width: Math.max(3, Math.min(100, s.vProgress)) + "%" },
                  })),
                React.createElement("div", { className: "agn-hint" },
                  (s.vStatus || "排队中…") + "　" + Math.max(0, Math.round(s.vProgress)) + "%"
                  + (s.videoId ? "　任务 " + String(s.videoId).slice(0, 18) : ""))
              )
            : null,

          keyBad
            ? React.createElement("div", { className: "agn-err" },
                "未找到 Key：" + (key.file || "") + " —— 把 Key 写进该文件后可立即使用")
            : null,
          s.error !== "" ? React.createElement("div", { className: "agn-err" }, s.error) : null,
          s.notice !== "" ? React.createElement("div", { className: "agn-notice" }, s.notice) : null,
          busy && !isVideo
            ? React.createElement("div", { className: "agn-hint" },
                "正在生成：可切到别的面板，回来仍会接着显示结果（请求不会中断）")
            : null
        ),

        /* ---- 结果区 ---- */
        React.createElement("div", { className: "agn-card" },
          React.createElement("div", { className: "agn-card-head" },
            React.createElement("div", { className: "agn-label" }, resultLabel),
            React.createElement("button", {
              type: "button",
              className: "agn-btn-ghost",
              title: "把输出目录里已有的图片 / 视频列出来，点一下就能显示在上方",
              onClick: () => store.toggleLibrary(),
            }, s.libraryOpen ? "收起目录" : "输出目录"),
            React.createElement("button", {
              type: "button",
              className: "agn-btn-ghost",
              disabled: busy || (s.result === null && s.history.length === 0),
              title: "清空界面上的生成结果显示（不会删除已保存到桌面的文件）",
              onClick: () => store.clear(),
            }, "清空")
          ),

          shown !== null
            ? React.createElement(MediaBox, { entry: shown, big: true, onCopyPrompt: (t) => store.copyPrompt(t) })
            : React.createElement("div", { className: "agn-shot" },
                React.createElement("div", { className: "agn-shot-msg" },
                  busy ? (isVideo ? "正在生成视频…" : "正在生成图片…")
                       : "输入提示词后点「生成」，结果会显示在这里")),

          shown !== null
            ? React.createElement("div", { className: "agn-hint" },
                React.createElement("span", null,
                  (shown.fromDisk ? "来自输出目录  ·  " : "")
                  + shown.filename + "  ·  " + (shown.bytes / 1024 / 1024 >= 1
                    ? (shown.bytes / 1024 / 1024).toFixed(2) + " MB"
                    : (shown.bytes / 1024).toFixed(0) + " KB")
                  + "  ·  " + shown.size + "/" + shown.ratio
                  + (shown.seconds ? "  ·  " + shown.seconds + " 秒" : "")
                  + (shown.mode === "keyframe" ? "  ·  图生视频" : "")
                  + (shown.mode === "reference" ? "  ·  参考生视频" : "")
                  + (shown.mode === "img2img" ? "  ·  图生图 " + (shown.refCount || 0) + " 张参考" : "")
                  + (shown.seed !== undefined && shown.seed !== null ? "  ·  seed " + shown.seed : "")
                  + "  ·  用时 " + (shown.elapsedSec || shown.wallSec) + "s"),
                React.createElement("br"),
                React.createElement("span", null, "已保存到 "),
                React.createElement("span", { className: "agn-code" }, shown.path || ""))
            : null,

          shown !== null
            ? React.createElement("div", { className: "agn-acts" },
                React.createElement("button", {
                  type: "button", className: "agn-act",
                  title: "把文件路径复制到剪贴板",
                  onClick: () => store.copyPath(),
                }, "复制路径"),
                React.createElement("button", {
                  type: "button", className: "agn-act",
                  title: "在访达中显示这个文件",
                  onClick: () => store.reveal(),
                }, "在访达中显示"),
                React.createElement("button", {
                  type: "button", className: "agn-act",
                  title: "另存一份到「下载」目录",
                  onClick: () => store.downloadResult(),
                }, "下载"),
                shown.kind === "image"
                  ? React.createElement("button", {
                      type: "button", className: "agn-act",
                      disabled: busy || s.frameBusy,
                      title: "把这张图设为视频首帧（切到视频模式即可看到）",
                      onClick: () => store.useResultAsFrame("first"),
                    }, "设为首帧")
                  : null,
                shown.kind === "image"
                  ? React.createElement("button", {
                      type: "button", className: "agn-act",
                      disabled: busy || s.frameBusy,
                      title: "把这张图设为视频尾帧（切到视频模式即可看到）",
                      onClick: () => store.useResultAsFrame("last"),
                    }, "设为尾帧")
                  : null)
            : null
        ),

        /* ---- 输出目录：把磁盘上已有的图 / 视频捞回来看 ---- */
        s.libraryOpen
          ? React.createElement("div", { className: "agn-card" },
              React.createElement("div", { className: "agn-card-head" },
                React.createElement("div", { className: "agn-label" }, "输出目录"),
                React.createElement("button", {
                  type: "button", className: "agn-btn-ghost",
                  disabled: s.libraryBusy,
                  title: "重新读一遍输出目录（新生成的文件会自动出现在这里）",
                  onClick: () => store.loadLibrary(),
                }, s.libraryBusy ? "读取中…" : "刷新")
              ),
              React.createElement("div", { className: "agn-hint" },
                "点缩略图会把它显示到上方结果区，并带上当初写进图片里的提示词"),
              React.createElement("div", { className: "agn-lib" },
                React.createElement("div", { className: "agn-lib-tabs" },
                  React.createElement("button", {
                    type: "button",
                    className: "agn-act" + (s.libraryTab === "image" ? " agn-act-on" : ""),
                    onClick: () => store.setLibraryTab("image"),
                  }, "图片 " + libraryImages.length),
                  React.createElement("button", {
                    type: "button",
                    className: "agn-act" + (s.libraryTab === "video" ? " agn-act-on" : ""),
                    onClick: () => store.setLibraryTab("video"),
                  }, "视频 " + libraryVideos.length)
                ),
                s.libraryError !== ""
                  ? React.createElement("div", { className: "agn-err" }, s.libraryError)
                  : null,
                libraryShown.length === 0
                  ? React.createElement("div", { className: "agn-lib-empty" },
                      s.libraryBusy
                        ? "正在读取输出目录…"
                        : "这个目录里还没有" + (s.libraryTab === "video" ? "视频" : "图片"))
                  : React.createElement("div", { className: "agn-lib-grid" },
                      libraryShown.map((f) => React.createElement("button", {
                        key: f.name,
                        type: "button",
                        className: "agn-lib-item" + (shown && shown.filename === f.name ? " agn-thumb-on" : ""),
                        title: (f.prompt ? f.prompt + "\n" : "") + f.name,
                        disabled: busy,
                        onClick: () => store.showLibraryFile(f),
                      },
                        f.kind === "video"
                          ? videoThumb(f.name)
                          : React.createElement("img", { src: srcOf(f.name), alt: f.name, loading: "lazy" }),
                        f.kind === "video"
                          ? React.createElement("div", { className: "agn-thumb-play" }, "▶")
                          : null,
                        f.kind === "video"
                          ? React.createElement("span", { className: "agn-lib-badge" }, "视频")
                          : null
                      ))
                    )
              )
            )
          : null,

        /* ---- 历史 ---- */
        s.history.length > 1
          ? React.createElement("div", { className: "agn-card agn-hist" },
              React.createElement("div", { className: "agn-label" }, "最近生成"),
              React.createElement("div", { className: "agn-hist-strip" },
                s.history.map((h, i) => React.createElement("button", {
                  key: h.filename + "-" + i,
                  type: "button",
                  className: "agn-thumb" + (shown && shown.filename === h.filename ? " agn-thumb-on" : ""),
                  title: h.filename,
                  onClick: () => store.show(h),
                },
                  h.kind === "video"
                    ? videoThumb(h.filename)
                    : React.createElement("img", { src: srcOf(h.filename), alt: h.filename, loading: "lazy" }),
                  h.kind === "video"
                    ? React.createElement("div", { className: "agn-thumb-play" }, "▶")
                    : null,
                  React.createElement("span", { className: "agn-thumb-cap" },
                    h.kind === "video"
                      ? (h.seconds ? h.seconds + "s" : "视频")
                      : (h.bytes / 1024).toFixed(0) + "KB")
                ))
              )
            )
          : null,

        /* ---- 设置：Key 文件路径 / 输出目录 ---- */
        React.createElement("div", { className: "agn-card" },
          React.createElement("div", { className: "agn-card-head" },
            React.createElement("div", { className: "agn-label" }, "设置"),
            React.createElement("button", {
              type: "button", className: "agn-btn-ghost", disabled: s.cfgSaving,
              onClick: () => store.toggleCfg(),
            }, s.cfgOpen ? "收起" : "展开")
          ),

          s.cfgOpen
            ? React.createElement("div", { className: "agn-field" },
                React.createElement("div", { className: "agn-label" }, "Key 文件路径"),
                React.createElement("input", {
                  className: "agn-input", type: "text", spellCheck: false,
                  value: s.cfgDraft.keyFile,
                  placeholder: s.cfgDefaults ? s.cfgDefaults.keyFile : "~/.agnes-key.txt",
                  disabled: s.cfgSaving,
                  onChange: (e) => store.setCfgDraft("keyFile", e.target.value),
                }),
                React.createElement("div", { className: "agn-note" },
                  "只放 key 本身，别带 Bearer 前缀。留空 = 默认 ",
                  s.cfgDefaults ? s.cfgDefaults.keyFile : "~/.agnes-key.txt")
              )
            : null,

          s.cfgOpen
            ? React.createElement("div", { className: "agn-field" },
                React.createElement("div", { className: "agn-label" }, "输出目录"),
                React.createElement("input", {
                  className: "agn-input", type: "text", spellCheck: false,
                  value: s.cfgDraft.outDir,
                  placeholder: s.cfgDefaults ? s.cfgDefaults.outDir : "~/Desktop/Agnes出图",
                  disabled: s.cfgSaving,
                  onChange: (e) => store.setCfgDraft("outDir", e.target.value),
                }),
                React.createElement("div", { className: "agn-note" },
                  "图片和视频都存这里，目录不存在会自动创建。留空 = 默认 ",
                  s.cfgDefaults ? s.cfgDefaults.outDir : "~/Desktop/Agnes出图")
              )
            : null,

          s.cfgOpen
            ? React.createElement("div", { className: "agn-field" },
                React.createElement("div", { className: "agn-label" }, "图片模型"),
                React.createElement("select", {
                  className: "agn-input", value: s.cfgDraft.imageModel, disabled: s.cfgSaving,
                  onChange: (e) => store.setCfgDraft("imageModel", e.target.value),
                },
                  React.createElement("option", { value: "" }, "默认（" + ((s.health && s.health.model) || "agnes-image-2.5-flash") + "）"),
                  ((s.health && s.health.models && s.health.models.image) || []).map((m) =>
                    React.createElement("option", { key: m, value: m }, m))
                ),
                React.createElement("div", { className: "agn-note" }, "只列出当前上游真实存在的图片模型")
              )
            : null,

          s.cfgOpen
            ? React.createElement("div", { className: "agn-field" },
                React.createElement("div", { className: "agn-label" }, "视频模型"),
                React.createElement("select", {
                  className: "agn-input", value: s.cfgDraft.videoModel, disabled: s.cfgSaving,
                  onChange: (e) => store.setCfgDraft("videoModel", e.target.value),
                },
                  React.createElement("option", { value: "" }, "默认（" + ((s.health && s.health.videoModel) || "agnes-video-2.5-flash") + "）"),
                  ((s.health && s.health.models && s.health.models.video) || []).map((m) =>
                    React.createElement("option", { key: m, value: m }, m))
                ),
                React.createElement("div", { className: "agn-note" }, "换模型后新提交的任务才会用新模型")
              )
            : null,

          s.cfgOpen
            ? React.createElement("div", { className: "agn-field" },
                React.createElement("button", {
                  type: "button", className: "agn-btn-ghost", disabled: s.checking,
                  title: "用当前 Key 请求一次上游模型清单，确认 Key 能用、网络通",
                  onClick: () => store.checkKey(),
                }, s.checking ? "连接中…" : "测试连接"),
                s.checkResult !== null
                  ? React.createElement("div", {
                      // 别给 style 传字符串：React 会抛错并卸载整块面板（白屏）
                      className: (s.checkResult.ok ? "agn-okline" : "agn-err") + " agn-check",
                    }, s.checkResult.text)
                  : null
              )
            : null,

          s.cfgOpen
            ? React.createElement("div", { className: "agn-row" },
                React.createElement("button", {
                  type: "button", className: "agn-btn", disabled: s.cfgSaving,
                  onClick: () => store.saveConfig(),
                }, s.cfgSaving ? "保存中…" : "保存"),
                React.createElement("button", {
                  type: "button", className: "agn-btn-ghost", disabled: s.cfgSaving,
                  title: "把两个输入框清空，保存后即回退到默认路径",
                  onClick: () => {
                    store.setCfgDraft("keyFile", "");
                    store.setCfgDraft("outDir", "");
                  },
                }, "填回默认"),
                s.cfgNotice !== "" ? React.createElement("span", { className: "agn-okline" }, s.cfgNotice) : null
              )
            : null,

          s.cfgError !== "" ? React.createElement("div", { className: "agn-err" }, s.cfgError) : null,

          s.cfgOpen
            ? React.createElement("div", { className: "agn-note" },
                "保存到 ",
                (s.health && s.health.configFile) || "~/.dsh/agnes-create/config.json")
            : null
        ),

        React.createElement("div", { className: "agn-hint" },
          s.health === null
            ? "正在读取插件状态…"
            : s.health.ok
              ? React.createElement("span", null,
                  "输出目录 ",
                  React.createElement("span", { className: "agn-code" }, s.health.outDir || ""),
                  "　Key：",
                  React.createElement("span", { className: "agn-code" },
                    key && key.present ? key.masked : "未就绪"))
              : "插件宿主半未就绪：" + (s.health.error || "未知错误")
        )
      );
    }

    /* ---------- 注册 ---------- */
    function apply(ctx) {
      ensureCss();

      const slots = ctx.get("slots");
      if (slots === undefined) return;

      slots.inject("main", () => slots.register(
        { name: "main", key: ID },
        () => React.createElement(Panel)
      ));

      slots.inject("sidebar.panellist", () => slots.register(
        { name: "sidebar.panellist", id: ID, order: 25, label: () => "Agnes创作" },
        (props) => React.createElement(Glyph, props)
      ));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.__internals = { pickableImagesOf, getStore, createStore, srcOf, shrinkImage, MAX_REFS };
    return module.exports;
  },
});
