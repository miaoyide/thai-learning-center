import { fmtTime } from "./subtitles.js";

let ytReady;
function loadYT() {
  return (ytReady ??= new Promise((resolve) => {
    if (window.YT?.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  }));
}

const RATES = [0.5, 0.75, 1];
// 跳到某一句時提前的秒數。實測提前 0.3 秒會把上一句結尾的語助詞（นะครับ 之類）帶進來，所以不提前
const LEAD = 0;
const savedRate = () => { try { return +localStorage.getItem("videoRate"); } catch { return 0; } };

// 在 container 內顯示影片 + 逐句字幕。回傳 destroy()。
// hl（選填）：本集重點 { canEdit, has(text), add(kind, item), swap(kind, index), generate(onStatus), auto, wait }
export function mountVideo(container, video, { esc, ICON, addCard, onBack, hl }) {
  const origin = encodeURIComponent(location.origin);
  container.innerHTML = `
    <!-- .vside：寬螢幕時是左欄（影片＋字幕），本集重點在右欄；窄螢幕時不產生外框（display:contents），順序由 CSS order 決定 -->
    <div class="vside">
    <div class="vplayer">
      <div class="vhead">
        <button id="vBack">← 返回</button>
        <strong class="vtitle">${esc(video.title || video.videoId)}</strong>
      </div>
      <!-- 頁面全域設為 no-referrer，但 YouTube 嵌入需要 referrer，所以只在這個 iframe 開啟 -->
      <iframe id="ytFrame" referrerpolicy="strict-origin-when-cross-origin"
        src="https://www.youtube.com/embed/${video.videoId}?enablejsapi=1&playsinline=1&rel=0&origin=${origin}"
        allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
      <div class="vctl">
        <button data-ctl="prev" title="上一句（←）">上一句</button>
        <button data-ctl="again" title="重聽這一句（R）">重聽</button>
        <button data-ctl="next" title="下一句（→）">下一句</button>
        <button data-ctl="loop" title="單句循環：一直重複目前這一句（L）" aria-pressed="false">單句循環</button>
        <span class="vrates" role="group" aria-label="播放速度">
          ${RATES.map((r) => `<button data-rate="${r}" title="播放速度 ${r} 倍">${r}×</button>`).join("")}
        </span>
        <span class="vkeys" title="點一下影片以外的地方，快捷鍵才會生效">空白鍵 播放／暫停</span>
      </div>
    </div>
    <div class="cues">
      ${video.cues.map((c, i) => `
        <div class="cue" data-i="${i}">
          <span class="ctime">${fmtTime(c.start)}</span>
          <div class="cwords">
            <div class="thai">${esc(c.thai)}</div>
            ${c.roman ? `<div class="roman">${esc(c.roman)}</div>` : ""}
            ${c.english ? `<div class="english">${esc(c.english)}</div>` : ""}
          </div>
          <div class="cbtns">
            <button class="icon" data-act="seg" title="重播這一句">${ICON.play}</button>
            <button class="icon" data-act="add" title="加入字卡">${ICON.plus}</button>
          </div>
        </div>`).join("")}
    </div>
    </div>
    ${hl ? `<details class="vhl" ${video.highlights || hl.auto || hl.wait ? "open" : ""}><summary>本集重點</summary><div class="hlbody"></div></details>` : ""}`;

  const cueEls = [...container.querySelectorAll(".cue")];
  let player = null;
  let ready = false;
  let active = -1;
  let segEnd = null;
  let destroyed = false;
  let pending = -1; // 剛跳到的那一句：提前量還沒播完之前，畫面先標示它而不是前一句
  let pendingAt = 0;
  let loopOn = false;
  let rate = RATES.includes(savedRate()) ? savedRate() : 1;

  const seek = (t) => { if (ready) { player.seekTo(Math.max(0, t - LEAD), true); player.playVideo(); } };
  // 跳到第 i 句；once＝播完這一句就停
  const jump = (i, once = false) => {
    const c = video.cues[i];
    if (!c || !ready) return;
    pending = i;
    pendingAt = Date.now();
    segEnd = once ? c.end : null;
    seek(c.start);
  };

  /* ---------- 播放控制：上一句／重聽／下一句、單句循環、速度、快捷鍵 ---------- */
  const ctl = container.querySelector(".vctl");
  const loopBtn = ctl.querySelector('[data-ctl="loop"]');
  const setLoop = (on) => {
    loopOn = on;
    loopBtn.classList.toggle("on", on);
    loopBtn.setAttribute("aria-pressed", on);
  };
  const setRate = (r) => {
    rate = r;
    ctl.querySelectorAll("[data-rate]").forEach((b) => b.classList.toggle("on", +b.dataset.rate === r));
    try { localStorage.setItem("videoRate", r); } catch (e) {}
    if (ready) player.setPlaybackRate(r);
  };
  const act = {
    prev: () => jump(Math.max(0, active - 1)),
    again: () => jump(Math.max(0, active)),
    next: () => jump(Math.min(video.cues.length - 1, active + 1)),
    loop: () => setLoop(!loopOn),
    toggle: () => { if (ready) player.getPlayerState() === 1 ? player.pauseVideo() : player.playVideo(); },
  };
  ctl.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.rate) setRate(+b.dataset.rate);
    else act[b.dataset.ctl]?.();
    b.blur(); // 不留焦點，接下來按空白鍵才是播放／暫停，而不是再按一次這顆按鈕
  };
  setRate(rate);
  const KEYS = { " ": "toggle", ArrowLeft: "prev", ArrowRight: "next", r: "again", R: "again", l: "loop", L: "loop" };
  const onKey = (e) => {
    const name = KEYS[e.key];
    if (!name || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (document.querySelector("dialog[open]") || e.target.closest?.("input, textarea, select, button, summary, [contenteditable]")) return;
    e.preventDefault();
    act[name]();
  };
  document.addEventListener("keydown", onKey);

  container.querySelector("#vBack").onclick = onBack;
  container.querySelector(".cues").onclick = async (e) => {
    const el = e.target.closest(".cue");
    if (!el) return;
    const c = video.cues[+el.dataset.i];
    const btn = e.target.closest("button[data-act]");
    if (btn?.dataset.act === "add") {
      btn.disabled = true;
      try { await addCard(c); btn.textContent = "✓"; } catch (err) { btn.disabled = false; alert("加入失敗：" + err.message); }
      return;
    }
    if (getSelection().toString()) return;
    jump(+el.dataset.i, btn?.dataset.act === "seg");
  };

  /* ---------- 本集重點：單字與句型 ---------- */
  const hlBody = container.querySelector(".hlbody");
  const norm = (t) => t.replace(/[\s…]+|\.{3}/g, "").toLowerCase();
  let hlBusy = false;
  let hlMsg = "";
  // 發音按鈕沿用字卡說明裡的 .say（app.js 統一處理點擊）；句型裡的「…」不念
  const sayBtn = (t) => `<button type="button" class="say" title="發音" data-say="${esc(t.replace(/…|\.{3}/g, " ").trim())}">${ICON.play}</button>`;
  const exHtml = (e) => `
    <div class="thai">${sayBtn(e.thai)}${esc(e.thai)}</div>
    ${e.roman ? `<div class="roman">${esc(e.roman)}</div>` : ""}
    ${e.english ? `<div class="english">${esc(e.english)}</div>` : ""}`;
  let swapping = ""; // 正在換的那一項，例如 "words:3"
  const addBtn = (it) => (!hl.canEdit ? "" : `<div class="hlbtns">
    ${hl.has(it.thai)
      ? `<button class="icon" disabled title="已在字卡裡">✓</button>`
      : `<button class="icon" data-act="add" title="加入字卡">${ICON.plus}</button>`}
    <button class="icon" data-act="swap" title="換一個：這個我會了或不需要" ${swapping ? "disabled" : ""}>${ICON.swap}</button>
  </div>`);
  const rowCls = (k, i) => (swapping === `${k}:${i}` ? " busy" : "");
  function renderHl() {
    if (!hlBody) return;
    const h = video.highlights;
    const words = h?.words ?? [], patterns = h?.patterns ?? [];
    const pending = [...words, ...patterns].filter((it) => !hl.has(it.thai)).length;
    const genLabel = hlBusy ? "挑選中…" : h ? "重新挑選" : "挑出本集重點";
    hlBody.innerHTML = `
      ${words.length ? `<h3>單字 <small>${words.length}</small></h3>
        <div class="hlwords">${words.map((w, i) => `
          <div class="hl${rowCls("words", i)}" data-k="words" data-i="${i}">
            <div class="cwords">${exHtml(w)}${w.note ? `<div class="hlnote">${esc(w.note)}</div>` : ""}</div>
            ${addBtn(w)}
          </div>`).join("")}</div>` : ""}
      ${patterns.length ? `<h3>常用句型 <small>${patterns.length}</small></h3>
        ${patterns.map((p, i) => `
          <div class="hl hlpat${rowCls("patterns", i)}" data-k="patterns" data-i="${i}">
            <div class="cwords">${exHtml(p)}
              ${p.explain ? `<div class="hlnote">${esc(p.explain)}</div>` : ""}
              ${p.examples?.length ? `<div class="hlex">${p.examples.map((e) => `<div class="hlexi">${exHtml(e)}</div>`).join("")}</div>` : ""}
            </div>
            ${addBtn(p)}
          </div>`).join("")}` : ""}
      ${!h && !hl.canEdit ? `<p class="hlmsg">這部影片還沒有挑出重點。</p>` : ""}
      ${hl.canEdit ? `<div class="hlbar">
          <button data-act="gen" ${hlBusy ? "disabled" : ""}>${genLabel}</button>
          ${pending ? `<button data-act="all">全部加入字卡（${pending}）</button>` : ""}
          <span class="hlmsg" role="status">${esc(hlMsg)}</span>
        </div>` : ""}`;
  }
  async function genHl() {
    if (hlBusy) return;
    hlBusy = true; hlMsg = "正在從逐字稿挑選，大約需要半分鐘";
    renderHl();
    try {
      video.highlights = await hl.generate((s) => { if (s && !destroyed) { hlMsg = s; renderHl(); } });
      hlMsg = "";
    } catch (err) {
      hlMsg = "挑選失敗：" + err.message;
    }
    hlBusy = false;
    if (!destroyed) renderHl();
  }
  if (hlBody) {
    hlBody.onclick = async (e) => {
      const act = e.target.closest("button[data-act]")?.dataset.act;
      if (act === "gen") {
        if (video.highlights && !confirm("要重新挑選嗎？目前的重點會被取代（已加入的字卡不受影響）。")) return;
        return genHl();
      }
      if (act === "all") {
        e.target.closest("button").disabled = true;
        try {
          for (const k of ["words", "patterns"]) {
            for (const it of video.highlights?.[k] ?? []) if (!hl.has(it.thai)) await hl.add(k, it);
          }
          hlMsg = "已全部加入字卡";
        } catch (err) { hlMsg = "加入失敗：" + err.message; }
        return renderHl();
      }
      const row = e.target.closest(".hl");
      if (!row || e.target.closest(".say")) return; // 發音按鈕只念出來，不跳影片
      const it = video.highlights[row.dataset.k][+row.dataset.i];
      if (act === "add") {
        try { await hl.add(row.dataset.k, it); hlMsg = ""; } catch (err) { hlMsg = "加入失敗：" + err.message; }
        return renderHl();
      }
      if (act === "swap") {
        if (swapping) return;
        swapping = `${row.dataset.k}:${row.dataset.i}`;
        hlMsg = `正在換掉「${it.thai}」…`;
        renderHl();
        try { video.highlights = await hl.swap(row.dataset.k, +row.dataset.i); hlMsg = ""; } catch (err) { hlMsg = "換一個失敗：" + err.message; }
        swapping = "";
        if (!destroyed) renderHl();
        return;
      }
      // 點一下：跳到影片裡出現這個詞／句型的那一句，播完那一句就停
      if (getSelection().toString()) return;
      const keys = [it.examples?.[0]?.thai, it.thai].filter(Boolean).map(norm);
      const hit = video.cues.find((c) => keys.some((k) => norm(c.thai).includes(k)));
      if (hit) jump(video.cues.indexOf(hit), true);
    };
    renderHl();
    if (hl.wait && !video.highlights) {
      // 背景工作還在替這部影片挑重點：顯示進行中，等它完成直接顯示結果
      hlBusy = true; hlMsg = "背景正在挑選本集重點…";
      renderHl();
      hl.wait.then((h) => { if (h && !video.highlights) video.highlights = h; }).finally(() => {
        hlBusy = false; hlMsg = "";
        if (!destroyed) renderHl();
      });
    } else if (hl.auto && hl.canEdit && !video.highlights) genHl();
  }

  // 讓正在播的那一句保持在視線內。寬螢幕時字幕有自己的捲動區，只捲那一區，
  // 不能用 scrollIntoView（它會連整個頁面一起捲，打斷正在右欄看本集重點的人）
  const cueBox = container.querySelector(".cues");
  const showCue = (el) => {
    if (getComputedStyle(cueBox).overflowY === "visible") return el.scrollIntoView({ block: "center", behavior: "smooth" });
    const top = cueBox.scrollTop + el.getBoundingClientRect().top - cueBox.getBoundingClientRect().top;
    cueBox.scrollTo({ top: top - (cueBox.clientHeight - el.offsetHeight) / 2, behavior: "smooth" });
  };

  const timer = setInterval(() => {
    if (!ready || destroyed) return;
    const t = player.getCurrentTime();
    // 單句循環：目前這一句播到結尾就跳回開頭（只在剛好播過結尾時處理，使用者自己拖進度條跳走就不拉回來）
    let idx = -1;
    for (let i = 0; i < video.cues.length && video.cues[i].start <= t + 0.05; i++) idx = i;
    if (pending >= 0) {
      // 剛跳轉完的一小段時間播放器回報的可能還是舊位置，之後則還在提前量裡：這兩段都先標示目標那一句
      const ps = video.cues[pending].start;
      if (Date.now() - pendingAt < 800 || (t < ps && t >= ps - LEAD - 0.5)) idx = pending;
      else pending = -1;
    }
    if (pending < 0) {
      // 單句循環：目前這一句播到結尾就跳回開頭（只在剛好播過結尾時處理，使用者自己拖進度條跳走就不拉回來）
      const cur = video.cues[active];
      if (loopOn && cur && t >= cur.end - 0.1 && t < cur.end + 1) return jump(active);
      if (segEnd != null && t >= segEnd - 0.1) { player.pauseVideo(); segEnd = null; return; }
    }
    if (idx !== active) {
      cueEls[active]?.classList.remove("on");
      cueEls[idx]?.classList.add("on");
      if (cueEls[idx]) showCue(cueEls[idx]);
      active = idx;
    }
  }, 100);

  loadYT().then(() => {
    if (destroyed) return;
    player = new YT.Player("ytFrame", { events: { onReady: () => { ready = true; player.setPlaybackRate(rate); } } });
  });

  return () => {
    destroyed = true;
    clearInterval(timer);
    document.removeEventListener("keydown", onKey);
    try { player?.destroy(); } catch (e) {}
    container.innerHTML = "";
  };
}
