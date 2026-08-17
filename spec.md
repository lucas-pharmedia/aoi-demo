# 專案需求規格書：2D 網頁 RPG 遊戲（AOI 九宮格即時位置同步原型）

## 1. 專案目標 (Project Goal)

使用 TypeScript 打造一個極簡的 2D 線上 RPG 即時位置同步原型 (Prototype)。
核心重點為實作 **九宮格空間分割演算法 (Area of Interest, AOI)**，確保玩家只會接收到周圍網格內的玩家資料，並在前端完成平滑插值渲染。

---

## 2. 技術棧 (Tech Stack)

- **後端 (Backend):** Node.js + TypeScript, 原生 `ws` (WebSocket 模組)
- **前端 (Frontend):** Vite + TypeScript, Phaser 3 (npm 安裝)
- **通訊協定:** WebSocket (JSON 格式封包)

---

## 3. 目錄結構 (Project Structure)

前後端分為獨立資料夾，共用同一份 npm workspace（或各自獨立 `package.json`）：

```
aoi-demo/
├── spec.md
├── package.json              # 根層 workspace 設定（可選）
├── server/                   # 後端
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # 伺服器入口：WebSocket 連線管理
│       ├── grid.ts           # 座標 <-> GridKey 轉換、九宮格計算
│       └── types.ts          # 共享封包型別定義
└── client/                   # 前端
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.ts           # Phaser 初始化
        ├── scene.ts          # 遊戲場景：玩家控制、AOI 同步、Lerp
        ├── network.ts        # WebSocket 封包收發
        └── types.ts          # 共享封包型別定義（與 server 對齊）
```

---

## 4. 地圖與九宮格規格 (Map & Grid Specifications)

- **Tile 規格:** 單一 Tile 大小為 $32 \times 32$ 像素 (px)。
- **地圖尺寸:** 寬 158 個 Tile ($5056$ px)，高 105 個 Tile ($3360$ px)。
- **單一 Grid 尺寸:** 寬 20 個 Tile ($640$ px)，高 15 個 Tile ($480$ px)。
- **網格矩陣 (Grid Matrix):**
  - X 軸網格數：$\lceil 158 / 20 \rceil = 8$ 格 (`0` ~ `7`)
  - Y 軸網格數：$\lceil 105 / 15 \rceil = 7$ 格 (`0` ~ `6`)
  - 總網格數：$8 \times 7 = 56$ 格。

---

## 5. 後端架構要求 (Backend Requirements: `server/src/index.ts`)

1. **連線管理:**

   - 玩家建立 WebSocket 連線時，指派唯一 `id` (如 `player_1`)，並給予地圖範圍內的隨機出生座標 $(X, Y)$。
   - 發送初始化封包 `{ type: 'init', selfId, x, y }` 給連線玩家。

2. **座標與網格轉換邏輯 (`server/src/grid.ts`):**

   - 提供公式將像素座標轉換為 Grid Key:
     - `gridX = Math.min(Math.floor(x / 640), 7)`
     - `gridY = Math.min(Math.floor(y / 480), 6)`
     - `gridKey = "${gridX}_${gridY}"`
   - 提供函式 `getSurroundingGridKeys(gridX, gridY)`，回傳包含中心與周圍相鄰（共最多 9 個）的 `gridKey` 清單。

3. **Server Loop (Tick Rate):**

   - 設定每秒更新 20 次 (Tick Interval = $50$ ms)。
   - **每一個 Tick 執行的流程：**
     1. 更新所有連線玩家的當前 `gridKey`。
     2. 遍歷每一個玩家，取得其對應的 9 個周圍 `gridKey` 清單 (AOI 視野範圍)。
     3. 篩選出站在這 9 個網格內的所有玩家位置。
     4. 發送 `update` 封包給該玩家：
        `{ type: 'update', players: [{ id, x, y }, ...] }`

4. **斷線處理 (Disconnect):**
   - 當玩家離線，自記憶體清單中刪除，停止廣播其座標。

---

## 6. 前端架構要求 (Frontend Requirements: `client/src/main.ts`)

1. **畫面與網格輔助 (Visuals):**

   - 初始化 Phaser 3 Game Canvas（建議解析度 $1280 \times 720$）。
   - 在背景繪製輔助網格線（每 $640 \times 480$ px 畫一條灰色弱線），方便驗證九宮格跨區。

2. **玩家控制 (Local Player):**

   - 自己使用方向鍵 (Keyboard Cursors) 移動。
   - 控制本地 Sprite (可以使用簡單圓形或預設圖片) 移動，並在移動時以 WebSocket 發送最新座標給伺服器：
     `{ type: 'move', x, y }`

3. **AOI 動態進出場處理 (AOI State Sync):**

   - 收到 `update` 封包時：
     - **新玩家出現 (Enter):** 若 `players` 陣列包含未見過的 `id`，創建新的 Sprite (如藍色圓形) 並記錄其座標。
     - **位置更新 (Move):** 若 `id` 已存在，更新其目標座標 `targetX`, `targetY`。
     - **玩家離開視野 (Leave):** 比對目前的 `players` 清單，若原本存在的玩家 **不在** 這次的清單內，立刻銷毀 (`destroy()`) 該玩家的 Sprite 並釋放記憶體。

4. **平滑移動 (Interpolation / Lerp):**
   - 在 Phaser 的 `update()` 生命週期中，使用 `Phaser.Math.Linear` 或 `Lerp` 讓其他玩家的 Sprite 平滑過渡至 `targetX`, `targetY`，消除卡頓感。

---

## 7. 程式碼生成指令 (Instructions for Cursor)

請按照以下步驟生成專案檔案：

1. **後端 `server/`**：初始化 `package.json`（含 `ws`、`typescript`、`tsx` 依賴），建立 `tsconfig.json`，並依規格實作 `src/index.ts`、`src/grid.ts`、`src/types.ts`。
   - 啟動方式：`npm run dev`（內部執行 `tsx watch src/index.ts`）。
2. **前端 `client/`**：使用 Vite 初始化專案，安裝 `phaser`、`typescript`、`vite` 依賴，建立 `index.html`、`tsconfig.json`、`vite.config.ts`，並依規格實作 `src/main.ts`、`src/scene.ts`、`src/network.ts`、`src/types.ts`。
   - 啟動方式：`npm run dev`（內部執行 `vite`）。
3. **共享封包型別**：前後端各自定義一致的 WebSocket 封包型別（`init`、`move`、`update`），確保溝通格式相符。
4. **輸出執行步驟**：告訴我如何啟動伺服器與前端進行多人連線測試。