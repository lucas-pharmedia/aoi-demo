/**
 * AOI 九宮格即時同步伺服器 (單執行緒 - QuickSelect 極速 Top-K 版)
 *
 * 優化重點：
 *   1. QuickSelect 演算法：篩選最近 50 人時間複雜度降至 O(K)，不對前 K 人做無謂的完備排序
 *   2. 原地交換 (In-place Swap)：零記憶體配置 (Zero-Alloc)，不產生任何新物件與 GC 負擔
 *   3. O(1) lastSeenTick 視圖判定：替代 O(N²) Leave 比對
 *   4. 15 Hz (TICK_MS = 67ms) 頻率
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
const TICK_MS = 67; // 15 Hz
const MOVE_THRESHOLD_SQ = 1 * 1; // 1px 移動門檻平方
const SNAPSHOT_TICKS = 15; // 15 Ticks = 約 1 秒一次全量快照
const MAX_AOI_CAP = 50; // 視野最多顯示人數

interface ConnectedPlayer extends PlayerState {
  ws: WebSocket;
  gridId: number;
  lastKnown: Map<string, { x: number; y: number }>;
  snapOffset: number;
  plain: PlayerState;
  lastSeenTick: number; // 用於 O(1) 判定 Leave
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
    lastSeenTick: 0,
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
// QuickSelect 極速 Top-K 演算法 (Zero-Alloc, In-Place Swap)
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

/** In-Place QuickSelect，時間複雜度 O(K) */
function quickSelectTopK(
  p: ConnectedPlayer,
  arr: ConnectedPlayer[],
  left: number,
  right: number,
  k: number
): void {
  while (left < right) {
    const pivotIndex = left + Math.floor(Math.random() * (right - left + 1));
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

  // 使用 QuickSelect 原地切分前 maxCap 個，不對 50 人做耗時的全排序
  quickSelectTopK(p, tempNearby, 0, candidateCount - 1, maxCap);

  return maxCap;
}

/**
 * 視圖同步
 */
function syncViewOptimized(p: ConnectedPlayer, nearbyCount: number): void {
  const lastKnown = p.lastKnown;
  tempEnters.length = 0;
  tempMoves.length = 0;

  // 1. 處理 Enter 與 Move
  for (let i = 0; i < nearbyCount; i++) {
    const q = tempNearby[i];
    q.lastSeenTick = currentTick; // 標記為當前 Tick 看到

    const prev = lastKnown.get(q.id);

    if (!prev) {
      tempEnters.push(q.plain);
      lastKnown.set(q.id, { x: q.x, y: q.y });
    } else {
      const dx = q.x - prev.x;
      const dy = q.y - prev.y;
      if (dx * dx + dy * dy >= MOVE_THRESHOLD_SQ) {
        tempMoves.push(q.plain);
        prev.x = q.x;
        prev.y = q.y;
      }
    }
  }

  // 2. 利用 lastSeenTick O(1) 判定 Leave
  tempLeaves.length = 0;
  for (const [id] of lastKnown) {
    const target = players.get(id);
    if (!target || target.lastSeenTick !== currentTick) {
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

let lastTickTime = Date.now();
let tickIntervalSum = 0;
let tickComputeSum = 0;
let tickCount = 0;

setInterval(() => {
  const now = Date.now();
  const interval = now - lastTickTime;
  lastTickTime = now;

  if (interval > 120) {
    console.log(
      `[Single-Opt 15Hz] spike interval=${interval}ms total=${players.size}`
    );
  }

  const computeStart = now;
  currentTick++;
  tickIntervalSum += interval;
  tickCount++;

  // 伺服器 Tick 主迴圈
  for (const p of players.values()) {
    const aoiIds = getSurroundingGridIds(p.gridId);
    tempNearby.length = 0;

    // 收集九宮格範圍內的玩家
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
      const snapPlayers: PlayerState[] = [];
      for (let i = 0; i < nearbyCount; i++) {
        snapPlayers.push(tempNearby[i].plain);
        p.lastKnown.set(tempNearby[i].id, {
          x: tempNearby[i].x,
          y: tempNearby[i].y,
        });
      }
      send(p.ws, { type: "update", players: snapPlayers });
    }
  }

  tickComputeSum += Date.now() - computeStart;

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
}, TICK_MS);

console.log(`[Single-Opt 15Hz] PID:${process.pid} 啟動於 port ${PORT}`);
