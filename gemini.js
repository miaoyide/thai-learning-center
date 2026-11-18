// 用 Gemini 直接「看」YouTube 影片，產生帶時間的逐字稿（含拼音／翻譯）。
// 純前端呼叫：金鑰只存在使用者自己的瀏覽器（localStorage），不進 repo、不進 Firestore。
import { parseTime, fmtTime } from "./subtitles.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const KEY_STORE = "geminiKey";
const MODEL_STORE = "geminiModel";

export const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-3.5-flash-lite"];

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
export const getGeminiKey = () => store.get(KEY_STORE);
export const setGeminiKey = (v) => store.set(KEY_STORE, v.trim());
export const getGeminiModel = () => (GEMINI_MODELS.includes(store.get(MODEL_STORE)) ? store.get(MODEL_STORE) : GEMINI_MODELS[0]);
export const setGeminiModel = (v) => store.set(MODEL_STORE, v);

// lang: "th"（泰文＋拼音＋英文）或 "en"（英文＋繁體中文）
// duration：片長（秒，0＝不知道）；from：只轉寫這個時間點之後（接續補後半段時用）
function buildPrompt(lang, duration = 0, from = 0) {
  const spoken = lang === "th" ? "Thai" : "English";
  const fields = lang === "th"
    ? `- "text": the sentence exactly as spoken, in Thai script.
- "roman": romanization of that sentence the way Thai people actually pronounce it, with tone diacritics.
- "meaning": a natural English translation.`
    : `- "text": the sentence exactly as spoken, in English.
- "roman": always an empty string.
- "meaning": a natural translation in Traditional Chinese (繁體中文).`;
  return `Transcribe the spoken ${spoken} in this video for a language learner.

Return JSON only, in this shape: {"cues":[{"t":"M:SS.s","text":"","roman":"","meaning":""}]}

Rules:
- Listen to the audio and transcribe what is actually said, verbatim. Do not summarise, and do not skip any part of the video, from the first word to the last.
- One cue per sentence or short phrase (roughly 2-8 seconds of speech), in order.
- "t": the moment the first word of the cue starts being spoken, measured from the start of the video, as M:SS.s with tenths of a second (for example 0:12.4; H:MM:SS.s past one hour). Never earlier than the end of the previous cue: sentence-final particles${lang === "th" ? " such as นะครับ / ค่ะ" : ""} belong to the cue they end, not to the start of the next one.
${fields}
- Skip music, sound effects and speech in other languages. If nothing in ${spoken} is spoken, return {"cues":[]}.
- No line breaks inside any value, no Markdown, no commentary.${duration ? `
- The video is ${fmtTime(Math.round(duration))} long. Keep transcribing until the speech actually ends; the last cue should be close to the end of the video. Do not stop after the first part.` : ""}${from ? `
- The part before ${fmtTime(Math.floor(from))} is already transcribed. Only transcribe speech from ${fmtTime(Math.floor(from))} onward. Timestamps are still measured from the start of the full video.` : ""}`;
}

const SCHEMA = {
  type: "object",
  properties: {
    cues: {
      type: "array",
      items: {
        type: "object",
        properties: { t: { type: "string" }, text: { type: "string" }, roman: { type: "string" }, meaning: { type: "string" } },
        required: ["t", "text", "roman", "meaning"],
      },
    },
  },
  required: ["cues"],
};

async function post(key, body, signal) {
  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("連不上 Gemini（網路問題，或被瀏覽器擋下）");
  }
  let json = null;
  try { json = await r.json(); } catch {}
  if (r.ok) return json;
  const err = (Array.isArray(json) ? json[0] : json)?.error ?? {};
  const e = new Error(explain(r.status, err));
  e.status = r.status;
  e.badKey = /API key|prepay|credits|billing/i.test(err.message || ""); // 金鑰或帳務問題：重試也沒用，直接請使用者處理
  throw e;
}

function explain(status, err) {
  const msg = err.message || `HTTP ${status}`;
  if (/prepay|credits|billing/i.test(msg)) return "這組金鑰的專案是預付計費方案，而且餘額用完了。請到 https://ai.studio/projects 儲值，或改用沒有綁定計費的專案（免費額度）產生的金鑰。\n" + msg;
  if (/API key/i.test(msg) || status === 401 || status === 403) return "Gemini 金鑰無效或沒有權限，請檢查金鑰設定。\n" + msg;
  if (status === 429) return "已達 Gemini 用量上限（免費額度每天、每分鐘都有限制），請稍後再試。\n" + msg;
  if (status >= 500) return "Gemini 伺服器暫時有問題，請稍後再試。\n" + msg;
  return msg;
}

const outputText = (res) => (res?.steps ?? [])
  .filter((s) => s.type === "model_output")
  .flatMap((s) => s.content ?? [])
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("");

// 回覆可能包在 ```json 裡、前後有多餘文字，或因為太長被截斷；盡量救回完整的句子
export function parseCuesJson(text) {
  const s = text.replace(/^﻿/, "").replace(/```(?:json)?/gi, "").trim();
  const from = s.search(/[[{]/);
  if (from < 0) return { items: [], truncated: false };
  const body = s.slice(from);
  try {
    const j = JSON.parse(body);
    return { items: Array.isArray(j) ? j : j.cues ?? [], truncated: false };
  } catch {}
  // 截斷：逐一取出完整的 {...} 物件（值裡面不會有巢狀物件）
  const items = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(body))) {
    try { const o = JSON.parse(m[0]); if (o && typeof o.text === "string") items.push(o); } catch {}
  }
  return { items, truncated: true };
}

const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

function toCues(items) {
  const cues = [];
  for (const it of items) {
    const start = parseTime(oneLine(it.t ?? it.time ?? it.start));
    const thai = oneLine(it.text);
    if (start == null || !thai) continue;
    cues.push({ start, thai, roman: oneLine(it.roman), english: oneLine(it.meaning) });
  }
  // 模型偶爾會把時間排錯；穩定排序後，同一秒的句子維持原順序
  return cues.map((c, i) => [c, i]).sort((a, b) => a[0].start - b[0].start || a[1] - b[1]).map(([c]) => c);
}

// 回傳 { cues: [{start, thai, roman, english}], truncated, lastTime }
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

// 共用的請求流程：選用參數被拒就退回最基本的請求；模型塞車就重試、再換模型。回傳 { text, status, model }
async function ask({ key, model, input, minimalInput = input, schema, signal, onStatus, emptyMsg, thinking = "low" }) {
  if (!key) throw Object.assign(new Error("尚未設定 Gemini 金鑰"), { badKey: true });
  const once = async (m) => {
    try {
      return await post(key, {
        model: m, store: false, input,
        response_format: { type: "text", mime_type: "application/json", schema },
        generation_config: { thinking_level: thinking },
      }, signal);
    } catch (e) {
      // 選用參數不被接受時（API 改版、模型不支援），退回最基本的請求；格式要求已經寫在 prompt 裡
      if (e.status !== 400 || e.badKey) throw e;
      minimal = true;
      return post(key, { model: m, store: false, input: minimalInput }, signal);
    }
  };
  // 模型塞車（5xx）很常見而且通常很短暫：同一個模型等一下再試，還是不行就換下一個模型
  const models = [model, ...GEMINI_MODELS.filter((m) => m !== model)];
  let res, used, lastErr;
  let minimal = false; // 是否退回了最基本的請求（選用參數，例如影片剪輯，沒有生效）
  for (const m of models) {
    for (const wait of [0, 5, 15]) {
      if (wait) { onStatus?.(`${m} 忙線中，${wait} 秒後重試`); await sleep(wait * 1000, signal); }
      onStatus?.(m === model ? "" : `改用 ${m}`);
      try { res = await once(m); used = m; break; } catch (e) {
        if (e.name === "AbortError" || !(e.status >= 500)) throw e;
        lastErr = e;
      }
    }
    if (res) break;
  }
  if (!res) throw lastErr;
  if (res?.status === "failed" || res?.status === "cancelled") {
    throw new Error("Gemini 沒有完成：" + (res.errors?.map((x) => x.message).join("；") || res.status));
  }
  const text = outputText(res);
  if (!text.trim()) throw new Error(emptyMsg || "Gemini 沒有回傳內容");
  return { text, status: res.status, model: used, minimal };
}

// 回傳 { cues: [{start, thai, roman, english}], model, truncated, lastTime }
// duration（秒，選填）：知道片長時會告訴模型；模型有時只轉寫前一段就停（實際遇過 3:24 的影片只到 0:41），
// 這時從最後一句接著再要後半段，最多補 4 次
export async function transcribeYoutube({ videoId, lang, duration = 0, key = getGeminiKey(), model = getGeminiModel(), signal, onStatus }) {
  const video = { type: "video", uri: `https://www.youtube.com/watch?v=${videoId}` };
  const once = async (from) => {
    const text = { type: "text", text: buildPrompt(lang, duration, from) };
    // 接續時只送後半段的影片；不支援剪輯時 ask() 會退回整部影片，靠 prompt 與下面的過濾去掉重複
    const clip = from ? { processing: { type: "static", start_offset: `${Math.floor(from)}s` } } : {};
    const res = await ask({
      key, model, signal, schema: SCHEMA,
      onStatus: (s) => onStatus?.(s || (from ? `補後半段（從 ${fmtTime(Math.floor(from))} 開始）` : "")),
      // 逐字稿只需要聲音，畫面用低解析度省 token（能處理的影片也比較長）
      input: [text, { ...video, resolution: "low", ...clip }],
      minimalInput: [text, video],
      emptyMsg: "Gemini 沒有回傳內容（影片可能不是公開的、太長，或被內容政策擋下）",
    });
    const { items, truncated } = parseCuesJson(res.text);
    let cues = toCues(items);
    // 剪輯後的時間有可能從 0 起算：第一句明顯早於起點，就整批加上起點
    if (from >= 10 && !res.minimal && cues.length && cues[0].start < from - 5) cues = cues.map((c) => ({ ...c, start: c.start + from }));
    return { cues, model: res.model, truncated: truncated || res.status === "incomplete" || res.status === "requires_continuation" };
  };
  const first = await once(0);
  let { cues, truncated, model: used } = first;
  const short = () => duration && cues.length && cues.at(-1).start < duration - 20;
  for (let round = 0; round < 4 && short(); round++) {
    const last = cues.at(-1).start;
    const more = await once(last);
    const add = more.cues.filter((c) => c.start > last + 0.5);
    if (!add.length) break;
    cues = [...cues, ...add];
    truncated = more.truncated;
    used = more.model;
  }
  return {
    cues,
    model: used,
    truncated: truncated || !!short(),
    lastTime: cues.length ? fmtTime(Math.floor(cues.at(-1).start)) : "",
  };
}

/* ---------- 本集重點：從逐字稿挑出值得學的單字與常用句型 ---------- */
const HL_SCHEMA = (() => {
  const str = { type: "string" };
  const ex = { type: "object", properties: { text: str, roman: str, meaning: str }, required: ["text", "roman", "meaning"] };
  return {
    type: "object",
    properties: {
      words: {
        type: "array",
        items: {
          type: "object",
          properties: { text: str, roman: str, meaning: str, note: str, examples: { type: "array", items: ex } },
          required: ["text", "roman", "meaning", "note", "examples"],
        },
      },
      patterns: {
        type: "array",
        items: {
          type: "object",
          properties: { pattern: str, roman: str, meaning: str, explain: str, examples: { type: "array", items: ex } },
          required: ["pattern", "roman", "meaning", "explain", "examples"],
        },
      },
    },
    required: ["words", "patterns"],
  };
})();

function buildHighlightPrompt(lang, transcript, known) {
  const th = lang === "th";
  const target = th ? "Thai" : "English";
  const meaning = th ? "a short English meaning" : "a short meaning in Traditional Chinese (繁體中文)";
  const roman = th ? "romanization the way Thai people actually pronounce it, with tone diacritics" : "always an empty string";
  return `Below is the transcript of a short ${target} video (usually an interview or talk). Pick what is most worth learning from it for this learner.

The learner: a native Chinese speaker (Traditional Chinese, Taiwan) at roughly elementary level in ${target}. They can get by stringing single words together, but cannot build proper sentences yet${th ? ", and cannot read Thai script, so they rely on the romanization" : ""}. They want everyday spoken ${target}, not textbook or formal language.

Return JSON only, in this shape:
{"words":[{"text":"","roman":"","meaning":"","note":"","examples":[{"text":"","roman":"","meaning":""}]}],"patterns":[{"pattern":"","roman":"","meaning":"","explain":"","examples":[{"text":"","roman":"","meaning":""}]}]}

"words": 10-20 words or short fixed phrases (fewer if the transcript is short).
- Choose by usefulness: words this learner will hear and need again and again in daily conversation, at or just above their level. Not the rarest or hardest words.
- Every word must actually appear in the transcript. Give it in its basic dictionary form, in the same script as the transcript.
- Skip names and proper nouns, numbers, pronouns, politeness particles${th ? " (ครับ, ค่ะ, นะ and the like)" : ""}, and everything in the "already known" list.
- "roman": ${roman}. "meaning": ${meaning}, as used in this video.
- "note": one short line in Traditional Chinese on how it is used or what it is easily confused with; empty string if there is nothing worth saying.
- "examples": 2 sentences showing how the word is used. The first is the sentence from the transcript that contains it, quoted as it was said (trim it to the clause around the word if it is very long); the second is a new, short, everyday sentence made with words this learner would know. Each with "roman" and "meaning" as above.
- Order them by usefulness, most useful first.

"patterns": exactly 3 sentence patterns that native speakers use all the time in speech and that appear in this transcript.
- "pattern": the reusable frame with "…" for the slot${th ? ', for example "อยาก…" or "…ได้ไหม"' : ', for example "I\'m about to …"'}. "roman": ${roman}. "meaning": ${meaning}.
- "explain": one or two sentences in Traditional Chinese: when people say this and what goes in the slot.
- "examples": 3 sentences. The first is the sentence from the transcript that uses the pattern, quoted as it was said; the other two are new, short, everyday sentences made with words this learner would know. Each with "roman" and "meaning" as above.

No Markdown, no line breaks inside values, no commentary.

Already known (do not pick these): ${known.length ? known.join(", ") : "(none)"}

Transcript:
${transcript}`;
}

const cleanEx = (e) => ({ thai: oneLine(e?.text), roman: oneLine(e?.roman), english: oneLine(e?.meaning) });

// cues: [{thai}]；known: 已有字卡的詞。回傳 { words: [{thai, roman, english, note}], patterns: [{thai, roman, english, explain, examples}], model }
// only（選填）：{ kind: "words" | "patterns", avoid: [...] } 只換一個——使用者覺得某一項已經會了或不需要時，補一個新的
export async function extractHighlights({ cues, lang, known = [], only, key = getGeminiKey(), model = getGeminiModel(), signal, onStatus }) {
  const transcript = cues.map((c) => c.thai).join("\n");
  let prompt = buildHighlightPrompt(lang, transcript, known.slice(0, 1500));
  if (only) {
    const [what, other] = only.kind === "words" ? ["word", "patterns"] : ["sentence pattern", "words"];
    prompt += `

IMPORTANT, this overrides the counts above: return exactly ONE new ${what} in "${only.kind}" and leave "${other}" as an empty array. The learner already knows, or does not want, every item in the list below. Pick the next most useful ${what} from the transcript that is not in the list and is not a near-duplicate or simple variant of anything in it:
${only.avoid.join(", ")}`;
  }
  const res = await ask({ key, model, signal, onStatus, schema: HL_SCHEMA, input: [{ type: "text", text: prompt }] });
  let j;
  try {
    const s = res.text.replace(/```(?:json)?/gi, "").trim();
    j = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
  } catch {
    throw new Error("Gemini 的回覆無法解析，請再試一次");
  }
  const words = (j.words ?? []).map((w) => ({
    ...cleanEx(w),
    note: oneLine(w.note),
    examples: (w.examples ?? []).map(cleanEx).filter((e) => e.thai),
  })).filter((w) => w.thai);
  const patterns = (j.patterns ?? []).map((p) => ({
    ...cleanEx({ ...p, text: p.pattern }),
    explain: oneLine(p.explain),
    examples: (p.examples ?? []).map(cleanEx).filter((e) => e.thai),
  })).filter((p) => p.thai);
  if (!words.length && !patterns.length) throw new Error("Gemini 沒有挑出任何重點，請再試一次");
  return { words, patterns, model: res.model };
}

/* ---------- 補例句：舊的本集重點沒有單字例句，加入字卡時再一次補齊 ---------- */
const EX_SCHEMA = (() => {
  const str = { type: "string" };
  const ex = { type: "object", properties: { text: str, roman: str, meaning: str }, required: ["text", "roman", "meaning"] };
  return {
    type: "object",
    properties: { items: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, examples: { type: "array", items: ex } }, required: ["i", "examples"] } } },
    required: ["items"],
  };
})();

// words: [{thai, english}]；cues：這部影片的逐字稿（第一個例句從裡面引用）。回傳同樣順序的例句陣列（失敗的為 []）
export async function wordExamples({ words, cues, lang, key = getGeminiKey(), model = getGeminiModel(), signal }) {
  const th = lang === "th";
  const target = th ? "Thai" : "English";
  const meaning = th ? "a short English meaning" : "a short meaning in Traditional Chinese (繁體中文)";
  const roman = th ? "romanization the way Thai people actually pronounce it, with tone diacritics" : "always an empty string";
  const prompt = `A ${target} learner (Traditional Chinese speaker, elementary level${th ? ", cannot read Thai script" : ""}) is saving these words from a video to flashcards and needs example sentences to understand how each word is used.

For each word return "examples": 2 sentences. The first is the sentence from the transcript below that contains the word, quoted as it was said (trim it to the clause around the word if it is very long; if the word is not in the transcript, write a natural everyday sentence instead). The second is a new, short, everyday sentence made with simple words. Each example has "text" (in ${target}), "roman" (${roman}) and "meaning" (${meaning}).

Return JSON only: {"items":[{"i":0,"examples":[{"text":"","roman":"","meaning":""}]}]}
No Markdown, no line breaks inside values.

Words:
${words.map((w, i) => `${i}. ${w.thai}${w.english ? ` (${w.english})` : ""}`).join("\n")}

Transcript:
${cues.map((c) => c.thai).join("\n")}`;
  const res = await ask({ key, model, signal, schema: EX_SCHEMA, input: [{ type: "text", text: prompt }] });
  let j;
  try {
    const s = res.text.replace(/```(?:json)?/gi, "").trim();
    j = JSON.parse(s.slice(s.search(/[[{]/)));
  } catch {
    throw new Error("Gemini 的回覆無法解析");
  }
  const out = words.map(() => []);
  for (const it of Array.isArray(j) ? j : j.items ?? []) {
    if (Number.isInteger(it?.i) && it.i >= 0 && it.i < out.length) out[it.i] = (it.examples ?? []).map(cleanEx).filter((e) => e.thai);
  }
  return out;
}

/* ---------- 找影片：把候選影片的標題翻成中文，並判斷適不適合練日常口語 ---------- */
const RATE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, zh: { type: "string" }, kind: { type: "string" }, score: { type: "integer" } },
        required: ["i", "zh", "kind", "score"],
      },
    },
  },
  required: ["items"],
};

// videos: [{ title, channel, description }]。回傳同樣順序的 [{ zh, kind, score }]（失敗的項目為 null）
// 這是很簡單的分類工作，固定用最快的模型、不花時間思考，讓「找影片」不用等太久
export async function rateVideos({ videos, lang, key = getGeminiKey(), model = "gemini-3.5-flash-lite", signal }) {
  const target = lang === "th" ? "Thai" : "English";
  const list = videos.map((v, i) => `${i}. ${v.title} | channel: ${v.channel} | ${oneLine(v.description).slice(0, 160)}`).join("\n");
  const prompt = `These are YouTube videos found for a language learner who wants to practise listening to everyday spoken ${target}. The learner is a Traditional Chinese speaker at elementary level and cannot read ${target} well, so they cannot judge the titles themselves.

For each video return:
- "i": its number.
- "zh": the title translated into natural Traditional Chinese (繁體中文), short, without hashtags or emoji.
- "kind": one of 訪談, 街訪, vlog, 食記, 旅遊, 教學, 新聞, 戲劇, 音樂, 其他 — your best guess from the title, channel and description.
- "score": 0-3, how good it is for hearing real people speak everyday ${target}. 3 = people talking naturally about daily life (interviews, street interviews, casual vlogs, chatting). 2 = spoken but more scripted or one-sided (reviews, tours, explainers). 1 = formal or hard for a beginner (news, lectures, politics). 0 = little or no useful speech (music, drama clips, gameplay, compilations, ads), or not in ${target}.

Return JSON only: {"items":[{"i":0,"zh":"","kind":"","score":0}]}

${list}`;
  const res = await ask({ key, model, signal, schema: RATE_SCHEMA, thinking: "minimal", input: [{ type: "text", text: prompt }] });
  let j;
  try {
    const s = res.text.replace(/```(?:json)?/gi, "").trim();
    j = JSON.parse(s.slice(s.search(/[[{]/)));
  } catch {
    throw new Error("Gemini 的回覆無法解析");
  }
  const out = videos.map(() => null);
  for (const it of Array.isArray(j) ? j : j.items ?? []) {
    if (Number.isInteger(it?.i) && it.i >= 0 && it.i < out.length) {
      out[it.i] = { zh: oneLine(it.zh), kind: oneLine(it.kind), score: Math.max(0, Math.min(3, +it.score || 0)) };
    }
  }
  return out;
}
