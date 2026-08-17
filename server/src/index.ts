/**
 * AOI 九宮格即時同步伺服器
 *
 * 通訊方式：
 *   1. 連線時發 `init` 給玩家（自己的 id / 出生座標 / 地圖大小）
 *   2. 每 tick (50ms) 計算每個玩家的 AOI 視野（9 格）
 *   3. 用「差異更新 (Delta)」只傳視野內的變化：
 *      - `enter`：有新玩家進視野
 *      - `leave`：玩家離開視野
 *      - `move`：視野內的玩家移動超過門檻
 *   4. 每 3 秒補一次完整快照 `update`，矯正前端 drift / 漏包
 */
import { WebSocketServer, WebSocket } from 'ws';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  toGrid,
  gridKey,
  getSurroundingGridKeys,
} from './grid.ts';
import type { PlayerState, ServerPacket, ClientPacket } from './types.ts';

const PORT = 8088;
/** Server 更新頻率：每 50ms 一個 tick (20 tick/s) */
const TICK_MS = 50;
/** move 事件的移動門檻 (px)：超過才算「有動」，過濾抖動/雜訊 */
const MOVE_THRESHOLD = 1;
/** 每幾 tick 補一次快照：60 tick × 50ms = 3 秒一次 */
const SNAPSHOT_TICKS = 60;

/** 記憶體中的玩家：位置 + WebSocket + 當前格子 + 對「每個視野內玩家上次已知座標」的記錄 */
interface ConnectedPlayer extends PlayerState {
  ws: WebSocket;
  gridKey: string;
  /** key=其他玩家id, value=該玩家上次通知給「這個玩家」的座標。用來判斷是否要發 move */
  lastKnown: Map<string, { x: number; y: number }>;
}

/** 所有連線玩家，key = player id */
const players = new Map<string, ConnectedPlayer>();
let nextId = 1;

const wss = new WebSocketServer({ port: PORT });

/** 在地圖範圍內取隨機出生座標（留 32px 邊距避免貼邊） */
function randomSpawn(): { x: number; y: number } {
  const x = Math.random() * (MAP_WIDTH - 64) + 32;
  const y = Math.random() * (MAP_HEIGHT - 64) + 32;
  return { x, y };
}

/** 送出 JSON 封包（連線仍開啟才送） */
function send(ws: WebSocket, packet: ServerPacket) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(packet));
  }
}

wss.on('connection', (ws) => {
  // 指派唯一 id 與隨機出生座標
  const id = `player_${nextId++}`;
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
  players.set(id, player);

  // 告訴這名玩家「你是誰、出生在哪、地圖多大」
  send(ws, {
    type: 'init',
    selfId: id,
    x,
    y,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
  });
  console.log(`${id} connected. total=${players.size}`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientPacket;
      if (msg.type === 'move') {
        // 更新伺服器端權威座標，並 clamp 在地圖內
        player.x = Math.max(0, Math.min(msg.x, MAP_WIDTH));
        player.y = Math.max(0, Math.min(msg.y, MAP_HEIGHT));
        const { gx: ngx, gy: ngy } = toGrid(player.x, player.y);
        player.gridKey = gridKey(ngx, ngy);
      }
    } catch {
      // 忽略壞掉的封包
    }
  });

  ws.on('close', () => {
    // 斷線即從記憶體移除，停止廣播其座標
    players.delete(id);
    console.log(`${id} disconnected. total=${players.size}`);
  });
});

/**
 * 差異同步：比對「這次 AOI 清單」與「上次通知過的清單 (lastKnown)」，
 * 只送出變化部分：
 *   - 上次沒有、這次有            -> enter（附位置）
 *   - 上次有、這次沒有            -> leave（只送 id）
 *   - 兩次都有但位置移動超過門檻    -> move
 */
function syncView(p: ConnectedPlayer, nearby: PlayerState[]): void {
  const nextIds = new Set(nearby.map((q) => q.id));
  const enters: PlayerState[] = [];
  const leaves: string[] = [];
  const moves: PlayerState[] = [];

  for (const q of nearby) {
    const prev = p.lastKnown.get(q.id);
    if (!prev) {
      // 新面孔：進視野
      enters.push(q);
      p.lastKnown.set(q.id, { x: q.x, y: q.y });
      continue;
    }
    // 舊面孔：移動超過門檻才發 move
    if (Math.hypot(q.x - prev.x, q.y - prev.y) >= MOVE_THRESHOLD) {
      moves.push(q);
      p.lastKnown.set(q.id, { x: q.x, y: q.y });
    }
  }

  // 上次有、這次不在清單內 = 離開視野
  for (const id of [...p.lastKnown.keys()]) {
    if (!nextIds.has(id)) leaves.push(id);
  }
  for (const id of leaves) p.lastKnown.delete(id);

  if (enters.length) send(p.ws, { type: 'enter', players: enters });
  if (leaves.length) send(p.ws, { type: 'leave', players: leaves });
  if (moves.length) send(p.ws, { type: 'move', players: moves });
}

let tick = 0;

// 主循環：每 tick 對每個玩家計算 AOI 並送出差異
setInterval(() => {
  tick++;
  const entries = [...players.values()];
  for (const p of entries) {
    // 1. 用玩家目前座標找出自己的 AOI 9 格
    const { gx, gy } = toGrid(p.x, p.y);
    const aoiKeys = new Set(getSurroundingGridKeys(gx, gy));

    // 2. 篩出站在這 9 格內的其他玩家（排除自己）
    const nearby: PlayerState[] = [];
    for (const other of entries) {
      if (other.id === p.id) continue;
      if (aoiKeys.has(other.gridKey)) {
        nearby.push({ id: other.id, x: other.x, y: other.y });
      }
    }

    // 3. 差異同步（enter / leave / move）
    syncView(p, nearby);

    // 4. 定期補完整快照，矯正前端狀態
    if (tick % SNAPSHOT_TICKS === 0) {
      send(p.ws, { type: 'update', players: nearby });
      // 快照即「完整正確狀態」，同步 lastKnown，之後只送變化
      for (const q of nearby) p.lastKnown.set(q.id, { x: q.x, y: q.y });
    }
  }
}, TICK_MS);

console.log(`AOI server listening on ws://localhost:${PORT}`);
