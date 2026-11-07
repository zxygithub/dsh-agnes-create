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
    const HISTORY_MAX = 8;
    const POLL_MS = 6000;
    const VIDEO_DEADLINE_MS = 15 * 60 * 1000;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ---------- 样式 ---------- */
    const CSS = `
      .agn-root { display: flex; flex-direction: column; gap: 12px; padding: 20px 24px; height: 100%;
                  box-sizing: border-box; overflow: auto; font-size: 13px; }
      .agn-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
      .agn-title { font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
      .agn-meta { font-size: 12px; color: var(--dsw-alias-label-secondary, #888); }
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
      .agn-shot { border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, #e3e3e3);
                  background: var(--dsw-alias-bg-layer-2, #fafafa); overflow: hidden;
                  display: flex; align-items: center; justify-content: center; min-height: 120px; }
      .agn-shot img, .agn-shot video { display: block; max-width: 100%; height: auto; }
      .agn-shot-big { max-height: 62vh; }
      .agn-shot-big img, .agn-shot-big video { max-height: 62vh; object-fit: contain; }
      .agn-shot-msg { padding: 18px; font-size: 12px; text-align: center; line-height: 1.7;
                      color: var(--dsw-alias-label-secondary, #888); }

      /* 历史缩略图 */
      .agn-hist { display: flex; flex-direction: column; gap: 6px; }
      .agn-hist-strip { display: flex; gap: 8px; flex-wrap: wrap; }
      .agn-thumb { position: relative; width: 84px; height: 84px; border-radius: 8px; padding: 0;
                   overflow: hidden; cursor: pointer; flex: none;
                   border: 2px solid var(--dsw-alias-border-l2, #e3e3e3);
                   background: var(--dsw-alias-bg-layer-2, #fafafa); }
      .agn-thumb-on { border-color: var(--dsw-alias-state-business-primary, #4b7bec); }
      .agn-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .agn-thumb-play { position: absolute; inset: 0; display: flex; align-items: center;
                        justify-content: center; font-size: 22px; line-height: 1;
                        color: #fff; background: rgba(0, 0, 0, .3); }
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
        health: null,
        healthRequested: false,

        /* ---- 可配置项：Key 文件路径 / 输出目录 ---- */
        cfg: null,              // 生效配置 { keyFile, outDir }
        cfgDefaults: null,
        cfgStored: null,
        cfgDraft: { keyFile: "", outDir: "" },
        cfgOpen: false,
        cfgSaving: false,
        cfgError: "",
        cfgNotice: "",
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
        set({ result: entry, history: [entry, ...state.history].slice(0, HISTORY_MAX) });
      };

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
            cfgDraft: { keyFile: data.config.keyFile, outDir: data.config.outDir },
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
            }),
          });
          if (res.status === 404) throw new Error("配置接口尚未就绪：需要完全重启应用（只重载窗口不够）");
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || "保存失败");
          set({
            cfg: data.config,
            cfgDefaults: data.defaults,
            cfgStored: data.stored,
            cfgDraft: { keyFile: data.config.keyFile, outDir: data.config.outDir },
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

      /* ---------- 图片：一次请求就出结果 ---------- */
      async function runImage(token, prompt) {
        const res = await fetch("/agnes/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt, size: state.size, ratio: state.ratio }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "生成失败");
        if (token !== runToken) return;
        pushResult({ ...data, kind: "image", wallSec: ((Date.now() - state.startedAt) / 1000).toFixed(1) });
      }

      /* ---------- 视频：提交 → 轮询 → 下载完成 ---------- */
      async function runVideo(token, prompt) {
        set({ vStatus: "提交中…", vProgress: 0, videoId: null });

        const subRes = await fetch("/agnes/video", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt, seconds: state.vSeconds, ratio: state.vRatio }),
        });
        const sub = await subRes.json();
        if (!sub.ok) throw new Error(sub.error || "提交失败");
        if (token !== runToken) return;

        set({ videoId: sub.videoId, vStatus: "排队中…" });
        const deadline = Date.now() + VIDEO_DEADLINE_MS;

        let transientFails = 0;
        for (;;) {
          await sleep(POLL_MS);
          if (token !== runToken) return;

          let st;
          try {
            const r = await fetch("/agnes/video?id=" + encodeURIComponent(sub.videoId));
            st = await r.json();
          } catch (e) {
            st = { ok: false, error: "网络错误：" + (e && e.message ? e.message : String(e)) };
          }

          if (!st.ok) {
            const msg = String(st.error || "查询任务失败");
            // 429/503 只是限流，任务还在服务端跑：退避后继续，别把整个任务判死。
            // 实测提交后立刻查询就会 429，这条路径是必需的。
            if (/\b429\b|\b503\b|频繁|队列已满|网络错误|timeout/i.test(msg)) {
              transientFails += 1;
              if (transientFails > 8) throw new Error(msg);
              set({ vStatus: "限流重试中…" });
              await sleep(Math.min(30000, 6000 * transientFails));
              continue;
            }
            throw new Error(msg);
          }

          transientFails = 0;
          if (token !== runToken) return;

          set({
            vStatus: st.status,
            vProgress: typeof st.progress === "number" ? st.progress : 0,
          });

          if (st.status === "completed") {
            pushResult({
              kind: "video",
              filename: st.filename,
              path: st.path,
              bytes: st.bytes,
              size: "720P",
              ratio: state.vRatio,
              seconds: st.seconds || state.vSeconds,
              transport: "异步任务",
              wallSec: ((Date.now() - state.startedAt) / 1000).toFixed(1),
            });
            return;
          }
          if (st.status === "failed") {
            const err = st.error;
            throw new Error(typeof err === "string" ? err : (err && err.message) || "视频生成失败");
          }
          if (Date.now() > deadline) throw new Error("等待超时（15 分钟）");
        }
      }

      async function run() {
        if (state.busy) return;
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
        saveConfig,
        setCfgDraft(field, value) {
          set({ cfgDraft: { ...state.cfgDraft, [field]: value }, cfgNotice: "" });
        },
        toggleCfg() { set({ cfgOpen: !state.cfgOpen }); },
        run,
        /** 切换主预览到历史里的某一张 */
        show(entry) { set({ result: entry }); },
        /**
         * 清空界面上的生成结果。只清显示状态：不删磁盘文件、不动提示词和参数。
         * 进行中的请求不清（否则结果回来又会写一遍，反而更乱）。
         */
        clear() {
          if (state.busy) return;
          set({ result: null, history: [], error: "" });
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
    function MediaBox({ entry, big }) {
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

      return React.createElement("div", { className: "agn-shot" + (big ? " agn-shot-big" : "") },
        isVideo
          ? React.createElement("video", {
              src,
              controls: true,
              playsInline: true,
              preload: "metadata",
              onError: () => setFailed(true),
            })
          : React.createElement("img", { src, alt: "生成结果", onError })
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

      React.useEffect(() => { store.loadHealth(); store.loadConfig(); }, []);

      const busy = s.busy;
      const isVideo = s.mode === "video";
      const key = s.health && s.health.key ? s.health.key : null;
      const keyBad = key !== null && key.present !== true;
      const shown = s.result;

      const onKeyDown = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); store.run(); }
      };

      const buttonLabel = busy
        ? (isVideo ? "生成视频… " : "生成中… ") + (s.elapsed > 0 ? s.elapsed.toFixed(0) + "s" : "")
        : (isVideo ? "生成视频" : "生成");

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

      return React.createElement("div", { className: "agn-root" },
        React.createElement("div", { className: "agn-head" },
          React.createElement("span", { className: "agn-title" }, "Agnes 创作"),
          React.createElement("span", { className: "agn-meta" },
            isVideo
              ? (s.health && s.health.videoModel ? s.health.videoModel : "agnes-video-2.5-flash")
              : (s.health && s.health.model ? s.health.model : "agnes-image-2.5-flash"))
        ),

        React.createElement("div", { className: "agn-card" },
          React.createElement("div", { className: "agn-modes" },
            modeBtn("image", "图片"),
            modeBtn("video", "视频")
          ),
          React.createElement("div", { className: "agn-label" }, "提示词"),
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
              disabled: busy || s.prompt.trim() === "" || keyBad,
              onClick: () => store.run(),
            }, buttonLabel)
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
              disabled: busy || (s.result === null && s.history.length === 0),
              title: "清空界面上的生成结果显示（不会删除已保存到桌面的文件）",
              onClick: () => store.clear(),
            }, "清空")
          ),

          shown !== null
            ? React.createElement(MediaBox, { entry: shown, big: true })
            : React.createElement("div", { className: "agn-shot" },
                React.createElement("div", { className: "agn-shot-msg" },
                  busy ? (isVideo ? "正在生成视频…" : "正在生成图片…")
                       : "输入提示词后点「生成」，结果会显示在这里")),

          shown !== null
            ? React.createElement("div", { className: "agn-hint" },
                React.createElement("span", null,
                  shown.filename + "  ·  " + (shown.bytes / 1024 / 1024 >= 1
                    ? (shown.bytes / 1024 / 1024).toFixed(2) + " MB"
                    : (shown.bytes / 1024).toFixed(0) + " KB")
                  + "  ·  " + shown.size + "/" + shown.ratio
                  + (shown.seconds ? "  ·  " + shown.seconds + " 秒" : "")
                  + "  ·  用时 " + shown.elapsedSec + "s"),
                React.createElement("br"),
                React.createElement("span", null, "已保存到 "),
                React.createElement("span", { className: "agn-code" }, shown.path || ""))
            : null
        ),

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
                    ? React.createElement("div", { className: "agn-thumb-play" }, "▶")
                    : React.createElement("img", { src: srcOf(h.filename), alt: h.filename, loading: "lazy" }),
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
                (s.health && s.health.configFile) || "~/.dsh/agnes-image/config.json")
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
    exports.__internals = { getStore, createStore, srcOf };
    return module.exports;
  },
});
