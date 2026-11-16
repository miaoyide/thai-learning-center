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

/* ---------- 語言（泰文／英文） ---------- */
// 每筆資料都有 lang 欄位；沒有的舊資料一律視為泰文。欄位名稱沿用 thai／english：
// thai＝正在學的語言的文字，english＝它的意思（泰文版是英文，英文版是中文），roman 只有泰文版使用。
const LANGS = {
  th: { name: "泰文", site: "泰語學習", tts: "th", term: "泰文", meaning: "英文", roman: true },
  en: { name: "英文", site: "英語學習", tts: "en", term: "英文", meaning: "中文", roman: false },
};
let lang = "th";
let langChosen = false; // 本次登入是否已選過語言（存在 sessionStorage，重新整理不會再問；登出就清掉）
try {
  const s = localStorage.getItem("lang");
  if (LANGS[s]) lang = s;
  langChosen = sessionStorage.getItem("langChosen") === "1";
} catch (e) {}
const L = () => LANGS[lang];
const langOf = (d) => d.lang || "th";
const raw = { cards: [], videos: [], articles: [] }; // Firestore 回來的全部資料；畫面只用目前語言的那一份

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
let quizScope = "normal"; // 測驗抽題範圍：normal 一般（未封存）｜weak 需加強｜archived 封存｜all 全部
try {
  quizScope = localStorage.getItem("quizScope") || (localStorage.getItem("quizWeak") === "1" ? "weak" : "normal");
  if (!["normal", "weak", "archived", "all"].includes(quizScope)) quizScope = "normal";
} catch (e) {}
const inQuizScope = (c) => (quizScope === "weak" ? c.weak && !c.archived : quizScope === "archived" ? c.archived : quizScope === "all" ? true : !c.archived);
const QUIZ_SCOPES = [["normal", "一般"], ["weak", "需加強"], ["archived", "封存"], ["all", "全部"]];
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
// 每一段要加喇叭的文字：泰文是連續泰文；英文是以空白相連的英文字（句尾的 . ! ? 一起念）
const SAY_RUN = {
  th: /[฀-๿]+(?:[ \t]+[฀-๿]+)*/g,
  en: /[A-Za-z][A-Za-z0-9'’-]*(?:[,;:]?[ \t]+[A-Za-z][A-Za-z0-9'’-]*)*[.!?]?/g,
};
function addSayButtons(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  // 泰文版：只含拉丁字母（含聲調符號）的斜體就是羅馬拼音，標上 class 讓它用拼音色、不傾斜
  if (lang === "th") {
    tpl.content.querySelectorAll("em, i").forEach((el) => {
      if (/[A-Za-z]/.test(el.textContent) && /^[\s\wÀ-ʯ̀-ͯḀ-ỿ'’.,?!()\/-]+$/.test(el.textContent)) el.classList.add("rom");
    });
  }
  tpl.content.querySelectorAll(SAY_BLOCKS).forEach((el) => {
    // 這一層自己的文字節點（不含巢狀區塊），依序串成一段字串來找泰文
    const nodes = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) nodes.push(c);
        else if (c.nodeType === 1 && !SKIP_IN_OWN_TEXT.test(c.tagName)) walk(c);
      }
    };
    walk(el);
    const starts = [];
    let full = "";
    for (const n of nodes) { starts.push(full.length); full += n.nodeValue; }
    // 每一段泰文各放一個按鈕，只念那一段。從後往前插入，前面的位置才不會被改動
    const runs = [...full.matchAll(SAY_RUN[lang])];
    for (const m of runs.reverse()) {
      let i = starts.length - 1;
      while (starts[i] > m.index) i--; // 這段泰文開頭落在哪個文字節點（可能跨粗體／斜體等標籤）
      const node = nodes[i];
      const off = m.index - starts[i];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "say";
      b.title = "發音";
      b.dataset.say = m[0];
      b.innerHTML = ICON.play;
      node.parentNode.insertBefore(b, off ? node.splitText(off) : node);
    }
  });
  return tpl.innerHTML;
}// AI 回答常夾帶 LaTeX 符號（例如 $\rightarrow$），Markdown 不認得，先轉成對應的符號再渲染。
// 只處理「整段 $...$ 或 \(...\) 裡只有一個符號指令」的情況，程式碼區塊與行內程式碼不動。\n// 從網頁貼上時 Markdown 轉換會把反斜線加倍（$\\rightarrow$），所以反斜線允許一個以上。
const LATEX_SYMBOLS = {
  rightarrow: "→", to: "→", longrightarrow: "⟶", Rightarrow: "⇒", Longrightarrow: "⟹",
  leftarrow: "←", gets: "←", Leftarrow: "⇐", leftrightarrow: "↔", Leftrightarrow: "⇔",
  uparrow: "↑", downarrow: "↓", mapsto: "↦",
  times: "×", div: "÷", pm: "±", mp: "∓", cdot: "·", approx: "≈", neq: "≠", ne: "≠", leq: "≤", le: "≤", geq: "≥", ge: "≥",
  checkmark: "✓", ldots: "…", dots: "…", infty: "∞", degree: "°",
};
function convertLatexSymbols(src) {
  return src
    .split(/(```[\s\S]*?```|`[^`\n]*`)/) // 奇數索引是程式碼片段，保持原樣
    .map((part, i) => (i % 2 ? part : part.replace(
      /\$\s*\\+([A-Za-z]+)\s*\$|\\+\(\s*\\+([A-Za-z]+)\s*\\+\)/g,
      (m, a, b) => LATEX_SYMBOLS[a || b] ?? m,
    )))
    .join("");
}
// 修復被換行拆壞的表格列：AI 回答複製出來時，儲存格內的換行（原本是 <br>）會變成真的換行，
// 例如 `| a | b | c |` 後面接著好幾行文字、最後一行才有單獨的 `|`，表格就會斷掉。
// 只在「往後找得到剛好補齊欄位數的結尾 |」時才合併，沒有把握就不動，避免弄壞正常內容。
function countPipes(s) { // 欄位分隔的 |（不含被跳脫的 \| 與行內程式碼裡的）
  let n = 0, code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "`") code = !code;
    else if (c === "\\") i++;
    else if (c === "|" && !code) n++;
  }
  return n;
}
function repairTables(src) {
  const lines = src.split("\n");
  const out = [];
  const isSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
  let inFence = false;
  let cols = 0; // 目前所在表格的欄數；0 表示不在表格內
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) { inFence = !inFence; cols = 0; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    if (!cols) {
      if (t.startsWith("|") && i + 1 < lines.length && isSep(lines[i + 1]) && lines[i + 1].includes("-")) {
        cols = lines[i + 1].split("|").filter((c) => c.trim()).length;
        out.push(line, lines[i + 1]);
        i++;
      } else out.push(line);
      continue;
    }
    if (!t.startsWith("|")) { cols = 0; out.push(line); continue; } // 表格結束
    const need = cols + 1; // 完整的列有「欄數 + 1」個 |
    let have = countPipes(t);
    if (have < need) {
      const extra = [];
      let j = i + 1;
      let merged = null;
      for (; j < lines.length && j <= i + 40; j++) {
        const nl = lines[j].trim();
        const np = countPipes(nl);
        if (np === 0) { if (nl) extra.push(nl); continue; }
        if (have + np === need && np === 1 && nl.endsWith("|")) { // 補上結尾的 |
          const tail = nl.slice(0, -1).trim();
          let k = j + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          // 結尾必須是單獨的 |，或後面緊接著下一列表格；否則只是剛好以 | 結尾的一般文字，不動
          if (!tail || (k < lines.length && lines[k].trim().startsWith("|"))) {
            if (tail) extra.push(tail);
            merged = `${t} ${extra.join("<br>")} |`;
          }
        }
        break;
      }
      if (merged) { out.push(merged); i = j; continue; }
    }
    out.push(line);
  }
  return out.join("\n");
}

const md = (s) => addSayButtons(DOMPurify.sanitize(marked.parse(repairTables(convertLatexSymbols(s || "")), { breaks: true })));
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
  archive: svg('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/>'),
  del: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>'),
};

/* ---------- 主題 ---------- */
// 預設白天模式（不跟隨系統）；選擇後會記住。index.html 的內嵌腳本會在畫面渲染前先套用已存的主題。
// 新增主題：這裡加一筆，並在 style.css 加上 :root[data-theme="id"] 變數區塊，另外把 id 加進 index.html 的 THEME_IDS。
const THEMES = [
  { id: "light", name: "默認", sw: ["#e5e5e5", "#3566c9"] },
  { id: "hollow", name: "Hollow Knight", sw: ["#0b0e16", "#bcd6f0", "#7fc8c0"] },
  { id: "cyberpunk", name: "Cyberpunk 2077", sw: ["#0a0a0f", "#fcee0a", "#00f0ff"] },
  { id: "expedition", name: "Expedition 33", sw: ["#0e1424", "#d8b25a", "#9cc4e4"] },
  { id: "confluence", name: "Confluence", sw: ["#ffffff", "#0c66e4", "#172b4d"] },
  { id: "notion", name: "Notion", sw: ["#ffffff", "#37352f", "#2383e2"] },
  { id: "obsidian", name: "Obsidian", sw: ["#1e1e1e", "#7f6df2", "#86b6f0"] },
];
const currentTheme = () => document.documentElement.dataset.theme || "light";
function renderThemeMenu() {
  $("themeMenu").innerHTML = THEMES.map((t) => `
    <button data-theme="${t.id}"${t.id === currentTheme() ? ' class="on"' : ""}>
      <span class="sw">${t.sw.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
      <span class="nm">${t.name}</span><span class="ck">✓</span>
    </button>`).join("");
}
function setTheme(id) {
  if (!THEMES.some((t) => t.id === id)) id = "light";
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem("theme", id); } catch (e) {}
  renderThemeMenu();
}
$("themeBtn").onclick = (e) => {
  e.stopPropagation();
  renderThemeMenu();
  $("themeMenu").hidden = !$("themeMenu").hidden;
};
$("themeMenu").onclick = (e) => {
  const b = e.target.closest("button[data-theme]");
  if (!b) return;
  setTheme(b.dataset.theme);
  $("themeMenu").hidden = true;
};
document.addEventListener("click", (e) => { if (!e.target.closest(".themepick")) $("themeMenu").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("themeMenu").hidden = true; });

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

function applyLang() {
  cards = raw.cards.filter((d) => langOf(d) === lang);
  videos = raw.videos.filter((d) => langOf(d) === lang);
  articles = raw.articles.filter((d) => langOf(d) === lang);
}

// 依目前語言更新畫面上與語言有關的文字與欄位
function applyLangUI() {
  const active = (signedIn || guest) && langChosen;
  document.body.classList.toggle("lang-en", lang === "en");
  $("siteTitle").textContent = active ? L().site : "語言學習";
  document.title = $("siteTitle").textContent;
  $("lblTerm").textContent = $("vLblTerm").textContent = L().term;
  $("lblMeaning").textContent = $("vLblMeaning").textContent = L().meaning;
  for (const id of ["fThai", "vThai", "aTitle", "aBody"]) $(id).lang = lang;
  $("maskBtn").title = `遮罩：隱藏${L().term}${L().roman ? "與拼音" : ""}，點一下卡片顯示答案`;
  $("importHint").innerHTML = L().roman
    ? "一行一筆：<code>泰文 | 羅馬拼音 | 英文</code>（也可用 Tab 分隔，可直接從試算表貼上）。泰文後面的詞性如 <code>(v)</code> 會自動移到英文後面。"
    : "一行一筆：<code>英文 | 中文</code>（也可用 Tab 分隔，可直接從試算表貼上）。英文後面的詞性如 <code>(v)</code> 會自動移到中文後面。";
  $("importText").placeholder = L().roman ? "นั่ง | nâng | sit\nยืน (v) | yuuen | stand" : "borrow (v) | 借\nCan I borrow some money? | 我可以借一點錢嗎？";
  $("search").placeholder = searchHint();
  document.querySelectorAll("#langPick [data-lang]").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
}
const searchHint = () => ({
  cards: `搜尋${L().term} / ${L().roman ? "拼音 / " : ""}${L().meaning}…`,
  videos: "搜尋影片標題 / 標籤…",
  articles: "搜尋文章標題 / 內容 / 標籤…",
}[page] || "");

function chooseLang(l) {
  lang = l;
  langChosen = true;
  try { localStorage.setItem("lang", l); sessionStorage.setItem("langChosen", "1"); } catch (e) {}
  selected.clear();
  tagFilter.clear();
  revealed.clear();
  opened.clear();
  quizIds = [];
  $("search").value = "";
  applyLang();
  applyAuthUI();
  navigate("home");
}
function resetLangChoice() {
  langChosen = false;
  try { sessionStorage.removeItem("langChosen"); } catch (e) {}
}
$("langPick").onclick = (e) => {
  const b = e.target.closest("button[data-lang]");
  if (b) chooseLang(b.dataset.lang);
};
$("langBtn").onclick = () => {
  setSidebar(false);
  closeVideo();
  closeArticle();
  resetLangChoice();
  applyAuthUI();
};

const watch = (name, label) =>
  onSnapshot(query(collection(db, name), orderBy("createdAt", "desc")), (snap) => {
    raw[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    applyLang();
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
    watch("cards", "字卡"),
    watch("videos", "影片"),
    watch("articles", "文章"),
  ];
}
function stopData() {
  unsubs.forEach((u) => u());
  unsubs = [];
  raw.cards = raw.videos = raw.articles = [];
  cards = [];
  videos = [];
  articles = [];
  closeVideo();
  closeArticle();
}

function applyAuthUI() {
  const active = signedIn || guest;
  const needLang = active && !langChosen; // 登入後的第一步：選擇練習哪一種語言
  document.body.classList.toggle("guest", guest && !signedIn);
  $("app").hidden = !active || needLang;
  $("nav").hidden = !active || needLang;
  $("langPick").hidden = !needLang;
  $("langBtn").hidden = !active;
  $("loginHint").hidden = active;
  applyLangUI();
  $("authBox").innerHTML = signedIn
    ? `<button id="outBtn">登出</button>`
    : guest
      ? `<button id="outBtn">離開訪客模式</button>`
      : `<button id="inBtn">Google 登入</button>`;
  if ($("outBtn")) $("outBtn").onclick = () => (signedIn ? signOut(auth) : exitGuest());
  if ($("inBtn")) $("inBtn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider());
  if (guest && !signedIn) {
    if (["weak", "archived"].includes(typeFilter)) setTypeFilter("all"); // 「需加強」「封存」是擁有者的個人標記，訪客看不到
    if (page === "quiz") navigate("home");
  }
}

function enterGuest() {
  guest = true;
  try { sessionStorage.setItem("guest", "1"); } catch (e) {}
  resetLangChoice();
  startData();
  applyAuthUI();
  go(location.hash.slice(1));
}
function exitGuest() {
  guest = false;
  try { sessionStorage.removeItem("guest"); } catch (e) {}
  resetLangChoice();
  stopData();
  applyAuthUI();
}
$("guestBtn").onclick = enterGuest;
$("loginBtn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider());

// 登入有效期：自「上次登入」起 1 天（Firestore 規則用 auth_time 做同樣的限制，這裡負責讓畫面一起登出）
const SESSION_MS = 24 * 60 * 60 * 1000;
let sessionTimer = null;
const sessionLeftMs = (authTime) => new Date(authTime).getTime() + SESSION_MS - Date.now();

// 回傳 true 表示仍有效；過期就登出並提示。有效時會排程在到期那一刻自動登出。
async function enforceSession(user) {
  clearTimeout(sessionTimer);
  if (!user) return true;
  const left = sessionLeftMs((await user.getIdTokenResult()).authTime);
  if (left <= 0) {
    await signOut(auth);
    $("loginMsg").textContent = "登入已超過 1 天，已自動登出，請重新登入。";
    return false;
  }
  sessionTimer = setTimeout(() => enforceSession(auth.currentUser), left + 1000);
  return true;
}
// 睡眠或背景分頁會讓計時器延遲，回到分頁時再檢查一次
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && auth.currentUser) enforceSession(auth.currentUser);
});

onAuthStateChanged(auth, async (user) => {
  if (user && !(await enforceSession(user))) return; // 過期：已登出，會再觸發一次 user=null 的回呼
  if (user) $("loginMsg").textContent = "";
  signedIn = !!user;
  if (signedIn) {
    guest = false;
    try { sessionStorage.removeItem("guest"); } catch (e) {}
    startData();
  } else if (guest) {
    startData(); // 重新整理後仍停留在訪客模式
  } else {
    resetLangChoice();
    stopData();
  }
  applyAuthUI();
});

/* ---------- 語音 ---------- */
// 固定用 Google 翻譯的語音（依目前語言：泰語或英語；非官方網址，若失效改寫這個函式即可），所有裝置聽到的聲音一致。
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
    audio = new Audio(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${L().tts}&q=${encodeURIComponent(chunks[i])}`);
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

/* ---------- 手機版側邊欄 ---------- */
const setSidebar = (open) => {
  document.body.classList.toggle("sidebar-open", open);
  $("menuBtn").setAttribute("aria-expanded", String(open));
};
$("menuBtn").onclick = () => setSidebar(!document.body.classList.contains("sidebar-open"));
$("sideOverlay").onclick = () => setSidebar(false);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setSidebar(false); });
$("authBox").addEventListener("click", (e) => { if (e.target.closest("button")) setSidebar(false); });

/* ---------- 頁面切換（#home / #cards / #videos / #articles） ---------- */
function applyView() {
  $("home").hidden = page !== "home";
  $("quiz").hidden = page !== "quiz";
  $("browse").hidden = page === "home" || page === "quiz" || !!viewing;
  $("player").hidden = viewing !== "video";
  $("reader").hidden = viewing !== "article";
  $("selBar").hidden = selected.size === 0 || $("browse").hidden; // 只在列表頁顯示
}

function go(p) {
  if (!PAGES.includes(p)) p = "home";
  if (readOnly() && p === "quiz") p = "home"; // 訪客不能做隨堂測驗
  if (p !== page) {
    selected.clear();
    updateBar();
    tagFilter.clear();
    $("search").value = "";
  }
  setSidebar(false); // 換頁後收起手機版側邊欄
  closeVideo();
  closeArticle();
  if (p === "quiz" && page !== "quiz") newQuiz(); // 每次進入測驗都重新抽題
  page = p;
  syncMask();
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.page === p));
  $("typeTabs").hidden = p !== "cards"; // 單字／句子分頁只用於字卡
  $("importBtn").hidden = p !== "cards"; // 批次匯入只用於字卡
  $("smartBtn").hidden = p !== "cards" && p !== "articles";
  $("archiveBtn").hidden = p !== "cards"; // 封存只用於字卡
  $("archiveHint").hidden = p !== "cards";
  $("search").placeholder = searchHint();
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
  $("selBar").hidden = selected.size === 0 || $("browse").hidden;
  $("selCount").textContent = `已選 ${selected.size} 項`;
  $("editBtn").disabled = selected.size !== 1;
  $("delBtn").disabled = selected.size === 0;
  $("delBtn").textContent = selected.size > 1 ? `刪除 (${selected.size})` : "刪除";
  $("archiveBtn").disabled = selected.size === 0;
  $("archiveBtn").textContent = (typeFilter === "archived" ? "取消封存" : "封存") + (selected.size > 1 ? ` (${selected.size})` : "");
  const n = visible.filter((c) => selected.has(c.id)).length;
  $("selAll").checked = visible.length > 0 && n === visible.length;
  $("selAll").indeterminate = n > 0 && n < visible.length;
}

function renderHome() {
  $("home").innerHTML = `
    <h2 class="welcome">歡迎回來</h2>
    <p class="muted">今天想學點什麼？（目前練習：${L().name}）</p>
    <div class="tiles">
      <button class="tile" data-go="cards"><b>${cards.filter((c) => !c.archived).length}</b><span>字卡</span></button>
      <button class="tile" data-go="weak"><b>${cards.filter((c) => c.weak && !c.archived).length}</b><span>需加強</span></button>
      <button class="tile" data-go="archived"><b>${cards.filter((c) => c.archived).length}</b><span>封存</span></button>
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
  if (t && ["weak", "archived"].includes(t.dataset.go)) { // 直接進字卡頁的「需加強」「封存」分頁
    if (page !== "cards") navigate("cards");
    return setTypeFilter(t.dataset.go);
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
  const pool = cards.filter((c) => c.english && inQuizScope(c)); // 沒有英文就沒辦法出題
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
    el.classList.toggle("archived", !!c?.archived);
    const ab = el.querySelector('[data-q="archive"]');
    if (ab) { ab.textContent = c?.archived ? "取消封存" : "封存"; ab.classList.toggle("on", !!c?.archived); }
    el.querySelector('[data-q="ok"]')?.classList.toggle("on", r === "ok");
    el.querySelector('[data-q="weak"]')?.classList.toggle("on", r === "weak");
  });
  $("quiz").querySelectorAll("[data-scope]").forEach((b) => b.classList.toggle("on", b.dataset.scope === quizScope));
}

function renderQuiz(force = false) {
  if (!quizIds.length && cards.length) newQuiz(); // 重新整理停在測驗頁時，等資料載入後再抽題
  const key = quizIds.join();
  if (!force && $("quiz").dataset.ids === key && $("quiz").children.length) return updateQuizMarks();
  $("quiz").dataset.ids = key;
  const list = quizIds.map((id) => cards.find((c) => c.id === id)).filter(Boolean);
  const empty = { weak: "還沒有標記為「需加強」的字卡。", archived: "還沒有封存的字卡。" }[quizScope] || "還沒有可出題的字卡（需要有英文），先去新增吧。";
  $("quiz").innerHTML = `
    <div class="readerbar">
      <button data-act="home">← 首頁</button>
      <strong class="vtitle">隨堂測驗（${list.length} 題）</strong>
      <button data-act="again">再抽一組</button>
    </div>
    <div class="quizscope">
      <span class="muted">抽題範圍</span>
      ${QUIZ_SCOPES.map(([k, n]) => `<button data-scope="${k}">${n}</button>`).join("")}
    </div>
    <p class="muted quizhint">看${L().meaning}回想${L().term}，點一下卡片顯示答案，再標記「記得了」「需加強」，或把已經確定學會的「封存」。</p>
    ${list.map((c) => `
      <div class="card quiz${c.weak ? " weak" : ""}${c.archived ? " archived" : ""}${revealed.has(c.id) ? " reveal" : ""}${opened.has(c.id) ? " open" : ""}" data-id="${c.id}">
        <div class="line quizline">
          <div class="english"><span class="flag" title="需加強">${ICON.flag}</span><span class="arch" title="已封存">${ICON.archive}</span>${esc(c.english)}</div>
          <div class="words">
            <div class="thai">${esc(c.thai)}</div>
            ${L().roman ? `<div class="roman">${esc(c.roman)}</div>` : ""}
          </div>
          <button class="icon play" data-act="play1" title="播放">${ICON.play}</button>
        </div>
        <div class="quizact">
          <button data-q="ok">記得了</button>
          <button data-q="weak">需加強</button>
          <button data-q="archive">封存</button>
          <input class="qnote" placeholder="備註（例如容易搞混的地方）" value="${esc(c.note || "")}">
        </div>
        ${c.detail ? `<div class="detail"${opened.has(c.id) ? "" : " hidden"}>${md(c.detail)}</div>` : ""}
      </div>`).join("") || `<p>${empty}</p>`}`;
  updateQuizMarks();
}

async function markQuiz(id, kind) {
  if (readOnly()) return;
  const c = cards.find((x) => x.id === id);
  if (!c || (kind !== "archive" && quizResult.get(id) === kind)) return;
  let data;
  if (kind === "archive") { // 封存／取消封存（封存時一併取消需加強）
    data = c.archived ? { archived: false } : { archived: true, weak: false };
  } else {
    quizResult.set(id, kind);
    // 需加強：記一次「答錯」，如果它原本已封存就取消封存（其實還沒學會）；記得了：取消需加強標記（累計次數保留）
    data = kind === "weak" ? { weak: true, misses: (c.misses || 0) + 1, archived: false } : { weak: false };
  }
  Object.assign(c, data); // 先更新本地，畫面立即反應
  updateQuizMarks();
  try { await updateDoc(doc(db, "cards", id), data); } catch (err) { alert("儲存失敗：" + err.message); }
}

$("quiz").onclick = (e) => {
  const b = e.target.closest("button[data-act], button[data-q], button[data-scope]");
  if (b?.dataset.act === "home") return navigate("home");
  if (b?.dataset.act === "again") { newQuiz(); return renderQuiz(true); }
  if (b?.dataset.scope) {
    quizScope = b.dataset.scope;
    try { localStorage.setItem("quizScope", quizScope); } catch (err) {}
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
  // 字卡頁的標籤列只統計目前看的範圍（封存分頁 vs 一般）
  renderTagBar(page === "cards" ? cards.filter((c) => !!c.archived === (typeFilter === "archived")) : pool);
  const q = $("search").value.trim().toLowerCase();
  if (page === "videos") return renderVideos(q);
  if (page === "articles") return renderArticles(q);
  $("weakTab").textContent = `需加強 ${cards.filter((c) => c.weak && !c.archived).length}`;
  $("archivedTab").textContent = `封存 ${cards.filter((c) => c.archived).length}`;
  // 封存的字卡只出現在「封存」分頁，不顯示在其他列表
  const inTab = (c) => (typeFilter === "archived"
    ? !!c.archived
    : !c.archived && (typeFilter === "all" || (typeFilter === "weak" ? c.weak : typeOf(c) === typeFilter)));
  const list = visible = cards.filter((c) =>
    inTab(c) && matchTags(c) &&
    (!q || [c.thai, c.roman, c.english, ...tagsOf(c)].join(" ").toLowerCase().includes(q)));
  $("cards").innerHTML = list.map((c) => `
    <div class="card${c.weak ? " weak" : ""}${c.archived ? " archived" : ""}${revealed.has(c.id) ? " reveal" : ""}${opened.has(c.id) ? " open" : ""}" data-id="${c.id}">
      <div class="line">
        <input type="checkbox" class="sel" ${selected.has(c.id) ? "checked" : ""}>
        <button class="icon play" data-act="play1" title="播放">${ICON.play}</button>
        <div class="words">
          <div class="thai">${esc(c.thai)}</div>
          ${L().roman ? `<div class="roman">${esc(c.roman)}</div>` : ""}
        </div>
        <div class="english"><span class="flag" title="需加強">${ICON.flag}</span><span class="arch" title="已封存">${ICON.archive}</span>${esc(c.english)}</div>
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
// 封存：從一般列表收起來但不刪除（測驗仍可選「封存」範圍抽考）；在封存分頁則是取消封存
$("archiveBtn").onclick = async () => {
  if (readOnly() || page !== "cards") return;
  const items = cards.filter((c) => selected.has(c.id));
  if (!items.length) return;
  const toArchive = typeFilter !== "archived";
  const batch = writeBatch(db);
  items.forEach((c) => batch.update(doc(db, "cards", c.id), toArchive ? { archived: true, weak: false } : { archived: false }));
  try {
    await batch.commit();
    selected.clear();
  } catch (err) {
    alert("操作失敗：" + err.message);
  }
};
$("editBtn").onclick = () => {
  if (readOnly()) return;
  const item = poolOf().find((x) => selected.has(x.id));
  if (item) OPEN_DLG[page](item);
};
// 快捷鍵一律是 Alt + 字母：N 新增、M 編輯（需先勾選一項）、A 封存；Esc 取消勾選。
// 用 e.code 判斷實體按鍵，Mac 的 Option 組合字不會干擾。
const setKeyTip = (open) => {
  $("keyTip").classList.toggle("open", open);
  $("keyTipBtn").setAttribute("aria-expanded", open);
};
$("keyTipBtn").onclick = (e) => { e.stopPropagation(); setKeyTip(!$("keyTip").classList.contains("open")); };
document.addEventListener("click", () => setKeyTip(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setKeyTip(false); });
const SHORTCUTS ={ KeyN: "addBtn", KeyM: "editBtn", KeyA: "archiveBtn" };
document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]") || readOnly() || $("browse").hidden) return;
  const btn = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && $(SHORTCUTS[e.code] || "");
  if (btn) {
    e.preventDefault();
    if (!btn.hidden && !btn.disabled) btn.click();
  } else if (e.key === "Escape" && selected.size && !e.target.closest?.("input, textarea")) {
    selected.clear();
    render();
  }
});
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
  $("fArchived").checked = !!c?.archived;
  $("fThai").value = termClean(c?.thai ?? "");
  $("fRoman").value = c?.roman ?? "";
  $("fEnglish").value = c?.english ?? "";
  $("fDetail").value = c?.detail ?? "";
  cardTags.set(c?.tags);
  $("dlg").showModal();
}
// 泰文不用空白分詞，貼上時自動移除空白；英文要保留空白，只去掉頭尾
const termClean = (s) => (lang === "th" ? stripSpaces(s) : s.trim());
$("fThai").addEventListener("input", (e) => {
  if (e.isComposing || lang !== "th") return;
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
// 表格儲存格裡的換行（<br> 或多個段落）改輸出成 <br>，否則 Markdown 表格會被斷行弄壞
turndown.addRule("tableCellNoBreak", {
  filter: ["th", "td"],
  replacement(content, node) {
    const flat = content.trim().replace(/\s*\n+\s*/g, "<br>").replace(/(?<!\\)\|/g, "\\|");
    const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
    return (index === 0 ? "| " : " ") + flat + " |";
  },
});
// AI（Gemini）網頁複製出來的 HTML 常把「一行一行」的版面用文字裡的換行、或 display:block 的行內元素表現，
// 轉成 Markdown 時就全黏成一行（例如 **例句****泰文**拼音 中文）。aiReply 模式先把這些換行補成 <br>，再做一次保險修補。
const INLINE_TAGS = new Set(["SPAN", "B", "STRONG", "I", "EM", "A", "CODE", "U"]);
function keepAiLineBreaks(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const t of texts) {
    if (t.parentElement.closest("pre, code") || !t.nodeValue.includes("\n")) continue;
    const parts = t.nodeValue.split(/[ \t]*\n[ \t\n]*/);
    const frag = doc.createDocumentFragment();
    parts.forEach((p, i) => { if (i) frag.append(doc.createElement("br")); if (p) frag.append(p); });
    t.replaceWith(frag);
  }
  for (const el of doc.body.querySelectorAll("[style]")) {
    if (INLINE_TAGS.has(el.tagName) && /display:\s*(block|flex|list-item)/i.test(el.getAttribute("style")) && el.nextSibling?.nodeName !== "BR") {
      el.after(doc.createElement("br"));
    }
  }
  return doc.body.innerHTML;
}
// 保險：相鄰的兩段粗體（****）、粗體後面緊接斜體拼音（**_），一定是不同行
// 另外，上一行是粗體泰文、這一行開頭是「_拼音_ 中文」時，拼音與中文翻譯也是不同行
const fixFlatMarkdown = (md) => {
  // 「例句」標籤如果接在意思說明的句尾（……旅行前。**例句**），要另起一段
  const lines = md.replace(/\*\*\*\*/g, "**\n**").replace(/(\*\*)(?=_)/g, "$1\n").replace(/([^\n])[ \t]*(\*\*例句\*\*)/g, "$1\n\n$2")
    .replace(/([。！？])[ \t]*(?=\*\*[^*\n]*[฀-๿]{6})/g, "$1\n\n") // 句號後直接接粗體泰文例句（沒有標籤）時也另起一段
    .split("\n");
  return lines.flatMap((line, i) => {
    const m = line.match(/^(\s*_[^_\n]+_)[ \t]+(?=[㐀-鿿])/);
    return m && i && lines[i - 1].includes("**") && /[฀-๿]/.test(lines[i - 1]) ? [m[1], line.slice(m[0].length)] : [line];
  }).join("\n");
};

function enableRichPaste(el, aiReply = false) {
  el.addEventListener("paste", (e) => {
    const html = e.clipboardData.getData("text/html");
    if (!html) return; // 純文字照常貼上
    e.preventDefault();
    let md = turndown.turndown(aiReply ? keepAiLineBreaks(html) : html).trim();
    if (aiReply) md = fixFlatMarkdown(md);
    el.setRangeText(md, el.selectionStart, el.selectionEnd, "end");
    el.dispatchEvent(new Event("input", { bubbles: true })); // setRangeText 不會自動觸發 input，要讓監聽的功能（如智慧貼上預覽）知道內容變了
  });
}
enableRichPaste($("fDetail"));
enableRichPaste($("aBody"));

$("cancelBtn").onclick = () => $("dlg").close();
$("form").onsubmit = async () => {
  const data = {
    lang,
    type: $("fType").value,
    thai: termClean($("fThai").value),
    roman: L().roman ? $("fRoman").value.trim() : "",
    english: $("fEnglish").value.trim(),
    detail: $("fDetail").value,
    note: $("fNote").value.trim(),
    archived: $("fArchived").checked,
    weak: $("fArchived").checked ? false : $("fWeak").checked, // 封存的字卡不算需加強
    tags: cardTags.get(),
  };
  if (editingId) await updateDoc(doc(db, "cards", editingId), data);
  else await addDoc(collection(db, "cards"), { ...data, createdAt: serverTimestamp() });
};

/* ---------- 匯出備份（JSON） ---------- */
function exportBackup() {
  if (readOnly()) return;
  const iso = (t) => (t?.toDate ? t.toDate().toISOString() : null);
  const data = { // 兩種語言的資料都會匯出（以 lang 區分）
    exportedAt: new Date().toISOString(),
    cards: raw.cards.map((c) => ({
      id: c.id, lang: langOf(c), type: typeOf(c), thai: c.thai ?? "", roman: c.roman ?? "", english: c.english ?? "",
      detail: c.detail ?? "", tags: tagsOf(c), note: c.note ?? "", weak: !!c.weak, archived: !!c.archived, misses: c.misses ?? 0,
      createdAt: iso(c.createdAt),
    })),
    videos: raw.videos.map((v) => ({
      id: v.id, lang: langOf(v), title: v.title ?? "", url: v.url ?? "", videoId: v.videoId ?? "",
      cues: v.cues ?? [], tags: tagsOf(v), createdAt: iso(v.createdAt),
    })),
    articles: raw.articles.map((a) => ({
      id: a.id, lang: langOf(a), title: a.title ?? "", subtitle: a.subtitle ?? "", body: a.body ?? "", tags: tagsOf(a),
      createdAt: iso(a.createdAt),
    })),
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = `language-learning-${data.exportedAt.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- 批次匯入字卡 ---------- */
// 一行一筆：泰文 | 拼音 | 英文（或 Tab 分隔）。泰文後面的 (v)(n)(adj) 詞性會併到英文後面。
function parseImport(text) {
  const rows = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split(/\t|\|/).map((s) => s.trim());
    // 泰文：泰文 | 拼音 | 英文；英文：英文 | 中文（沒有拼音欄）
    let [thai = "", roman = "", english = ""] = L().roman ? cols : [cols[0], "", cols[1]];
    const m = thai.match(/^(.*?)\s*[（(]\s*([A-Za-z.]+)\s*[)）]\s*$/);
    const pos = m ? m[2] : "";
    if (m) thai = m[1];
    thai = termClean(thai);
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
      lang, type, ...r, detail: "", tags, createdAt: Timestamp.fromMillis(base - i),
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

/* ---------- 智慧貼上：把 AI 的整段回覆拆成欄位，預覽後一次新增 ---------- */
// 回覆格式（提示詞會要求 AI 照這個格式）：每張卡開頭是「欄位名: 內容」的幾行，後面是詳細說明（Markdown）；多張卡之間用 --- 隔開。
const smartLabels = () => ({
  ...(L().roman
    ? {
      thai: ["泰文", "泰語", "泰语", "thai", "單字", "詞彙", "詞語"],
      roman: ["羅馬拼音", "拼音", "羅馬", "romanization", "romanisation", "roman"],
      english: ["英文", "english", "意思", "翻譯", "meaning", "translation", "中文"],
    }
    : {
      thai: ["英文", "english", "單字", "詞彙", "word", "term"],
      roman: [],
      english: ["中文", "意思", "翻譯", "meaning", "translation"],
    }),
  type: ["類型", "分類", "type"],
  tags: ["標籤", "tags", "tag"],
  note: ["備註", "note", "notes"],
});
const SMART_HEAD = /^[\s>*•-]*\**\s*([^:：*\n]{1,24}?)\s*\**\s*[:：]\s*\**\s*(.*)$/;
const SMART_SEP = /^\s*(?:-{3,}|_{3,}|\*{3,}|(?:\*\s+){2,}\*)\s*$/; // 從網頁複製時分隔線會變成 * * *
const SMART_DETAIL_HEAD = /^#{1,6}\s*\**\s*(詳細說明|详细说明|說明|details?|explanation)\s*\**\s*[:：]?\s*$/i;

function parseSmart(text) {
  const lookup = new Map();
  for (const [field, names] of Object.entries(smartLabels())) for (const n of names) lookup.set(n.toLowerCase(), field);
  const head = (line) => {
    const m = line.match(SMART_HEAD);
    const field = m && lookup.get(m[1].trim().toLowerCase());
    return field ? [field, m[2].replace(/\s*\*+\s*$/, "").trim()] : null;
  };
  // 從網頁複製時欄位之間的換行常被吃掉，變成「泰文: x 拼音: y 英文: z」擠在同一行；在每個欄位名稱前面把它們拆開
  const names = [...lookup.keys()].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const SPLIT = new RegExp(`\\s+(?=\\**(?:${names})\\**\\s*[:：])`, "i");
  // 依分隔線切成一張一張；只有分隔線後面緊接著「泰文／英文」欄位才算新卡，說明裡的分隔線不會被誤切
  const lines = text.replace(/\r/g, "").split("\n");
  const chunks = [];
  let cur = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (!fence && SMART_SEP.test(lines[i])) {
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && head(lines[k])?.[0] === "thai") { chunks.push(cur); cur = []; continue; }
    }
    cur.push(lines[i]);
  }
  chunks.push(cur);

  const rows = [];
  let skipped = 0;
  for (const ch of chunks) {
    if (!ch.some((l) => l.trim())) continue;
    const card = { thai: "", roman: "", english: "", type: "", tags: "", note: "" };
    let found = false;
    let i = 0;
    for (; i < ch.length; i++) {
      if (!ch[i].trim()) continue;
      if (head(ch[i])) { const parts = ch[i].split(SPLIT); if (parts.length > 1) ch.splice(i, 1, ...parts); }
      const h = head(ch[i]);
      if (h) { found = true; card[h[0]] = h[1]; continue; }
      if (found) break; // 欄位區結束，後面都是詳細說明
      // 還沒遇到欄位前的開場白就略過
    }
    const body = ch.slice(i);
    while (body.length && !body[0].trim()) body.shift();
    if (body.length && SMART_DETAIL_HEAD.test(body[0].trim())) body.shift();
    card.detail = body.join("\n").trim();
    card.thai = termClean(card.thai);
    if (!card.thai) { skipped++; continue; }
    card.tags = card.tags ? card.tags.split(/[,，、]/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean) : [];
    if (!L().roman) card.roman = "";
    if (/句|sentence/i.test(card.type)) card.type = "sentence";
    else if (/單字|词|字|word/i.test(card.type)) card.type = "word";
    else { // AI 沒給類型就用長度猜：詞組（英文版 3 個字以上、泰文版英文意思 4 個字以上）視為句子
      const words = (L().roman ? card.english : card.thai).trim().split(/\s+/).filter(Boolean).length;
      card.type = words >= (L().roman ? 4 : 3) ? "sentence" : "word";
    }
    rows.push(card);
  }
  return { rows, skipped };
}

// words：使用者輸入的單字（一行一個），會附在提示詞最後面
const smartPrompt = (words = "") => (smartTemplate() + (words ? `

以下是我要查的${L().term}（一行一個）：
${words}` : ""));
const smartTemplate = () => L().roman
  ? `我只會給你泰文單字或句子（可能一次多個，一行一個）。請你補上泰國人實際的羅馬拼音（含聲調符號）與英文意思，說明用繁體中文，並「嚴格照下面格式」輸出，不要有開場白或結尾；有多個項目時，每個項目之間用單獨一行 --- 隔開。

泰文: （原文）
拼音: （你補上的羅馬拼音）
英文: （你補上的英文意思）
類型: 單字 或 句子

## 詳細說明
我已經不是初學者：請不要寫發音說明（我另有語音可聽）、基本禮貌與稱呼（例如 ครับ／ค่ะ、พี่、น้อง 這類）、基礎文法常識，把篇幅留給下面這些內容。
詳細程度請你自己判斷：多義、用法多、會出現在很多情境的詞（例如 กิน）要完整介紹下面各部分；意思單一、用法單純的詞（例如 แว่นกันแดด）只要簡短寫，保留真正有用的 1–2 個部分（例如詞性、一兩個例句、幾個相關詞），其餘部分整段省略，不要為了湊內容而硬寫。
請用 Markdown 寫，涵蓋下面幾個部分（沒有的部分可以省略）。凡是泰文，一律附羅馬拼音與中文，而且每個泰文詞或句子獨立一行或獨立一格（用清單或表格），不要把多個泰文詞擠在同一句中文裡。
### 詞性與基本用法
### 常見搭配與句型
### 這個詞的情境與相關詞彙
先判斷這個詞最常出現在哪 1–2 個生活情境（例如按摩、點餐、問路、看病），再整理在這個情境裡「會一起用到」的詞，用表格列出（泰文｜拼音｜中文），並盡量涵蓋：感受與程度（舒服、痛、剛好、太用力）、常用動作與要求（輕一點、重一點、這裡、換邊）、相關的人事物與地點、對方可能會問的話與自己的回答。
### 情境短對話
2–3 組，每組 2–4 句，泰文＋拼音＋中文。
### 容易混淆的詞
近義詞、反義詞，說明差別。`
  : `我只會給你英文單字或句子（可能一次多個，一行一個）。請你補上中文意思，說明用繁體中文，並「嚴格照下面格式」輸出，不要有開場白或結尾；有多個項目時，每個項目之間用單獨一行 --- 隔開。

英文: （原文）
中文: （中文意思）
類型: 單字 或 句子

## 詳細說明
我已經不是初學者：請不要寫發音說明（我另有語音可聽）、基礎文法常識與一般禮貌用語，把篇幅留給下面這些內容。
詳細程度請你自己判斷：多義、用法多、會出現在很多情境的詞（例如 take、get）要完整介紹下面各部分；意思單一、用法單純的詞（例如 sunglasses）只要簡短寫，保留真正有用的 1–2 個部分（例如詞性、一兩個例句、幾個相關詞），其餘部分整段省略，不要為了湊內容而硬寫。
請用 Markdown 寫，涵蓋下面幾個部分（沒有的部分可以省略）。凡是英文，一律附中文，而且每個英文詞或句子獨立一行或獨立一格（用清單或表格）。
### 詞性與變化
### 常見搭配與句型
### 這個詞的情境與相關詞彙
先判斷這個詞最常出現在哪 1–2 個生活或工作情境，再整理在這個情境裡「會一起用到」的詞，用表格列出（英文｜中文），並盡量涵蓋：感受與程度、常用動作與要求、相關的人事物與地點、對方可能會問的話與自己的回答。
### 情境短對話
2–3 組，每組 2–4 句，英文＋中文。
### 容易混淆的詞
近義詞、反義詞，說明差別。`;

let smartRows = [];
const smartOff = new Set(); // 預覽裡取消勾選的列
function renderSmart() {
  const { rows, skipped } = parseSmart($("smartText").value);
  smartRows = rows;
  for (const i of [...smartOff]) if (i >= rows.length) smartOff.delete(i);
  $("smartPreview").innerHTML = rows.map((r, i) => `
    <label class="smartrow">
      <input type="checkbox" data-i="${i}" ${smartOff.has(i) ? "" : "checked"}>
      <span class="smartmain"><b>${esc(r.thai)}</b>${r.roman ? ` <span class="roman">${esc(r.roman)}</span>` : ""}
        <span class="smartmeaning">${esc(r.english)}</span></span>
      <span class="smartmeta">${r.type === "sentence" ? "句子" : "單字"}${r.tags.length ? ` · ${esc(r.tags.join("、"))}` : ""}${r.detail ? " · 有說明" : ""}${r.note ? " · 有備註" : ""}</span>
    </label>`).join("");
  const n = rows.length - smartOff.size;
  $("smartCount").textContent = $("smartText").value.trim()
    ? `解析到 ${rows.length} 筆，將新增 ${n} 筆${skipped ? `（${skipped} 段找不到${L().term}欄位，已略過）` : ""}`
    : "";
  $("smartSave").disabled = n === 0;
}
$("smartText").addEventListener("input", () => { smartOff.clear(); renderSmart(); });
$("smartPreview").addEventListener("change", (e) => {
  const i = +e.target.dataset.i;
  e.target.checked ? smartOff.delete(i) : smartOff.add(i);
  renderSmart();
});
enableRichPaste($("smartText"), true);
const openSmartCards = () => {
  if (readOnly()) return;
  $("smartText").value = "";
  $("smartWords").value = "";
  $("smartWordsLbl").textContent = `要查的${L().term}`;
  smartOff.clear();
  renderSmart();
  $("smartDlg").showModal();
};
$("smartCancel").onclick = () => $("smartDlg").close();
$("smartCopy").onclick = async () => {
  const words = $("smartWords").value.split(/\n/).map((w) => w.trim()).filter(Boolean).join("\n");
  try {
    await navigator.clipboard.writeText(smartPrompt(words));
    $("smartCopy").textContent = "已複製 ✓";
  } catch (e) {
    $("smartText").value = smartPrompt(words); // 剪貼簿不可用時放進輸入框讓使用者自己複製
    $("smartText").select();
  }
  setTimeout(() => ($("smartCopy").textContent = "生成提示詞並複製"), 2000);
};
$("smartForm").onsubmit = async (e) => {
  e.preventDefault();
  const rows = smartRows.filter((_, i) => !smartOff.has(i));
  if (!rows.length) return;
  if (rows.length > 400) return alert("一次最多新增 400 筆，請分批");
  const btn = $("smartSave");
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    const base = Date.now();
    rows.forEach((r, i) => batch.set(doc(collection(db, "cards")), {
      lang, type: r.type, thai: r.thai, roman: r.roman, english: r.english, detail: r.detail, note: r.note,
      tags: r.tags, archived: false, weak: false,
      createdAt: Timestamp.fromMillis(base - i), // 依序遞減，列表就維持貼上的順序
    }));
    await batch.commit();
    $("smartDlg").close();
  } catch (err) {
    alert("新增失敗：" + err.message);
  } finally {
    btn.disabled = false;
  }
};

/* ---------- 文章的智慧貼上：輸入主題 → 生成提示詞 → 貼回 AI 的回覆，自動拆出標題／副標題／內文 ---------- */
// 參考既有文章的寫法：課文（逐句拆解）、情境句型清單（計程車、結帳）、速查表＋逐項解說（口頭禪）。
// 結構讓 AI 依主題性質自己選，統一的是：精簡、每個外語詞句獨立一行、附拼音／中文、不寫開場白。
const ART_SIZES = [["精簡", 8], ["標準", 15], ["完整", 25]];

function articlePrompt({ topic, size }) {
  const th = L().roman;
  const n = ART_SIZES.find(([k]) => k === size)?.[1] || 8;
  const w = th ? "泰文" : "英文";
  // 每個外語詞句固定成「粗體原文＋底下兩行（拼音、中文）」，不要「拼音：」「中文：」這類欄位標籤
  const item = th
    ? `-   **泰文詞或句子**
    -   _羅馬拼音_
    -   中文意思`
    : `-   **英文詞或句子**
    -   中文意思`;
  const table = th ? "泰文｜拼音｜中文｜使用情境" : "英文｜中文｜使用情境";
  const lesson = th
    ? `### 第 1 句
-   **A: 泰文句子**
    -   _羅馬拼音_
    -   中文翻譯
    -   **泰文詞** (_拼音_)：中文意思（每句只列 2–4 個值得學的詞，一詞一行）`
    : `### 第 1 句
-   **A: 英文句子**
    -   中文翻譯
    -   **英文詞**：中文意思（每句只列 2–4 個值得學的詞，一詞一行）`;
  return `請針對下面的主題，整理一篇精簡的${w}學習筆記。
主題：${topic || "（請你自行挑一個實用的生活主題）"}
規模：約 ${n} 個詞句項目（對話型則約 ${Math.max(4, Math.round(n / 2))} 句）。

結構請依主題性質從下面三種挑「一種」，不要混用：
1. 情境型主題（例如搭計程車、結帳、點餐）：用「### 1. 情境名稱」分成幾組，每組列出實用的詞與句型，每項照這個格式：
${item}
2. 詞彙或語氣型主題（例如情緒形容詞、口頭禪、量詞）：先給一張速查表（${table}），再用「### 分類」分組、${th ? "「#### N. **泰文詞** (_拼音_)」逐項簡述，拼音放在泰文旁邊的括號裡、不要另起一行" : "「#### N. **英文詞**」逐項簡述"}：用一行文字寫意思與情境（這一行不要夾外語例句）；例句另起一段（與意思說明之間空一行），不要加「例句」標籤或分隔線，直接寫${th ? "三行（不要用清單符號）：粗體泰文句子、斜體拼音、中文翻譯" : "兩行（不要用清單符號）：粗體英文句子、中文翻譯"}，最多一則。
3. 對話型（主題本身就是一段對話、課文，或情境適合用對話呈現）：A、B 兩人的短對話，每句這樣拆：
${lesson}

共同規則：
- 我已經不是初學者：省略太基礎的詞、發音說明、基本禮貌與稱呼、文法長篇大論。
- 內容要自然、貼近母語者平常的說法，不要翻譯腔；寧可少而實用，不要為了湊數量硬寫。
- 凡是${w}一律用粗體，且每個詞或句子獨立一行（或表格的獨立一格），不要把多個${w}擠在同一行，也不要把${w}例句接在中文說明的句子後面。
- 不要使用「拼音：」「中文：」「英文：」「說明：」這類欄位標籤，只寫內容本身。
- 不要開場白、結尾、總結。

請「嚴格照下面格式」輸出，標題下面直接接內容：

標題: （簡短的中文標題，例如「計程車相關」）
副標題: （英文副標題，可留空）

（內容）`;
}

const ART_HEAD = /^[\s>*•-]*\**\s*(標題|副標題|英文副標題|title|subtitle)\s*\**\s*[:：]\s*\**\s*(.*)$/i;
const ART_BODY_HEAD = /^#{1,6}\s*\**\s*(內文|正文|文章|body|article|text)\s*\**\s*[:：]?\s*$/i;
function parseArticle(text) {
  let lines = text.replace(/\r/g, "").split("\n");
  // 欄位被壓成同一行時（網頁複製常見）在「副標題:」前拆開
  lines = lines.flatMap((l) => (ART_HEAD.test(l) ? l.split(/\s+(?=\**(?:副標題|英文副標題|subtitle)\**\s*[:：])/i) : [l]));
  let title = "", subtitle = "";
  let i = 0;
  let found = false;
  for (; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const m = lines[i].match(ART_HEAD);
    if (m) {
      found = true;
      const v = m[2].replace(/\s*\*+\s*$/, "").trim();
      if (/^(副標題|英文副標題|subtitle)$/i.test(m[1])) subtitle = v; else title = v;
      continue;
    }
    if (found) break;
  }
  const body = lines.slice(i);
  while (body.length && !body[0].trim()) body.shift();
  if (body.length && ART_BODY_HEAD.test(body[0].trim())) body.shift();
  return { title, subtitle, body: body.join("\n").trim() };
}

let artParsed = { title: "", subtitle: "", body: "" };
function renderSmartArt() {
  artParsed = parseArticle($("saText").value);
  const { title, subtitle, body } = artParsed;
  $("saPreview").innerHTML = $("saText").value.trim()
    ? `<div class="smartrow"><span class="smartmain"><b>${esc(title) || "（找不到標題）"}</b>
        <span class="smartmeaning">${esc(subtitle)}</span></span>
        <span class="smartmeta">內文 ${body.length} 字</span></div>`
    : "";
  $("saSave").disabled = !title || !body;
}
$("saText").addEventListener("input", renderSmartArt);
enableRichPaste($("saText"), true);

function openSmartArticle() {
  if (readOnly()) return;
  $("saTopic").value = "";
  $("saText").value = "";
  $("saSize").innerHTML = ART_SIZES.map(([k, n]) => `<option value="${k}">${k}（約 ${n} 項）</option>`).join("");
  renderSmartArt();
  $("smartArtDlg").showModal();
}
$("saCancel").onclick = () => $("smartArtDlg").close();
$("saCopy").onclick = async () => {
  const prompt = articlePrompt({ topic: $("saTopic").value.trim(), size: $("saSize").value });
  try {
    await navigator.clipboard.writeText(prompt);
    $("saCopy").textContent = "已複製 ✓";
  } catch (e) {
    $("saText").value = prompt; // 剪貼簿不可用時放進輸入框讓使用者自己複製
    $("saText").select();
  }
  setTimeout(() => ($("saCopy").textContent = "生成提示詞並複製"), 2000);
};
$("saForm").onsubmit = async (e) => {
  e.preventDefault();
  const { title, subtitle, body } = artParsed;
  if (!title || !body) return;
  const btn = $("saSave");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "articles"), { lang, title, subtitle, body, tags: [], createdAt: serverTimestamp() });
    $("smartArtDlg").close();
  } catch (err) {
    alert("新增失敗：" + err.message);
  } finally {
    btn.disabled = !title || !body;
  }
};

$("smartBtn").onclick = () => (page === "articles" ? openSmartArticle() : openSmartCards());

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
      lang, type: "sentence", thai: c.thai, roman: c.roman, english: c.english, detail: "", tags: v.tags ?? [],
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
    const data = { lang, title, url, videoId, cues, tags: videoTags.get() };
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
    <article class="detail article-body" lang="${lang}">${md(a.body)}</article>`;
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
    lang,
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
  // 泰文版只取選取範圍內的泰文；英文版取整段選取文字（需含英文字母）
  const txt = sel.toString().replace(/\s+/g, " ").trim();
  selThai = lang === "th" ? thaiOf(sel.toString()) : /[A-Za-z]/.test(txt) ? txt.slice(0, 300) : "";
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
  $("fThai").value = termClean(thai);
  $("fType").value = /\s/.test(thai) ? "sentence" : "word"; // 有空白視為句子，否則單字（可手動改）
  (L().roman ? $("fRoman") : $("fEnglish")).focus();
};

/* ---------- 啟動 ---------- */
go(location.hash.slice(1));









































