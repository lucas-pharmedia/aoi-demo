/**
 * AOI 九宮格伺服器壓力測試 (極速二進位 ArrayBuffer 版)
 *
 * 模擬 N 個線上玩家（每個都像真實客戶端：連 ws → 收二進位 init → 隨機走動 → 每 50ms 送一次二進位 move），
 * 漸增人數，找出「開始卡」的臨界點。
 *
 * 用法：
 *   npm run stress
 *   調整 STRESS_MAX / STRESS_STEP / STRESS_HOLD_MS 常數即可
 */
import WebSocket from "ws";
import { MAP_WIDTH, MAP_HEIGHT } from "../../shared/grid.ts";

/** 判斷「卡」：平均封包間隔超過此值 (ms)。正常 66.7ms (15Hz) 左右。 */
const LAG_THRESHOLD_MS = 150;
/** 連線後等 init 的逾時 (ms)，超過算失敗 */
const INIT_TIMEOUT_MS = 5000;
/** 每個 bot 送 move 的節流 (ms)，跟真實 client 一致 (20/s) */
const MOVE_INTERVAL_MS = 50;
/** true = 常態走動；false = 集中一點 */
const BOT_NORMAL_WALK = true;
const CLUSTER_CENTER_X = 2000;
const CLUSTER_CENTER_Y = 2000;
const CLUSTER_SPREAD = 100;
/** 壓測上限人數 */
const STRESS_MAX = 800;
/** 每批新增人數 */
const STRESS_STEP = 30;
/** 每批新增後等待時間 (ms) */
const STRESS_HOLD_MS = 2000;

// ----------------------------------------------------------------------
// Bot 全域發送專用 Buffer (9 Bytes) - 避免 Bot 端的 GC 影響測量精準度
// ----------------------------------------------------------------------
const botSendBuffer = new ArrayBuffer(9);
const botSendView = new DataView(botSendBuffer);
botSendView.setUint8(0, 2); // Opcode 2 = Move

function parseUrl(argv: string[]): string {
  const i = argv.indexOf("--url");
  return i >= 0 ? argv[i + 1]! : "ws://43.212.31.124:8088";
}

interface Bot {
  id: number;
  ws: WebSocket;
  selfId: number | null; // 改用數字 ID
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

  /** 啟動連線；init 成功才算該 bot 就緒 */
  private spawnBot(id: number): void {
    const ws = new WebSocket(this.url, { handshakeTimeout: 15000 });
    ws.binaryType = "arraybuffer"; // ⚠️ 必須設定為二進位模式

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
    };
    this.bots.push(bot);

    const initTimeout = setTimeout(() => {
      if (!bot.initOk) {
        this.failed++;
        ws.close();
      }
    }, INIT_TIMEOUT_MS);

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

    ws.on("error", () => {
      if (!bot.initOk) {
        this.failed++;
        clearTimeout(initTimeout);
      }
    });

    ws.on("close", () => {
      if (bot.initOk) {
        this.connected--;
        if (bot.moveTimer) clearInterval(bot.moveTimer);
        if (bot.dirTimer) clearTimeout(bot.dirTimer);
      }
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

    botSendView.setFloat32(1, bot.x, true);
    botSendView.setFloat32(5, bot.y, true);
    bot.ws.send(botSendBuffer);
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
          notes.length ? `  <<< ${notes.join(" ")}` : ""
        }`
    );
  }, 1000);

  async run(): Promise<void> {
    this.log(`AOI Binary stress test → ${this.url}`);
    this.log(
      `ramp: start=${this.step} step=${this.step} max=${this.max} hold=${this.holdMs}ms`
    );
    this.log("---");

    let total = 0;
    while (total < this.max) {
      const batch = Math.min(this.step, this.max - total);
      for (let i = 0; i < batch; i++) this.spawnBot(total + i);
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

const url = parseUrl(process.argv.slice(2));
const test = new StressTest(url, STRESS_MAX, STRESS_STEP, STRESS_HOLD_MS);
void test.run();
