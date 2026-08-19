/**
 * AOI 九宮格即時同步伺服器 (Cluster 多核心版 + 完整 IPC 狀態同步)
 *
 * 架構：
 *   - Master：不監聽 port，只當 IPC 仲介。收集各 Worker 的玩家狀態，每 tick 彙整後
 *     廣播「全域玩家快照」給所有 Worker。
 *   - Worker：共享 port 8088，OS round-robin 分流連線。各自持有自己的 WebSocket，
 *     每 tick 把自己的玩家狀態傳給 Master，並用「全域快照 + 自己的玩家」合併計算
 *     AOI 九宮格，再直接對自己的 client 送出 enter/leave/move。
 *
 * 跨 Worker 可見性：靠每 tick 的狀態同步（gossip）達成，不需 message routing，
 * 因為 socket 只存在於 owner worker 手上，發送一律走自己的 ws。
 */
import cluster from "node:cluster";
import os from "node:os";
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
const TICK_MS = 16;
const MOVE_THRESHOLD = 1;
const SNAPSHOT_TICKS = 60;
const MAX_AOI_CAP = 50;
/** 跨 worker 狀態同步頻率：每 N tick 一次（2 = 31Hz，降低 master 廣播 + 全量 rebuild 負載）。 */
const SYNC_EVERY_TICKS = 2;

/** IPC 上傳的玩家短表（不含 ws，避免跨行程傳 socket） */
interface WorkerPlayerState extends PlayerState {
  gridKey: string;
}

// ----------------------------------------------------------------------
// Master 主進程：IPC 仲介
// ----------------------------------------------------------------------
if (cluster.isPrimary) {
  // const numCPUs = 1;
  const numCPUs = 8;
  console.log(`[Master] PID:${process.pid} 啟動，開 ${numCPUs} 個 Worker`);

  /** workerId -> 該 worker 最新上傳的玩家狀態 */
  const workerStates = new Map<number, WorkerPlayerState[]>();
  /** 是否有 worker 狀態變動（變動才廣播） */
  let stateDirty = false;
  let masterTick = 0;
  let masterBroadcastSum = 0;
  let masterBroadcastCount = 0;
  /** 上次廣播的全域狀態（算 diff 用） */
  let lastBroadcast = new Map<string, WorkerPlayerState>();
  /** 剛 fork / 補開的 worker 需先收一次全量快照 bootstrap */
  const needsFull = new Set<number>();

  for (let i = 0; i < numCPUs; i++) {
    const w = cluster.fork();
    needsFull.add(w.id ?? i + 1);
  }

  cluster.on("message", (worker, msg: { type?: string }) => {
    if (msg?.type === "WORKER_SYNC_STATES") {
      workerStates.set(
        worker.id,
        (msg as { states: WorkerPlayerState[] }).states
      );
      stateDirty = true;
    }
  });

  // 節流廣播：每 SYNC_EVERY_TICKS 個 tick 才彙整一次，無變動則完全跳過
  setInterval(() => {
    masterTick++;
    if (masterTick % SYNC_EVERY_TICKS !== 0) return;
    if (!stateDirty) return;
    stateDirty = false;

    const bcastStart = Date.now();
    const current = new Map<string, WorkerPlayerState>();
    for (const states of workerStates.values()) {
      for (const s of states) current.set(s.id, s);
    }

    // 算 diff：新增/位置或格子變動 → moved；消失 → left
    const moved: WorkerPlayerState[] = [];
    const left: string[] = [];
    for (const [id, s] of current) {
      const prev = lastBroadcast.get(id);
      if (
        !prev ||
        prev.x !== s.x ||
        prev.y !== s.y ||
        prev.gridKey !== s.gridKey
      ) {
        moved.push(s);
      }
    }
    for (const id of lastBroadcast.keys()) {
      if (!current.has(id)) left.push(id);
    }
    lastBroadcast = current;

    // 無變動且無新 worker → 完全不送，省 IPC
    if (moved.length === 0 && left.length === 0 && needsFull.size === 0) {
      return;
    }

    const diffPayload = { type: "MASTER_SYNC_DIFF", moved, left } as const;
    let allArr: WorkerPlayerState[] | null = null;
    for (const id of workerStates.keys()) {
      const w = cluster.workers?.[id];
      if (!w?.isConnected()) continue;
      try {
        if (needsFull.delete(id)) {
          if (!allArr) allArr = [...current.values()];
          w.send({ type: "MASTER_SYNC_ALL", states: allArr });
        } else {
          w.send(diffPayload);
        }
      } catch {
        // worker 剛斷線，忽略
      }
    }
    const bcastMs = Date.now() - bcastStart;
    masterBroadcastSum += bcastMs;
    masterBroadcastCount++;
    if (bcastMs > 80) {
      console.log(
        `[Master] spike broadcast=${bcastMs}ms total=${current.size}`
      );
    }
    if (masterTick % 180 === 0) {
      const avg =
        masterBroadcastCount > 0
          ? (masterBroadcastSum / masterBroadcastCount).toFixed(1)
          : "0";
      console.log(`[Master] tick avgBroadcast=${avg}ms total=${current.size}`);
      masterBroadcastSum = 0;
      masterBroadcastCount = 0;
    }
  }, TICK_MS);

  cluster.on("exit", (worker) => {
    workerStates.delete(worker.id);
    console.log(`[Master] Worker ${worker.process.pid} 離線，補開一個`);
    const w = cluster.fork();
    needsFull.add(w.id);
  });
} else {
  // ----------------------------------------------------------------------
  // Worker 子進程：平行處理連線 + AOI 運算
  // ----------------------------------------------------------------------
  const workerId = cluster.worker?.id ?? 1;

  interface ConnectedPlayer extends PlayerState {
    ws: WebSocket;
    gridKey: string;
    lastKnown: Map<string, { x: number; y: number }>;
    snapOffset: number;
  }

  /** 連到「這個 worker」的玩家（socket owner） */
  const localPlayers = new Map<string, ConnectedPlayer>();
  /** 全域所有玩家快照（master 同步來；含其他 worker 的玩家） */
  let allPlayersCache = new Map<string, WorkerPlayerState>();
  /** 持久化 Spatial Bucket（master 送 diff 增量套用，不全量重建） */
  type BucketEntry = PlayerState & { gridKey: string };
  const gridBuckets = new Map<string, BucketEntry[]>();
  /** id -> 目前所在的 bucket gridKey（追蹤增量移動） */
  const playerBucketKey = new Map<string, string>();

  let nextId = 1;

  // 所有 Worker 共享同一個 port，OS 自動 round-robin 分流
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

  // 接收 master 的全域同步：新 worker 收一次全量，之後只收 diff 增量套用
  cluster.worker?.on("message", (msg: { type?: string }) => {
    if (msg?.type === "MASTER_SYNC_ALL") {
      const next = new Map<string, WorkerPlayerState>();
      for (const s of (msg as { states: WorkerPlayerState[] }).states) {
        next.set(s.id, s);
      }
      allPlayersCache = next;
      rebuildBuckets();
    } else if (msg?.type === "MASTER_SYNC_DIFF") {
      const { moved, left } = msg as {
        moved: WorkerPlayerState[];
        left: string[];
      };
      for (const id of left) {
        if (allPlayersCache.delete(id)) removeFromBucket(id);
      }
      for (const s of moved) {
        const local = localPlayers.get(s.id);
        if (local) {
          // 本地玩家以本 worker 為準，bucket 持 ConnectedPlayer 引用位置自動更新；
          // 這裡只需同步 cache 副本，跨格搬移由 applyLocalBucketMoves 每 tick 處理
          const prev = allPlayersCache.get(s.id);
          if (prev) {
            prev.x = s.x;
            prev.y = s.y;
            prev.gridKey = s.gridKey;
          } else {
            allPlayersCache.set(s.id, s);
          }
          continue;
        }
        const prev = allPlayersCache.get(s.id);
        if (!prev) {
          allPlayersCache.set(s.id, s);
          addToBucket(s);
        } else if (prev.gridKey !== s.gridKey) {
          removeFromBucket(s.id);
          prev.x = s.x;
          prev.y = s.y;
          prev.gridKey = s.gridKey;
          addToBucket(prev);
        } else {
          prev.x = s.x;
          prev.y = s.y;
        }
      }
    }
  });

  wss.on("connection", (ws) => {
    // ID 加上 workerId 避免多核衝突
    const id = `p_w${workerId}_${nextId++}`;
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
    localPlayers.set(id, player);
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
      localPlayers.delete(id);
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

  /** bootstrap：新 worker 收到全量快照後全量重建一次 bucket */
  function rebuildBuckets(): void {
    gridBuckets.clear();
    playerBucketKey.clear();
    for (const p of allPlayersCache.values()) {
      if (localPlayers.has(p.id)) continue;
      addToBucket(p);
    }
    for (const p of localPlayers.values()) {
      addToBucket(p);
    }
  }

  /** 非快照 tick：只把本地玩家的位置增量搬進正確 bucket（連線已持有同一物件，位置自動更新） */
  function applyLocalBucketMoves(): void {
    for (const p of localPlayers.values()) {
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
        `[Worker ${workerId}] spike interval=${interval}ms local=${
          localPlayers.size
        } global=${allPlayersCache.size + localPlayers.size}`
      );
    }
    const computeStart = now;
    tick++;
    tickIntervalSum += interval;
    tickCount++;

    // 1. 節流上傳自己的玩家狀態給 master（每 SYNC_EVERY_TICKS tick 一次）
    if (tick % SYNC_EVERY_TICKS === 0) {
      const states: WorkerPlayerState[] = [];
      for (const p of localPlayers.values()) {
        states.push({ id: p.id, x: p.x, y: p.y, gridKey: p.gridKey });
      }
      try {
        process.send?.({ type: "WORKER_SYNC_STATES", states });
      } catch {
        // master 已離線，忽略
      }
    }

    // 2. Spatial Bucket：快照/diff 已在 message handler 增量套用，這裡只搬本地玩家跨格
    applyLocalBucketMoves();

    // 3. 對自己 worker 的每個玩家算 AOI（含跨 worker 玩家）
    for (const p of localPlayers.values()) {
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

      if (nearby.length > MAX_AOI_CAP) {
        nearby.sort((a, b) => {
          const distA = Math.hypot(a.x - p.x, a.y - p.y);
          const distB = Math.hypot(b.x - p.x, b.y - p.y);
          return distA - distB;
        });
        nearby = nearby.slice(0, MAX_AOI_CAP);
      }

      syncView(p, nearby);

      if ((tick + p.snapOffset) % SNAPSHOT_TICKS === 0) {
        send(p.ws, { type: "update", players: nearby.map(toPlain) });
        for (const q of nearby) p.lastKnown.set(q.id, { x: q.x, y: q.y });
      }
    }
    tickComputeSum += Date.now() - computeStart;

    // 每 3 秒印一次 tick 體質（間隔遠大於 TICK_MS = server 在卡）
    if (tick % 180 === 0) {
      const avgInterval = (tickIntervalSum / tickCount).toFixed(1);
      const avgCompute = (tickComputeSum / tickCount).toFixed(1);
      console.log(
        `[Worker ${workerId}] tick avgInterval=${avgInterval}ms compute=${avgCompute}ms local=${localPlayers.size}`
      );
      tickIntervalSum = 0;
      tickComputeSum = 0;
      tickCount = 0;
    }
  }, TICK_MS);

  console.log(`[Worker ${workerId}] PID:${process.pid} 啟動於 port ${PORT}`);
}
