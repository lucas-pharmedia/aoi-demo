/**
 * AOI 九宮格即時同步伺服器 (單執行緒 - 極速 ArrayBuffer 二進位版)
 *
 * 優化重點：
 *   1. 使用 enum Opcode 規範二進位通訊協定
 *   2. 全二進位通訊 (ArrayBuffer + DataView)：徹底消滅 JSON.stringify 字串 GC
 *   3. 預留全域共享可重用 Buffer (Shared ArrayBuffer)：0 記憶體配置，直接壓低 Compute 時間
 *   4. 數字化 Player ID (Uint16)：省去字串比對與記憶體負擔
 *   5. 休眠型自適應遊戲主迴圈 (解決 setImmediate 導致 CPU 100% 空轉與 Timer 漂移)
 *   6. QuickSelect (中點 Pivot，無 Math.random() 開銷)
 */
import { WebSocketServer, WebSocket } from "ws";
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  GRID_COLS,
  GRID_ROWS,
  toGrid,
  getSurroundingGridIds,
} from "../../shared/grid.ts";

const PORT = 8088;
const TICK_RATE = 8; // 8 Hz
const TICK_MS = 1000 / TICK_RATE; // 125ms

// 🟢 1. 設為 0，確保任何微小的移動都會即時廣播，消除「忽快忽慢」的鋸齒突跳感
const MOVE_THRESHOLD_SQ = 0;

// 🟢 2. 將全量快照調整為 24 Ticks (約 3 秒一次)，避免每秒全量校正干擾正常的 Lerp 插值
const SNAPSHOT_TICKS = 24;

const MAX_AOI_CAP = 100; // 視野最多顯示人數
const HEARTBEAT_MS = 10_000; // 10s 探活一次；連續兩輪無 pong ≈ 20s 踢除

/** 64 KB：網路積壓防衛，超過則丟本幀廣播，保護 server RAM */
const BACKPRESSURE_DROP_BYTES = 64 * 1024;
/** 1 MB：熔斷門檻，判定 client 假死 / 不消費，強制踢除 */
const BACKPRESSURE_KILL_BYTES = 1024 * 1024;

// ----------------------------------------------------------------------
// 二進位 Opcode 定義 (Enum 封裝)
// ----------------------------------------------------------------------
export enum Opcode {
  Init = 1,
  Move = 2,
  Enter = 3,
  Leave = 4,
  Update = 5,
}

// ----------------------------------------------------------------------
// 全域共享記憶體池與 二進位 Buffer (Zero-Allocation Buffer Pool)
// ----------------------------------------------------------------------
const OUT_BUFFER = new ArrayBuffer(65536);
const OUT_VIEW = new DataView(OUT_BUFFER);

interface TrackedPlayerInfo {
  x: number;
  y: number;
  lastSeenTick: number;
}

interface ConnectedPlayer {
  numId: number; // 數字型態 ID (1 ~ 65535)
  x: number;
  y: number;
  ws: WebSocket;
  gridId: number;
  lastKnown: Map<number, TrackedPlayerInfo>;
  snapOffset: number;
  /** WebSocket ping/pong 探活；heartbeat 輪到時先清 false，收到 pong 再設回 true */
  isAlive: boolean;
}

/** 所有玩家 */
const players = new Map<number, ConnectedPlayer>();

/** Spatial Buckets */
const gridBuckets: ConnectedPlayer[][] = Array.from(
  { length: GRID_COLS * GRID_ROWS },
  () => []
);

const tempNearby: ConnectedPlayer[] = [];
const tempEnters: ConnectedPlayer[] = [];
const tempMoves: ConnectedPlayer[] = [];
const tempLeaves: number[] = [];

let currentTick = 0;
let nextNumId = 1;
let bufferedWarningCount = 0;
const wss = new WebSocketServer({ port: PORT, backlog: 2048 });

function randomSpawn(): { x: number; y: number } {
  const x = Math.random() * (MAP_WIDTH - 64) + 32;
  const y = Math.random() * (MAP_HEIGHT - 64) + 32;
  return { x, y };
}

function addToBucket(p: ConnectedPlayer): void {
  gridBuckets[p.gridId].push(p);
}

function removeFromBucket(p: ConnectedPlayer): void {
  const bucket = gridBuckets[p.gridId];
  const idx = bucket.indexOf(p);
  if (idx >= 0) bucket.splice(idx, 1);
}

/** 同步從 players / gridBuckets 卸下玩家；可重入（heartbeat + close 都可能呼叫） */
function detachPlayer(p: ConnectedPlayer): void {
  if (!players.delete(p.numId)) return;
  removeFromBucket(p);
}

/**
 * 發送前積壓檢查。
 * - 1MB：任何 opcode 都熔斷踢除
 * - 64KB：只丟高頻 Move；Init/Enter/Leave/Update 不丟（狀態包）
 */
function canSendOrDrop(p: ConnectedPlayer, opcode: Opcode): boolean {
  const { ws } = p;
  if (ws.readyState !== WebSocket.OPEN) return false;

  if (ws.bufferedAmount > BACKPRESSURE_KILL_BYTES) {
    console.warn(
      `[NET KILL] Player p_${p.numId} bufferedAmount>${(
        BACKPRESSURE_KILL_BYTES /
        1024 /
        1024
      ).toFixed(0)}MB，強制踢除`
    );
    detachPlayer(p);
    ws.terminate();
    return false;
  }

  if (opcode === Opcode.Move && ws.bufferedAmount > BACKPRESSURE_DROP_BYTES) {
    bufferedWarningCount++;
    return false;
  }

  return true;
}

// ----------------------------------------------------------------------
// 二進位封包打包與發送函式 (Binary Encoders)
// ----------------------------------------------------------------------

/** 發送 Init 封包 [1B Opcode][2B SelfId][4B X][4B Y][2B MapW][2B MapH] (15 Bytes) */
function sendInitBinary(p: ConnectedPlayer) {
  if (!canSendOrDrop(p, Opcode.Init)) return;
  OUT_VIEW.setUint8(0, Opcode.Init);
  OUT_VIEW.setUint16(1, p.numId, true);
  OUT_VIEW.setFloat32(3, p.x, true);
  OUT_VIEW.setFloat32(7, p.y, true);
  OUT_VIEW.setUint16(11, MAP_WIDTH, true);
  OUT_VIEW.setUint16(13, MAP_HEIGHT, true);
  p.ws.send(new Uint8Array(OUT_BUFFER, 0, 15));
}

/** 發送 Enter / Move / Update 複數玩家陣列封包 [1B Opcode][2B Count] + Count * [2B Id][4B X][4B Y] (10 Bytes/Person) */
function sendPlayerListBinary(
  p: ConnectedPlayer,
  opcode: Opcode,
  list: ConnectedPlayer[],
  count: number
) {
  if (count === 0 || !canSendOrDrop(p, opcode)) return;

  OUT_VIEW.setUint8(0, opcode);
  OUT_VIEW.setUint16(1, count, true);

  let offset = 3;
  for (let i = 0; i < count; i++) {
    const target = list[i];
    OUT_VIEW.setUint16(offset, target.numId, true);
    OUT_VIEW.setFloat32(offset + 2, target.x, true);
    OUT_VIEW.setFloat32(offset + 6, target.y, true);
    offset += 10;
  }

  p.ws.send(new Uint8Array(OUT_BUFFER, 0, offset));
}

/** 發送 Leave 玩家離開封包 [1B Opcode][2B Count] + Count * [2B Id] */
function sendLeavesBinary(p: ConnectedPlayer, leaveIds: number[]) {
  if (leaveIds.length === 0 || !canSendOrDrop(p, Opcode.Leave)) return;

  const count = leaveIds.length;
  OUT_VIEW.setUint8(0, Opcode.Leave);
  OUT_VIEW.setUint16(1, count, true);

  let offset = 3;
  for (let i = 0; i < count; i++) {
    OUT_VIEW.setUint16(offset, leaveIds[i], true);
    offset += 2;
  }

  p.ws.send(new Uint8Array(OUT_BUFFER, 0, offset));
}

// ----------------------------------------------------------------------
// WebSocket 伺服器監聽與二進位接收處理
// ----------------------------------------------------------------------

wss.on("connection", (ws) => {
  ws.binaryType = "arraybuffer"; // 設定接收二進位格式

  const numId = nextNumId++;
  if (nextNumId > 65535) nextNumId = 1; // 循環 16-bit ID

  const { x, y } = randomSpawn();
  const gId = toGrid(x, y);

  const player: ConnectedPlayer = {
    numId,
    x,
    y,
    ws,
    gridId: gId,
    lastKnown: new Map(),
    snapOffset: numId % SNAPSHOT_TICKS,
    isAlive: true,
  };

  players.set(numId, player);
  addToBucket(player);

  sendInitBinary(player);

  ws.on("pong", () => {
    player.isAlive = true;
  });

  ws.on("message", (raw: ArrayBuffer) => {
    // 接收 Client 移動二進位封包 [1B Opcode (2)][4B X][4B Y] (共 9 Bytes)
    if (raw.byteLength < 9) return;

    const inView = new DataView(raw);
    const opcode = inView.getUint8(0) as Opcode;

    if (opcode === Opcode.Move) {
      const newX = inView.getFloat32(1, true);
      const newY = inView.getFloat32(5, true);

      if (!isNaN(newX) && !isNaN(newY)) {
        player.x = Math.max(0, Math.min(newX, MAP_WIDTH));
        player.y = Math.max(0, Math.min(newY, MAP_HEIGHT));

        const newGridId = toGrid(player.x, player.y);
        if (newGridId !== player.gridId) {
          removeFromBucket(player);
          player.gridId = newGridId;
          addToBucket(player);
        }
      }
    }
  });

  ws.on("close", () => {
    detachPlayer(player);
  });
});

// ----------------------------------------------------------------------
// WebSocket 心跳探活 (ping / pong → ConnectedPlayer.isAlive)
// ----------------------------------------------------------------------

const heartbeatTimer = setInterval(() => {
  for (const p of players.values()) {
    if (!p.isAlive) {
      console.warn(`[HB] Player p_${p.numId} 無 pong，踢除`);
      detachPlayer(p);
      p.ws.terminate();
      continue;
    }
    p.isAlive = false;
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.ping();
    }
  }
}, HEARTBEAT_MS);

heartbeatTimer.unref?.();

wss.on("close", () => clearInterval(heartbeatTimer));

// ----------------------------------------------------------------------
// QuickSelect 極速 Top-K (In-Place Swap)
// ----------------------------------------------------------------------

function partition(
  p: ConnectedPlayer,
  arr: ConnectedPlayer[],
  left: number,
  right: number,
  pivotIndex: number
): number {
  const pivotPlayer = arr[pivotIndex];
  const dxP = pivotPlayer.x - p.x;
  const dyP = pivotPlayer.y - p.y;
  const pivotDist = dxP * dxP + dyP * dyP;

  const tempPivot = arr[pivotIndex];
  arr[pivotIndex] = arr[right];
  arr[right] = tempPivot;

  let storeIndex = left;

  for (let i = left; i < right; i++) {
    const q = arr[i];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const dist = dx * dx + dy * dy;

    if (dist < pivotDist) {
      const temp = arr[i];
      arr[i] = arr[storeIndex];
      arr[storeIndex] = temp;
      storeIndex++;
    }
  }

  const tempFinal = arr[storeIndex];
  arr[storeIndex] = arr[right];
  arr[right] = tempFinal;

  return storeIndex;
}

function quickSelectTopK(
  p: ConnectedPlayer,
  arr: ConnectedPlayer[],
  left: number,
  right: number,
  k: number
): void {
  while (left < right) {
    const pivotIndex = (left + right) >> 1;
    const newPivot = partition(p, arr, left, right, pivotIndex);

    if (newPivot === k) return;
    else if (newPivot > k) right = newPivot - 1;
    else left = newPivot + 1;
  }
}

function selectNearestAOI(
  p: ConnectedPlayer,
  candidateCount: number,
  maxCap: number
): number {
  if (candidateCount <= maxCap) return candidateCount;
  quickSelectTopK(p, tempNearby, 0, candidateCount - 1, maxCap);
  return maxCap;
}

// ----------------------------------------------------------------------
// 視圖同步 (全二進位版)
// ----------------------------------------------------------------------

function syncViewOptimized(p: ConnectedPlayer, nearbyCount: number): void {
  const lastKnown = p.lastKnown;
  tempEnters.length = 0;
  tempMoves.length = 0;

  // 1. 比對 Enter 與 Move
  for (let i = 0; i < nearbyCount; i++) {
    const q = tempNearby[i];
    const prev = lastKnown.get(q.numId);

    if (!prev) {
      tempEnters.push(q);
      lastKnown.set(q.numId, { x: q.x, y: q.y, lastSeenTick: currentTick });
    } else {
      prev.lastSeenTick = currentTick;
      const dx = q.x - prev.x;
      const dy = q.y - prev.y;

      // 🟢 3. 取消門檻過濾：只要座標有變動就直接發送，確保 8Hz 移動軌跡平滑無卡衝
      if (dx !== 0 || dy !== 0) {
        tempMoves.push(q);
        prev.x = q.x;
        prev.y = q.y;
      }
    }
  }

  // 2. 比對 Leave
  tempLeaves.length = 0;
  for (const [id, info] of lastKnown) {
    if (info.lastSeenTick !== currentTick) {
      tempLeaves.push(id);
    }
  }

  for (let i = 0; i < tempLeaves.length; i++) {
    lastKnown.delete(tempLeaves[i]);
  }

  // 發送二進位封包（含 bufferedAmount 防衛）
  if (tempLeaves.length > 0) sendLeavesBinary(p, tempLeaves);
  if (tempEnters.length > 0)
    sendPlayerListBinary(p, Opcode.Enter, tempEnters, tempEnters.length);
  if (tempMoves.length > 0)
    sendPlayerListBinary(p, Opcode.Move, tempMoves, tempMoves.length);
}

// ----------------------------------------------------------------------
// 自適應高精度遊戲主迴圈
// ----------------------------------------------------------------------

let lastTime = performance.now();
let accumulator = 0;

let tickIntervalSum = 0;
let tickComputeSum = 0;
let tickCount = 0;

function updateTick() {
  currentTick++;

  if (players.size === 0) return;

  const computeStart = performance.now();

  for (const p of players.values()) {
    const aoiIds = getSurroundingGridIds(p.gridId);
    tempNearby.length = 0;

    for (let i = 0; i < aoiIds.length; i++) {
      const bucket = gridBuckets[aoiIds[i]];
      if (bucket) {
        for (let j = 0; j < bucket.length; j++) {
          const other = bucket[j];
          if (other.numId !== p.numId) {
            tempNearby.push(other);
          }
        }
      }
    }

    const nearbyCount = selectNearestAOI(p, tempNearby.length, MAX_AOI_CAP);
    syncViewOptimized(p, nearbyCount);

    // 全量快照更新（改為約 3 秒一次）
    if ((currentTick + p.snapOffset) % SNAPSHOT_TICKS === 0) {
      for (let i = 0; i < nearbyCount; i++) {
        p.lastKnown.set(tempNearby[i].numId, {
          x: tempNearby[i].x,
          y: tempNearby[i].y,
          lastSeenTick: currentTick,
        });
      }
      sendPlayerListBinary(p, Opcode.Update, tempNearby, nearbyCount);
    }
  }

  tickComputeSum += performance.now() - computeStart;
  tickCount++;

  if (currentTick % 24 === 0 && tickCount > 0) {
    const avgInterval = (tickIntervalSum / tickCount).toFixed(1);
    const avgCompute = (tickComputeSum / tickCount).toFixed(1);
    console.log(
      `[Binary-Opt 8Hz] avgInterval=${avgInterval}ms compute=${avgCompute}ms players=${players.size} bufferWarnings=${bufferedWarningCount}`
    );
    tickIntervalSum = 0;
    tickComputeSum = 0;
    tickCount = 0;
    bufferedWarningCount = 0;
  }
}

function gameLoop() {
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;

  tickIntervalSum += deltaTime;
  accumulator += deltaTime;

  while (accumulator >= TICK_MS) {
    updateTick();
    accumulator -= TICK_MS;
  }

  const nextDelay = Math.max(0, TICK_MS - accumulator);
  setTimeout(gameLoop, nextDelay);
}

gameLoop();

console.log(
  `[Binary-Opt 8Hz] PID:${process.pid} 啟動於 port ${PORT}, AOI_CAP=${MAX_AOI_CAP}`
);
