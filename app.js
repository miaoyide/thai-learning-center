import { marked } from "marked";
import DOMPurify from "dompurify";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut } from "firebase/auth";
import { getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, orderBy, serverTimestamp }
  from "firebase/firestore";
import { firebaseConfig } from "./firebase-config.js";
import { buildCues, cuesToTranscript, extractVideoId } from "./subtitles.js";
import { mountVideo } from "./video.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);

let cards = [];
let videos = [];
let editingId = null;
let editingVideoId = null;
let unsubs = [];

/* ---------- 主題 ---------- */
const sysDark = matchMedia("(prefers-color-scheme: dark)");
const currentTheme = () => document.documentElement.dataset.theme || (sysDark.matches ? "dark" : "light");
const syncThemeBtn = () => { $("themeBtn").textContent = currentTheme() === "dark" ? "☀️" : "🌙"; };
$("themeBtn").onclick = () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) {}
  syncThemeBtn();
};
sysDark.addEventListener("change", syncThemeBtn);
syncThemeBtn();

/* ---------- Auth ---------- */
onAuthStateChanged(auth, (user) => {
  $("app").hidden = !user;
  $("loginHint").hidden = !!user;
  $("authBox").innerHTML = user
    ? `<button id="outBtn">登出</button>`
    : `<button id="inBtn">Google 登入</button>`;
  if (user) {
    $("outBtn").onclick = () => signOut(auth);
    unsubs = [
      onSnapshot(query(collection(db, "cards"), orderBy("createdAt", "desc")), (snap) => {
        cards = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
      }, (e) => alert("讀取失敗：" + e.message)),
      onSnapshot(query(collection(db, "videos"), orderBy("createdAt", "desc")), (snap) => {
        videos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
      }, (e) => console.warn("影片讀取失敗（Firestore 規則是否已加入 videos？）", e)),
    ];
  } else {
    $("inBtn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider());
    unsubs.forEach((u) => u());
    unsubs = [];
    cards = [];
    videos = [];
    closeVideo();
  }
});

/* ---------- 語音 ---------- */
// 預設用瀏覽器內建 Web Speech API。要改用外部 TTS API，只要改寫這個函式即可。
// 系統有泰語語音就用內建的；沒有就改用 Google 翻譯 TTS（非官方網址，若失效改寫這裡即可）。
let audio = null;
function speak(text, rate) {
  if (audio) audio.pause();
  // 固定用 Google 翻譯的泰語語音，所有裝置聽到的聲音一致（不使用系統語音）
  audio = new Audio(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=th&q=${encodeURIComponent(text)}`);
  audio.playbackRate = rate;
  audio.preservesPitch = true;
  audio.play().catch((e) => alert("語音播放失敗：" + e.message));
}

/* ---------- 渲染 ---------- */
const esc = (s = "") => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = (s) => DOMPurify.sanitize(marked.parse(s || "", { breaks: true }));

// 單色 SVG icon：用 currentColor，顏色/大小直接由 CSS 控制（.ico）
const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  play: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  del: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>'),
};

let typeFilter = "all";
const TYPE_LABEL = { word: "單字", sentence: "句子" };
const typeOf = (c) => c.type || "sentence"; // 舊資料沒有分類時視為句子

$("tabs").onclick = (e) => {
  const b = e.target.closest("button[data-type]");
  if (!b) return;
  // 影片與字卡是不同集合，切換時清掉勾選，避免誤刪
  if ((b.dataset.type === "video") !== (typeFilter === "video")) selected.clear();
  typeFilter = b.dataset.type;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
  render();
};

const selected = new Set();
let visible = []; // 目前列表顯示的字卡

function updateBar() {
  $("editBtn").disabled = selected.size !== 1;
  $("delBtn").disabled = selected.size === 0;
  $("delBtn").textContent = selected.size > 1 ? `刪除 (${selected.size})` : "刪除";
  const n = visible.filter((c) => selected.has(c.id)).length;
  $("selAll").checked = visible.length > 0 && n === visible.length;
  $("selAll").indeterminate = n > 0 && n < visible.length;
}

function renderVideos(q) {
  const list = visible = videos.filter((v) => !q || (v.title || "").toLowerCase().includes(q));
  $("cards").innerHTML = list.map((v) => `
    <div class="card" data-id="${v.id}">
      <div class="vline">
        <input type="checkbox" class="sel" ${selected.has(v.id) ? "checked" : ""}>
        <div class="vname">${esc(v.title || v.videoId)}</div>
        <div class="english">${v.cues?.length ?? 0} 句</div>
      </div>
    </div>`).join("") || "<p>還沒有影片。</p>";
  updateBar();
}

function render() {
  const pool = typeFilter === "video" ? videos : cards;
  for (const id of [...selected]) if (!pool.some((c) => c.id === id)) selected.delete(id);
  const q = $("search").value.trim().toLowerCase();
  if (typeFilter === "video") return renderVideos(q);
  const list = visible = cards.filter((c) =>
    (typeFilter === "all" || typeOf(c) === typeFilter) &&
    (!q || [c.thai, c.roman, c.english].join(" ").toLowerCase().includes(q)));
  $("cards").innerHTML = list.map((c) => `
    <div class="card" data-id="${c.id}">
      <div class="line">
        <input type="checkbox" class="sel" ${selected.has(c.id) ? "checked" : ""}>
        <button class="icon play" data-act="play1" title="播放">${ICON.play}</button>
        <div class="words">
          <div class="thai">${esc(c.thai)}</div>
          <div class="roman">${esc(c.roman)}</div>
        </div>
        <div class="english">${esc(c.english)}</div>
        <div class="meta">
          ${typeFilter === "all" ? `<span class="badge">${TYPE_LABEL[typeOf(c)]}</span>` : ""}
        </div>
      </div>
      ${c.detail ? `<div class="detail" hidden>${md(c.detail)}</div>` : ""}
    </div>`).join("") || "<p>還沒有字卡。</p>";
  updateBar();
}

$("search").oninput = render;

$("selAll").onchange = (e) => {
  for (const c of visible) e.target.checked ? selected.add(c.id) : selected.delete(c.id);
  render();
};
$("editBtn").onclick = () => {
  if (typeFilter === "video") {
    const v = videos.find((x) => selected.has(x.id));
    if (v) openVideoDlg(v);
    return;
  }
  const c = cards.find((x) => selected.has(x.id));
  if (c) openDlg(c);
};
$("delBtn").onclick = async () => {
  const isVideo = typeFilter === "video";
  const items = (isVideo ? videos : cards).filter((c) => selected.has(c.id));
  if (!items.length) return;
  const name = (x) => (isVideo ? x.title || x.videoId : x.thai);
  const label = items.length === 1 ? `「${name(items[0])}」` : `${items.length} ${isVideo ? "部影片" : "張字卡"}`;
  if (!confirm(`刪除${label}？`)) return;
  await Promise.all(items.map((c) => deleteDoc(doc(db, isVideo ? "videos" : "cards", c.id))));
  selected.clear();
};

$("cards").onclick = async (e) => {
  const el = e.target.closest(".card");
  if (!el) return;
  if (e.target.matches("input.sel")) {
    e.target.checked ? selected.add(el.dataset.id) : selected.delete(el.dataset.id);
    updateBar();
    return;
  }
  if (typeFilter === "video") return openVideo(videos.find((v) => v.id === el.dataset.id));
  const btn = e.target.closest("button[data-act]");
  // 點卡片（非按鈕）切換說明；選取文字或點說明內的連結/內容時不切換
  if (!btn) {
    if (e.target.closest(".detail") || getSelection().toString()) return;
    const d = el.querySelector(".detail");
    if (d) d.hidden = !d.hidden;
    return;
  }
  const c = cards.find((x) => x.id === el.dataset.id);
  switch (btn.dataset.act) {
    case "play1": speak(c.thai, 1); break;
  }
};

/* ---------- 新增 / 編輯 ---------- */
function openDlg(c) {
  editingId = c?.id ?? null;
  $("dlgTitle").textContent = c ? "編輯字卡" : "新增字卡";
  $("fType").value = c ? typeOf(c) : typeFilter === "all" ? "word" : typeFilter;
  $("fThai").value = c?.thai ?? "";
  $("fRoman").value = c?.roman ?? "";
  $("fEnglish").value = c?.english ?? "";
  $("fDetail").value = c?.detail ?? "";
  $("dlg").showModal();
}
// 從 AI 網頁複製時剪貼簿帶有 HTML；貼上時轉成 Markdown，標題/粗體/表格/清單才不會掉
const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
turndown.use(gfm);
$("fDetail").addEventListener("paste", (e) => {
  const html = e.clipboardData.getData("text/html");
  if (!html) return; // 純文字照常貼上
  e.preventDefault();
  const markdown = turndown.turndown(html).trim();
  const t = e.target;
  t.setRangeText(markdown, t.selectionStart, t.selectionEnd, "end");
});

$("addBtn").onclick = () => (typeFilter === "video" ? openVideoDlg() : openDlg());

/* ---------- 影片 ---------- */
let unmountVideo = null;
const browseEls = () => [document.querySelector(".toolbar"), $("tabs"), $("cards")];

function openVideo(v) {
  if (!v) return;
  closeVideo();
  browseEls().forEach((el) => (el.hidden = true));
  $("player").hidden = false;
  unmountVideo = mountVideo($("player"), v, {
    esc, ICON, onBack: closeVideo,
    addCard: (c) => addDoc(collection(db, "cards"), {
      type: "sentence", thai: c.thai, roman: c.roman, english: c.english, detail: "", createdAt: serverTimestamp(),
    }),
  });
}
function closeVideo() {
  if (unmountVideo) unmountVideo();
  unmountVideo = null;
  $("player").hidden = true;
  browseEls().forEach((el) => (el.hidden = false));
}

function openVideoDlg(v) {
  editingVideoId = v?.id ?? null;
  $("vdlgTitle").textContent = v ? "編輯影片" : "新增影片";
  $("vUrl").value = v?.url ?? "";
  $("vTitle").value = v?.title ?? "";
  $("vThai").value = v ? cuesToTranscript(v.cues) : "";
  // 部分句子沒有譯文時用 "-" 佔位，才不會因為空行被略過而錯位（buildCues 會把 "-" 還原成空白）
  const col = (k) => (v?.cues.some((c) => c[k]) ? v.cues.map((c) => c[k] || "-").join("\n") : "");
  $("vEnglish").value = col("english");
  $("vRoman").value = col("roman");
  $("vdlg").showModal();
}
$("vCancel").onclick = () => $("vdlg").close();

async function fetchTitle(url) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    return r.ok ? (await r.json()).title : "";
  } catch { return ""; }
}

$("vform").onsubmit = async (e) => {
  e.preventDefault();
  const url = $("vUrl").value.trim();
  const videoId = extractVideoId(url);
  if (!videoId) return alert("無法辨識 YouTube 連結");
  const { cues, warnings } = buildCues($("vThai").value, $("vRoman").value, $("vEnglish").value);
  if (!cues.length) return alert("沒有解析到任何泰文字幕，請確認格式（時間 + 文字）");
  if (warnings.length && !confirm(`${warnings.join("；")}\n仍要儲存嗎？多的行會被忽略，不足的會留空。`)) return;
  if (JSON.stringify(cues).length > 900000) return alert("字幕太長，超過 Firestore 單筆文件上限，請分段新增");
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const title = $("vTitle").value.trim() || (await fetchTitle(url)) || videoId;
    const data = { title, url, videoId, cues };
    if (editingVideoId) await updateDoc(doc(db, "videos", editingVideoId), data);
    else await addDoc(collection(db, "videos"), { ...data, createdAt: serverTimestamp() });
    $("vdlg").close();
  } catch (err) {
    alert("儲存失敗：" + err.message + "\n（若是 permission-denied，請在 Firestore 規則加入 videos）");
  } finally {
    btn.disabled = false;
  }
};
$("cancelBtn").onclick = () => $("dlg").close();

$("form").onsubmit = async () => {
  const data = {
    type: $("fType").value,
    thai: $("fThai").value.trim(),
    roman: $("fRoman").value.trim(),
    english: $("fEnglish").value.trim(),
    detail: $("fDetail").value,
  };
  if (editingId) await updateDoc(doc(db, "cards", editingId), data);
  else await addDoc(collection(db, "cards"), { ...data, createdAt: serverTimestamp() });
};
