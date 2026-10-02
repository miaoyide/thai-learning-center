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

const PAGES = ["home", "cards", "articles", "videos", "quiz"]; // quiz 不在導覽列，從首頁進入
let quizIds = []; // 隨堂測驗目前抽到的字卡 id
const quizResult = new Map(); // 本次測驗各題的標記：id → "ok" | "weak"
let quizWeakOnly = false; // 只考「需加強」的字卡
try { quizWeakOnly = localStorage.getItem("quizWeak") === "1"; } catch (e) {}
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
// 取出文字中的泰文（連續泰文片段，片段間用空白相連）
const thaiOf = (text) => (text.match(/[฀-๿]+(?:[ \t]+[฀-๿]+)*/g) || []).join(" ");

// 渲染 Markdown 後，在「本身含泰文的那一行」最前面加喇叭按鈕（清單項目、段落、表格格子、標題）
const SAY_BLOCKS = "li, p, td, th, h1, h2, h3, h4, h5, h6";
const SKIP_IN_OWN_TEXT = /^(UL|OL|P|BLOCKQUOTE|TABLE|PRE|DIV|H[1-6]|LI)$/; // 只算這一層自己的文字，不含巢狀區塊
function addSayButtons(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll(SAY_BLOCKS).forEach((el) => {
    let own = "";
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) own += c.nodeValue;
        else if (c.nodeType === 1 && !SKIP_IN_OWN_TEXT.test(c.tagName)) walk(c);
      }
    };
    walk(el);
    const thai = thaiOf(own);
    if (!thai) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "say";
    b.title = "發音";
    b.dataset.say = thai;
    b.innerHTML = ICON.play;
    el.insertBefore(b, el.firstChild);
  });
  return tpl.innerHTML;
}
const md = (s) => addSayButtons(DOMPurify.sanitize(marked.parse(s || "", { breaks: true })));
// 泰文不用空白分詞：移除所有空白（含全形空白、不換行空白、零寬字元）
const stripSpaces = (s) => s.replace(/[\s​-‍﻿]+/g, "");
const fmtDate = (t) => (t?.toDate ? t.toDate().toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" }) : "");

// 單色 SVG icon：用 currentColor，顏色/大小直接由 CSS 控制（.ico）
const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  play: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  flag: svg('<path d="M5 22V4"/><path d="M5 4h13l-2.5 4L18 12H5"/>'),
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

/* ---------- 遮罩（字卡頁專用）：隱藏泰文與拼音，點一下卡片顯示 ---------- */
let maskOn = false;
// 只在字卡頁生效，離開字卡頁就自動取消遮罩效果（開關狀態仍保留）
const syncMask = () => document.body.classList.toggle("mask", maskOn && page === "cards");
function setMask(on) {
  maskOn = on;
  syncMask();
  $("maskBtn").classList.toggle("on", on);
  if (on) { // 每次開啟都重新蓋住全部
    revealed.clear();
    document.querySelectorAll(".reveal").forEach((el) => el.classList.remove("reveal"));
  }
  try { localStorage.setItem("mask", on ? "1" : "0"); } catch (e) {}
}
$("maskBtn").onclick = () => setMask(!maskOn);
try { setMask(localStorage.getItem("mask") === "1"); } catch (e) {}

/* ---------- Auth ---------- */
// 訪客模式：不登入、純閱讀。不能新增／編輯／刪除、不能做隨堂測驗（介面隱藏＋程式內雙重擋下；
// 真正的寫入限制由 Firestore 規則負責：只有擁有者帳號能寫入）。
let guest = false;
try { guest = sessionStorage.getItem("guest") === "1"; } catch (e) {}
let signedIn = false;
const readOnly = () => guest && !signedIn;

const watch = (name, label, set) =>
  onSnapshot(query(collection(db, name), orderBy("createdAt", "desc")), (snap) => {
    set(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    render();
  }, (e) => {
    if (name === "cards" && guest && !signedIn) {
      alert("訪客模式目前無法讀取資料（擁有者尚未開放公開讀取）。");
      return exitGuest();
    }
    if (name === "cards") alert("讀取失敗：" + e.message);
    else console.warn(`${label}讀取失敗（Firestore 規則是否已加入 ${name}？）`, e);
  });

function startData() {
  stopData();
  unsubs = [
    watch("cards", "字卡", (v) => (cards = v)),
    watch("videos", "影片", (v) => (videos = v)),
    watch("articles", "文章", (v) => (articles = v)),
  ];
}
function stopData() {
  unsubs.forEach((u) => u());
  unsubs = [];
  cards = [];
  videos = [];
  articles = [];
  closeVideo();
  closeArticle();
}

function applyAuthUI() {
  const active = signedIn || guest;
  document.body.classList.toggle("guest", guest && !signedIn);
  $("app").hidden = !active;
  $("nav").hidden = !active;
  $("loginHint").hidden = active;
  $("authBox").innerHTML = signedIn
    ? `<button id="outBtn">登出</button>`
    : guest
      ? `<button id="outBtn">離開訪客模式</button><span class="badge">訪客・唯讀</span>`
      : `<button id="inBtn">Google 登入</button>`;
  if ($("outBtn")) $("outBtn").onclick = () => (signedIn ? signOut(auth) : exitGuest());
  if ($("inBtn")) $("inBtn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider());
  if (guest && !signedIn) {
    if (typeFilter === "weak") setTypeFilter("all"); // 「需加強」是擁有者的個人標記，訪客看不到
    if (page === "quiz") navigate("home");
  }
}

function enterGuest() {
  guest = true;
  try { sessionStorage.setItem("guest", "1"); } catch (e) {}
  startData();
  applyAuthUI();
  go(location.hash.slice(1));
}
function exitGuest() {
  guest = false;
  try { sessionStorage.removeItem("guest"); } catch (e) {}
  stopData();
  applyAuthUI();
}
$("guestBtn").onclick = enterGuest;

onAuthStateChanged(auth, (user) => {
  signedIn = !!user;
  if (signedIn) {
    guest = false;
    try { sessionStorage.removeItem("guest"); } catch (e) {}
    startData();
  } else if (guest) {
    startData(); // 重新整理後仍停留在訪客模式
  } else {
    stopData();
  }
  applyAuthUI();
});

/* ---------- 語音 ---------- */
// 固定用 Google 翻譯的泰語語音（非官方網址，若失效改寫這個函式即可），所有裝置聽到的聲音一致。
let audio = null;
let speakToken = 0;
// 這個語音端點一次只能念短文字，長段落依空白切成小段，依序播放
function chunkText(text, max = 150) {
  const chunks = [];
  let cur = "";
  for (let w of text.split(/\s+/).filter(Boolean)) {
    while (w.length > max) { // 沒有空白的超長文字只好硬切
      if (cur) { chunks.push(cur); cur = ""; }
      chunks.push(w.slice(0, max));
      w = w.slice(max);
    }
    if ((cur ? `${cur} ${w}` : w).length > max) { chunks.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
function speak(text, rate) {
  const token = ++speakToken; // 重新點擊時中斷前一次的連續播放
  if (audio) audio.pause();
  const chunks = chunkText(text);
  const playAt = (i) => {
    if (token !== speakToken || i >= chunks.length) return;
    audio = new Audio(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=th&q=${encodeURIComponent(chunks[i])}`);
    audio.playbackRate = rate;
    audio.preservesPitch = true;
    audio.onended = () => playAt(i + 1);
    audio.play().catch((e) => { if (token === speakToken) alert("語音播放失敗：" + e.message); });
  };
  playAt(0);
}
// 說明區、文章裡自動產生的喇叭按鈕
document.addEventListener("click", (e) => {
  const b = e.target.closest(".say");
  if (b) speak(b.dataset.say, 1);
});

/* ---------- 頁面切換（#home / #cards / #videos / #articles） ---------- */
const SEARCH_HINT = {
  cards: "搜尋泰文 / 拼音 / 英文…",
  videos: "搜尋影片標題 / 標籤…",
  articles: "搜尋文章標題 / 內容 / 標籤…",
};

function applyView() {
  $("home").hidden = page !== "home";
  $("quiz").hidden = page !== "quiz";
  $("browse").hidden = page === "home" || page === "quiz" || !!viewing;
  $("player").hidden = viewing !== "video";
  $("reader").hidden = viewing !== "article";
}

function go(p) {
  if (!PAGES.includes(p)) p = "home";
  if (readOnly() && p === "quiz") p = "home"; // 訪客不能做隨堂測驗
  if (p !== page) {
    selected.clear();
    tagFilter.clear();
    $("search").value = "";
  }
  closeVideo();
  closeArticle();
  if (p === "quiz" && page !== "quiz") newQuiz(); // 每次進入測驗都重新抽題
  page = p;
  syncMask();
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
      <button class="tile" data-go="weak"><b>${cards.filter((c) => c.weak).length}</b><span>需加強</span></button>
      <button class="tile" data-go="articles"><b>${articles.length}</b><span>文章</span></button>
      <button class="tile" data-go="videos"><b>${videos.length}</b><span>影片</span></button>
    </div>
    <div class="homeactions">
      <button data-act="quiz" title="從字卡隨機抽 5–10 張，只顯示英文">隨堂測驗</button>
      <button data-act="export" title="下載全部字卡、影片、文章（JSON 備份）">匯出備份</button>
    </div>`;
}
$("home").onclick = (e) => {
  const t = e.target.closest("[data-go]");
  if (t?.dataset.go === "weak") { // 直接進字卡頁的「需加強」分頁
    if (page !== "cards") navigate("cards");
    return setTypeFilter("weak");
  }
  if (t) return navigate(t.dataset.go);
  const b = e.target.closest("button[data-act]");
  if (b?.dataset.act === "quiz") navigate("quiz");
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
    (!q || [a.title || "", a.subtitle || "", a.body || "", ...tagsOf(a)].join(" ").toLowerCase().includes(q)));
  $("cards").innerHTML = list.map((a) => `
    <div class="card" data-id="${a.id}">
      <div class="vline">
        <input type="checkbox" class="sel" ${selected.has(a.id) ? "checked" : ""}>
        <div class="vname">${esc(a.title || "（無標題）")}${a.subtitle ? ` <span class="subtitle">${esc(a.subtitle)}</span>` : ""}</div>
        <div class="english vcount">${fmtDate(a.createdAt)}</div>
      </div>
    </div>`).join("") || "<p>還沒有文章。</p>";
  updateBar();
}

/* ---------- 隨堂測驗：從字卡隨機抽 5–10 張，只顯示英文；看完答案後可標記「記得了／需加強」並寫備註 ---------- */
function newQuiz() {
  const pool = cards.filter((c) => c.english && (!quizWeakOnly || c.weak)); // 沒有英文就沒辦法出題
  for (let i = pool.length - 1; i > 0; i--) { // Fisher–Yates 洗牌
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const n = Math.min(pool.length, 5 + Math.floor(Math.random() * 6));
  quizIds = pool.slice(0, n).map((c) => c.id);
  quizResult.clear();
  delete $("quiz").dataset.ids; // 讓下一次 renderQuiz 一定重建畫面
  for (const id of quizIds) { revealed.delete(id); opened.delete(id); }
}

// 資料更新（例如剛標記完）時只更新標記狀態，不重建畫面，避免正在輸入備註或按鈕被替換
function updateQuizMarks() {
  $("quiz").querySelectorAll(".card").forEach((el) => {
    const c = cards.find((x) => x.id === el.dataset.id);
    const r = quizResult.get(el.dataset.id);
    el.classList.toggle("weak", !!c?.weak);
    el.querySelector('[data-q="ok"]')?.classList.toggle("on", r === "ok");
    el.querySelector('[data-q="weak"]')?.classList.toggle("on", r === "weak");
  });
  const wb = $("quiz").querySelector('[data-act="weakonly"]');
  if (wb) wb.classList.toggle("on", quizWeakOnly);
}

function renderQuiz(force = false) {
  if (!quizIds.length && cards.length) newQuiz(); // 重新整理停在測驗頁時，等資料載入後再抽題
  const key = quizIds.join();
  if (!force && $("quiz").dataset.ids === key && $("quiz").children.length) return updateQuizMarks();
  $("quiz").dataset.ids = key;
  const list = quizIds.map((id) => cards.find((c) => c.id === id)).filter(Boolean);
  const empty = quizWeakOnly ? "還沒有標記為「需加強」的字卡。" : "還沒有可出題的字卡（需要有英文），先去新增吧。";
  $("quiz").innerHTML = `
    <div class="readerbar">
      <button data-act="home">← 首頁</button>
      <strong class="vtitle">隨堂測驗（${list.length} 題）</strong>
      <button data-act="weakonly" title="只從標記為「需加強」的字卡抽題">只考需加強</button>
      <button data-act="again">再抽一組</button>
    </div>
    <p class="muted quizhint">看英文回想泰文，點一下卡片顯示答案，再標記「記得了」或「需加強」。</p>
    ${list.map((c) => `
      <div class="card quiz${c.weak ? " weak" : ""}${revealed.has(c.id) ? " reveal" : ""}${opened.has(c.id) ? " open" : ""}" data-id="${c.id}">
        <div class="line quizline">
          <div class="english"><span class="flag" title="需加強">${ICON.flag}</span>${esc(c.english)}</div>
          <div class="words">
            <div class="thai">${esc(c.thai)}</div>
            <div class="roman">${esc(c.roman)}</div>
          </div>
          <button class="icon play" data-act="play1" title="播放">${ICON.play}</button>
        </div>
        <div class="quizact">
          <button data-q="ok">記得了</button>
          <button data-q="weak">需加強</button>
          <input class="qnote" placeholder="備註（例如容易搞混的地方）" value="${esc(c.note || "")}">
        </div>
        ${c.detail ? `<div class="detail"${opened.has(c.id) ? "" : " hidden"}>${md(c.detail)}</div>` : ""}
      </div>`).join("") || `<p>${empty}</p>`}`;
  updateQuizMarks();
}

async function markQuiz(id, kind) {
  if (readOnly()) return;
  const c = cards.find((x) => x.id === id);
  if (!c || quizResult.get(id) === kind) return;
  quizResult.set(id, kind);
  // 需加強：記一次「答錯」；記得了：取消需加強標記（累計次數保留）
  const data = kind === "weak" ? { weak: true, misses: (c.misses || 0) + 1 } : { weak: false };
  Object.assign(c, data); // 先更新本地，畫面立即反應
  updateQuizMarks();
  try { await updateDoc(doc(db, "cards", id), data); } catch (err) { alert("儲存失敗：" + err.message); }
}

$("quiz").onclick = (e) => {
  const b = e.target.closest("button[data-act], button[data-q]");
  if (b?.dataset.act === "home") return navigate("home");
  if (b?.dataset.act === "again") { newQuiz(); return renderQuiz(true); }
  if (b?.dataset.act === "weakonly") {
    quizWeakOnly = !quizWeakOnly;
    try { localStorage.setItem("quizWeak", quizWeakOnly ? "1" : "0"); } catch (err) {}
    newQuiz();
    return renderQuiz(true);
  }
  const el = e.target.closest(".card");
  if (!el) return;
  if (b?.dataset.q) return markQuiz(el.dataset.id, b.dataset.q);
  cardClick(e, el, true);
};
$("quiz").addEventListener("change", async (e) => { // 備註在離開輸入框或按 Enter 時儲存
  if (!e.target.matches(".qnote")) return;
  const id = e.target.closest(".card").dataset.id;
  const c = cards.find((x) => x.id === id);
  const note = e.target.value.trim();
  if (!c || (c.note || "") === note) return;
  c.note = note;
  try { await updateDoc(doc(db, "cards", id), { note }); } catch (err) { alert("儲存失敗：" + err.message); }
});

function render() {
  if (page === "home") return renderHome();
  if (page === "quiz") return renderQuiz();
  if (viewing === "article") renderReader(); // 編輯後立即更新閱讀中的內容
  const pool = poolOf();
  for (const id of [...selected]) if (!pool.some((c) => c.id === id)) selected.delete(id);
  renderTagBar(pool);
  const q = $("search").value.trim().toLowerCase();
  if (page === "videos") return renderVideos(q);
  if (page === "articles") return renderArticles(q);
  $("weakTab").textContent = `需加強 ${cards.filter((c) => c.weak).length}`;
  const list = visible = cards.filter((c) =>
    (typeFilter === "all" || (typeFilter === "weak" ? c.weak : typeOf(c) === typeFilter)) && matchTags(c) &&
    (!q || [c.thai, c.roman, c.english, ...tagsOf(c)].join(" ").toLowerCase().includes(q)));
  $("cards").innerHTML = list.map((c) => `
    <div class="card${c.weak ? " weak" : ""}${revealed.has(c.id) ? " reveal" : ""}${opened.has(c.id) ? " open" : ""}" data-id="${c.id}">
      <div class="line">
        <input type="checkbox" class="sel" ${selected.has(c.id) ? "checked" : ""}>
        <button class="icon play" data-act="play1" title="播放">${ICON.play}</button>
        <div class="words">
          <div class="thai">${esc(c.thai)}</div>
          <div class="roman">${esc(c.roman)}</div>
        </div>
        <div class="english"><span class="flag" title="需加強">${ICON.flag}</span>${esc(c.english)}</div>
      </div>
      ${c.note ? `<div class="mynote">我的備註：${esc(c.note)}</div>` : ""}
      ${c.detail ? `<div class="detail"${opened.has(c.id) ? "" : " hidden"}>${md(c.detail)}</div>` : ""}
    </div>`).join("") || "<p>還沒有字卡。</p>";
  updateBar();
}

function setTypeFilter(t) {
  typeFilter = t;
  document.querySelectorAll("#typeTabs button[data-type]").forEach((x) => x.classList.toggle("on", x.dataset.type === t));
  render();
}
$("typeTabs").onclick = (e) => {
  const b = e.target.closest("button[data-type]");
  if (b) setTypeFilter(b.dataset.type);
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

$("addBtn").onclick = () => { if (!readOnly()) OPEN_DLG[page](); };
$("editBtn").onclick = () => {
  if (readOnly()) return;
  const item = poolOf().find((x) => selected.has(x.id));
  if (item) OPEN_DLG[page](item);
};
$("delBtn").onclick = async () => {
  if (readOnly()) return;
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
  cardClick(e, el, document.body.classList.contains("mask"));
};

// 字卡列（字卡頁與隨堂測驗共用）：播放；點卡片切換說明；masked 時第一次點擊先顯示答案
function cardClick(e, el, masked) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) {
    // 選取文字或點說明內的內容時不切換
    if (e.target.closest(".detail, .quizact") || getSelection().toString()) return;
    if (masked && !el.classList.contains("reveal")) {
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
}

/* ---------- 字卡對話框 ---------- */
function openDlg(c) {
  editingId = c?.id ?? null;
  $("dlgTitle").textContent = c ? "編輯字卡" : "新增字卡";
  $("fType").value = c ? typeOf(c) : typeFilter === "sentence" ? "sentence" : "word";
  $("fNote").value = c?.note ?? "";
  $("fWeak").checked = !!c?.weak;
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
    note: $("fNote").value.trim(),
    weak: $("fWeak").checked,
    tags: cardTags.get(),
  };
  if (editingId) await updateDoc(doc(db, "cards", editingId), data);
  else await addDoc(collection(db, "cards"), { ...data, createdAt: serverTimestamp() });
};

/* ---------- 匯出備份（JSON） ---------- */
function exportBackup() {
  if (readOnly()) return;
  const iso = (t) => (t?.toDate ? t.toDate().toISOString() : null);
  const data = {
    exportedAt: new Date().toISOString(),
    cards: cards.map((c) => ({
      id: c.id, type: typeOf(c), thai: c.thai ?? "", roman: c.roman ?? "", english: c.english ?? "",
      detail: c.detail ?? "", tags: tagsOf(c), note: c.note ?? "", weak: !!c.weak, misses: c.misses ?? 0,
      createdAt: iso(c.createdAt),
    })),
    videos: videos.map((v) => ({
      id: v.id, title: v.title ?? "", url: v.url ?? "", videoId: v.videoId ?? "",
      cues: v.cues ?? [], tags: tagsOf(v), createdAt: iso(v.createdAt),
    })),
    articles: articles.map((a) => ({
      id: a.id, title: a.title ?? "", subtitle: a.subtitle ?? "", body: a.body ?? "", tags: tagsOf(a),
      createdAt: iso(a.createdAt),
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
  if (readOnly()) return;
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
    addCard: (c) => readOnly() ? Promise.reject(new Error("訪客模式不能新增字卡")) : addDoc(collection(db, "cards"), {
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
      <div class="vtitle">
        <strong>${esc(a.title || "（無標題）")}</strong>
        ${a.subtitle ? `<div class="subtitle">${esc(a.subtitle)}</div>` : ""}
      </div>
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
  else if (e.target.closest("#aEdit") && !readOnly()) openArticleDlg(articles.find((x) => x.id === currentArticleId));
};

function openArticleDlg(a) {
  editingArticleId = a?.id ?? null;
  $("adlgTitle").textContent = a ? "編輯文章" : "新增文章";
  $("aTitle").value = a?.title ?? "";
  $("aSubtitle").value = a?.subtitle ?? "";
  $("aBody").value = a?.body ?? "";
  articleTags.set(a?.tags);
  $("adlg").showModal();
}
$("aCancel").onclick = () => $("adlg").close();
$("aform").onsubmit = async () => {
  const data = {
    title: $("aTitle").value.trim(),
    subtitle: $("aSubtitle").value.trim(),
    body: $("aBody").value,
    tags: articleTags.get(),
  };
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
  // 只取選取範圍內的泰文
  selThai = thaiOf(sel.toString());
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
  if (readOnly()) return;
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












