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
  PLAYER_SPEED,
} from "./world/constants/gameConfig.ts";
import {
  getPlayerSpriteUrl,
  resolvePlayerSpriteTextureKey,
} from "./world/constants/playerSpriteUrls.ts";
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

// ----------------------------------------------------------------------
// 🟢 伺服器同步頻率配置與動態參數導出
// ----------------------------------------------------------------------
/** 伺服器廣播頻率 (Hz) - 請隨時對齊伺服器的 TICK_RATE (例如 3 或 8) */
const SERVER_TICK_RATE = 3;
/** 伺服器廣播單次間隔時間 (ms) */
const SERVER_TICK_MS = 1000 / SERVER_TICK_RATE;
/** Enter 延遲顯影超時門檻 (1.25 倍 Tick 間隔)，3Hz 下約 416ms */
const ENTER_SPAWN_TIMEOUT_MS = Math.ceil(SERVER_TICK_MS * 1.25);

interface RemoteSnap {
  t: number;
  x: number;
  y: number;
}

interface RemotePlayer {
  sprite: Phaser.GameObjects.Sprite;
  buffer: RemoteSnap[];
  lastDir: Direction;
  leaving: boolean;
  textureKey: string;
}

/** Enter 載圖 / 等待雙包對齊中：先收座標與設超時，等條件達成再建 sprite */
interface PendingRemote {
  playerId: number;
  buffer: RemoteSnap[];
  timerId?: number;
}

/** 緩衝區最多留幾筆快照 */
const MAX_BUFFER_SNAPSHOTS = 60;
/** 前端發送移動位置的最小間隔 (ms) */
const SEND_MOVE_INTERVAL_MS = 80;

export class GameScene extends Phaser.Scene {
  mapManager!: MapManager;
  playerManager: PlayerManager | null = null;
  private selfId = 0; // 數字 ID
  private aoiOverlay!: Phaser.GameObjects.Graphics;
  private remotes = new Map<number, RemotePlayer>();
  private pendingRemotes = new Map<number, PendingRemote>();
  private textureLoadPromises = new Map<string, Promise<string>>();
  private lastSend = 0;
  private lastGridId = -1;
  private lastTotal = -1;
  private fpsOverlay!: FpsOverlay;
  private teardownNetwork: (() => void) | null = null;
  private selfPlayerId = 0;

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

    this.selfPlayerId = resolveSelfPlayerIdFromPage();
    const baseWsUrl =
      import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:8088`;
    const wsUrl =
      this.selfPlayerId > 0
        ? `${baseWsUrl}${baseWsUrl.includes("?") ? "&" : "?"}player=${
            this.selfPlayerId
          }`
        : baseWsUrl;
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

  private resetWorldForReconnect(): void {
    for (const pending of this.pendingRemotes.values()) {
      if (pending.timerId) clearTimeout(pending.timerId);
    }
    for (const rp of this.remotes.values()) {
      rp.sprite.destroy();
    }
    this.remotes.clear();
    this.pendingRemotes.clear();
    this.playerManager?.destroyPlayer();
    this.aoiOverlay?.clear();
    this.selfId = 0;
    this.lastGridId = -1;
    this.lastTotal = -1;
    this.lastSend = 0;
  }

  private ensurePlayerTextureLoaded(playerId: number): Promise<string> {
    const textureKey = resolvePlayerSpriteTextureKey(
      playerId,
      PLAYER_SPRITE_TEXTURE_KEY
    );
    if (textureKey === PLAYER_SPRITE_TEXTURE_KEY) {
      return Promise.resolve(textureKey);
    }
    if (this.textures.exists(textureKey)) {
      if (!this.anims.exists(walkAnimKey(textureKey, "down"))) {
        registerSpriteWalkAnimations(this, textureKey);
      }
      return Promise.resolve(textureKey);
    }

    const inflight = this.textureLoadPromises.get(textureKey);
    if (inflight) return inflight;

    const url = getPlayerSpriteUrl(playerId);
    if (!url) return Promise.resolve(PLAYER_SPRITE_TEXTURE_KEY);

    const promise = new Promise<string>((resolve) => {
      let settled = false;
      const finishOk = (): void => {
        if (settled) return;
        settled = true;
        this.textureLoadPromises.delete(textureKey);
        registerSpriteWalkAnimations(this, textureKey);
        resolve(textureKey);
      };
      const finishFail = (): void => {
        if (settled) return;
        settled = true;
        this.textureLoadPromises.delete(textureKey);
        console.warn(`[sprite] load failed playerId=${playerId}, fallback`);
        resolve(PLAYER_SPRITE_TEXTURE_KEY);
      };

      this.load.setCORS("anonymous");
      this.load.spritesheet(textureKey, url, WORLD_CHARACTER_SHEET_FRAME);
      this.load.once(`filecomplete-spritesheet-${textureKey}`, finishOk);
      this.load.once("loaderror", (file: { key?: string }) => {
        if (file?.key === textureKey) finishFail();
      });
      this.load.start();
    });

    this.textureLoadPromises.set(textureKey, promise);
    return promise;
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
    void this.ensurePlayerTextureLoaded(this.selfPlayerId).then(
      (textureKey) => {
        if (this.selfId !== p.selfId) return;
        this.playerManager?.createPlayer({ x: p.x, y: p.y }, textureKey);
        const player = this.playerManager?.getPlayer();
        if (player) {
          sendMove(player.sprite.x, player.sprite.y);
        }
      }
    );
  }

  /**
   * 🟢 Zero-GC 快照推入與雙軌延遲顯影解鎖 (軌道 A)
   */
  private pushRemoteSnap(p: BinaryPlayerState): void {
    if (p.id === this.selfId || this.selfId === 0) return;

    const existing = this.remotes.get(p.id);
    if (existing) {
      const targetBuffer = existing.buffer;
      if (targetBuffer.length >= MAX_BUFFER_SNAPSHOTS) {
        const recycledSnap = targetBuffer.shift()!;
        recycledSnap.t = performance.now();
        recycledSnap.x = p.x;
        recycledSnap.y = p.y;
        targetBuffer.push(recycledSnap);
      } else {
        targetBuffer.push({ t: performance.now(), x: p.x, y: p.y });
      }
      return;
    }

    const pending = this.pendingRemotes.get(p.id);
    if (pending) {
      pending.buffer.push({ t: performance.now(), x: p.x, y: p.y });

      // 🟢 軌道 A：收到第 2 包 Move 證明正在移動！立即取消超時並生成 Sprite
      if (pending.buffer.length >= 2) {
        if (pending.timerId) clearTimeout(pending.timerId);
        this.spawnRemoteFromPending(p.id, pending);
      }
    }
  }

  /**
   * 🟢 異步建立待處理玩家，註冊超時條款 (軌道 B)
   */
  private upsertRemote(p: BinaryPlayerState): void {
    if (p.id === this.selfId || this.selfId === 0) return;

    const snap: RemoteSnap = { t: performance.now(), x: p.x, y: p.y };
    const existing = this.remotes.get(p.id);
    if (existing) {
      this.pushRemoteSnap(p);
      return;
    }

    const pending = this.pendingRemotes.get(p.id);
    if (pending) {
      this.pushRemoteSnap(p);
      return;
    }

    const remoteId = p.id;
    const pendingData: PendingRemote = {
      playerId: p.playerId,
      buffer: [snap],
    };

    // 🟢 軌道 B (超時備援)：若在超時時間內都沒有第 2 包 Move，判定為靜止玩家並生成
    pendingData.timerId = window.setTimeout(() => {
      const pNow = this.pendingRemotes.get(remoteId);
      if (pNow) {
        this.spawnRemoteFromPending(remoteId, pNow);
      }
    }, ENTER_SPAWN_TIMEOUT_MS);

    this.pendingRemotes.set(remoteId, pendingData);

    // 預先載入貼圖
    void this.ensurePlayerTextureLoaded(p.playerId);
  }

  /**
   * 🟢 從 Pending 狀態實體化建立 Remote Player Sprite
   */
  private spawnRemoteFromPending(
    remoteId: number,
    pending: PendingRemote
  ): void {
    if (this.remotes.has(remoteId)) return;

    const playerId = pending.playerId;
    void this.ensurePlayerTextureLoaded(playerId).then((textureKey) => {
      const pendingNow = this.pendingRemotes.get(remoteId);
      if (!pendingNow || this.remotes.has(remoteId)) return;

      if (pendingNow.timerId) clearTimeout(pendingNow.timerId);
      this.pendingRemotes.delete(remoteId);

      const buf = pendingNow.buffer;
      const p1 = buf[0];
      const p2 = buf.length >= 2 ? buf[1] : p1;

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const isMoving = Math.hypot(dx, dy) > 0.1;

      const initialDir = isMoving ? directionFromDelta(dx, dy) : "down";
      const animKey = walkAnimKey(textureKey, initialDir);

      const sprite = this.add
        .sprite(p1.x, p1.y, textureKey)
        .setScale(2)
        .setDepth(p1.y)
        .setAlpha(1);

      sprite.setOrigin(
        0.5,
        (WORLD_CHARACTER_SHEET_FRAME.frameHeight - 14) /
          WORLD_CHARACTER_SHEET_FRAME.frameHeight
      );
      sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);

      if (isMoving) {
        sprite.play(animKey, true);
      } else {
        const idleFrame = WALK_ANIM_FRAMES[initialDir].start + 1;
        sprite.setFrame(idleFrame);
      }

      this.remotes.set(remoteId, {
        sprite,
        buffer: buf,
        lastDir: initialDir,
        leaving: false,
        textureKey,
      });
    });
  }

  private removeRemote(id: number): void {
    const pending = this.pendingRemotes.get(id);
    if (pending) {
      if (pending.timerId) clearTimeout(pending.timerId);
      this.pendingRemotes.delete(id);
    }

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
    for (const p of players) this.pushRemoteSnap(p);
  }

  private handleUpdate(players: BinaryPlayerState[]): void {
    for (const p of players) this.upsertRemote(p);

    for (const id of this.remotes.keys()) {
      let found = false;
      for (let i = 0; i < players.length; i++) {
        if (players[i].id === id) {
          found = true;
          break;
        }
      }
      if (!found) this.removeRemote(id);
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

  /**
   * 🟢 平滑勻速與精確動畫插值
   */
  private lerpRemotes(delta: number): void {
    const dt = delta / 1000;

    for (const rp of this.remotes.values()) {
      const buf = rp.buffer;

      // 網路卡頓時清理積壓快照
      if (buf.length > 6) {
        buf.splice(0, buf.length - 2);
      }

      if (buf.length === 0) {
        if (rp.sprite.anims.isPlaying) {
          rp.sprite.anims.stop();
          const idleFrame = WALK_ANIM_FRAMES[rp.lastDir].start + 1;
          rp.sprite.setFrame(idleFrame);
        }
        continue;
      }

      // 🟢 兩全其美關鍵：只對「畫面上的靜止角色起步」實施水墊保護
      // 如果角色目前是靜止的（沒有播放走路動畫），且 buffer 只有 1 包，
      // 代表剛按下方向鍵啟動，強制等待第 2 包到達（建立水位）再開跑，避免暴衝急煞！
      const isStopped = !rp.sprite.anims.isPlaying;
      if (isStopped && buf.length < 2) {
        continue;
      }

      const target = buf[0];
      const currentX = rp.sprite.x;
      const currentY = rp.sprite.y;

      const dx = target.x - currentX;
      const dy = target.y - currentY;
      const distToTarget = Math.hypot(dx, dy);

      // 精確吸附門檻 0.1px
      if (distToTarget <= 0.1) {
        rp.sprite.x = target.x;
        rp.sprite.y = target.y;
        buf.shift();

        if (buf.length === 0) {
          if (rp.sprite.anims.isPlaying) {
            rp.sprite.anims.stop();
            const idleFrame = WALK_ANIM_FRAMES[rp.lastDir].start + 1;
            rp.sprite.setFrame(idleFrame);
          }
          continue;
        }
      }

      // 勻速位移
      const step = Math.min(distToTarget, PLAYER_SPEED * dt);
      const angle = Math.atan2(dy, dx);

      const moveX = Math.cos(angle) * step;
      const moveY = Math.sin(angle) * step;

      rp.sprite.x = currentX + moveX;
      rp.sprite.y = currentY + moveY;
      rp.sprite.setDepth(rp.sprite.y);

      // 動畫觸發門檻 0.05px
      if (Math.hypot(moveX, moveY) > 0.05) {
        const newDir = directionFromDelta(moveX, moveY);
        rp.lastDir = newDir;

        const animKey = walkAnimKey(rp.textureKey, newDir);
        if (
          !rp.sprite.anims.isPlaying ||
          rp.sprite.anims.currentAnim?.key !== animKey
        ) {
          rp.sprite.play(animKey, true);
        }
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

function resolveSelfPlayerIdFromPage(): number {
  const raw = new URLSearchParams(location.search).get("player");
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 1 && n <= 255) return Math.floor(n);
  return 0;
}
