/**
 * AOI 九宮格即時同步伺服器 (單執行緒 - 極速精確最近 N 人版)
 *
 * 核心修復：
 *   1. 完全復原原有的 ./grid.ts 模組引入 (MAP_WIDTH, MAP_HEIGHT, toGrid, gridKey 等)
 *   2. 精確最近 N 人：使用 selectNearestAOI 搭配平方距離比對，不開根號且 100% 安全
 *   3. 零 GC 配置：全域復用陣列，徹底解決 GC 帶來的 Spike
 */
import { WebSocketServer, WebSocket } from "ws";
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  toGrid,
  gridKey,
  getSurroundingGridKeys,
} from "./grid.ts";
import type { PlayerState, ServerPacket, ClientPacket } from "./types.ts";

const PORT = 8088;
const TICK_MS = 33; // 30 FPS (黃金標準)
const MOVE_THRESHOLD_SQ = 1 * 1; // 1px 移動門檻平方
const SNAPSHOT_TICKS = 30; // 約 1 秒一次全量快照
const MAX_AOI_CAP = 50; // 視野最多顯示人數

interface ConnectedPlayer extends PlayerState {
  ws: WebSocket;
  gridKey: string;
  lastKnown: Map<string, { x: number; y: number }>;
  snapOffset: number;
  plain: PlayerState; // 預先快照好的純資料物件
}

/** 所有玩家 */
const players = new Map<string, ConnectedPlayer>();

/** 持久化 Spatial Bucket (使用原本 gridKey 算出的 string Key) */
type BucketEntry = ConnectedPlayer;
const gridBuckets = new Map<string, BucketEntry[]>();
const playerBucketKey = new Map<string, string>();

// ----------------------------------------------------------------------
// 全域重用記憶體池 (Zero-Allocation)，徹底消滅 GC 負擔
// ----------------------------------------------------------------------
const tempNearby: ConnectedPlayer[] = [];
const tempEnters: PlayerState[] = [];
const tempMoves: PlayerState[] = [];
const tempLeaves: string[] = [];

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

wss.on("connection", (ws) => {
  const id = `p_${nextId++}`;
  const { x, y } = randomSpawn();
  const { gx, gy } = toGrid(x, y);
  const key = gridKey(gx, gy);

  const player: ConnectedPlayer = {
    id,
    x,
    y,
    ws,
    gridKey: key,
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

        const { gx: ngx, gy: ngy } = toGrid(player.x, player.y);
        player.gridKey = gridKey(ngx, ngy);
      }
    } catch {
      // 忽略壞掉的封包
    }
  });

  ws.on("close", () => {
    players.delete(id);
    removeFromBucket(id);
  });
});

/**
 * 精確的最近 N 人快速排序 (平方距離比對，零開根號，安全不遺失物件)
 */
function selectNearestAOI(
  p: ConnectedPlayer,
  candidateCount: number,
  maxCap: number
): number {
  if (candidateCount <= maxCap) {
    return candidateCount;
  }

  // 使用平方距離快速排序，不呼叫昂貴的 Math.sqrt
  tempNearby.sort((a, b) => {
    const dxA = a.x - p.x;
    const dyA = a.y - p.y;
    const distA = dxA * dxA + dyA * dyA;

    const dxB = b.x - p.x;
    const dyB = b.y - p.y;
    const distB = dxB * dxB + dyB * dyB;

    return distA - distB;
  });

  return maxCap;
}

/**
 * 零 GC 配置的視圖同步 (重用全域陣列)
 */
function syncViewOptimized(p: ConnectedPlayer, nearbyCount: number): void {
  const lastKnown = p.lastKnown;
  tempEnters.length = 0;
  tempMoves.length = 0;

  // 1. 單次 O(N) 比對 Enter 與 Move
  for (let i = 0; i < nearbyCount; i++) {
    const q = tempNearby[i];
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

  // 2. 檢查 Leave
  if (lastKnown.size > nearbyCount - tempEnters.length) {
    tempLeaves.length = 0;
    for (const [id] of lastKnown) {
      let found = false;
      for (let i = 0; i < nearbyCount; i++) {
        if (tempNearby[i].id === id) {
          found = true;
          break;
        }
      }
      if (!found) tempLeaves.push(id);
    }

    for (let i = 0; i < tempLeaves.length; i++) {
      lastKnown.delete(tempLeaves[i]);
    }

    if (tempLeaves.length > 0)
      send(p.ws, { type: "leave", players: tempLeaves });
  }

  if (tempEnters.length > 0) send(p.ws, { type: "enter", players: tempEnters });
  if (tempMoves.length > 0) send(p.ws, { type: "move", players: tempMoves });
}

function addToBucket(p: BucketEntry): void {
  let arr = gridBuckets.get(p.gridKey);
  if (!arr) {
    arr = [];
    gridBuckets.set(p.gridKey, arr);
  }
  arr.push(p);
  playerBucketKey.set(p.id, p.gridKey);
}

function removeFromBucket(id: string): void {
  const key = playerBucketKey.get(id);
  if (!key) return;
  const arr = gridBuckets.get(key);
  if (arr) {
    const i = arr.findIndex((p) => p.id === id);
    if (i >= 0) arr.splice(i, 1);
  }
  playerBucketKey.delete(id);
}

function applyLocalBucketMoves(): void {
  for (const p of players.values()) {
    const key = playerBucketKey.get(p.id);
    if (key !== p.gridKey) {
      if (key) {
        const arr = gridBuckets.get(key);
        if (arr) {
          const i = arr.findIndex((q) => q.id === p.id);
          if (i >= 0) arr.splice(i, 1);
        }
      }
      addToBucket(p);
    }
  }
}

let tick = 0;
let lastTickTime = Date.now();
let tickIntervalSum = 0;
let tickComputeSum = 0;
let tickCount = 0;

setInterval(() => {
  const now = Date.now();
  const interval = now - lastTickTime;
  lastTickTime = now;

  if (interval > 80) {
    console.log(
      `[Single-Opt] spike interval=${interval}ms total=${players.size}`
    );
  }

  const computeStart = now;
  tick++;
  tickIntervalSum += interval;
  tickCount++;

  // 1. 維護 Spatial Bucket
  applyLocalBucketMoves();

  // 2. 對每個玩家算 AOI
  for (const p of players.values()) {
    const { gx, gy } = toGrid(p.x, p.y);
    const aoiKeys = getSurroundingGridKeys(gx, gy);

    tempNearby.length = 0;

    // 完全使用你原本的九宮格 Key 陣列尋找桶子
    for (let i = 0; i < aoiKeys.length; i++) {
      const bucket = gridBuckets.get(aoiKeys[i]);
      if (bucket) {
        for (let j = 0; j < bucket.length; j++) {
          const other = bucket[j];
          if (other.id !== p.id) {
            tempNearby.push(other);
          }
        }
      }
    }

    // 精確最近 50 人篩選 (避開 Math.sqrt 開根號)
    const nearbyCount = selectNearestAOI(p, tempNearby.length, MAX_AOI_CAP);

    // 3. 視圖同步 (Zero-Alloc)
    syncViewOptimized(p, nearbyCount);

    // 4. 定期全量 Snapshot
    if ((tick + p.snapOffset) % SNAPSHOT_TICKS === 0) {
      const snapPlayers: PlayerState[] = [];
      for (let i = 0; i < nearbyCount; i++) {
        snapPlayers.push(tempNearby[i].plain);
      }
      send(p.ws, { type: "update", players: snapPlayers });
      for (let i = 0; i < nearbyCount; i++) {
        const q = tempNearby[i];
        p.lastKnown.set(q.id, { x: q.x, y: q.y });
      }
    }
  }

  tickComputeSum += Date.now() - computeStart;

  // 每 3 秒印一次體質健康度
  if (tick % 90 === 0) {
    const avgInterval = (tickIntervalSum / tickCount).toFixed(1);
    const avgCompute = (tickComputeSum / tickCount).toFixed(1);
    console.log(
      `[Single-Opt 30Hz] avgInterval=${avgInterval}ms compute=${avgCompute}ms players=${players.size}`
    );
    tickIntervalSum = 0;
    tickComputeSum = 0;
    tickCount = 0;
  }
}, TICK_MS);

console.log(`[Single-Opt 30Hz] PID:${process.pid} 啟動於 port ${PORT}`);
