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
const MAX_AOI_CAP = 40;
/** 跨 worker 狀態同步頻率：每 N tick 一次（1 = 20Hz，跟 AOI tick 同頻）。 */
const SYNC_EVERY_TICKS = 1;

/** IPC 上傳的玩家短表（不含 ws，避免跨行程傳 socket） */
interface WorkerPlayerState extends PlayerState {
  gridKey: string;
}

// ----------------------------------------------------------------------
// Master 主進程：IPC 仲介
// ----------------------------------------------------------------------
if (cluster.isPrimary) {
  // const numCPUs = 1;
  const numCPUs = os.cpus().length;
  console.log(`[Master] PID:${process.pid} 啟動，開 ${numCPUs} 個 Worker`);

  /** workerId -> 該 worker 最新上傳的玩家狀態 */
  const workerStates = new Map<number, WorkerPlayerState[]>();
  /** 是否有 worker 狀態變動（變動才廣播） */
  let stateDirty = false;
  let masterTick = 0;

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
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

  // 節流廣播：每 SYNC_EVERY_TICKS 個 tick 才彙整廣播一次，無變動則完全跳過
  setInterval(() => {
    masterTick++;
    if (masterTick % SYNC_EVERY_TICKS !== 0) return;
    if (!stateDirty) return;
    stateDirty = false;

    const all: WorkerPlayerState[] = [];
    for (const states of workerStates.values()) {
      for (const s of states) all.push(s);
    }
    const payload = { type: "MASTER_SYNC_ALL", states: all } as const;
    for (const id of workerStates.keys()) {
      const w = cluster.workers?.[id];
      if (w?.isConnected()) {
        try {
          w.send(payload);
        } catch {
          // worker 剛斷線，忽略
        }
      }
    }
  }, TICK_MS);

  cluster.on("exit", (worker) => {
    workerStates.delete(worker.id);
    console.log(`[Master] Worker ${worker.process.pid} 離線，補開一個`);
    cluster.fork();
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
  }

  /** 連到「這個 worker」的玩家（socket owner） */
  const localPlayers = new Map<string, ConnectedPlayer>();
  /** 全域所有玩家快照（master 每 tick 同步來；含其他 worker 的玩家） */
  let allPlayersCache = new Map<string, WorkerPlayerState>();

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

  // 接收 master 的全域快照
  cluster.worker?.on("message", (msg: { type?: string }) => {
    if (msg?.type === "MASTER_SYNC_ALL") {
      const next = new Map<string, WorkerPlayerState>();
      for (const s of (msg as { states: WorkerPlayerState[] }).states) {
        next.set(s.id, s);
      }
      allPlayersCache = next;
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
    };
    localPlayers.set(id, player);

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

    if (enters.length) send(p.ws, { type: "enter", players: enters });
    if (leaves.length) send(p.ws, { type: "leave", players: leaves });
    if (moves.length) send(p.ws, { type: "move", players: moves });
  }

  let tick = 0;

  setInterval(() => {
    tick++;

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

    // 2. 合併「全域快照」+「自己的玩家」（自己的以本 worker 為準），重建 Spatial Bucket
    const combined = new Map<string, WorkerPlayerState>(allPlayersCache);
    for (const p of localPlayers.values()) {
      combined.set(p.id, { id: p.id, x: p.x, y: p.y, gridKey: p.gridKey });
    }

    const gridBuckets = new Map<string, PlayerState[]>();
    for (const p of combined.values()) {
      if (!gridBuckets.has(p.gridKey)) {
        gridBuckets.set(p.gridKey, []);
      }
      gridBuckets.get(p.gridKey)!.push({ id: p.id, x: p.x, y: p.y });
    }

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

      if (tick % SNAPSHOT_TICKS === 0) {
        send(p.ws, { type: "update", players: nearby });
        for (const q of nearby) p.lastKnown.set(q.id, { x: q.x, y: q.y });
      }
    }
  }, TICK_MS);

  console.log(`[Worker ${workerId}] PID:${process.pid} 啟動於 port ${PORT}`);
}
