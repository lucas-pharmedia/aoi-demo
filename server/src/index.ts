/**
 * AOI 九宮格即時同步伺服器（單執行緒版）
 *
 * 架構：
 *   - 單一 process 監聽 port 8088，所有玩家狀態在同一份 Map 裡，
 *     每 tick 直接算 AOI 九宮格廣播，無 IPC、無跨行程同步。
 *
 * 對照用：cluster 版見 index-cluster.ts（master 彙整 + IPC 每 tick 同步）。
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
const TICK_MS = 16;
const MOVE_THRESHOLD = 1;
const SNAPSHOT_TICKS = 60;
const MAX_AOI_CAP = 50;

interface ConnectedPlayer extends PlayerState {
  ws: WebSocket;
  gridKey: string;
  lastKnown: Map<string, { x: number; y: number }>;
  snapOffset: number;
}

/** 所有玩家（單 process，全部在自己手上） */
const players = new Map<string, ConnectedPlayer>();
/** 持久化 Spatial Bucket（增量維護，不每 tick 全量重建） */
type BucketEntry = PlayerState & { gridKey: string };
const gridBuckets = new Map<string, BucketEntry[]>();
/** id -> 目前所在的 bucket gridKey（追蹤增量移動） */
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

/** 只留協定欄位，避免把 ws/socket 內部物件序列化出去 */
function toPlain(p: { id: string; x: number; y: number }): PlayerState {
  return { id: p.id, x: p.x, y: p.y };
}

wss.on("connection", (ws) => {
  const id = `p_${nextId++}`;
  const { x, y } = randomSpawn();
  const { gx, gy } = toGrid(x, y);
  const player: ConnectedPlayer = {
    id,
    x,
    y,
    ws,
    gridKey: gridKey(gx, gy),
    lastKnown: new Map(),
    snapOffset: nextId % SNAPSHOT_TICKS,
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

function syncView(p: ConnectedPlayer, nearby: PlayerState[]): void {
  const nextIds = new Set(nearby.map((q) => q.id));
  const enters: PlayerState[] = [];
  const leaves: string[] = [];
  const moves: PlayerState[] = [];

  for (const q of nearby) {
    const prev = p.lastKnown.get(q.id);
    if (!prev) {
      enters.push(q);
      p.lastKnown.set(q.id, { x: q.x, y: q.y });
      continue;
    }
    if (Math.hypot(q.x - prev.x, q.y - prev.y) >= MOVE_THRESHOLD) {
      moves.push(q);
      p.lastKnown.set(q.id, { x: q.x, y: q.y });
    }
  }

  for (const id of [...p.lastKnown.keys()]) {
    if (!nextIds.has(id)) leaves.push(id);
  }
  for (const id of leaves) p.lastKnown.delete(id);

  if (enters.length) send(p.ws, { type: "enter", players: enters.map(toPlain) });
  if (leaves.length) send(p.ws, { type: "leave", players: leaves });
  if (moves.length) send(p.ws, { type: "move", players: moves.map(toPlain) });
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

/** 每 tick 只把玩家位置的增量搬進正確 bucket（連線已持有同一物件，位置自動更新） */
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
    console.log(`[Single] spike interval=${interval}ms total=${players.size}`);
  }
  const computeStart = now;
  tick++;
  tickIntervalSum += interval;
  tickCount++;

  // 增量維護 Spatial Bucket（只搬跨格玩家，不全量重建）
  applyLocalBucketMoves();

  // 對每個玩家算 AOI 九宮格
  for (const p of players.values()) {
    const { gx, gy } = toGrid(p.x, p.y);
    const aoiKeys = getSurroundingGridKeys(gx, gy);

    let nearby: PlayerState[] = [];
    for (const key of aoiKeys) {
      const bucket = gridBuckets.get(key);
      if (bucket) {
        for (const other of bucket) {
          if (other.id !== p.id) nearby.push(other);
        }
      }
    }

    nearby = nearest(p.x, p.y, nearby, MAX_AOI_CAP);

    syncView(p, nearby);

    if ((tick + p.snapOffset) % SNAPSHOT_TICKS === 0) {
      send(p.ws, { type: "update", players: nearby.map(toPlain) });
      for (const q of nearby) p.lastKnown.set(q.id, { x: q.x, y: q.y });
    }
  }
  tickComputeSum += Date.now() - computeStart;

  // 每 3 秒印一次 tick 體質：實際間隔 vs 計算耗時（間隔遠大於 TICK_MS = server 在卡）
  if (tick % 180 === 0) {
    const avgInterval = (tickIntervalSum / tickCount).toFixed(1);
    const avgCompute = (tickComputeSum / tickCount).toFixed(1);
    console.log(
      `[Single] tick avgInterval=${avgInterval}ms compute=${avgCompute}ms players=${players.size}`
    );
    tickIntervalSum = 0;
    tickComputeSum = 0;
    tickCount = 0;
  }
}, TICK_MS);

console.log(`[Single] PID:${process.pid} 啟動於 port ${PORT}`);
