/* gpt-image-2 Studio — frontend logic */
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

  const form = $("#genForm");
  const promptEl = $("#prompt");
  const promptCount = $("#promptCount");
  const canvas = $("#canvas");
  const generateBtn = $("#generateBtn");
  const panelNote = $("#panelNote");

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

  let lastPayload = null;
  let inFlight = false;

  /* ---------- reveal on scroll ---------- */
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

  /* ---------- prompt counter ---------- */
  const updateCount = () => {
    promptCount.textContent = String(promptEl.value.length);
  };
  promptEl.addEventListener("input", updateCount);
  updateCount();

  /* ---------- aspect ratio -> canvas sizing ---------- */
  const currentRatio = () => form.querySelector('input[name="ratio"]:checked').value;
  const syncCanvasRatio = () => {
    canvas.style.setProperty("--canvas-ratio", RATIO_TO_CSS[currentRatio()] || "1 / 1");
  };
  $$('input[name="ratio"]').forEach((r) => r.addEventListener("change", syncCanvasRatio));
  syncCanvasRatio();

  /* ---------- reference image rows ---------- */
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
    remove.setAttribute("aria-label", "Remove reference image");
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

  refToggle.addEventListener("click", () => {
    const open = refPanel.hasAttribute("hidden");
    if (open) {
      refPanel.removeAttribute("hidden");
      refToggle.setAttribute("aria-expanded", "true");
      if ($$(".ref__row", refRows).length === 0) addRefRow();
    } else {
      refPanel.setAttribute("hidden", "");
      refToggle.setAttribute("aria-expanded", "false");
    }
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

  /* ---------- canvas state ---------- */
  const setState = (state) => {
    canvas.dataset.state = state;
  };
  const setProgress = (pct, statusWord) => {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    progressFill.style.width = clamped + "%";
    progressPct.textContent = clamped + "%";
    if (statusWord) progressStatus.textContent = statusWord;
  };

  const showError = (msg) => {
    errorText.textContent = msg || "Something went wrong. Please try again.";
    setState("error");
    setBusy(false);
  };

  const setBusy = (busy) => {
    inFlight = busy;
    generateBtn.classList.toggle("is-busy", busy);
    generateBtn.disabled = busy;
    generateBtn.innerHTML = busy
      ? '<span class="spinner"></span><span class="btn__label">Generating</span>'
      : '<span class="btn__label">Generate image</span>';
  };

  /* ---------- result image (with propagation retry) ---------- */
  const showResult = (url, promptText) => {
    let attempts = 0;
    setProgress(100, "finalizing");
    resultImg.onerror = () => {
      if (attempts++ < 6) {
        setTimeout(() => {
          resultImg.src = url + (url.includes("?") ? "&" : "?") + "r=" + Date.now();
        }, 1400);
      } else {
        showError("The image finished rendering but could not be loaded. Open it directly below.");
        openBtn.href = url;
      }
    };
    resultImg.onload = () => setState("result");
    resultImg.src = url;
    resultImg.alt = promptText ? "Generated image: " + promptText : "Generated image";
    resultPrompt.textContent = promptText;
    openBtn.href = url;
    downloadBtn.dataset.url = url;
  };

  /* ---------- download ---------- */
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

  /* ---------- SSE event handling ---------- */
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
      showError(d.failure_reason || d.error || d.detail || "Generation failed.");
      return;
    }
    if (typeof d.progress === "number") {
      setProgress(d.progress, status === "succeeded" ? "finalizing" : "rendering");
    }
    if (status === "succeeded") {
      const url = d.results && d.results[0] && d.results[0].url;
      if (url) showResult(url, lastPayload ? lastPayload.prompt : "");
      else showError("The model reported success but returned no image.");
    }
  };

  const runGeneration = async (payload) => {
    if (inFlight) return;
    lastPayload = payload;
    panelNote.hidden = true;
    setBusy(true);
    setProgress(0, "starting");
    setState("loading");

    let res;
    try {
      res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      showError("Could not reach the server. Check your connection and try again.");
      return;
    }
    if (!res.ok || !res.body) {
      showError("The server rejected the request (HTTP " + res.status + ").");
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
      if (!sawSuccess) showError("The connection dropped while rendering. Please try again.");
    } finally {
      setBusy(false);
      if (!sawSuccess && canvas.dataset.state === "loading") {
        showError("The stream ended before an image was produced. Please try again.");
      }
    }
  };

  /* ---------- submit ---------- */
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const prompt = promptEl.value.trim();
    if (!prompt) {
      promptEl.focus();
      return;
    }
    runGeneration({ prompt, aspectRatio: currentRatio(), urls: refValues() });
  });

  /* ---------- gallery samples ---------- */
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

  /* ---------- backend status ---------- */
  (async () => {
    const pill = $("#statusPill");
    const txt = $("#statusText");
    try {
      const r = await fetch("/api/config");
      const cfg = await r.json();
      if (cfg.apiKeyConfigured) {
        pill.classList.add("is-ok");
        txt.textContent = "online";
      } else {
        pill.classList.add("is-down");
        txt.textContent = "no api key";
        panelNote.hidden = false;
        panelNote.textContent =
          "Heads up: the server has no GRSAI_API_KEY set, so generation will fail until it is configured.";
      }
    } catch {
      pill.classList.add("is-down");
      txt.textContent = "offline";
    }
  })();
})();
