/**
 * AOI 九宮格伺服器壓力測試
 *
 * 模擬 N 個線上玩家（每個都像真實客戶端：連 ws → 收 init → 隨機走動 → 每 50ms 送一次 move），
 * 漸增人數，找出「開始卡」的臨界點。
 *
 * 卡頓指標：
 *   - avgInterval：每個 client 收到封包的平均間隔 (ms)。正常 ≈ 50ms（server 每 tick 廣播一次）。
 *     間隔明顯變大 → server 處理跟不上。
 *   - msgs/s：整體吞吐。卡住時吞吐不再隨人數上升。
 *
 * 用法（先啟動 server）：
 *   npm run stress                 # 預設 20 人起步、每 5 秒 +20、上限 300
 *   npm run stress -- --max 500 --step 50 --hold 3000 --url ws://localhost:8088
 */
import WebSocket from "ws";
import type { ServerPacket } from "../src/types.ts";

const MAP_WIDTH = 5056;
const MAP_HEIGHT = 3360;

/** 判斷「卡」：平均封包間隔超過此值 (ms)。正常 50ms 左右。 */
const LAG_THRESHOLD_MS = 150;
/** 連線後等 init 的逾時 (ms)，超過算失敗 */
const INIT_TIMEOUT_MS = 5000;
/** 每個 bot 送 move 的節流 (ms)，跟真實 client 一致 (20/s) */
const MOVE_INTERVAL_MS = 50;

function parseArgs(argv: string[]): {
  max: number;
  step: number;
  hold: number;
  url: string;
} {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    max: Number(get("max") ?? 500),
    step: Number(get("step") ?? 50),
    hold: Number(get("hold") ?? 1000),
    url: get("url") ?? "ws://localhost:8088",
  };
}

interface Bot {
  id: number;
  ws: WebSocket;
  selfId: string | null;
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
    const ws = new WebSocket(this.url);
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

    ws.on("message", (raw) => {
      const now = Date.now();
      if (!bot.initOk) {
        const msg = JSON.parse(raw.toString()) as ServerPacket;
        if (msg.type === "init") {
          bot.initOk = true;
          bot.selfId = msg.selfId;
          bot.x = msg.x;
          bot.y = msg.y;
          this.connected++;
          clearTimeout(initTimeout);
          this.pickRandomDir(bot);
          // 就緒後開始送 move（跟真實 client 一樣 20/s）
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

  private sendMove(bot: Bot): void {
    if (bot.ws.readyState !== WebSocket.OPEN || !bot.initOk) return;
    bot.x = Math.max(
      0,
      Math.min(bot.x + bot.vx * (MOVE_INTERVAL_MS / 1000), MAP_WIDTH)
    );
    bot.y = Math.max(
      0,
      Math.min(bot.y + bot.vy * (MOVE_INTERVAL_MS / 1000), MAP_HEIGHT)
    );
    bot.ws.send(JSON.stringify({ type: "move", x: bot.x, y: bot.y }));
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
    this.log(`AOI stress test → ${this.url}`);
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
    // process.exit(0);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

const args = parseArgs(process.argv.slice(2));
const test = new StressTest(args.url, args.max, args.step, args.hold);
void test.run();
