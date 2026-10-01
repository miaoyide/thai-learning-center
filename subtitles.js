// 字幕解析：支援 YouTube「顯示轉錄稿」複製的純文字，以及 .srt / .vtt

export function parseTime(s) {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +m[4].padEnd(3, "0") / 1000 : 0);
}

export function fmtTime(sec) {
  let s = Math.floor(sec);
  let ms = Math.round((sec - s) * 1000);
  if (ms === 1000) { s++; ms = 0; }
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  const base = h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
  return ms ? `${base}.${String(ms).padStart(3, "0")}` : base;
}

function parseSrtVtt(t) {
  const cues = [];
  for (const block of t.split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->").map((s) => s.trim().split(/\s+/)[0]);
    const start = parseTime(a);
    const text = lines.slice(i + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (start == null || !text) continue;
    cues.push({ start, end: parseTime(b), thai: text });
  }
  return cues;
}

// 時間獨立一行、文字在下一行（或同一行）
function parseYoutube(t) {
  const cues = [];
  let cur = null;
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const t0 = parseTime(line);
    if (t0 != null) { cur = { start: t0, thai: "" }; cues.push(cur); continue; }
    const m = line.match(/^(\S+)\s+(.+)$/);
    const t1 = m && parseTime(m[1]);
    if (t1 != null) { cur = { start: t1, thai: m[2] }; cues.push(cur); continue; }
    if (cur) cur.thai = `${cur.thai} ${line}`.trim();
  }
  return cues.filter((c) => c.thai);
}

export function parseTranscript(text) {
  const t = text.replace(/\r/g, "").replace(/^﻿/, "");
  const cues = t.includes("-->") ? parseSrtVtt(t) : parseYoutube(t);
  // 沒有結束時間（YouTube 轉錄稿）就用下一句的開始時間
  cues.forEach((c, i) => {
    if (c.end == null || c.end <= c.start) c.end = cues[i + 1]?.start ?? c.start + 5;
  });
  return cues;
}

export const parseLines = (text) => text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);

// 英文 / 拼音依順序對應泰文句子；回傳 cues 與行數不符的警告
export function buildCues(thaiText, romanText, englishText) {
  const cues = parseTranscript(thaiText);
  const roman = parseLines(romanText);
  const english = parseLines(englishText);
  const warnings = [];
  if (roman.length && roman.length !== cues.length) warnings.push(`拼音 ${roman.length} 行 ≠ 泰文 ${cues.length} 句`);
  if (english.length && english.length !== cues.length) warnings.push(`英文 ${english.length} 行 ≠ 泰文 ${cues.length} 句`);
  return {
    cues: cues.map((c, i) => ({
      start: c.start, end: c.end, thai: c.thai,
      roman: roman[i] === "-" ? "" : roman[i] ?? "",
      english: english[i] === "-" ? "" : english[i] ?? "",
    })),
    warnings,
  };
}

// 編輯時把已存的 cues 還原成可再解析的文字
export const cuesToTranscript = (cues) => cues.map((c) => `${fmtTime(c.start)}\n${c.thai}`).join("\n");

export function extractVideoId(input) {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
