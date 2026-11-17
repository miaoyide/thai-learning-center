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

// 在 container 內顯示影片 + 逐句字幕。回傳 destroy()。
// hl（選填）：本集重點 { canEdit, has(text), add(kind, item), generate(onStatus), auto }
export function mountVideo(container, video, { esc, ICON, addCard, onBack, hl }) {
  const origin = encodeURIComponent(location.origin);
  container.innerHTML = `
    <div class="vplayer">
      <div class="vhead">
        <button id="vBack">← 返回</button>
        <strong class="vtitle">${esc(video.title || video.videoId)}</strong>
      </div>
      <!-- 頁面全域設為 no-referrer，但 YouTube 嵌入需要 referrer，所以只在這個 iframe 開啟 -->
      <iframe id="ytFrame" referrerpolicy="strict-origin-when-cross-origin"
        src="https://www.youtube.com/embed/${video.videoId}?enablejsapi=1&playsinline=1&rel=0&origin=${origin}"
        allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
    </div>
    ${hl ? `<details class="vhl" ${video.highlights || hl.auto ? "open" : ""}><summary>本集重點</summary><div class="hlbody"></div></details>` : ""}
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
    </div>`;

  const cueEls = [...container.querySelectorAll(".cue")];
  let player = null;
  let ready = false;
  let active = -1;
  let segEnd = null;
  let destroyed = false;

  const seek = (t) => { if (ready) { player.seekTo(t, true); player.playVideo(); } };

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
    segEnd = btn?.dataset.act === "seg" ? c.end : null;
    seek(c.start);
  };

  /* ---------- 本集重點：單字與句型 ---------- */
  const hlBody = container.querySelector(".hlbody");
  const norm = (t) => t.replace(/[\s…]+|\.{3}/g, "").toLowerCase();
  let hlBusy = false;
  let hlMsg = "";
  const exHtml = (e) => `
    <div class="thai">${esc(e.thai)}</div>
    ${e.roman ? `<div class="roman">${esc(e.roman)}</div>` : ""}
    ${e.english ? `<div class="english">${esc(e.english)}</div>` : ""}`;
  const addBtn = (it) => (!hl.canEdit ? "" : hl.has(it.thai)
    ? `<button class="icon" disabled title="已在字卡裡">✓</button>`
    : `<button class="icon" data-act="add" title="加入字卡">${ICON.plus}</button>`);
  function renderHl() {
    if (!hlBody) return;
    const h = video.highlights;
    const words = h?.words ?? [], patterns = h?.patterns ?? [];
    const pending = [...words, ...patterns].filter((it) => !hl.has(it.thai)).length;
    const genLabel = hlBusy ? "挑選中…" : h ? "重新挑選" : "挑出本集重點";
    hlBody.innerHTML = `
      ${words.length ? `<h3>單字 <small>${words.length}</small></h3>
        <div class="hlwords">${words.map((w, i) => `
          <div class="hl" data-k="words" data-i="${i}">
            <div class="cwords">${exHtml(w)}${w.note ? `<div class="hlnote">${esc(w.note)}</div>` : ""}</div>
            ${addBtn(w)}
          </div>`).join("")}</div>` : ""}
      ${patterns.length ? `<h3>常用句型 <small>${patterns.length}</small></h3>
        ${patterns.map((p, i) => `
          <div class="hl hlpat" data-k="patterns" data-i="${i}">
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
      if (!row) return;
      const it = video.highlights[row.dataset.k][+row.dataset.i];
      if (act === "add") {
        try { await hl.add(row.dataset.k, it); hlMsg = ""; } catch (err) { hlMsg = "加入失敗：" + err.message; }
        return renderHl();
      }
      // 點一下：跳到影片裡出現這個詞／句型的那一句，播完那一句就停
      if (getSelection().toString()) return;
      const keys = [it.examples?.[0]?.thai, it.thai].filter(Boolean).map(norm);
      const hit = video.cues.find((c) => keys.some((k) => norm(c.thai).includes(k)));
      if (hit) { segEnd = hit.end; seek(hit.start); }
    };
    renderHl();
    if (hl.auto && hl.canEdit && !video.highlights) genHl();
  }

  const timer = setInterval(() => {
    if (!ready || destroyed) return;
    const t = player.getCurrentTime();
    if (segEnd != null && t >= segEnd) { player.pauseVideo(); segEnd = null; }
    let idx = -1;
    for (let i = 0; i < video.cues.length && video.cues[i].start <= t + 0.05; i++) idx = i;
    if (idx !== active) {
      cueEls[active]?.classList.remove("on");
      cueEls[idx]?.classList.add("on");
      cueEls[idx]?.scrollIntoView({ block: "center", behavior: "smooth" });
      active = idx;
    }
  }, 200);

  loadYT().then(() => {
    if (destroyed) return;
    player = new YT.Player("ytFrame", { events: { onReady: () => { ready = true; } } });
  });

  return () => {
    destroyed = true;
    clearInterval(timer);
    try { player?.destroy(); } catch (e) {}
    container.innerHTML = "";
  };
}
