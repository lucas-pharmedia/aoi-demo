import Phaser from "phaser";
import {
  connect,
  sendMove,
  setupVisibilityReconnect,
  type BinaryPlayerState,
} from "./network.ts";
import { MapManager } from "./world/managers/MapManager.ts";
import { PlayerManager } from "./world/managers/PlayerManager.ts";
import { HOME_TILE_MAP_KEY } from "./world/constants/mapConfig.ts";
import { WORLD_HOME_TEXTURE_KEYS } from "./world/constants/homeMapTextureKeys.ts";
import {
  PLAYER_SPRITE_TEXTURE_KEY,
  WORLD_CHARACTER_SHEET_FRAME,
  walkAnimKey,
  WALK_ANIM_FRAMES,
} from "./world/constants/gameConfig.ts";
import {
  directionFromDelta,
  registerSpriteWalkAnimations,
} from "./world/services/spriteWalk.ts";
import type { Direction } from "./world/types/index.ts";
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  GRID_WIDTH,
  GRID_HEIGHT,
  GRID_COLS,
  GRID_ROWS,
  toGrid,
  getSurroundingGridIds,
} from "../../shared/grid.ts";
import { FpsOverlay } from "./ui/fps.ts";

interface RemotePlayer {
  sprite: Phaser.GameObjects.Sprite;
  buffer: { t: number; x: number; y: number }[];
  lastDir: Direction;
  leaving: boolean;
  /**  標記該角色是否處於靜止狀態 */
  isMoving: boolean;
}

/** 🟢 專為 3 Hz (333ms) 伺服器設計：設定為 550ms 延遲，保證水庫常駐 2 筆快照做純線性插值 */
const BUFFER_DELAY_MS = 550;
/** 緩衝區最多留幾筆快照 */
const MAX_BUFFER_SNAPSHOTS = 120;
/** 🟢 3 Hz 伺服器下，前端 sendMove 設為 100ms ~ 150ms 即可 */
const SEND_MOVE_INTERVAL_MS = 120;

export class GameScene extends Phaser.Scene {
  mapManager!: MapManager;
  playerManager: PlayerManager | null = null;
  private selfId = 0; // 數字 ID
  private aoiOverlay!: Phaser.GameObjects.Graphics;
  private remotes = new Map<number, RemotePlayer>();
  private lastSend = 0;
  private lastGridId = -1;
  private lastTotal = -1;
  private fpsOverlay!: FpsOverlay;
  private teardownNetwork: (() => void) | null = null;

  constructor() {
    super("game");
  }

  preload(): void {
    this.load.tilemapTiledJSON(HOME_TILE_MAP_KEY, "assets/world/home/home.tmj");
    for (const key of WORLD_HOME_TEXTURE_KEYS) {
      this.load.image(key, `assets/world/home/map-objects/${key}.png`);
    }
    this.load.spritesheet(
      PLAYER_SPRITE_TEXTURE_KEY,
      "assets/world/player-sprite.png",
      WORLD_CHARACTER_SHEET_FRAME
    );
  }

  create(): void {
    registerSpriteWalkAnimations(this, PLAYER_SPRITE_TEXTURE_KEY);

    this.mapManager = new MapManager(this);
    this.mapManager.init();
    this.playerManager = new PlayerManager(this);

    this.drawStaticGrid();
    this.aoiOverlay = this.add.graphics().setDepth(25000);
    this.fpsOverlay = new FpsOverlay();

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) =>
      this.onPointerDown(pointer)
    );

    this.scale.on("resize", () => {
      this.playerManager?.recenterCameraOnPlayer();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off("resize", () =>
        this.playerManager?.recenterCameraOnPlayer()
      );
      this.teardownNetwork?.();
      this.teardownNetwork = null;
    });

    const wsUrl =
      import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:8088`;
    connect(wsUrl, {
      onInit: (p) => this.handleInit(p),
      onEnter: (players) => this.handleEnter(players),
      onLeave: (ids) => this.handleLeave(ids),
      onMove: (players) => this.handleMove(players),
      onUpdate: (players) => this.handleUpdate(players),
    });
    this.teardownNetwork = setupVisibilityReconnect(() =>
      this.resetWorldForReconnect()
    );
  }

  /** 分頁切回前景重連前清場，等同重開網頁的 client 狀態 */
  private resetWorldForReconnect(): void {
    for (const rp of this.remotes.values()) {
      rp.sprite.destroy();
    }
    this.remotes.clear();
    this.playerManager?.destroyPlayer();
    this.aoiOverlay?.clear();
    this.selfId = 0;
    this.lastGridId = -1;
    this.lastTotal = -1;
    this.lastSend = 0;
  }

  private drawStaticGrid(): void {
    const g = this.add.graphics();
    g.lineStyle(1, 0x333355, 0.8);
    for (let c = 1; c < GRID_COLS; c++) {
      g.lineBetween(c * GRID_WIDTH, 0, c * GRID_WIDTH, MAP_HEIGHT);
    }
    for (let r = 1; r < GRID_ROWS; r++) {
      g.lineBetween(0, r * GRID_HEIGHT, MAP_WIDTH, r * GRID_HEIGHT);
    }
    g.strokeRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        this.add
          .text(c * GRID_WIDTH + 8, r * GRID_HEIGHT + 4, `${c}_${r}`, {
            fontFamily: "monospace",
            fontSize: "14px",
            color: "#667",
          })
          .setDepth(1);
      }
    }
  }

  private handleInit(p: { selfId: number; x: number; y: number }): void {
    this.selfId = p.selfId;
    this.playerManager?.createPlayer({ x: p.x, y: p.y });
    const player = this.playerManager?.getPlayer();
    if (player) {
      sendMove(player.sprite.x, player.sprite.y);
    }
  }

  private upsertRemote(p: BinaryPlayerState): void {
    if (p.id === this.selfId || this.selfId === 0) return;

    const now = performance.now();
    const existing = this.remotes.get(p.id);

    if (existing) {
      const lastSnap = existing.buffer[existing.buffer.length - 1];

      if (lastSnap) {
        const timeDiff = now - lastSnap.t;

        //  核心修復 1：靜止後重新起步邏輯 (Stationary Resumption)
        // 只要收包間隔 > 130ms (超過一個 8Hz Tick)，代表對方剛才停了下來！
        // 當他重新起步時，直接以「當前畫面的 Sprite 座標」作為插值起點，
        // 絕對不拿舊的伺服器座標做插值，徹底杜絕反方向抖動！
        if (timeDiff > 130 || !existing.isMoving) {
          existing.isMoving = true;
          existing.buffer = [
            {
              t: now - BUFFER_DELAY_MS,
              x: existing.sprite.x,
              y: existing.sprite.y,
            },
            { t: now, x: p.x, y: p.y },
          ];
          return;
        }
      }

      existing.buffer.push({ t: now, x: p.x, y: p.y });
      if (existing.buffer.length > MAX_BUFFER_SNAPSHOTS) {
        existing.buffer.shift();
      }
      return;
    }

    const idleFrame = WALK_ANIM_FRAMES.down.start + 1;
    const sprite = this.add
      .sprite(p.x, p.y, PLAYER_SPRITE_TEXTURE_KEY, idleFrame)
      .setScale(2)
      .setDepth(10)
      .setAlpha(1);
    sprite.setOrigin(
      0.5,
      (WORLD_CHARACTER_SHEET_FRAME.frameHeight - 14) /
        WORLD_CHARACTER_SHEET_FRAME.frameHeight
    );
    sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);

    this.remotes.set(p.id, {
      sprite,
      buffer: [{ t: now, x: p.x, y: p.y }],
      lastDir: "down",
      leaving: false,
      isMoving: false,
    });
  }

  private removeRemote(id: number): void {
    const rp = this.remotes.get(id);
    if (!rp) return;

    rp.sprite.destroy();
    this.remotes.delete(id);
  }

  private handleEnter(players: BinaryPlayerState[]): void {
    for (const p of players) this.upsertRemote(p);
  }

  private handleLeave(ids: number[]): void {
    for (const id of ids) this.removeRemote(id);
  }

  private handleMove(players: BinaryPlayerState[]): void {
    for (const p of players) this.upsertRemote(p);
  }

  private handleUpdate(players: BinaryPlayerState[]): void {
    const seen = new Set(players.map((p) => p.id));
    for (const p of players) this.upsertRemote(p);
    for (const id of [...this.remotes.keys()]) {
      if (!seen.has(id)) this.removeRemote(id);
    }
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    const player = this.playerManager?.getPlayer();
    if (!player) return;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);

    const obstacle = this.mapManager.findObstacleObjectAtWorld(
      world.x,
      world.y
    );
    if (obstacle) {
      this.playerManager?.walkToPoint(
        this.mapManager.getObstacleApproachPoint(obstacle)
      );
      return;
    }

    if (this.mapManager.navMesh?.isPointInMesh({ x: world.x, y: world.y })) {
      this.playerManager?.walkToPoint({ x: world.x, y: world.y });
    }
  }

  private drawAoi(): void {
    const player = this.playerManager?.getPlayer();
    if (!player) return;

    const currentGridId = toGrid(player.sprite.x, player.sprite.y);
    if (currentGridId === this.lastGridId) return;
    this.lastGridId = currentGridId;

    const aoiIds = new Set(getSurroundingGridIds(currentGridId));
    const g = this.aoiOverlay;
    g.clear();

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const id = r * GRID_COLS + c;
        if (!aoiIds.has(id)) continue;

        g.fillStyle(0x4488ff, 0.15);
        g.fillRect(c * GRID_WIDTH, r * GRID_HEIGHT, GRID_WIDTH, GRID_HEIGHT);
        g.lineStyle(2, 0x66aaff, 0.9);
        g.strokeRect(c * GRID_WIDTH, r * GRID_HEIGHT, GRID_WIDTH, GRID_HEIGHT);
      }
    }
  }

  /**  商業級平滑插值演算法 */
  private lerpRemotes(_delta: number): void {
    const renderTime = performance.now() - BUFFER_DELAY_MS;

    for (const rp of this.remotes.values()) {
      const buf = rp.buffer;

      // 1. 拋棄過期快照 (保留至少 2 筆)
      while (buf.length > 2 && buf[1].t <= renderTime) {
        buf.shift();
      }

      const prevX = rp.sprite.x;
      const prevY = rp.sprite.y;

      let nextX = prevX;
      let nextY = prevY;

      // 2. 依據時間軸計算目標座標 (100% 忠實於伺服器座標)
      if (buf.length === 1) {
        // 水庫乾涸（網路波動 > 550ms）：精準停在伺服器給的最後座標，絕不虛構位移
        nextX = buf[0].x;
        nextY = buf[0].y;
        rp.isMoving = false;
      } else if (buf.length >= 2) {
        const s1 = buf[0];
        const s2 = buf[1];
        const seg = s2.t - s1.t || 1;

        if (renderTime < s1.t) {
          // 時間未到，保持當前畫面座標，避免向舊點吸過去
          nextX = prevX;
          nextY = prevY;
        } else if (renderTime <= s2.t) {
          // 正常 3 Hz 下的標準 100% 精準線性插值
          const t = Phaser.Math.Clamp((renderTime - s1.t) / seg, 0, 1);
          nextX = Phaser.Math.Linear(s1.x, s2.x, t);
          nextY = Phaser.Math.Linear(s1.y, s2.y, t);
        } else {
          // 🟢 網路微幅卡頓 (renderTime > s2.t)：
          // 採用指數衰減（Factor 0.15）平滑趨近最後點，讓角色自然減速停下，而不是硬卡/暴衝
          nextX = Phaser.Math.Linear(prevX, s2.x, 0.15);
          nextY = Phaser.Math.Linear(prevY, s2.y, 0.15);
        }
      }

      // 3. 超遠距離防暴衝硬貼合 (切換分頁重連等)
      const distToNext = Math.hypot(nextX - prevX, nextY - prevY);
      if (distToNext > 150) {
        const latest = buf[buf.length - 1];
        rp.buffer = [latest];
        nextX = latest.x;
        nextY = latest.y;
      }

      // 4. 更新 Sprite 實體座標與繪圖深度
      rp.sprite.x = nextX;
      rp.sprite.y = nextY;
      rp.sprite.setDepth(rp.sprite.y);

      // 5. 依據實質影格位移量播放動畫
      const frameDx = nextX - prevX;
      const frameDy = nextY - prevY;
      const actualMovedDist = Math.hypot(frameDx, frameDy);

      if (actualMovedDist > 0.15) {
        const dir = directionFromDelta(frameDx, frameDy);
        rp.lastDir = dir;
        const animKey = walkAnimKey(PLAYER_SPRITE_TEXTURE_KEY, dir);
        rp.sprite.play(animKey, true);
      } else if (rp.sprite.anims.isPlaying) {
        rp.sprite.anims.stop();
        rp.sprite.setFrame(WALK_ANIM_FRAMES[rp.lastDir].start + 1);
      }
    }
  }

  update(_time: number, delta: number): void {
    if (delta > 50 && delta < 1000) {
      console.log(`[FRAME] hitched ${delta.toFixed(0)}ms`);
    }

    if (delta < 1000) {
      this.fpsOverlay.set(Math.round(1000 / Math.max(delta, 1)));
    }

    this.playerManager?.tick();
    this.lerpRemotes(delta);
    this.drawAoi();

    if (this.playerManager?.getPlayer()) {
      const total = 1 + this.remotes.size;
      if (total !== this.lastTotal) {
        this.lastTotal = total;
      }
    }

    const player = this.playerManager?.getPlayer();
    if (player && (player.keyboardMoveActive || player.isPathMoving)) {
      const now = this.time.now;
      if (now - this.lastSend >= SEND_MOVE_INTERVAL_MS) {
        sendMove(player.sprite.x, player.sprite.y);
        this.lastSend = now;
      }
    }
  }
}
