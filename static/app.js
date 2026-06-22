/* gpt-image-2 工作室 — 前端逻辑 */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const MAX_REFS = 4;

  // Build a same-origin API URL from location.origin (which never carries
  // userinfo). The page may be opened via a credentialed URL
  // (https://user:pass@host) behind a basic-auth tunnel; relative fetch()
  // would then inherit those credentials and the Fetch API throws
  // "Request cannot be constructed from a URL that includes credentials".
  // Cached basic-auth is still applied to the credential-free same-origin URL.
  const apiUrl = (path) => location.origin + path;

  const ratioToCss = (val) => {
    const v = (val || "").trim();
    if (!v || v === "auto") return "1 / 1";
    let m = /^(\d{2,5})x(\d{2,5})$/.exec(v); // pixels, e.g. 1280x720
    if (m) return `${m[1]} / ${m[2]}`;
    m = /^(\d{1,4}):(\d{1,4})$/.exec(v); // ratio, e.g. 16:9
    if (m) return `${m[1]} / ${m[2]}`;
    return "1 / 1";
  };

  const form = $("#genForm");
  const promptEl = $("#prompt");
  const promptCount = $("#promptCount");
  const canvas = $("#canvas");
  const generateBtn = $("#generateBtn");
  const panelNote = $("#panelNote");

  const progress = $("#progress");
  const progressFill = $("#progressFill");
  const progressStatus = $("#progressStatus");
  const progressPct = $("#progressPct");

  const resultImg = $("#resultImg");
  const resultPrompt = $("#resultPrompt");
  const downloadBtn = $("#downloadBtn");
  const openBtn = $("#openBtn");
  const useRefBtn = $("#useRefBtn");
  const errorText = $("#errorText");
  const retryBtn = $("#retryBtn");

  const refToggle = $("#refToggle");
  const refPanel = $("#refPanel");
  const refRows = $("#refRows");
  const refAdd = $("#refAdd");
  const dropzone = $("#dropzone");
  const fileInput = $("#fileInput");
  const thumbs = $("#thumbs");

  let lastPayload = null;
  let inFlight = false;

  /* ---------- 滚动渐入 ---------- */
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("is-visible");
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 },
  );
  $$("[data-reveal]").forEach((el) => io.observe(el));

  /* ---------- 提示词字数 ---------- */
  const updateCount = () => {
    promptCount.textContent = String(promptEl.value.length);
  };
  promptEl.addEventListener("input", updateCount);
  updateCount();

  /* ---------- 模型选择 ---------- */
  const panelModel = $("#panelModel");
  const activeModel = () => {
    const el = form.querySelector('input[name="model"]:checked');
    return el ? el.value : "gpt-image-2";
  };
  const syncPanelModel = () => {
    if (panelModel) panelModel.textContent = "模型 · " + activeModel();
  };
  $$('input[name="model"]').forEach((r) => r.addEventListener("change", syncPanelModel));
  syncPanelModel();

  // gpt-image-2-vip 不支持比例字符串，只接受像素值；按官方分辨率表取 1K 档。
  const VIP_RATIO_TO_PX = {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "5:4": "1120x896",
    "4:5": "896x1120",
    "16:9": "1280x720",
    "9:16": "720x1280",
    "21:9": "1456x624",
    "auto": "auto",
  };
  const sizeForModel = (model, ratio) => {
    if (model !== "gpt-image-2-vip") return ratio;
    if (/^\d{2,5}x\d{2,5}$/.test(ratio)) return ratio;
    return VIP_RATIO_TO_PX[ratio] || "1024x1024";
  };

  /* ---------- 尺寸 -> 画布比例 ---------- */
  const activeRatio = () => form.querySelector('input[name="ratio"]:checked').value;
  const syncCanvasRatio = () => {
    canvas.style.setProperty("--canvas-ratio", ratioToCss(activeRatio()));
  };
  $$('input[name="ratio"]').forEach((r) => r.addEventListener("change", syncCanvasRatio));
  syncCanvasRatio();

  /* ---------- 折叠面板 ---------- */
  const toggleDisclosure = (toggle, panel, onOpen) => {
    toggle.addEventListener("click", () => {
      const willOpen = panel.hasAttribute("hidden");
      if (willOpen) {
        panel.removeAttribute("hidden");
        toggle.setAttribute("aria-expanded", "true");
        if (onOpen) onOpen();
      } else {
        panel.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  };

  /* ---------- 参考图 ---------- */
  // Uploaded reference images: [{ url, name }]. Combined with pasted URL rows.
  const uploads = [];

  const refValues = () =>
    $$(".ref__row input", refRows)
      .map((i) => i.value.trim())
      .filter(Boolean);

  // All reference URLs sent to the API: uploads first, then pasted links.
  const gatherRefs = () =>
    [...uploads.map((u) => u.url), ...refValues()].slice(0, MAX_REFS);

  const refCount = () => uploads.length + $$(".ref__row", refRows).length;

  const syncRefAdd = () => {
    const full = refCount() >= MAX_REFS;
    refAdd.disabled = full;
    if (dropzone) dropzone.classList.toggle("is-full", full);
  };

  const renderThumbs = () => {
    thumbs.innerHTML = "";
    if (uploads.length === 0) {
      thumbs.hidden = true;
      syncRefAdd();
      return;
    }
    thumbs.hidden = false;
    uploads.forEach((u, idx) => {
      const fig = document.createElement("figure");
      fig.className = "thumb";
      const img = document.createElement("img");
      img.src = u.path || u.url;
      img.alt = u.name || "参考图";
      img.loading = "lazy";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "thumb__remove";
      remove.setAttribute("aria-label", "移除这张参考图");
      remove.textContent = "\u00d7";
      remove.addEventListener("click", () => {
        uploads.splice(idx, 1);
        renderThumbs();
      });
      fig.append(img, remove);
      thumbs.append(fig);
    });
    syncRefAdd();
  };

  const setDropMsg = (msg) => {
    const title = $(".drop__title", dropzone);
    if (title) title.textContent = msg;
  };

  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    dropzone.classList.add("is-uploading");
    const defaultMsg = "点击上传，或将图片拖拽到此处";
    try {
      for (const file of files) {
        if (refCount() >= MAX_REFS) {
          setDropMsg("最多只能添加 4 张参考图");
          break;
        }
        if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
          setDropMsg("仅支持 JPG / PNG / WEBP 格式");
          continue;
        }
        setDropMsg("上传中… " + file.name);
        const fd = new FormData();
        fd.append("file", file);
        let data;
        try {
          const r = await fetch(apiUrl("/api/upload"), { method: "POST", body: fd });
          data = await r.json().catch(() => ({}));
          if (!r.ok) {
            setDropMsg(data.detail || "上传失败，请重试");
            continue;
          }
        } catch {
          setDropMsg("上传失败，请检查网络后重试");
          continue;
        }
        if (data && data.url) {
          uploads.push({
            url: data.url,
            path: data.path || data.url,
            name: data.name || file.name,
          });
          renderThumbs();
        }
      }
    } finally {
      dropzone.classList.remove("is-uploading");
      setTimeout(() => setDropMsg(defaultMsg), 1600);
    }
  };

  if (dropzone && fileInput) {
    dropzone.addEventListener("click", () => {
      if (refCount() < MAX_REFS) fileInput.click();
    });
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (refCount() < MAX_REFS) fileInput.click();
      }
    });
    fileInput.addEventListener("change", () => {
      uploadFiles(fileInput.files);
      fileInput.value = "";
    });
    ["dragenter", "dragover"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("is-drag");
      }),
    );
    ["dragleave", "dragend"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("is-drag");
      }),
    );
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-drag");
      if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
    });
  }

  const addRefRow = (value = "") => {
    if (refCount() >= MAX_REFS) return;
    const row = document.createElement("div");
    row.className = "ref__row";
    const input = document.createElement("input");
    input.type = "url";
    input.placeholder = "https://example.com/image.png";
    input.value = value;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ref__remove";
    remove.setAttribute("aria-label", "移除参考图");
    remove.textContent = "\u00d7";
    remove.addEventListener("click", () => {
      row.remove();
      syncRefAdd();
    });
    row.append(input, remove);
    refRows.append(row);
    syncRefAdd();
    return input;
  };

  toggleDisclosure(refToggle, refPanel);
  refAdd.addEventListener("click", () => {
    const input = addRefRow();
    if (input) input.focus();
  });

  const openRefWith = (url) => {
    refPanel.removeAttribute("hidden");
    refToggle.setAttribute("aria-expanded", "true");
    if (refCount() >= MAX_REFS) return;
    const empty = $$(".ref__row input", refRows).find((i) => !i.value.trim());
    if (empty) empty.value = url;
    else addRefRow(url);
    syncRefAdd();
  };

  /* ---------- 画布状态 ---------- */
  const setState = (state) => {
    canvas.dataset.state = state;
  };
  const setIndeterminate = (on) => {
    progress.classList.toggle("is-indeterminate", on);
  };
  const setProgress = (pct, statusWord) => {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    progressFill.style.width = clamped + "%";
    progressPct.textContent = clamped + "%";
    if (statusWord) progressStatus.textContent = statusWord;
  };

  const showError = (msg) => {
    errorText.textContent = msg || "出了点问题，请重试。";
    setState("error");
    setBusy(false);
  };

  const setBusy = (busy) => {
    inFlight = busy;
    generateBtn.classList.toggle("is-busy", busy);
    generateBtn.disabled = busy;
    generateBtn.innerHTML = busy
      ? '<span class="spinner"></span><span class="btn__label">生成中</span>'
      : '<span class="btn__label">生成图像</span>';
  };

  /* ---------- 结果图片（带传播重试） ---------- */
  const showResult = (url, promptText) => {
    let attempts = 0;
    setIndeterminate(false);
    setProgress(100, "收尾中");
    resultImg.onerror = () => {
      if (attempts++ < 6) {
        setTimeout(() => {
          resultImg.src = url + (url.includes("?") ? "&" : "?") + "r=" + Date.now();
        }, 1400);
      } else {
        showError("图像已生成，但暂时无法加载，可点击下方「打开原图」直接查看。");
        openBtn.href = url;
      }
    };
    resultImg.onload = () => setState("result");
    resultImg.src = url;
    resultImg.alt = promptText ? "生成的图像：" + promptText : "生成的图像";
    resultPrompt.textContent = promptText;
    openBtn.href = url;
    downloadBtn.dataset.url = url;
  };

  /* ---------- 下载 ---------- */
  downloadBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    const url = downloadBtn.dataset.url;
    if (!url) return;
    try {
      const r = await fetch(url);
      const blob = await r.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = "gpt-image-2.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(obj);
    } catch {
      window.open(url, "_blank");
    }
  });
  useRefBtn.addEventListener("click", () => {
    const url = downloadBtn.dataset.url;
    if (url) openRefWith(url);
  });
  retryBtn.addEventListener("click", () => {
    if (lastPayload) runGeneration(lastPayload);
  });

  /* ---------- SSE 事件处理 ---------- */
  const handleEvent = (raw) => {
    const dataLines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;
    const text = dataLines.join("");
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      return;
    }
    const status = d.status || "running";
    if (status === "failed") {
      showError(d.failure_reason || d.error || d.detail || "生成失败，请重试。");
      return;
    }
    if (typeof d.progress === "number") {
      setIndeterminate(false);
      setProgress(d.progress, status === "succeeded" ? "收尾中" : "生成中");
    }
    if (status === "succeeded") {
      const url = d.results && d.results[0] && d.results[0].url;
      if (url) showResult(url, lastPayload ? lastPayload.prompt : "");
      else showError("模型返回成功，但没有给出图像。");
    }
  };

  const runGeneration = async (payload) => {
    if (inFlight) return;
    lastPayload = payload;
    panelNote.hidden = true;
    setBusy(true);
    canvas.style.setProperty("--canvas-ratio", ratioToCss(payload.aspectRatio));
    setIndeterminate(false);
    setProgress(0, "准备中");
    setState("loading");

    let res;
    try {
      res = await fetch(apiUrl("/api/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      showError("无法连接到服务器，请检查网络后重试。");
      return;
    }
    if (!res.ok || !res.body) {
      showError("服务器拒绝了请求（HTTP " + res.status + "）。");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawSuccess = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.trim()) {
            if (chunk.includes('"succeeded"')) sawSuccess = true;
            handleEvent(chunk);
          }
        }
      }
      if (buf.trim()) {
        if (buf.includes('"succeeded"')) sawSuccess = true;
        handleEvent(buf);
      }
    } catch {
      if (!sawSuccess) showError("渲染过程中连接中断，请重试。");
    } finally {
      setBusy(false);
      setIndeterminate(false);
      if (!sawSuccess && canvas.dataset.state === "loading") {
        showError("数据流在产出图像前结束了，请重试。");
      }
    }
  };

  /* ---------- 提交 ---------- */
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const prompt = promptEl.value.trim();
    if (!prompt) {
      promptEl.focus();
      return;
    }
    const model = activeModel();
    const payload = {
      prompt,
      model,
      aspectRatio: sizeForModel(model, activeRatio()),
      urls: gatherRefs(),
    };
    runGeneration(payload);
  });

  /* ---------- 示例卡片 ---------- */
  $$(".sample").forEach((btn) => {
    btn.addEventListener("click", () => {
      promptEl.value = btn.dataset.prompt || "";
      updateCount();
      const ratio = btn.dataset.ratio;
      const target = form.querySelector(`input[name="ratio"][value="${ratio}"]`);
      if (target) {
        target.checked = true;
        syncCanvasRatio();
      }
      document.getElementById("studio").scrollIntoView({ behavior: "smooth", block: "start" });
      promptEl.focus({ preventScroll: true });
    });
  });

  /* ---------- 服务状态 ---------- */
  (async () => {
    const pill = $("#statusPill");
    const txt = $("#statusText");
    try {
      const r = await fetch(apiUrl("/api/config"));
      const cfg = await r.json();
      if (cfg.apiKeyConfigured) {
        pill.classList.add("is-ok");
        txt.textContent = "在线";
      } else {
        pill.classList.add("is-down");
        txt.textContent = "未配置密钥";
        panelNote.hidden = false;
        panelNote.textContent = "注意：服务端尚未配置 GRSAI_API_KEY，生成会失败，请先设置密钥。";
      }
    } catch {
      pill.classList.add("is-down");
      txt.textContent = "离线";
    }
  })();
})();
