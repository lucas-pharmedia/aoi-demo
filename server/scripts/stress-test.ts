/**
 * AOI 九宮格伺服器壓力測試 (極速二進位 ArrayBuffer 版 - 平滑連線與心跳保活修復版)
 *
 * 模擬 N 個線上玩家（每個都像真實客戶端：連 ws → 收二進位 init → 隨機走動 → 每 50ms 送一次二進位 move），
 * 漸增人數，找出「開始卡」的臨界點。
 *
 * 用法：
 *   npm run stress
 *   調整 scripts/.env 的 STRESS_URL，其餘常數在檔案內修改
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { MAP_WIDTH, MAP_HEIGHT } from "../../shared/grid.ts";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

/** 判斷「卡」：平均封包間隔超過此值 (ms)。正常 125ms (8Hz) 或 333ms (3Hz) 左右。 */
const LAG_THRESHOLD_MS = 600;
/** 🟢 連線後等 init 的逾時 (ms)，拉長至 10 秒，適應 3Hz 低頻率 Server 佇列 */
const INIT_TIMEOUT_MS = 10000;
/** 每個 bot 送 move 的節流 (ms)，跟真實 client 一致 (20/s) */
const MOVE_INTERVAL_MS = 50;
/** true = 常態走動；false = 集中一點 */
const BOT_NORMAL_WALK = true;
const CLUSTER_CENTER_X = 2200;
const CLUSTER_CENTER_Y = 2200;
const CLUSTER_SPREAD = 600;

/** 壓測上限人數 */
const STRESS_MAX = 800;
/** 每批新增人數 */
const STRESS_STEP = 10;
/** 🟢 每個 Bot 建立連線的間隔 (ms)，改為 50ms，讓連線平滑穿透 3Hz / 8Hz 週期 */
const STRESS_SPAWN_INTERVAL_MS = 50;
/** 每批新增後等待穩定時間 (ms) */
const STRESS_HOLD_MS = 2000;

/** 壓測目標 WebSocket URL（scripts/.env 的 STRESS_URL） */
const STRESS_URL = process.env.STRESS_URL;
if (!STRESS_URL) {
  console.error("Missing STRESS_URL. Set it in server/scripts/.env");
  process.exit(1);
}

interface Bot {
  id: number;
  ws: WebSocket;
  selfId: number | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dirTimer: ReturnType<typeof setTimeout> | null;
  lastRecvAt: number | null;
  recvCount: number;
  /** 累積的封包間隔（本取樣窗） */
  intervalSum: number;
  intervalCount: number;
  initOk: boolean;
  moveTimer: ReturnType<typeof setInterval> | null;
  // 🟢 每個 Bot 獨立的 9-Byte 發送 Buffer，避免高併發下的記憶體覆寫
  sendBuffer: ArrayBuffer;
  sendView: DataView;
}

class StressTest {
  private bots: Bot[] = [];
  private connected = 0;
  private failed = 0;
  private totalRecv = 0;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly url: string,
    private readonly max: number,
    private readonly step: number,
    private readonly holdMs: number
  ) {
    this.log = (msg: string) => console.log(msg);
  }

  /** 啟動連線；init 失敗或斷線自動觸發重連 */
  private spawnBot(id: number): void {
    const ws = new WebSocket(this.url, { handshakeTimeout: 15000 });
    ws.binaryType = "arraybuffer"; // ⚠️ 必須設定為二進位模式

    const sendBuffer = new ArrayBuffer(9);
    const sendView = new DataView(sendBuffer);
    sendView.setUint8(0, 2); // Opcode 2 = Move

    const bot: Bot = {
      id,
      ws,
      selfId: null,
      x: Math.random() * MAP_WIDTH,
      y: Math.random() * MAP_HEIGHT,
      vx: 0,
      vy: 0,
      dirTimer: null,
      lastRecvAt: null,
      recvCount: 0,
      intervalSum: 0,
      intervalCount: 0,
      initOk: false,
      moveTimer: null,
      sendBuffer,
      sendView,
    };

    // 尋找陣列中是否已有該 id 的舊 bot 物件，重連時覆蓋以維持佇列正確
    const existingIndex = this.bots.findIndex((b) => b.id === id);
    if (existingIndex >= 0) {
      this.bots[existingIndex] = bot;
    } else {
      this.bots.push(bot);
    }

    // 防重複觸發 Lock Flag
    let hasRetried = false;

    // 統一重試邏輯 (清除資源 + 亂數延遲重發)
    const retry = () => {
      if (hasRetried) return;
      hasRetried = true;

      clearTimeout(initTimeout);
      if (bot.moveTimer) clearInterval(bot.moveTimer);
      if (bot.dirTimer) clearTimeout(bot.dirTimer);

      try {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        } else {
          ws.close();
        }
      } catch (e) {}

      if (!bot.initOk) {
        this.failed++;
      } else {
        this.connected--;
      }

      // 🟢 避峰退避延遲 (1000ms ~ 3000ms 後重試)，避免連線雪崩
      const jitterMs = 1000 + Math.random() * 2000;
      setTimeout(() => {
        this.spawnBot(id);
      }, jitterMs);
    };

    const initTimeout = setTimeout(() => {
      if (!bot.initOk) {
        retry();
      }
    }, INIT_TIMEOUT_MS);

    // 🟢 關鍵：自動響應 Server 的 WebSocket Ping，防止被 Server 心跳踢除
    ws.on("ping", (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.pong(data);
      }
    });

    // 預先抓取所有錯誤防止 Node.js 崩潰
    ws.on("error", (err) => {
      if (!bot.initOk) {
        retry();
      }
    });

    ws.on("message", (raw: ArrayBuffer) => {
      const now = Date.now();

      // 二進位封包解碼
      if (raw.byteLength < 1) return;
      const view = new DataView(raw);
      const opcode = view.getUint8(0);

      if (!bot.initOk) {
        // OP_INIT (1): [1B Opcode][2B SelfId][4B X][4B Y][2B MapW][2B MapH]
        if (opcode === 1 && raw.byteLength >= 11) {
          bot.initOk = true;
          bot.selfId = view.getUint16(1, true);
          bot.x = view.getFloat32(3, true);
          bot.y = view.getFloat32(7, true);
          this.connected++;
          clearTimeout(initTimeout);
          this.pickRandomDir(bot);

          // 就緒後開始送二進位 move
          bot.moveTimer = setInterval(
            () => this.sendMove(bot),
            MOVE_INTERVAL_MS
          );
        }
        return;
      }

      bot.recvCount++;
      this.totalRecv++;
      if (bot.lastRecvAt !== null) {
        bot.intervalSum += now - bot.lastRecvAt;
        bot.intervalCount++;
      }
      bot.lastRecvAt = now;
    });

    ws.on("close", () => {
      retry();
    });
  }

  private pickRandomDir(bot: Bot): void {
    const angle = Math.random() * Math.PI * 2;
    const speed = 200;
    bot.vx = Math.cos(angle) * speed;
    bot.vy = Math.sin(angle) * speed;
    // 0.5~1.5 秒後換方向（模擬真人走走停停換向）
    bot.dirTimer = setTimeout(() => {
      if (bot.ws.readyState === WebSocket.OPEN) this.pickRandomDir(bot);
    }, 500 + Math.random() * 1000);
  }

  /** 極速二進位傳送移動封包 */
  private sendMove(bot: Bot): void {
    if (bot.ws.readyState !== WebSocket.OPEN || !bot.initOk) return;
    if (BOT_NORMAL_WALK) {
      bot.x = Math.max(
        0,
        Math.min(bot.x + bot.vx * (MOVE_INTERVAL_MS / 1000), MAP_WIDTH)
      );
      bot.y = Math.max(
        0,
        Math.min(bot.y + bot.vy * (MOVE_INTERVAL_MS / 1000), MAP_HEIGHT)
      );
    } else {
      bot.x = CLUSTER_CENTER_X + (Math.random() - 0.5) * CLUSTER_SPREAD;
      bot.y = CLUSTER_CENTER_Y + (Math.random() - 0.5) * CLUSTER_SPREAD;
    }

    bot.sendView.setFloat32(1, bot.x, true);
    bot.sendView.setFloat32(5, bot.y, true);
    bot.ws.send(bot.sendBuffer);
  }

  /** 每秒取樣一次：計算吞吐 / 平均封包間隔，判斷是否卡 */
  private sampler = setInterval(() => {
    let intervalSum = 0;
    let intervalCount = 0;
    for (const b of this.bots) {
      if (!b.initOk) continue;
      intervalSum += b.intervalSum;
      intervalCount += b.intervalCount;
      b.intervalSum = 0;
      b.intervalCount = 0;
    }
    const msgPerSec = this.totalRecv;
    this.totalRecv = 0;
    const avgInterval = intervalCount > 0 ? intervalSum / intervalCount : NaN;
    const perClient =
      this.connected > 0 ? (msgPerSec / this.connected).toFixed(1) : "-";
    const intervalStr = Number.isNaN(avgInterval)
      ? "-"
      : avgInterval.toFixed(0);
    const lag = !Number.isNaN(avgInterval) && avgInterval > LAG_THRESHOLD_MS;
    const backlog = this.bots.length - this.connected;
    const notes: string[] = [];
    if (lag) notes.push("LAG");
    if (backlog > 0) notes.push(`initBacklog=${backlog}`);
    this.log(
      `players=${this.bots.length} connected=${this.connected} failed=${this.failed} ` +
        `msgs/s=${msgPerSec} perClient=${perClient} avgInterval=${intervalStr}ms${
          notes.length ? `   <<< ${notes.join(" ")}` : ""
        }`
    );
  }, 1000);

  async run(): Promise<void> {
    this.log(`AOI Binary stress test → ${this.url}`);
    this.log(
      `ramp: start=${this.step} step=${this.step} max=${this.max} hold=${this.holdMs}ms spawnInterval=${STRESS_SPAWN_INTERVAL_MS}ms`
    );
    this.log("---");

    let total = 0;
    while (total < this.max) {
      const batch = Math.min(this.step, this.max - total);
      for (let i = 0; i < batch; i++) {
        this.spawnBot(total + i);
        // 🟢 每建立一個連線停 50ms，讓連線平滑穿透 3Hz / 8Hz 伺服器
        await this.sleep(STRESS_SPAWN_INTERVAL_MS);
      }
      total += batch;
      // 等一批連上 + 穩定跑一個 hold 期間
      await this.sleep(this.holdMs);
    }

    this.log("---");
    this.log(
      `done. max=${total} connected=${this.connected} failed=${this.failed}`
    );
    this.log("最後一列 avgInterval > 150ms 代表該人數下 server 已開始卡。");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

const test = new StressTest(
  STRESS_URL,
  STRESS_MAX,
  STRESS_STEP,
  STRESS_HOLD_MS
);
void test.run();
