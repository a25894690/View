# 影片編輯程式：程式結構

三個檔案，沒有建置步驟。`app.js` 用 `/* ---- 區塊名稱 ---- */` 分段，可用 grep 找區塊。

## 檔案

- `index.html`：版面。左邊 `.left`（`#player` 影片區、`.transport` 播放列、`#timeline` 時間軸 canvas）；右邊 `.right` 是三個分頁 `.tab-panel[data-panel=subs|review|cuts]`；`#helpModal` 是快捷鍵說明視窗、`#exportModal` 是輸出進度。
- `style.css`：深色主題，顏色變數在 `:root`。後半段依版本分成 v2（分頁、刪除片段、留言、畫記）和 v3（變色、單句位置）的樣式。右側欄寬在 `.layout { grid-template-columns: minmax(0, 1fr) 400px; }`。
- `app.js`：全部邏輯。
- `README.md`：使用說明（繁中）。

## 資料模型（`state`）

```js
state.subs   // [{ id, start, end, text, orig?, colors?, x?, y?, size? }]
             //   orig   = 第一次修改前的原文（字幕校正用）
             //   colors = [{ start, end, color }] 字串索引範圍（部分變色）
             //   x      = 水平中心 0..1；y = 字幕框底部離畫面底部 0..1；size = 字高佔畫面高 %
state.cuts   // [{ id, start, end }] 刪除片段，normalizeCuts() 保持不重疊且排序
state.notes  // [{ id, time, text, thumb(dataURL jpeg), drawn }] 審片留言
state.style  // 全域字幕樣式 { size, pos, color, bg, bgA, outline, bold }
state.sel    // 音軌框選範圍 { start, end } 或 null
state.selectedId / state.selCutId   // 目前選取的字幕 / 刪除片段
state.draft  // { time } 正在寫的留言，time 非 null 代表已鎖定
state.strokes, state.drawMode       // 畫記
state.skipCuts, state.playUntil, state.playSkip   // 預覽播放
```

localStorage key：`subtitle-editor-v1`，內容 `{ subs, cuts, notes, style, skipCuts }`。存檔在 `save()`（300ms debounce，空間不足時會去掉留言縮圖再存），讀檔在 `load()`。

## 重要函式（依區塊）

| 區塊 | 函式 | 用途 |
| --- | --- | --- |
| 時間格式 | `fmt` `fmtShort` `fmtFile` `fmtRuler` `parseTime` | 顯示與解析時間；`parseTime` 支援 `83.5`、`1:23.5`、`00:01:23,500`、`1分23秒` |
| 復原 / 重做 | `pushUndo` `undo` `redo` `snapshot` | 快照包含 `subs` 和 `cuts`（留言不在復原範圍） |
| 字幕資料操作 | `addSub` `deleteSub` `splitAt` `splitText` `mergeWithPrev` `setText` `changed` `updateCounts` | `changed()` = 存檔 + 重繪列表 / 刪除片段 / 計數 + 標記時間軸要重畫 |
| 部分文字變色 | `remapColors` `setColors` `applyColor` `sliceColors` `segments` | 編輯文字時用「相同開頭 / 結尾」推算顏色範圍的新位置 |
| 刪除片段 | `addCut` `markCut` `deleteCut` `normalizeCuts` `cutAt` `cutStats` `mapTime` `renderCuts` | `mapTime` 把原始時間換成剪後時間 |
| 試聽 | `playRange` `previewCut` `playSelection` | 靠 `tick()` 裡的 `playUntil` 停止 |
| 字幕列表 | `renderList` `refreshEdited` `select` `setEdge` `focusItemText` | 打字時不重繪整個列表，只用 `refreshEdited` 局部更新 |
| 🎨 / 🎯 面板 | `colorPanel` `layoutPanel` `togglePanel` `paintSelection` `renderPreview` | 面板開關狀態在 `panelState` |
| 影片上編輯 | `updateOverlay` `applyOverlayStyle` `placeOverlay` `layoutOverlay` | 字幕層對齊影片實際畫面（扣黑邊） |
| 拖曳位置 | `positionHandle` + `#subHandle` 事件 | 黃色 ✥，靠近中間自動置中 |
| 畫記 | `setDrawMode` `paintStrokes` `redrawStrokes` | 筆畫座標 0..1，縮放不失真 |
| 審片留言 | `lockDraft` `addNote` `captureThumb` `renderNotes` `reviewText` `copyText` | `reviewText({images})` 產生 .md / 複製文字 |
| 時間軸 | `draw` `setZoom` `fitZoom` `revealTime` `followPlayhead` | 單一 canvas；`xOf` / `tOf` 換算座標 |
| 時間軸滑鼠 | `pointerdown/move/up`、`hitSub` `snap` `region` | 字幕軌：拖曳字幕；音軌：框選；時間尺：拖播放頭 |
| 音軌波形 | `computePeaks` | `decodeAudioData` 後分段計算 min/max，每秒 200 個點 |
| 載入 | `loadVideo` `loadSubFile` `parseSubs` `parseTagged` | 匯入 SRT 時會讀 `<font color>` |
| 匯出字幕 | `toSRT` `toVTT` `taggedText` `subsForExport` | SRT 帶顏色標籤；VTT 純文字 |
| 輸出影片 | `drawSubtitle` `exportBurned` | canvas 畫影片 + 字幕，MediaRecorder 錄製；碰到刪除片段就暫停錄影、跳過、再繼續 |
| 播放 / 快捷鍵 | `seek` `togglePlay` `addAtCurrent`、`keydown` 處理 | 打字時不觸發快捷鍵 |
| 主迴圈 | `tick` | 每幀：試聽停止、跳過刪除片段、跟隨播放頭、重畫時間軸、更新字幕 / ✥ / 留言時間 |

## 外觀要一致的兩處

影片預覽（`placeOverlay` / `updateOverlay` + CSS `.sub-overlay`）和輸出影片（`drawSubtitle`）是兩套程式畫同一個字幕。改字幕外觀（字型、大小、位置、顏色、背景、描邊）時兩邊都要改，並用輸出影片截圖確認。

## 測試小技巧

- `window.__editor` 暴露 `state`、`parseTime`、`parseSubs`、`toSRT`、`toVTT`、`fmt`、`mapTime`、`reviewText`、`cutStats`、`segments`。
- 下載檔名：輸出影片 `<影片名>_subtitled.mp4|webm`、字幕 `<影片名>.srt`、審片 `<影片名>_review.md`。
- 用 ffmpeg 擷取輸出影片的某一格確認字幕：`ffmpeg -ss 2 -i out.mp4 -frames:v 1 frame.png`。
