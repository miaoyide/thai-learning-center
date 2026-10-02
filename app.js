import { marked } from "marked";
import DOMPurify from "dompurify";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut } from "firebase/auth";
import { getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, orderBy, serverTimestamp, writeBatch, Timestamp }
  from "firebase/firestore";
import { firebaseConfig } from "./firebase-config.js";
import { buildCues, cuesToTranscript, extractVideoId } from "./subtitles.js";
import { mountVideo } from "./video.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);

/* ---------- 狀態 ---------- */
let cards = [];
let videos = [];
let articles = [];
let editingId = null;
let editingVideoId = null;
let editingArticleId = null;
let unsubs = [];

const PAGES = ["home", "cards", "videos", "articles"];
let page = "home"; // 目前頁面
let viewing = null; // 列表頁內正在看的內容："video" | "article" | null
let currentArticleId = null;
let unmountVideo = null;

let typeFilter = "all"; // 字卡頁的分類分頁：all | word | sentence
const selected = new Set();
let visible = []; // 目前列表顯示的項目
const revealed = new Set(); // 遮罩模式下已點開的字卡（重新渲染後保留）
const opened = new Set(); // 已展開的字卡（重新渲染後保留）
const tagFilter = new Set(); // 多選時為「同時符合」
let knownTags = []; // 目前頁面已用過的標籤（依使用次數排序），供輸入框選單使用

const poolOf = (p = page) => ({ cards, videos, articles })[p] || [];
const typeOf = (c) => c.type || "sentence"; // 舊資料沒有分類時視為句子
const tagsOf = (c) => c.tags || [];
const matchTags = (c) => [...tagFilter].every((t) => tagsOf(c).includes(t));

/* ---------- 工具 ---------- */
const esc = (s = "") => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = (s) => DOMPurify.sanitize(marked.parse(s || "", { breaks: true }));
// 泰文不用空白分詞：移除所有空白（含全形空白、不換行空白、零寬字元）
const stripSpaces = (s) => s.replace(/[\s​-‍﻿]+/g, "");
const fmtDate = (t) => (t?.toDate ? t.toDate().toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" }) : "");

// 單色 SVG icon：用 currentColor，顏色/大小直接由 CSS 控制（.ico）
const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  play: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  del: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>'),
};

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

/* ---------- 遮罩（自我測驗）：隱藏泰文與拼音，點一下顯示 ---------- */
function setMask(on) {
  document.body.classList.toggle("mask", on);
  $("maskBtn").classList.toggle("on", on);
  if (on) { // 每次開啟都重新蓋住全部
    revealed.clear();
    document.querySelectorAll(".reveal").forEach((el) => el.classList.remove("reveal"));
  }
  try { localStorage.setItem("mask", on ? "1" : "0"); } catch (e) {}
}
$("maskBtn").onclick = () => setMask(!document.body.classList.contains("mask"));
try { setMask(localStorage.getItem("mask") === "1"); } catch (e) {}

/* ---------- Auth ---------- */
const watch = (name, label, set) =>
  onSnapshot(query(collection(db, name), orderBy("createdAt", "desc")), (snap) => {
    set(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    render();
  }, (e) => (name === "cards"
    ? alert("讀取失敗：" + e.message)
    : console.warn(`${label}讀取失敗（Firestore 規則是否已加入 ${name}？）`, e)));

onAuthStateChanged(auth, (user) => {
  $("app").hidden = !user;
  $("nav").hidden = !user;
  $("loginHint").hidden = !!user;
  $("authBox").innerHTML = user
    ? `<button id="outBtn">登出</button>`
    : `<button id="inBtn">Google 登入</button>`;
  if (user) {
    $("outBtn").onclick = () => signOut(auth);
    unsubs = [
      watch("cards", "字卡", (v) => (cards = v)),
      watch("videos", "影片", (v) => (videos = v)),
      watch("articles", "文章", (v) => (articles = v)),
    ];
  } else {
    $("inBtn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider());
    unsubs.forEach((u) => u());
    unsubs = [];
    cards = [];
    videos = [];
    articles = [];
    closeVideo();
    closeArticle();
  }
});

/* ---------- 語音 ---------- */
// 固定用 Google 翻譯的泰語語音（非官方網址，若失效改寫這個函式即可），所有裝置聽到的聲音一致。
let audio = null;
function speak(text, rate) {
  if (audio) audio.pause();
  audio = new Audio(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=th&q=${encodeURIComponent(text)}`);
  audio.playbackRate = rate;
  audio.preservesPitch = true;
  audio.play().catch((e) => alert("語音播放失敗：" + e.message));
}

/* ---------- 頁面切換（#home / #cards / #videos / #articles） ---------- */
const SEARCH_HINT = {
  cards: "搜尋泰文 / 拼音 / 英文…",
  videos: "搜尋影片標題 / 標籤…",
  articles: "搜尋文章標題 / 內容 / 標籤…",
};

function applyView() {
  $("home").hidden = page !== "home";
  $("browse").hidden = page === "home" || !!viewing;
  $("player").hidden = viewing !== "video";
  $("reader").hidden = viewing !== "article";
}

function go(p) {
  if (!PAGES.includes(p)) p = "home";
  if (p !== page) {
    selected.clear();
    tagFilter.clear();
    $("search").value = "";
  }
  closeVideo();
  closeArticle();
  page = p;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.page === p));
  $("typeTabs").hidden = p !== "cards"; // 單字／句子分頁只用於字卡
  $("importBtn").hidden = p !== "cards"; // 批次匯入只用於字卡
  $("search").placeholder = SEARCH_HINT[p] || "";
  applyView();
  render();
  scrollTo(0, 0);
}
const navigate = (p) => (location.hash === `#${p}` ? go(p) : (location.hash = `#${p}`));
$("nav").onclick = (e) => {
  const b = e.target.closest("button[data-page]");
  if (b) navigate(b.dataset.page);
};
addEventListener("hashchange", () => go(location.hash.slice(1)));

/* ---------- 標籤（情境分類，一個項目可有多個；與字卡的 type 互相獨立） ---------- */
function renderTagBar(pool) {
  const counts = new Map();
  for (const c of pool) for (const t of tagsOf(c)) counts.set(t, (counts.get(t) || 0) + 1);
  for (const t of [...tagFilter]) if (!counts.has(t)) tagFilter.delete(t); // 標籤已不存在就取消篩選
  const all = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $("tagbar").hidden = !all.length;
  $("tagbar").innerHTML = all
    .map(([t, n]) => `<button class="tagbtn${tagFilter.has(t) ? " on" : ""}" data-tag="${esc(t)}">${esc(t)} <span>${n}</span></button>`)
    .join("");
  knownTags = all.map(([t]) => t);
}
$("tagbar").onclick = (e) => {
  const b = e.target.closest("button[data-tag]");
  if (!b) return;
  const t = b.dataset.tag;
  tagFilter.has(t) ? tagFilter.delete(t) : tagFilter.add(t);
  render();
};

// 標籤輸入框：自訂下拉選單（點選即加入標籤）；也可輸入後按 Enter／逗號新增，Backspace 刪除最後一個
function tagInput(root) {
  const input = root.querySelector("input");
  const menu = document.createElement("div");
  menu.className = "tagmenu";
  menu.hidden = true;
  root.append(menu);
  let tags = [];
  let items = [];
  let hi = -1;

  const draw = () => {
    root.querySelectorAll(".chip").forEach((c) => c.remove());
    for (const t of tags) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = t;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.onclick = () => { tags = tags.filter((y) => y !== t); draw(); };
      chip.append(x);
      root.insertBefore(chip, input);
    }
  };
  const add = (raw) => {
    for (const p of raw.split(/[,，]/)) {
      const t = p.trim().replace(/^#/, "");
      if (t && !tags.includes(t)) tags.push(t);
    }
    input.value = "";
    draw();
  };
  const hideMenu = () => { menu.hidden = true; hi = -1; };
  const paintHi = () => menu.querySelectorAll(".opt").forEach((el, i) => el.classList.toggle("hi", i === hi));
  const showMenu = () => {
    const q = input.value.trim().replace(/^#/, "");
    items = knownTags
      .filter((t) => !tags.includes(t) && t.toLowerCase().includes(q.toLowerCase()))
      .map((t) => ({ t, label: esc(t) }));
    if (q && !knownTags.includes(q) && !tags.includes(q)) items.push({ t: q, label: `＋ 新增「${esc(q)}」` });
    hi = -1;
    menu.innerHTML = items.map((it, i) => `<div class="opt" data-i="${i}">${it.label}</div>`).join("");
    menu.hidden = !items.length;
  };

  input.addEventListener("focus", showMenu);
  input.addEventListener("input", showMenu);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (menu.hidden) showMenu();
      if (!items.length) return;
      e.preventDefault();
      hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paintHi();
      menu.querySelector(".hi")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" || e.key === "," || e.key === "，") {
      e.preventDefault();
      add(hi >= 0 && e.key === "Enter" ? items[hi].t : input.value);
      showMenu();
    } else if (e.key === "Escape" && !menu.hidden) {
      e.preventDefault(); // 先關選單，不要連對話框一起關掉
      hideMenu();
    } else if (e.key === "Backspace" && !input.value && tags.length) {
      tags.pop();
      draw();
      showMenu();
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) add(input.value);
    hideMenu();
  });
  // mousedown 就加入並保持輸入框焦點，所以點一下就直接變成標籤、可以連續點選多個
  menu.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const el = e.target.closest(".opt");
    if (!el) return;
    add(items[+el.dataset.i].t);
    showMenu();
  });
  return {
    get() { if (input.value.trim()) add(input.value); return [...tags]; },
    set(arr) { tags = [...(arr || [])]; input.value = ""; hideMenu(); draw(); },
  };
}
const cardTags = tagInput($("fTags"));
const videoTags = tagInput($("vTags"));
const articleTags = tagInput($("aTags"));
const importTags = tagInput($("iTags"));

/* ---------- 渲染 ---------- */
function updateBar() {
  $("editBtn").disabled = selected.size !== 1;
  $("delBtn").disabled = selected.size === 0;
  $("delBtn").textContent = selected.size > 1 ? `刪除 (${selected.size})` : "刪除";
  const n = visible.filter((c) => selected.has(c.id)).length;
  $("selAll").checked = visible.length > 0 && n === visible.length;
  $("selAll").indeterminate = n > 0 && n < visible.length;
}

function renderHome() {
  $("home").innerHTML = `
    <h2 class="welcome">歡迎回來</h2>
    <p class="muted">今天想學點什麼？</p>
    <div class="tiles">
      <button class="tile" data-go="cards"><b>${cards.length}</b><span>字卡</span></button>
      <button class="tile" data-go="videos"><b>${videos.length}</b><span>影片</span></button>
      <button class="tile" data-go="articles"><b>${articles.length}</b><span>文章</span></button>
    </div>
    <div class="homeactions">
      <button data-act="quiz">開始遮罩測驗</button>
      <button data-act="export" title="下載全部字卡、影片、文章（JSON 備份）">匯出備份</button>
    </div>`;
}
$("home").onclick = (e) => {
  const t = e.target.closest("[data-go]");
  if (t) return navigate(t.dataset.go);
  const b = e.target.closest("button[data-act]");
  if (b?.dataset.act === "quiz") { setMask(true); navigate("cards"); }
  if (b?.dataset.act === "export") exportBackup();
};

function renderVideos(q) {
  const list = visible = videos.filter((v) => matchTags(v) &&
    (!q || [v.title || "", ...tagsOf(v)].join(" ").toLowerCase().includes(q)));
  $("cards").innerHTML = list.map((v) => `
    <div class="card" data-id="${v.id}">
      <div class="vline">
        <input type="checkbox" class="sel" ${selected.has(v.id) ? "checked" : ""}>
        <div class="vname">${esc(v.title || v.videoId)}</div>
        <div class="english vcount">${v.cues?.length ?? 0} 句</div>
      </div>
    </div>`).join("") || "<p>還沒有影片。</p>";
  updateBar();
}

function renderArticles(q) {
  const list = visible = articles.filter((a) => matchTags(a) &&
    (!q || [a.title || "", a.body || "", ...tagsOf(a)].join(" ").toLowerCase().includes(q)));
  const preview = (b = "") => b.replace(/[#>*`_|\[\]()-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
  $("cards").innerHTML = list.map((a) => `
    <div class="card" data-id="${a.id}">
      <div class="vline">
        <input type="checkbox" class="sel" ${selected.has(a.id) ? "checked" : ""}>
        <div>
          <div class="vname">${esc(a.title || "（無標題）")}</div>
          <div class="preview">${esc(preview(a.body))}</div>
        </div>
        <div class="english vcount">${fmtDate(a.createdAt)}</div>
      </div>
    </div>`).join("") || "<p>還沒有文章。</p>";
  updateBar();
}

function render() {
  if (page === "home") return renderHome();
  if (viewing === "article") renderReader(); // 編輯後立即更新閱讀中的內容
  const pool = poolOf();
  for (const id of [...selected]) if (!pool.some((c) => c.id === id)) selected.delete(id);
  renderTagBar(pool);
  const q = $("search").value.trim().toLowerCase();
  if (page === "videos") return renderVideos(q);
  if (page === "articles") return renderArticles(q);
  const list = visible = cards.filter((c) =>
    (typeFilter === "all" || typeOf(c) === typeFilter) && matchTags(c) &&
    (!q || [c.thai, c.roman, c.english, ...tagsOf(c)].join(" ").toLowerCase().includes(q)));
  $("cards").innerHTML = list.map((c) => `
    <div class="card${revealed.has(c.id) ? " reveal" : ""}${opened.has(c.id) ? " open" : ""}" data-id="${c.id}">
      <div class="line">
        <input type="checkbox" class="sel" ${selected.has(c.id) ? "checked" : ""}>
        <button class="icon play" data-act="play1" title="播放">${ICON.play}</button>
        <div class="words">
          <div class="thai">${esc(c.thai)}</div>
          <div class="roman">${esc(c.roman)}</div>
        </div>
        <div class="english">${esc(c.english)}</div>
      </div>
      ${c.detail ? `<div class="detail"${opened.has(c.id) ? "" : " hidden"}>${md(c.detail)}</div>` : ""}
    </div>`).join("") || "<p>還沒有字卡。</p>";
  updateBar();
}

$("typeTabs").onclick = (e) => {
  const b = e.target.closest("button[data-type]");
  if (!b) return;
  typeFilter = b.dataset.type;
  document.querySelectorAll("#typeTabs button").forEach((x) => x.classList.toggle("on", x === b));
  render();
};
$("search").oninput = render;
$("selAll").onchange = (e) => {
  for (const c of visible) e.target.checked ? selected.add(c.id) : selected.delete(c.id);
  render();
};

/* ---------- 新增 / 編輯 / 刪除（依目前頁面） ---------- */
const OPEN_DLG = { cards: (x) => openDlg(x), videos: (x) => openVideoDlg(x), articles: (x) => openArticleDlg(x) };
const COLL = { cards: "cards", videos: "videos", articles: "articles" };
const UNIT = { cards: "張字卡", videos: "部影片", articles: "篇文章" };
const nameOf = (x) => x.thai ?? (x.title || x.videoId || "");

$("addBtn").onclick = () => OPEN_DLG[page]();
$("editBtn").onclick = () => {
  const item = poolOf().find((x) => selected.has(x.id));
  if (item) OPEN_DLG[page](item);
};
$("delBtn").onclick = async () => {
  const items = poolOf().filter((c) => selected.has(c.id));
  if (!items.length) return;
  const label = items.length === 1 ? `「${nameOf(items[0])}」` : `${items.length} ${UNIT[page]}`;
  if (!confirm(`刪除${label}？`)) return;
  await Promise.all(items.map((c) => deleteDoc(doc(db, COLL[page], c.id))));
  selected.clear();
};

$("cards").onclick = (e) => {
  const el = e.target.closest(".card");
  if (!el) return;
  if (e.target.matches("input.sel")) {
    e.target.checked ? selected.add(el.dataset.id) : selected.delete(el.dataset.id);
    updateBar();
    return;
  }
  if (page === "videos") return openVideo(videos.find((v) => v.id === el.dataset.id));
  if (page === "articles") return openArticle(articles.find((a) => a.id === el.dataset.id));
  const btn = e.target.closest("button[data-act]");
  // 點卡片（非按鈕）切換說明；選取文字或點說明內的連結/內容時不切換
  if (!btn) {
    if (e.target.closest(".detail") || getSelection().toString()) return;
    // 遮罩模式：第一次點擊先顯示答案，之後才是展開／收合說明
    if (document.body.classList.contains("mask") && !el.classList.contains("reveal")) {
      el.classList.add("reveal");
      revealed.add(el.dataset.id);
      return;
    }
    // 展開：顯示完整泰文／拼音與說明（沒有說明的卡也能展開看完整文字）
    const open = el.classList.toggle("open");
    open ? opened.add(el.dataset.id) : opened.delete(el.dataset.id);
    const d = el.querySelector(".detail");
    if (d) d.hidden = !open;
    return;
  }
  const c = cards.find((x) => x.id === el.dataset.id);
  if (btn.dataset.act === "play1") speak(c.thai, 1);
};

/* ---------- 字卡對話框 ---------- */
function openDlg(c) {
  editingId = c?.id ?? null;
  $("dlgTitle").textContent = c ? "編輯字卡" : "新增字卡";
  $("fType").value = c ? typeOf(c) : typeFilter === "all" ? "word" : typeFilter;
  $("fThai").value = stripSpaces(c?.thai ?? "");
  $("fRoman").value = c?.roman ?? "";
  $("fEnglish").value = c?.english ?? "";
  $("fDetail").value = c?.detail ?? "";
  cardTags.set(c?.tags);
  $("dlg").showModal();
}
$("fThai").addEventListener("input", (e) => {
  if (e.isComposing) return;
  const el = e.target;
  const cleaned = stripSpaces(el.value);
  if (cleaned === el.value) return;
  const caret = stripSpaces(el.value.slice(0, el.selectionStart)).length; // 游標位置扣掉被移除的空白
  el.value = cleaned;
  el.setSelectionRange(caret, caret);
});

// 從 AI 網頁或文章複製時剪貼簿帶有 HTML；貼上時轉成 Markdown，標題/粗體/表格/清單才不會掉
const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
turndown.use(gfm);
function enableRichPaste(el) {
  el.addEventListener("paste", (e) => {
    const html = e.clipboardData.getData("text/html");
    if (!html) return; // 純文字照常貼上
    e.preventDefault();
    el.setRangeText(turndown.turndown(html).trim(), el.selectionStart, el.selectionEnd, "end");
  });
}
enableRichPaste($("fDetail"));
enableRichPaste($("aBody"));

$("cancelBtn").onclick = () => $("dlg").close();
$("form").onsubmit = async () => {
  const data = {
    type: $("fType").value,
    thai: stripSpaces($("fThai").value),
    roman: $("fRoman").value.trim(),
    english: $("fEnglish").value.trim(),
    detail: $("fDetail").value,
    tags: cardTags.get(),
  };
  if (editingId) await updateDoc(doc(db, "cards", editingId), data);
  else await addDoc(collection(db, "cards"), { ...data, createdAt: serverTimestamp() });
};

/* ---------- 匯出備份（JSON） ---------- */
function exportBackup() {
  const iso = (t) => (t?.toDate ? t.toDate().toISOString() : null);
  const data = {
    exportedAt: new Date().toISOString(),
    cards: cards.map((c) => ({
      id: c.id, type: typeOf(c), thai: c.thai ?? "", roman: c.roman ?? "", english: c.english ?? "",
      detail: c.detail ?? "", tags: tagsOf(c), createdAt: iso(c.createdAt),
    })),
    videos: videos.map((v) => ({
      id: v.id, title: v.title ?? "", url: v.url ?? "", videoId: v.videoId ?? "",
      cues: v.cues ?? [], tags: tagsOf(v), createdAt: iso(v.createdAt),
    })),
    articles: articles.map((a) => ({
      id: a.id, title: a.title ?? "", body: a.body ?? "", tags: tagsOf(a), createdAt: iso(a.createdAt),
    })),
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = `thai-learning-${data.exportedAt.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- 批次匯入字卡 ---------- */
// 一行一筆：泰文 | 拼音 | 英文（或 Tab 分隔）。泰文後面的 (v)(n)(adj) 詞性會併到英文後面。
function parseImport(text) {
  const rows = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue;
    let [thai = "", roman = "", english = ""] = line.split(/\t|\|/).map((s) => s.trim());
    const m = thai.match(/^(.*?)\s*[（(]\s*([A-Za-z.]+)\s*[)）]\s*$/);
    const pos = m ? m[2] : "";
    if (m) thai = m[1];
    thai = stripSpaces(thai);
    if (!thai) continue;
    rows.push({ thai, roman, english: pos ? `${english} (${pos})`.trim() : english });
  }
  return rows;
}
const updateImportCount = () => {
  const n = parseImport($("importText").value).length;
  $("importCount").textContent = n ? `將匯入 ${n} 筆` : "";
};
$("importText").addEventListener("input", updateImportCount);
$("importBtn").onclick = () => {
  $("iType").value = typeFilter === "sentence" ? "sentence" : "word";
  importTags.set([]);
  updateImportCount();
  $("importDlg").showModal();
};
$("importCancel").onclick = () => $("importDlg").close();
$("importForm").onsubmit = async (e) => {
  e.preventDefault();
  const rows = parseImport($("importText").value);
  if (!rows.length) return alert("沒有可匯入的資料");
  if (rows.length > 400) return alert("一次最多匯入 400 筆，請分批");
  const type = $("iType").value;
  const tags = importTags.get();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    const base = Date.now();
    // 時間依序遞減，列表（新到舊）就會維持貼上的順序
    rows.forEach((r, i) => batch.set(doc(collection(db, "cards")), {
      type, ...r, detail: "", tags, createdAt: Timestamp.fromMillis(base - i),
    }));
    await batch.commit();
    $("importText").value = "";
    updateImportCount();
    $("importDlg").close();
  } catch (err) {
    alert("匯入失敗：" + err.message);
  } finally {
    btn.disabled = false;
  }
};

/* ---------- 影片 ---------- */
function openVideo(v) {
  if (!v) return;
  closeVideo();
  viewing = "video";
  applyView();
  scrollTo(0, 0);
  unmountVideo = mountVideo($("player"), v, {
    esc, ICON, onBack: closeVideo,
    addCard: (c) => addDoc(collection(db, "cards"), {
      type: "sentence", thai: c.thai, roman: c.roman, english: c.english, detail: "", tags: v.tags ?? [],
      createdAt: serverTimestamp(),
    }),
  });
}
function closeVideo() {
  if (unmountVideo) unmountVideo();
  unmountVideo = null;
  if (viewing === "video") viewing = null;
  applyView();
}

function openVideoDlg(v) {
  editingVideoId = v?.id ?? null;
  $("vdlgTitle").textContent = v ? "編輯影片" : "新增影片";
  $("vUrl").value = v?.url ?? "";
  videoTags.set(v?.tags);
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
    const data = { title, url, videoId, cues, tags: videoTags.get() };
    if (editingVideoId) await updateDoc(doc(db, "videos", editingVideoId), data);
    else await addDoc(collection(db, "videos"), { ...data, createdAt: serverTimestamp() });
    $("vdlg").close();
  } catch (err) {
    alert("儲存失敗：" + err.message + "\n（若是 permission-denied，請在 Firestore 規則加入 videos）");
  } finally {
    btn.disabled = false;
  }
};

/* ---------- 文章 ---------- */
function renderReader() {
  const a = articles.find((x) => x.id === currentArticleId);
  if (!a) return closeArticle();
  $("reader").innerHTML = `
    <div class="readerbar">
      <button id="aBack">← 返回</button>
      <strong class="vtitle">${esc(a.title || "（無標題）")}</strong>
      <button id="aEdit" class="icon" title="編輯">${ICON.edit}</button>
    </div>
    <article class="detail article-body" lang="th">${md(a.body)}</article>`;
}
function openArticle(a) {
  if (!a) return;
  closeVideo();
  currentArticleId = a.id;
  viewing = "article";
  renderReader();
  applyView();
  scrollTo(0, 0);
}
function closeArticle() {
  currentArticleId = null;
  if (viewing === "article") viewing = null;
  $("reader").innerHTML = "";
  applyView();
}
$("reader").onclick = (e) => {
  if (e.target.closest("#aBack")) closeArticle();
  else if (e.target.closest("#aEdit")) openArticleDlg(articles.find((x) => x.id === currentArticleId));
};

function openArticleDlg(a) {
  editingArticleId = a?.id ?? null;
  $("adlgTitle").textContent = a ? "編輯文章" : "新增文章";
  $("aTitle").value = a?.title ?? "";
  $("aBody").value = a?.body ?? "";
  articleTags.set(a?.tags);
  $("adlg").showModal();
}
$("aCancel").onclick = () => $("adlg").close();
$("aform").onsubmit = async () => {
  const data = { title: $("aTitle").value.trim(), body: $("aBody").value, tags: articleTags.get() };
  if (editingArticleId) await updateDoc(doc(db, "articles", editingArticleId), data);
  else await addDoc(collection(db, "articles"), { ...data, createdAt: serverTimestamp() });
};

/* ---------- 反白泰文 → 浮窗：發音 / 加入字卡（字卡說明、文章、影片字幕） ---------- */
const selPop = $("selPop");
$("selPlay").innerHTML = `${ICON.play} 發音`;
$("selAdd").innerHTML = `${ICON.plus} 加入字卡`;
let selThai = "";
let selTimer = null;
let mouseDown = false;

const hideSelPop = () => { selPop.hidden = true; };

function checkSelection() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return hideSelPop();
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const host = (node.nodeType === 1 ? node : node.parentElement)?.closest(".detail, .cue");
  if (!host) return hideSelPop();
  // 只取選取範圍內的泰文（連續泰文片段，片段間用空白相連）
  selThai = (sel.toString().match(/[฀-๿]+(?:[ \t]+[฀-๿]+)*/g) || []).join(" ");
  if (!selThai) return hideSelPop();
  $("selText").textContent = selThai;
  selPop.hidden = false;
  const r = range.getBoundingClientRect();
  const w = selPop.offsetWidth, h = selPop.offsetHeight;
  const top = r.bottom + 8 + h > innerHeight ? Math.max(8, r.top - h - 8) : r.bottom + 8;
  selPop.style.top = `${top}px`;
  selPop.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
}

document.addEventListener("selectionchange", () => { // 手機長按選取也會觸發；等選取停下來再顯示
  clearTimeout(selTimer);
  selTimer = setTimeout(() => { if (!mouseDown) checkSelection(); }, 250);
});
document.addEventListener("mousedown", (e) => {
  if (e.target.closest("#selPop")) return;
  mouseDown = true;
  hideSelPop();
});
document.addEventListener("mouseup", () => {
  mouseDown = false;
  clearTimeout(selTimer);
  selTimer = setTimeout(checkSelection, 0);
});
document.addEventListener("scroll", hideSelPop, { passive: true });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideSelPop(); });
// 點浮窗按鈕時不要讓反白消失
selPop.addEventListener("mousedown", (e) => e.preventDefault());

$("selPlay").onclick = () => speak(selThai, 1);
$("selAdd").onclick = () => {
  const thai = selThai;
  hideSelPop();
  getSelection().removeAllRanges();
  openDlg();
  $("fThai").value = stripSpaces(thai);
  $("fType").value = /\s/.test(thai) ? "sentence" : "word"; // 有空白視為句子，否則單字（可手動改）
  $("fRoman").focus();
};

/* ---------- 啟動 ---------- */
go(location.hash.slice(1));


