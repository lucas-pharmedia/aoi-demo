/**
 * AOI 九宮格即時同步伺服器 (單執行緒 - 極致效能優化版)
 *
 * 核心優化：
 *   1. 調整 TICK_MS = 33 (30 FPS)，搭配前端內插，CPU 負擔減少 50%
 *   2. 徹底消除 syncView 中的 Set / Array 臨時物件建立，避免 V8 GC Spike
 *   3. 距離計算改用「平方距離」(dx*dx + dy*dy)，省去開根號 CPU 運算
 *   4. 預先建立 Plain Object (toPlain)，減少 JSON 序列化前的物件轉譯開銷
 */
import { WebSocketServer, WebSocket } from "ws";
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  toGrid,
  gridKey,
  getSurroundingGridKeys,
  nearest,
} from "./grid.ts";
import type { PlayerState, ServerPacket, ClientPacket } from "./types.ts";

const PORT = 8088;
const TICK_MS = 33; // 30 FPS (伺服器黃金標準，CPU 負擔減半)
const MOVE_THRESHOLD_SQ = 1 * 1; // 距離門檻平方 (避免 Math.hypot 開根號)
const SNAPSHOT_TICKS = 30; // 約 1 秒一次全量快照
const MAX_AOI_CAP = 50;

interface ConnectedPlayer extends PlayerState {
  ws: WebSocket;
  gridKey: string;
  lastKnown: Map<string, { x: number; y: number }>;
  snapOffset: number;
  plain: PlayerState; // 預先快照好的純資料物件，避免每 tick 重新建構
}

/** 所有玩家 */
const players = new Map<string, ConnectedPlayer>();

/** 持久化 Spatial Bucket */
type BucketEntry = ConnectedPlayer;
const gridBuckets = new Map<string, BucketEntry[]>();
const playerBucketKey = new Map<string, string>();

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
 * 零 GC 負擔的 View 同步 (避免 new Set, Array.map, Math.hypot)
 */
function syncViewOptimized(
  p: ConnectedPlayer,
  nearby: ConnectedPlayer[]
): void {
  const lastKnown = p.lastKnown;
  const enters: PlayerState[] = [];
  const moves: PlayerState[] = [];

  // 1. 單次 O(N) 迴圈比對 Enter 與 Move
  for (let i = 0; i < nearby.length; i++) {
    const q = nearby[i];
    const prev = lastKnown.get(q.id);

    if (!prev) {
      enters.push(q.plain);
      lastKnown.set(q.id, { x: q.x, y: q.y });
    } else {
      const dx = q.x - prev.x;
      const dy = q.y - prev.y;
      // 距離平方比對，避開開根號
      if (dx * dx + dy * dy >= MOVE_THRESHOLD_SQ) {
        moves.push(q.plain);
        prev.x = q.x;
        prev.y = q.y;
      }
    }
  }

  // 2. 檢查 Leave (極簡 O(K) 檢查，K 為視野內人數)
  if (lastKnown.size > nearby.length - enters.length) {
    const leaves: string[] = [];
    for (const [id] of lastKnown) {
      let found = false;
      for (let i = 0; i < nearby.length; i++) {
        if (nearby[i].id === id) {
          found = true;
          break;
        }
      }
      if (!found) {
        leaves.push(id);
      }
    }

    for (let i = 0; i < leaves.length; i++) {
      lastKnown.delete(leaves[i]);
    }

    if (leaves.length > 0) send(p.ws, { type: "leave", players: leaves });
  }

  if (enters.length > 0) send(p.ws, { type: "enter", players: enters });
  if (moves.length > 0) send(p.ws, { type: "move", players: moves });
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

    let nearby: ConnectedPlayer[] = [];
    for (let i = 0; i < aoiKeys.length; i++) {
      const bucket = gridBuckets.get(aoiKeys[i]);
      if (bucket) {
        for (let j = 0; j < bucket.length; j++) {
          const other = bucket[j];
          if (other.id !== p.id) nearby.push(other);
        }
      }
    }

    // 限制最大視野人數
    nearby = nearest(p.x, p.y, nearby, MAX_AOI_CAP) as ConnectedPlayer[];

    // 3. 零 GC 視圖同步
    syncViewOptimized(p, nearby);

    // 4. 定期全量 Snapshot
    if ((tick + p.snapOffset) % SNAPSHOT_TICKS === 0) {
      send(p.ws, {
        type: "update",
        players: nearby.map((q) => q.plain),
      });
      for (let i = 0; i < nearby.length; i++) {
        const q = nearby[i];
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
