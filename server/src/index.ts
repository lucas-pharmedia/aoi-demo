/**
 * AOI 九宮格即時同步伺服器 (單執行緒 - 極速優化版)
 *
 * 優化重點：
 *   1. setImmediate + performance.now() 自適應遊戲主迴圈 (解決 Timer 漂移)
 *   2. QuickSelect (中點 Pivot，無 Math.random() 開銷)
 *   3. 修正獨立 lastSeenTick 追蹤機制 (解決 Leave 判斷失真 Bug)
 *   4. Zero-Alloc 物件與陣列重用 (降低 GC Spike 頻率)
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
import type { PlayerState, ServerPacket, ClientPacket } from "./types.ts";

const PORT = 8088;
const TICK_RATE = 15; // 15 Hz
const TICK_MS = 1000 / TICK_RATE; // 66.666ms
const MOVE_THRESHOLD_SQ = 1 * 1; // 1px 移動門檻平方
const SNAPSHOT_TICKS = 15; // 15 Ticks = 約 1 秒一次全量快照
const MAX_AOI_CAP = 50; // 視野最多顯示人數

interface TrackedPlayerInfo {
  x: number;
  y: number;
  lastSeenTick: number;
}

interface ConnectedPlayer extends PlayerState {
  ws: WebSocket;
  gridId: number;
  lastKnown: Map<string, TrackedPlayerInfo>;
  snapOffset: number;
  plain: PlayerState;
}

/** 所有玩家 */
const players = new Map<string, ConnectedPlayer>();

/** Spatial Buckets (數字 Key 避免字串 GC) */
const gridBuckets: ConnectedPlayer[][] = Array.from(
  { length: GRID_COLS * GRID_ROWS },
  () => []
);

// ----------------------------------------------------------------------
// 全域重用記憶體池 (Zero-Allocation)
// ----------------------------------------------------------------------
const tempNearby: ConnectedPlayer[] = [];
const tempEnters: PlayerState[] = [];
const tempMoves: PlayerState[] = [];
const tempLeaves: string[] = [];
const snapPlayersPool: PlayerState[] = [];

let currentTick = 0;
let nextId = 1;
const wss = new WebSocketServer({ port: PORT });

function randomSpawn(): { x: number; y: number } {
  const x = Math.random() * (MAP_WIDTH - 64) + 32;
  const y = Math.random() * (MAP_HEIGHT - 64) + 32;
  return { x, y };
}

function send(ws: WebSocket, packet: ServerPacket) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(packet));
  }
}

function addToBucket(p: ConnectedPlayer): void {
  gridBuckets[p.gridId].push(p);
}

function removeFromBucket(p: ConnectedPlayer): void {
  const bucket = gridBuckets[p.gridId];
  const idx = bucket.indexOf(p);
  if (idx >= 0) bucket.splice(idx, 1);
}

wss.on("connection", (ws) => {
  const id = `p_${nextId++}`;
  const { x, y } = randomSpawn();
  const gId = toGrid(x, y);

  const player: ConnectedPlayer = {
    id,
    x,
    y,
    ws,
    gridId: gId,
    lastKnown: new Map(),
    snapOffset: nextId % SNAPSHOT_TICKS,
    plain: { id, x, y },
  };

  players.set(id, player);
  addToBucket(player);

  send(ws, {
    type: "init",
    selfId: id,
    x,
    y,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientPacket;
      if (
        msg.type === "move" &&
        typeof msg.x === "number" &&
        typeof msg.y === "number" &&
        !isNaN(msg.x) &&
        !isNaN(msg.y)
      ) {
        player.x = Math.max(0, Math.min(msg.x, MAP_WIDTH));
        player.y = Math.max(0, Math.min(msg.y, MAP_HEIGHT));
        player.plain.x = player.x;
        player.plain.y = player.y;

        const newGridId = toGrid(player.x, player.y);
        if (newGridId !== player.gridId) {
          removeFromBucket(player);
          player.gridId = newGridId;
          addToBucket(player);
        }
      }
    } catch {
      // 忽略無效封包
    }
  });

  ws.on("close", () => {
    players.delete(id);
    removeFromBucket(player);
  });
});

// ----------------------------------------------------------------------
// QuickSelect 極速 Top-K 演算法 (無 Math.random, In-Place Swap)
// ----------------------------------------------------------------------

/** 原地 Partition：以 pivot 為基準，比 pivot 近的換到左邊 */
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

  // 1. 將 Pivot 暫存至最右邊
  const tempPivot = arr[pivotIndex];
  arr[pivotIndex] = arr[right];
  arr[right] = tempPivot;

  let storeIndex = left;

  // 2. 比 pivotDist 近的集中到左區塊
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

  // 3. 將 Pivot 歸位
  const tempFinal = arr[storeIndex];
  arr[storeIndex] = arr[right];
  arr[right] = tempFinal;

  return storeIndex;
}

/** In-Place QuickSelect (改用中點取 Pivot，節省 CPU 開銷) */
function quickSelectTopK(
  p: ConnectedPlayer,
  arr: ConnectedPlayer[],
  left: number,
  right: number,
  k: number
): void {
  while (left < right) {
    const pivotIndex = (left + right) >> 1; // 中點 Pivot，比 Math.random() 快
    const newPivot = partition(p, arr, left, right, pivotIndex);

    if (newPivot === k) {
      return; // 前 K 個已正確分割歸位至左側
    } else if (newPivot > k) {
      right = newPivot - 1;
    } else {
      left = newPivot + 1;
    }
  }
}

/**
 * 精確的最近 N 人篩選 (QuickSelect O(K) 優化版)
 */
function selectNearestAOI(
  p: ConnectedPlayer,
  candidateCount: number,
  maxCap: number
): number {
  if (candidateCount <= maxCap) {
    return candidateCount;
  }

  quickSelectTopK(p, tempNearby, 0, candidateCount - 1, maxCap);
  return maxCap;
}

/**
 * 視圖同步 (修復獨佔 lastSeenTick)
 */
function syncViewOptimized(p: ConnectedPlayer, nearbyCount: number): void {
  const lastKnown = p.lastKnown;
  tempEnters.length = 0;
  tempMoves.length = 0;

  // 1. 處理 Enter 與 Move
  for (let i = 0; i < nearbyCount; i++) {
    const q = tempNearby[i];
    const prev = lastKnown.get(q.id);

    if (!prev) {
      tempEnters.push(q.plain);
      lastKnown.set(q.id, { x: q.x, y: q.y, lastSeenTick: currentTick });
    } else {
      prev.lastSeenTick = currentTick; // 標記此玩家的獨立視野在當前 Tick 看到 q
      const dx = q.x - prev.x;
      const dy = q.y - prev.y;
      if (dx * dx + dy * dy >= MOVE_THRESHOLD_SQ) {
        tempMoves.push(q.plain);
        prev.x = q.x;
        prev.y = q.y;
      }
    }
  }

  // 2. 利用各自獨立的 lastSeenTick 做 O(1) 準確判定 Leave
  tempLeaves.length = 0;
  for (const [id, info] of lastKnown) {
    if (info.lastSeenTick !== currentTick) {
      tempLeaves.push(id);
    }
  }

  for (let i = 0; i < tempLeaves.length; i++) {
    lastKnown.delete(tempLeaves[i]);
  }

  if (tempLeaves.length > 0) send(p.ws, { type: "leave", players: tempLeaves });
  if (tempEnters.length > 0) send(p.ws, { type: "enter", players: tempEnters });
  if (tempMoves.length > 0) send(p.ws, { type: "move", players: tempMoves });
}

// ----------------------------------------------------------------------
// 自適應高精度遊戲主迴圈 (Main Game Loop)
// ----------------------------------------------------------------------

let lastTime = performance.now();
let accumulator = 0;

let tickIntervalSum = 0;
let tickComputeSum = 0;
let tickCount = 0;

function updateTick() {
  const computeStart = performance.now();
  currentTick++;

  // 伺服器 Tick 主邏輯
  for (const p of players.values()) {
    const aoiIds = getSurroundingGridIds(p.gridId);
    tempNearby.length = 0;

    // 收集九宮格範圍內的所有玩家
    for (let i = 0; i < aoiIds.length; i++) {
      const bucket = gridBuckets[aoiIds[i]];
      if (bucket) {
        for (let j = 0; j < bucket.length; j++) {
          const other = bucket[j];
          if (other.id !== p.id) {
            tempNearby.push(other);
          }
        }
      }
    }

    // QuickSelect 篩選前 50 人
    const nearbyCount = selectNearestAOI(p, tempNearby.length, MAX_AOI_CAP);

    // 視圖同步
    syncViewOptimized(p, nearbyCount);

    // 定期全量 Snapshot
    if ((currentTick + p.snapOffset) % SNAPSHOT_TICKS === 0) {
      snapPlayersPool.length = 0;
      for (let i = 0; i < nearbyCount; i++) {
        snapPlayersPool.push(tempNearby[i].plain);
        p.lastKnown.set(tempNearby[i].id, {
          x: tempNearby[i].x,
          y: tempNearby[i].y,
          lastSeenTick: currentTick,
        });
      }
      send(p.ws, { type: "update", players: snapPlayersPool });
    }
  }

  tickComputeSum += performance.now() - computeStart;
  tickCount++;

  // 每 3 秒印一次健康度 (15 Hz * 3s = 45 Ticks)
  if (currentTick % 45 === 0) {
    const avgInterval = (tickIntervalSum / tickCount).toFixed(1);
    const avgCompute = (tickComputeSum / tickCount).toFixed(1);
    console.log(
      `[Single-Opt 15Hz] avgInterval=${avgInterval}ms compute=${avgCompute}ms players=${players.size}`
    );
    tickIntervalSum = 0;
    tickComputeSum = 0;
    tickCount = 0;
  }
}

function gameLoop() {
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;

  tickIntervalSum += deltaTime;
  accumulator += deltaTime;

  // 補幀機制：若偶爾發生延遲，自動捕捉並補齊進度，防止時間軸漂移
  while (accumulator >= TICK_MS) {
    updateTick();
    accumulator -= TICK_MS;
  }

  // 使用 setImmediate 進行下一次 Loop，徹底不佔用/不依賴 setTimeout 漂移
  setImmediate(gameLoop);
}

// 啟動主迴圈
gameLoop();

console.log(`[Single-Opt 15Hz] PID:${process.pid} 啟動於 port ${PORT}`);
