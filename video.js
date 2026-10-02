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
export function mountVideo(container, video, { esc, ICON, addCard, onBack }) {
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
