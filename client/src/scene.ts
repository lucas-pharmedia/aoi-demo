import Phaser from "phaser";
import { connect, sendMove } from "./network.ts";
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
  gridKey,
  getSurroundingGridKeys,
} from "./constants.ts";
import type { PlayerState, ServerPacket } from "./types.ts";
import { FpsOverlay } from "./ui/fps.ts";

interface RemotePlayer {
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  buffer: { t: number; x: number; y: number }[];
  lastDir: Direction;
  leaving: boolean;
}

/** 內插緩衝區：畫面恆渲染「now-100ms」的歷史位置，封包 16/32ms 抖動完全不影響平滑度 */
const BUFFER_DELAY_MS = 100;
/** 緩衝區最多留幾筆快照（60Hz * 2s） */
const MAX_BUFFER_SNAPSHOTS = 120;
/** 遠端進出場淡入/淡出時間 */
const REMOTE_FADE_MS = 200;

export class GameScene extends Phaser.Scene {
  mapManager!: MapManager;
  playerManager: PlayerManager | null = null;
  private selfId = "";
  private aoiOverlay!: Phaser.GameObjects.Graphics;
  private remotes = new Map<string, RemotePlayer>();
  private lastSend = 0;
  private lastGridKey = "";
  private lastTotal = -1;
  private fpsOverlay!: FpsOverlay;

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
    // 玩家行走動畫註冊要在 Player.create 之前
    registerSpriteWalkAnimations(this, PLAYER_SPRITE_TEXTURE_KEY);

    this.mapManager = new MapManager(this);
    this.mapManager.init();
    this.playerManager = new PlayerManager(this);

    this.drawStaticGrid();
    // AOI 高亮蓋在地圖物件上面（前景 fg depth=20000）
    this.aoiOverlay = this.add.graphics().setDepth(25000);
    // 右上角 fps（DOM overlay，CSS 定位，不擋遊戲點擊）
    this.fpsOverlay = new FpsOverlay();
    // 點擊 → 障礙物走過去、空地 navmesh 尋路
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
    });

    const wsUrl = `ws://${location.hostname}:8088`;
    connect(wsUrl, {
      onInit: (p) => this.handleInit(p),
      onEnter: (players) => this.handleEnter(players),
      onLeave: (ids) => this.handleLeave(ids),
      onMove: (players) => this.handleMove(players),
      onUpdate: (players) => this.handleUpdate(players),
    });
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

  private handleInit(p: Extract<ServerPacket, { type: "init" }>): void {
    this.selfId = p.selfId;
    // server 隨機出生可能落在攤位/牆上，PlayerManager 會拉回可行走區域
    this.playerManager?.createPlayer({ x: p.x, y: p.y });
    const player = this.playerManager?.getPlayer();
    if (player) {
      sendMove(player.sprite.x, player.sprite.y);
    }
  }

  private upsertRemote(p: PlayerState): void {
    const snap = { t: this.time.now, x: p.x, y: p.y };
    const existing = this.remotes.get(p.id);
    if (existing) {
      // 淡出中又收到包（AOI 邊界抖動）→ 取消淡出、拉回不透明
      if (existing.leaving) {
        existing.leaving = false;
        this.tweens.killTweensOf(existing.sprite);
        this.tweens.killTweensOf(existing.label);
        existing.sprite.setAlpha(1);
        existing.label.setAlpha(1);
      }
      existing.buffer.push(snap);
      if (existing.buffer.length > MAX_BUFFER_SNAPSHOTS)
        existing.buffer.shift();
      return;
    }
    // 遠端玩家用同一張 player-sprite，縮放與本地一致；移動中由 lerp 方向播 walk 動畫
    const idleFrame = WALK_ANIM_FRAMES.down.start + 1;
    const sprite = this.add
      .sprite(p.x, p.y, PLAYER_SPRITE_TEXTURE_KEY, idleFrame)
      .setScale(2)
      .setDepth(10)
      .setAlpha(0);
    sprite.setOrigin(
      0.5,
      (WORLD_CHARACTER_SHEET_FRAME.frameHeight - 14) /
        WORLD_CHARACTER_SHEET_FRAME.frameHeight
    );
    sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    const label = this.add
      .text(p.x + 16, p.y - 8, p.id, { fontSize: "10px", color: "#8af" })
      .setDepth(10)
      .setAlpha(0);
    this.remotes.set(p.id, {
      sprite,
      label,
      buffer: [snap],
      lastDir: "down",
      leaving: false,
    });
    // 進場淡入
    this.tweens.add({ targets: sprite, alpha: 1, duration: REMOTE_FADE_MS });
    this.tweens.add({ targets: label, alpha: 1, duration: REMOTE_FADE_MS });
  }

  private removeRemote(id: string): void {
    const rp = this.remotes.get(id);
    if (!rp || rp.leaving) return;
    rp.leaving = true;
    // 出場淡出：淡完才真的 destroy + 從 map 刪除
    this.tweens.add({
      targets: [rp.sprite, rp.label],
      alpha: 0,
      duration: REMOTE_FADE_MS,
      onComplete: () => {
        rp.sprite.destroy();
        rp.label.destroy();
        this.remotes.delete(id);
      },
    });
  }

  private handleEnter(players: PlayerState[]): void {
    for (const p of players) this.upsertRemote(p);
  }

  private handleLeave(ids: string[]): void {
    for (const id of ids) this.removeRemote(id);
  }

  private handleMove(players: PlayerState[]): void {
    for (const p of players) this.upsertRemote(p);
  }

  private handleUpdate(players: PlayerState[]): void {
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

    // 點到障礙物 → 走到其外接矩形底邊中心
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

    // 點到空地 → navmesh 尋路
    if (this.mapManager.navMesh?.isPointInMesh({ x: world.x, y: world.y })) {
      this.playerManager?.walkToPoint({ x: world.x, y: world.y });
    }
  }

  private drawAoi(): void {
    const player = this.playerManager?.getPlayer();
    if (!player) return;

    const { gx, gy } = toGrid(player.sprite.x, player.sprite.y);
    const key = gridKey(gx, gy);
    if (key === this.lastGridKey) return;
    this.lastGridKey = key;

    const aoiKeys = new Set(getSurroundingGridKeys(gx, gy));
    const g = this.aoiOverlay;
    g.clear();
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (!aoiKeys.has(gridKey(c, r))) continue;
        g.fillStyle(0x4488ff, 0.15);
        g.fillRect(c * GRID_WIDTH, r * GRID_HEIGHT, GRID_WIDTH, GRID_HEIGHT);
        g.lineStyle(2, 0x66aaff, 0.9);
        g.strokeRect(c * GRID_WIDTH, r * GRID_HEIGHT, GRID_WIDTH, GRID_HEIGHT);
      }
    }
  }

  private lerpRemotes(_delta: number): void {
    // 內插緩衝區：畫面恆渲染「now-100ms」的歷史位置，在兩個已知歷史快照間 Linear 平滑移動。
    // 純內插、零外插——不猜未來，因此不會過衝、不會往後跳。
    const renderTime = this.time.now - BUFFER_DELAY_MS;
    for (const rp of this.remotes.values()) {
      const buf = rp.buffer;

      // 清掉 renderTime 之前的點（留 2 筆當錨點）
      while (buf.length > 2 && buf[1].t < renderTime) buf.shift();

      const newest = buf[buf.length - 1];
      let x: number;
      let y: number;

      if (buf.length === 1) {
        x = newest.x;
        y = newest.y;
      } else {
        // 找包住 renderTime 的兩點 s1 <= renderTime <= s2
        let s2i = buf.length - 1;
        for (let i = 1; i < buf.length; i++) {
          if (buf[i].t > renderTime) {
            s2i = i;
            break;
          }
        }
        const s1 = buf[s2i - 1];
        const s2 = buf[s2i];
        const seg = s2.t - s1.t || 1;

        if (renderTime <= s2.t) {
          // 純內插：兩個已知點之間平滑移動
          const t = Phaser.Math.Clamp((renderTime - s1.t) / seg, 0, 1);
          x = Phaser.Math.Linear(s1.x, s2.x, t);
          y = Phaser.Math.Linear(s1.y, s2.y, t);

          // 走路動畫：用歷史快照段（s1→s2）位移算方向；沒位移立刻停
          const tdx = s2.x - s1.x;
          const tdy = s2.y - s1.y;
          const moving = Math.hypot(tdx, tdy) > 0.5;
          if (moving) {
            const dir = directionFromDelta(tdx, tdy);
            rp.lastDir = dir;
            const animKey = walkAnimKey(PLAYER_SPRITE_TEXTURE_KEY, dir);
            // stop() 後 currentAnim.key 仍殘留舊值，不能拿它判斷「在播」；
            // play(key, true) 的 ignoreIfPlaying 會自己決定要不要重播
            rp.sprite.play(animKey, true);
          } else if (rp.sprite.anims.isPlaying) {
            rp.sprite.anims.stop();
            rp.sprite.setFrame(WALK_ANIM_FRAMES[rp.lastDir].start + 1);
          }
        } else {
          // buffer 乾涸（包遲到超過緩衝深度）：停在最新已知位置，不加外插；
          // 此時已無位移 → 動畫一併停掉，避免「站在原地走」的殘影
          x = s2.x;
          y = s2.y;
          if (rp.sprite.anims.isPlaying) {
            rp.sprite.anims.stop();
            rp.sprite.setFrame(WALK_ANIM_FRAMES[rp.lastDir].start + 1);
          }
        }
      }

      rp.sprite.x = x;
      rp.sprite.y = y;
      rp.sprite.setDepth(rp.sprite.y);
      rp.label.setPosition(rp.sprite.x + 16, rp.sprite.y - 8);
      rp.label.setDepth(rp.sprite.y + 1);
    }
  }

  update(_time: number, delta: number): void {
    // 單幀卡頓偵測：>50ms = 主執行緒卡住（<1000ms 排除分頁切回）
    if (delta > 50 && delta < 1000) {
      console.log(`[FRAME] hitched ${delta.toFixed(0)}ms`);
    }

    // 右上角 fps：每幀純 raw（1000/delta），分頁切回巨量 delta 跳過不計
    if (delta < 1000) {
      this.fpsOverlay.set(Math.round(1000 / Math.max(delta, 1)));
    }

    this.playerManager?.tick();
    this.lerpRemotes(delta);
    this.drawAoi();

    // 人數 log：自己 + 視野內遠端（人數有變才印）
    if (this.playerManager?.getPlayer()) {
      const total = 1 + this.remotes.size;
      if (total !== this.lastTotal) {
        this.lastTotal = total;
        console.log(
          `[AOI] 地圖上人數: ${total} (自己 1 + 遠端 ${this.remotes.size})`
        );
      }
    }

    // 玩家行走中（鍵盤／navmesh 路徑）→ 節流發送位置
    const player = this.playerManager?.getPlayer();
    if (player && (player.keyboardMoveActive || player.isPathMoving)) {
      const now = this.time.now;
      if (now - this.lastSend >= 16) {
        sendMove(player.sprite.x, player.sprite.y);
        this.lastSend = now;
      }
    }
  }
}
