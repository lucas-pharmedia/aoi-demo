/**
 * AOI 九宮格伺服器壓力測試 (Cluster 多核心 + 區域集中走動控制版)
 *
 * 特點：
 *  1. 可調整 BOT_NORMAL_WALK 切換全地圖巡邏或區域集中。
 *  2. 可透過 CLUSTER_CENTER_X / Y / SPREAD 常數靈活指定壓測熱區。
 *
 * 用法：
 *   npm run stress
 */
import cluster from "node:cluster";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { MAP_WIDTH, MAP_HEIGHT } from "../../shared/grid.ts";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const LAG_THRESHOLD_MS = 600;
const INIT_TIMEOUT_MS = 10000;

/** 🟢 62.5ms (16Hz) 發包頻率，100% 契合 Server 8Hz (125ms) 採樣週期 */
const MOVE_INTERVAL_MS = 62.5;

const STRESS_MAX = 800; // 總壓測人數
const STRESS_SPAWN_INTERVAL_MS = 50;

// ----------------------------------------------------------------------
// 區域集中走動控制常數
// ----------------------------------------------------------------------
/** true = 全地圖隨機走動；false = 集中在特定區域 */
const BOT_NORMAL_WALK = true;
const CLUSTER_CENTER_X = 2200;
const CLUSTER_CENTER_Y = 2200;
const CLUSTER_SPREAD = 600; // 區域範圍 (例如 2200 ± 300 像素內)

const STRESS_URL = process.env.STRESS_URL || "";
if (!STRESS_URL) {
  console.error("Missing STRESS_URL. Set it in server/scripts/.env");
  process.exit(1);
}

// 限制最大 Worker 數為 8，避免進程 Context Switch 開銷過大
const rawCpus = availableParallelism ? availableParallelism() : 4;
const CPU_COUNT = Math.min(rawCpus, 8);

// ----------------------------------------------------------------------
// 1. Primary 主進程
// ----------------------------------------------------------------------
if (cluster.isPrimary) {
  console.log(
    `[Master ${
      process.pid
    }] 啟動多核心壓測，目標 Bot: ${STRESS_MAX} | 集中模式: ${!BOT_NORMAL_WALK} | 中心: (${CLUSTER_CENTER_X}, ${CLUSTER_CENTER_Y})`
  );
  console.log("---");

  interface WorkerStats {
    connected: number;
    failed: number;
    msgPerSec: number;
    avgInterval: number;
  }

  const workerStats = new Map<number, WorkerStats>();

  const baseCount = Math.floor(STRESS_MAX / CPU_COUNT);
  const remainder = STRESS_MAX % CPU_COUNT;

  let currentOffset = 0;
  for (let i = 0; i < CPU_COUNT; i++) {
    const assignedCount = baseCount + (i < remainder ? 1 : 0);
    const worker = cluster.fork({
      WORKER_BOT_COUNT: assignedCount.toString(),
      WORKER_OFFSET_ID: currentOffset.toString(),
    });

    currentOffset += assignedCount;

    workerStats.set(worker.id, {
      connected: 0,
      failed: 0,
      msgPerSec: 0,
      avgInterval: 0,
    });

    worker.on("message", (msg) => {
      if (msg.type === "stats") {
        workerStats.set(worker.id, msg.data);
      }
    });
  }

  setInterval(() => {
    let totalConnected = 0;
    let totalFailed = 0;
    let totalMsgs = 0;
    let totalIntervalSum = 0;
    let intervalCount = 0;

    for (const stats of workerStats.values()) {
      totalConnected += stats.connected;
      totalFailed += stats.failed;
      totalMsgs += stats.msgPerSec;
      if (!Number.isNaN(stats.avgInterval) && stats.avgInterval > 0) {
        totalIntervalSum += stats.avgInterval;
        intervalCount++;
      }
    }

    const avgInterval =
      intervalCount > 0 ? totalIntervalSum / intervalCount : NaN;
    const perClient =
      totalConnected > 0 ? (totalMsgs / totalConnected).toFixed(1) : "-";
    const intervalStr = Number.isNaN(avgInterval)
      ? "-"
      : avgInterval.toFixed(0);
    const lag = !Number.isNaN(avgInterval) && avgInterval > LAG_THRESHOLD_MS;

    console.log(
      `[Master Metric] totalBots=${STRESS_MAX} connected=${totalConnected} failed=${totalFailed} ` +
        `msgs/s=${totalMsgs} perClient=${perClient} avgInterval=${intervalStr}ms${
          lag ? "    <<< LAG" : ""
        }`
    );
  }, 1000);
} else {
  // ----------------------------------------------------------------------
  // 2. Worker 子進程
  // ----------------------------------------------------------------------
  const myBotCount = Number(process.env.WORKER_BOT_COUNT || 100);
  const myOffsetId = Number(process.env.WORKER_OFFSET_ID || 0);

  interface Bot {
    id: number;
    ws: WebSocket;
    selfId: number | null;
    x: number;
    y: number;
    vx: number;
    vy: number;
    lastRecvAt: number | null;
    recvCount: number;
    intervalSum: number;
    intervalCount: number;
    initOk: boolean;
    sendBuffer: ArrayBuffer;
    sendView: DataView;
    nextDirTime: number;
  }

  const bots = new Map<number, Bot>();
  let connected = 0;
  let failed = 0;
  let totalRecv = 0;

  function pickNewDirection(bot: Bot, now: number): void {
    const angle = Math.random() * Math.PI * 2;
    const speed = 400;
    bot.vx = Math.cos(angle) * speed;
    bot.vy = Math.sin(angle) * speed;
    bot.nextDirTime = now + 4000 + Math.random() * 4000;
  }

  function spawnBot(id: number): void {
    const ws = new WebSocket(STRESS_URL, { handshakeTimeout: 15000 });
    ws.binaryType = "arraybuffer";

    const sendBuffer = new ArrayBuffer(9);
    const sendView = new DataView(sendBuffer);
    sendView.setUint8(0, 2); // Opcode 2 = Move

    // 🟢 依據 BOT_NORMAL_WALK 決定出生點
    let spawnX = 0;
    let spawnY = 0;
    if (BOT_NORMAL_WALK) {
      spawnX = Math.random() * (MAP_WIDTH - 256) + 128;
      spawnY = Math.random() * (MAP_HEIGHT - 256) + 128;
    } else {
      spawnX = CLUSTER_CENTER_X + (Math.random() - 0.5) * CLUSTER_SPREAD;
      spawnY = CLUSTER_CENTER_Y + (Math.random() - 0.5) * CLUSTER_SPREAD;
    }

    const bot: Bot = {
      id,
      ws,
      selfId: null,
      x: spawnX,
      y: spawnY,
      vx: 0,
      vy: 0,
      lastRecvAt: null,
      recvCount: 0,
      intervalSum: 0,
      intervalCount: 0,
      initOk: false,
      sendBuffer,
      sendView,
      nextDirTime: 0,
    };

    bots.set(id, bot);

    let hasRetried = false;
    const retry = () => {
      if (hasRetried) return;
      hasRetried = true;
      clearTimeout(initTimeout);

      try {
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close();
      } catch (e) {}

      if (!bot.initOk) failed++;
      else connected--;

      bots.delete(id);

      const jitterMs = 1000 + Math.random() * 2000;
      setTimeout(() => spawnBot(id), jitterMs);
    };

    const initTimeout = setTimeout(() => {
      if (!bot.initOk) retry();
    }, INIT_TIMEOUT_MS);

    ws.on("ping", (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.pong(data);
    });

    ws.on("error", () => {
      if (!bot.initOk) retry();
    });

    ws.on("message", (raw: ArrayBuffer) => {
      const now = Date.now();
      if (raw.byteLength < 1) return;

      const view = new DataView(raw);
      const opcode = view.getUint8(0);

      if (!bot.initOk) {
        if (opcode === 1 && raw.byteLength >= 11) {
          bot.initOk = true;
          bot.selfId = view.getUint16(1, true);
          bot.x = view.getFloat32(3, true);
          bot.y = view.getFloat32(7, true);
          connected++;
          clearTimeout(initTimeout);
          pickNewDirection(bot, now);
        }
        return;
      }

      bot.recvCount++;
      totalRecv++;
      if (bot.lastRecvAt !== null) {
        bot.intervalSum += now - bot.lastRecvAt;
        bot.intervalCount++;
      }
      bot.lastRecvAt = now;
    });

    ws.on("close", () => retry());
  }

  // 發包主迴圈 (62.5ms)
  setInterval(() => {
    const now = Date.now();

    for (const bot of bots.values()) {
      if (!bot.initOk || bot.ws.readyState !== WebSocket.OPEN) continue;

      if (BOT_NORMAL_WALK) {
        // 常態長距離走動模式
        if (now >= bot.nextDirTime) {
          pickNewDirection(bot, now);
        }

        let nextX = bot.x + bot.vx * (MOVE_INTERVAL_MS / 1000);
        let nextY = bot.y + bot.vy * (MOVE_INTERVAL_MS / 1000);

        if (nextX <= 64 || nextX >= MAP_WIDTH - 64) {
          bot.vx = -bot.vx;
          nextX = Math.max(64, Math.min(nextX, MAP_WIDTH - 64));
        }
        if (nextY <= 64 || nextY >= MAP_HEIGHT - 64) {
          bot.vy = -bot.vy;
          nextY = Math.max(64, Math.min(nextY, MAP_HEIGHT - 64));
        }

        bot.x = nextX;
        bot.y = nextY;
      } else {
        // 🟢 區域集中走動模式 (在中心點範圍內微幅隨機踱步)
        bot.x = CLUSTER_CENTER_X + (Math.random() - 0.5) * CLUSTER_SPREAD;
        bot.y = CLUSTER_CENTER_Y + (Math.random() - 0.5) * CLUSTER_SPREAD;
      }

      bot.sendView.setFloat32(1, bot.x, true);
      bot.sendView.setFloat32(5, bot.y, true);
      bot.ws.send(bot.sendBuffer);
    }
  }, MOVE_INTERVAL_MS);

  setInterval(() => {
    let intervalSum = 0;
    let intervalCount = 0;

    for (const bot of bots.values()) {
      if (!bot.initOk) continue;
      intervalSum += bot.intervalSum;
      intervalCount += bot.intervalCount;
      bot.intervalSum = 0;
      bot.intervalCount = 0;
    }

    const msgPerSec = totalRecv;
    totalRecv = 0;
    const avgInterval = intervalCount > 0 ? intervalSum / intervalCount : NaN;

    if (process.send) {
      process.send({
        type: "stats",
        data: {
          connected,
          failed,
          msgPerSec,
          avgInterval,
        },
      });
    }
  }, 1000);

  async function runWorker(): Promise<void> {
    for (let i = 0; i < myBotCount; i++) {
      spawnBot(myOffsetId + i);
      await new Promise((r) => setTimeout(r, STRESS_SPAWN_INTERVAL_MS));
    }
  }

  void runWorker();
}
