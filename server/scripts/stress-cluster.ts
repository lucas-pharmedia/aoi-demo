/**
 * AOI 九宮格伺服器壓力測試 (Cluster 多核心 + 62.5ms 對齊 + 400 高速平滑版)
 *
 * 特點：
 *  1. Cluster 多核心：自動按 CPU 核心數分派 Bot，解決壓測腳本單執行緒 CPU 瓶頸。
 *  2. Map<number, Bot>：O(1) 點對點查找，消除 Array.findIndex 搜尋卡頓。
 *  3. 62.5ms 發包對齊：完美契合 Server 8Hz (125ms) 採樣，打破 400ms 相位死鎖。
 *  4. 邊界反彈與擬真長走：避免撞牆 Δx=0 發呆與高頻急停煞車，Bot 移動極度滑順。
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

/** 🟢 關鍵：62.5ms (16Hz) 發包頻率，100% 契合 Server 8Hz (125ms) 採樣週期 */
const MOVE_INTERVAL_MS = 62.5;

const STRESS_MAX = 800; // 總壓測人數
const STRESS_SPAWN_INTERVAL_MS = 50;

const STRESS_URL = process.env.STRESS_URL;
if (!STRESS_URL) {
  console.error("Missing STRESS_URL. Set it in server/scripts/.env");
  process.exit(1);
}

// 取得 CPU 邏輯核心數 (例如 Apple Silicon 8 核)
const CPU_COUNT = availableParallelism ? availableParallelism() : 4;

// ----------------------------------------------------------------------
// 1. Primary 主進程 (負責進度控制、數據彙整與 Log 輸出)
// ----------------------------------------------------------------------
if (cluster.isPrimary) {
  console.log(
    `[Master ${process.pid}] 啟動多核心壓測，目標 Bot: ${STRESS_MAX} | 分派核心數: ${CPU_COUNT}`
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

  // Master 每秒彙總數據並印出 Log
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
  // 2. Worker 子進程 (負責各核心分派到的 Bot 模擬與發包)
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
    nextDirTime: number; // 記錄下一次隨機換向的時間戳
  }

  // 🟢 使用 Map<number, Bot> 實現 O(1) 點對點查找，徹底消除 Array.findIndex 卡頓
  const bots = new Map<number, Bot>();
  let connected = 0;
  let failed = 0;
  let totalRecv = 0;

  function pickNewDirection(bot: Bot, now: number): void {
    const angle = Math.random() * Math.PI * 2;

    // 🟢 保持你的 PLAYER_SPEED = 400 高速
    const speed = 400;
    bot.vx = Math.cos(angle) * speed;
    bot.vy = Math.sin(angle) * speed;

    // 🟢 4 ~ 8 秒才換向一次，讓 Bot 能夠長距離直線平滑行走，避免高頻急停
    bot.nextDirTime = now + 4000 + Math.random() * 4000;
  }

  function spawnBot(id: number): void {
    const ws = new WebSocket(STRESS_URL, { handshakeTimeout: 15000 });
    ws.binaryType = "arraybuffer";

    const sendBuffer = new ArrayBuffer(9);
    const sendView = new DataView(sendBuffer);
    sendView.setUint8(0, 2); // Opcode 2 = Move

    // 離地圖邊界留出安全距離，防止出生即卡牆
    const spawnX = Math.random() * (MAP_WIDTH - 256) + 128;
    const spawnY = Math.random() * (MAP_HEIGHT - 256) + 128;

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
        // 🟢 對齊精簡後的 11-byte Init 協議: [1B Opcode][2B SelfId][4B X][4B Y]
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

  // 🟢 單一批次 Timer 驅動所有 Bot 移動與發包 (62.5ms)
  setInterval(() => {
    const now = Date.now();

    for (const bot of bots.values()) {
      if (!bot.initOk || bot.ws.readyState !== WebSocket.OPEN) continue;

      // 定期切換方向
      if (now >= bot.nextDirTime) {
        pickNewDirection(bot, now);
      }

      let nextX = bot.x + bot.vx * (MOVE_INTERVAL_MS / 1000);
      let nextY = bot.y + bot.vy * (MOVE_INTERVAL_MS / 1000);

      // 🟢 邊界自動反彈機制：400 高速撞牆時自動轉向，避免卡邊界導致 dx=0 被 Server 過濾
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

      bot.sendView.setFloat32(1, bot.x, true);
      bot.sendView.setFloat32(5, bot.y, true);
      bot.ws.send(bot.sendBuffer);
    }
  }, MOVE_INTERVAL_MS);

  // 定期打包數據回報給 Primary 主進程
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

  // 啟動本 Worker 負責的 Bot 連線
  async function runWorker(): Promise<void> {
    for (let i = 0; i < myBotCount; i++) {
      spawnBot(myOffsetId + i);
      await new Promise((r) => setTimeout(r, STRESS_SPAWN_INTERVAL_MS));
    }
  }

  void runWorker();
}
