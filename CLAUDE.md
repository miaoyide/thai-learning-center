# 語言學習中心（ThaiLearningCenter）

個人用的泰語（也支援英語）學習網站：字卡、文章、影片逐字稿、隨堂測驗。使用者只有擁有者一人，其他人以訪客身分唯讀瀏覽。

## 使用者與溝通

- 用**繁體中文**溝通；程式註解、介面文字也都是繁體中文。
- 使用者的泰語約小學程度：能用單字拼湊溝通，還不會造句，**看不懂泰文字**，靠羅馬拼音。所有 AI 挑字、出題的難度以此為準（日常口語，不是課本用語）。
- 翻譯欄位的邏輯已確認正確：泰文版的意思用**英文**，用法說明用中文；英文版的意思用中文。
- 學習目標：每天看一部 3–5 分鐘、日常口語（訪談、街訪、vlog）的影片，搭配逐字稿與「本集重點」。

## 技術架構

- 純前端：原生 JavaScript（ES modules）＋ Vite，**沒有後端**。
- Firebase：Google 登入（Auth）＋ Firestore。設定在 `firebase-config.js`。
- 部署：push 到 `main` 後由 `.github/workflows/deploy.yml` 自動建置並發佈到 GitHub Pages。
- 開發伺服器：`.claude/launch.json` 的 `thai-cards`（`npm run dev`，port 5199）。
- 沒有測試框架，驗證靠瀏覽器實際操作。

## 檔案

| 檔案 | 內容 |
|---|---|
| `app.js` | 主程式（約 2,200 行）：登入、語言切換、各頁列表、對話框、字卡、智慧貼上、文章、找影片、背景生成工作、反白浮窗 |
| `video.js` | 影片播放頁：YouTube 播放器、字幕跟播、播放控制、影片／閱讀模式、本集重點區塊 |
| `gemini.js` | Gemini API：逐字稿生成（含停太早時接續）、本集重點挑選與「換一個」、單字例句、找影片時的標題翻譯與評分 |
| `youtube.js` | YouTube Data API：依預設關鍵字搜尋 3–5 分鐘的口語影片 |
| `subtitles.js` | 字幕解析（YouTube 轉錄稿、.srt、.vtt）、時間格式、YouTube 網址解析 |
| `index.html` | 版面骨架與所有對話框 |
| `style.css` | 樣式；檔案後段是各主題（Hollow Knight、Cyberpunk、Expedition 33、Confluence、Notion、Obsidian） |
| `firestore.rules` | 讀取開放；寫入只限擁有者帳號，且登入未滿 1 天 |

## 資料模型（Firestore）

三個集合：`cards`、`videos`、`articles`。每筆都有 `lang`（`th` / `en`，舊資料沒有時視為 `th`）。

欄位沿用早期命名：**`thai` ＝正在學的語言的文字，`english` ＝它的意思**（英文版也一樣叫 `thai`／`english`），`roman` 只有泰文版使用。

- `cards`：`type`（`word` / `sentence`）、`thai`、`roman`、`english`、`detail`（Markdown）、`tags`、`weak`、`archived`、`misses`、`note`
- `videos`：`title`、`origTitle`（找影片時的原文標題）、`url`、`videoId`、`cues`（`[{start, end, thai, roman, english}]`）、`tags`、`highlights`（`{words, patterns, skipped}`；單字與句型都有 `examples`，舊資料的單字可能沒有）

本集重點的呈現原則：**影片頁只顯示摘要**（文字、拼音、意思、一行用法）；例句只寫進加入後的字卡說明（`### 例句` 清單）。舊重點沒有單字例句時，加入字卡當下用 `wordExamples()` 一次補齊並存回影片。
- `articles`：`title`、`subtitle`、`body`（Markdown）、`tags`

單筆文件上限約 1 MB，影片儲存前會檢查字幕長度。

## 外部 API（重要的坑）

兩組金鑰都只存在使用者瀏覽器的 localStorage，不進 repo、不進 Firestore。

**Gemini（Interactions API，不是舊的 generateContent）**
- `POST https://generativelanguage.googleapis.com/v1beta/interactions`，標頭 `x-goog-api-key`。
- **不能帶 `Api-Revision` 標頭**：官方範例有，但從瀏覽器呼叫會被 CORS 擋。
- 一律送 `store: false`。結構化輸出用 `response_format: { type: "text", mime_type: "application/json", schema }`，設定放 `generation_config`（例如 `thinking_level`）。
- 回應文字在 `steps[]`（`type: "model_output"`）→ `content[]`（`type: "text"`）→ `text`。`status: "incomplete"` 表示被截斷。
- YouTube 影片當成輸入：`{ type: "video", uri: "https://www.youtube.com/watch?v=..." }`，只支援公開影片；免費額度每天 8 小時影片。
- `gemini.js` 的 `ask()` 統一處理：400 時退回最基本的請求（回傳 `minimal: true`）、5xx（模型塞車很常見）時重試並依序換模型。
- **Gemini 會轉寫到一半就停**（實際遇過 3:24 的影片只到 0:41）。`transcribeYoutube()` 會接收片長（找影片時已知，手動新增時用 `youtube.js` 的 `getVideoSeconds()` 查），寫進 prompt；最後一句距片尾超過 20 秒就用 `processing.start_offset` 從最後一句接著要後半段，最多 4 次。剪輯後的時間若從 0 起算會自動加回起點（只在剪輯真的生效時）。沒有 YouTube 金鑰又是手動新增時查不到片長，無法偵測。
- 評分影片固定用最快的 `gemini-3.5-flash-lite` 加 `thinking_level: "minimal"`。
- 使用者曾遇過預付專案餘額為 0 的錯誤，解法是改用沒綁計費的專案金鑰。

**YouTube Data API v3**
- 金鑰用 `X-Goog-Api-Key` 標頭，可直接從瀏覽器呼叫。
- 網站全域設了 `<meta name="referrer" content="no-referrer">`，所以金鑰**不能設「HTTP 參照網址」限制**。（YouTube 嵌入播放器的 iframe 單獨開啟 referrer。）
- 每天 10,000 單位額度；`search` 一次 100 單位，換一批約 200–600 單位。

**發音**：用 Google 翻譯的 TTS 網址（`app.js` 的 `speak()`），`.say` 按鈕統一由 document 層的點擊處理。

## localStorage 鍵

`lang`、`theme`、`mask`、`quizScope`、`videoRate`、`videoMode`、`geminiKey`、`geminiModel`、`youtubeKey`、`ytSeen`（推薦過、跳過的影片）、`ytPool`（候選池快取）、`videoJobs`（背景生成工作，用來顯示「已中斷」）、`newVideos`（標「新」的影片）。

讀寫一律包 try/catch。

## 慣例

- 直接在 `main` 上 commit；使用者說要才 push。commit 訊息用英文。
- 程式檔是 LF，git 會出現「LF will be replaced by CRLF」警告，可忽略。`app.js` 開頭有 BOM。
- 找影片的背景工作只存在分頁裡：換頁不受影響，關掉或重新整理分頁會中斷；逐字稿完成前不寫進 Firestore。
- 跳到某一句時**不要提前**（`video.js` 的 `LEAD = 0`）：提前會把上一句結尾的語助詞（นะครับ）帶進來。

## 驗證的限制

在預覽瀏覽器只能用**訪客模式**（擁有者登入是使用者的 Google 帳號），所以：
- 任何寫入 Firestore 的步驟（存影片、加字卡、存重點）都無法親自驗證，需請使用者登入實測。
- 外部 API 沒有金鑰時，用替換 `window.fetch` 的模擬回應驗證流程。
- 預覽環境不會跑平滑捲動動畫，驗證捲動位置時要暫時改成瞬間捲動。

## 尚未做的想法

依使用者先前的回饋整理，優先順序待使用者決定：
- 影片字幕的遮罩（先聽、再點開翻譯與拼音），字卡頁已有同樣功能可參考
- 在字幕裡標出本集重點的單字
- 首頁的「今日進度」：今天的影片、看完沒、重點加入字卡沒
- 只考某部影片單字的隨堂測驗
- 跨影片的「已經會了」清單（目前「換一個」只在該部影片內有效）
- 找影片的「偏好頻道」清單（等使用者試出喜歡的頻道再加）
