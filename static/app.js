/* gpt-image-2 工作室 — 前端逻辑 */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const RATIO_TO_CSS = {
    "1024x1024": "1 / 1",
    "1536x1024": "3 / 2",
    "1024x1536": "2 / 3",
    auto: "1 / 1",
  };
  const MAX_REFS = 4;

  const ratioToCss = (val) => {
    if (RATIO_TO_CSS[val]) return RATIO_TO_CSS[val];
    const m = /^(\d{2,5})x(\d{2,5})$/.exec((val || "").trim());
    if (m) return `${m[1]} / ${m[2]}`;
    return "1 / 1";
  };

  const form = $("#genForm");
  const promptEl = $("#prompt");
  const promptCount = $("#promptCount");
  const canvas = $("#canvas");
  const generateBtn = $("#generateBtn");
  const panelNote = $("#panelNote");
  const panelModel = $("#panelModel");

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

  const advToggle = $("#advToggle");
  const advPanel = $("#advPanel");
  const modelInput = $("#modelInput");
  const customSize = $("#customSize");
  const webhookInput = $("#webhookInput");
  const shutProgressEl = $("#shutProgress");

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

  /* ---------- 尺寸 -> 画布比例 ---------- */
  const checkedRatio = () => form.querySelector('input[name="ratio"]:checked').value;
  const activeRatio = () => (customSize && customSize.value.trim()) || checkedRatio();
  const syncCanvasRatio = () => {
    canvas.style.setProperty("--canvas-ratio", ratioToCss(activeRatio()));
  };
  $$('input[name="ratio"]').forEach((r) => r.addEventListener("change", syncCanvasRatio));
  syncCanvasRatio();

  /* ---------- 高级参数 ---------- */
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
  toggleDisclosure(advToggle, advPanel);

  if (modelInput) {
    modelInput.addEventListener("input", () => {
      const name = modelInput.value.trim() || "gpt-image-2";
      panelModel.textContent = "模型 · " + name;
    });
  }
  if (customSize) {
    customSize.addEventListener("input", syncCanvasRatio);
  }

  /* ---------- 参考图 ---------- */
  const refValues = () =>
    $$(".ref__row input", refRows)
      .map((i) => i.value.trim())
      .filter(Boolean);

  const syncRefAdd = () => {
    refAdd.disabled = $$(".ref__row", refRows).length >= MAX_REFS;
  };

  const addRefRow = (value = "") => {
    if ($$(".ref__row", refRows).length >= MAX_REFS) return;
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

  toggleDisclosure(refToggle, refPanel, () => {
    if ($$(".ref__row", refRows).length === 0) addRefRow();
  });
  refAdd.addEventListener("click", () => {
    const input = addRefRow();
    if (input) input.focus();
  });

  const openRefWith = (url) => {
    refPanel.removeAttribute("hidden");
    refToggle.setAttribute("aria-expanded", "true");
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
    if (payload.shutProgress) {
      setIndeterminate(true);
      setProgress(0, "生成中（已关闭进度推送）");
    } else {
      setIndeterminate(false);
      setProgress(0, "准备中");
    }
    setState("loading");

    let res;
    try {
      res = await fetch("/api/generate", {
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
    const payload = {
      prompt,
      aspectRatio: activeRatio(),
      urls: refValues(),
      shutProgress: !!(shutProgressEl && shutProgressEl.checked),
    };
    if (modelInput && modelInput.value.trim()) payload.model = modelInput.value.trim();
    if (webhookInput && webhookInput.value.trim()) payload.webHook = webhookInput.value.trim();
    runGeneration(payload);
  });

  /* ---------- 示例卡片 ---------- */
  $$(".sample").forEach((btn) => {
    btn.addEventListener("click", () => {
      promptEl.value = btn.dataset.prompt || "";
      updateCount();
      if (customSize) customSize.value = "";
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
      const r = await fetch("/api/config");
      const cfg = await r.json();
      if (cfg && cfg.model && panelModel && !modelInput.value.trim()) {
        panelModel.textContent = "模型 · " + cfg.model;
      }
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
