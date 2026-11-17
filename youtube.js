// 用 YouTube Data API 找適合練聽力的短影片（3–5 分鐘、日常口語）。
// 純前端呼叫：金鑰只存在使用者自己的瀏覽器（localStorage）。
const API = "https://www.googleapis.com/youtube/v3";
const KEY_STORE = "youtubeKey";
const SEEN_STORE = "ytSeen"; // 已經推薦過、被跳過的影片，不再出現

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
export const getYoutubeKey = () => store.get(KEY_STORE);
export const setYoutubeKey = (v) => store.set(KEY_STORE, v.trim());

export const getSeen = () => { try { return JSON.parse(store.get(SEEN_STORE) || "[]"); } catch { return []; } };
export const markSeen = (ids) => store.set(SEEN_STORE, JSON.stringify([...new Set([...getSeen(), ...ids])].slice(-600)));

// 搜尋關鍵字：使用者看不懂泰文，所以由系統準備。都是「真人講日常口語」的題材，刻意不放新聞、戲劇、音樂。
const QUERIES = {
  th: [
    "สัมภาษณ์ข้างถนน",        // 街頭訪問
    "ถามคนไทย",               // 問泰國人
    "สัมภาษณ์คนไทย ชีวิตประจำวัน", // 訪問泰國人 日常生活
    "vlog ชีวิตประจำวัน",      // 日常生活 vlog
    "หนึ่งวันของฉัน vlog",      // 我的一天
    "พาเดินตลาด",              // 帶你逛市場
    "รีวิวร้านอาหาร ร้านเด็ด",   // 餐廳食記
    "คุยกับแม่ค้า",             // 跟攤販聊天
    "ถามตอบ Q&A คุยเล่น",      // 問答閒聊
    "พาเที่ยว หนึ่งวัน",         // 一日遊
    "Thai street interview",
    "real life Thai conversation",
  ],
  en: [
    "street interview",
    "day in my life vlog",
    "asking strangers",
    "everyday English conversation real life",
    "what's in my bag",
    "food tour vlog",
    "Q&A get to know me",
    "apartment tour vlog",
  ],
};
const REGION = { th: ["th", "TH"], en: ["en", "US"] };
export const queryCount = (lang) => QUERIES[lang].length;

async function get(path, params, key, signal) {
  let r;
  try {
    r = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, { headers: { "X-Goog-Api-Key": key }, signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("連不上 YouTube（網路問題，或被瀏覽器擋下）");
  }
  let json = null;
  try { json = await r.json(); } catch {}
  if (r.ok) return json;
  const msg = json?.error?.message || `HTTP ${r.status}`;
  const reason = json?.error?.errors?.[0]?.reason || "";
  const e = new Error(
    /API key/i.test(msg) ? "YouTube 金鑰無效，請檢查金鑰設定。\n" + msg
      : /quota/i.test(reason + msg) ? "今天的 YouTube 搜尋額度用完了，明天會自動恢復。"
      : /not been used|disabled|accessNotConfigured/i.test(reason + msg) ? "這組金鑰的專案還沒啟用 YouTube Data API v3，請到 Google Cloud Console 啟用。\n" + msg
      : "YouTube 搜尋失敗：" + msg);
  e.badKey = /API key|not been used|disabled|accessNotConfigured/i.test(reason + msg);
  throw e;
}

// ISO 8601（PT4M13S）→ 秒
function seconds(iso = "") {
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

const decode = (s = "") => { const t = document.createElement("textarea"); t.innerHTML = s; return t.value; };

// 用第 round 組關鍵字搜尋，回傳 3–5 分鐘左右、可嵌入播放、還沒看過的影片
// [{ videoId, title, channel, description, seconds, thumb }]
export async function findCandidates({ lang, round = 0, exclude = [], minSec = 170, maxSec = 330, key = getYoutubeKey(), signal }) {
  if (!key) throw Object.assign(new Error("尚未設定 YouTube 金鑰"), { badKey: true });
  const q = QUERIES[lang][round % QUERIES[lang].length];
  const [relevanceLanguage, regionCode] = REGION[lang];
  const base = {
    part: "snippet", type: "video", q, maxResults: 25, relevanceLanguage, regionCode,
    videoEmbeddable: "true", videoSyndicated: "true", safeSearch: "moderate",
  };
  // 搜尋只能用「短於 4 分鐘」「4–20 分鐘」這種粗分類，兩種都搜，再用實際片長篩
  const pages = await Promise.all(["short", "medium"].map((videoDuration) => get("search", { ...base, videoDuration }, key, signal)));
  const skip = new Set(exclude);
  const ids = [...new Set(pages.flatMap((p) => p.items ?? []).map((it) => it.id?.videoId).filter((id) => id && !skip.has(id)))];
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await get("videos", { part: "snippet,contentDetails,status", id: ids.slice(i, i + 50).join(",") }, key, signal);
    for (const v of d.items ?? []) {
      const sec = seconds(v.contentDetails?.duration);
      if (sec < minSec || sec > maxSec) continue;
      if (v.status?.embeddable === false || v.status?.privacyStatus !== "public") continue;
      if (v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== "none") continue;
      if (v.contentDetails?.contentRating?.ytRating) continue; // 有年齡限制的影片不能嵌入播放
      out.push({
        videoId: v.id,
        title: decode(v.snippet.title),
        channel: decode(v.snippet.channelTitle),
        description: decode(v.snippet.description || "").slice(0, 300),
        seconds: sec,
        thumb: v.snippet.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
      });
    }
  }
  return out;
}
