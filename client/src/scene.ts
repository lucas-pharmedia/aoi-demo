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

/** Enter 載圖中：先收座標，texture 就緒再建 sprite */
interface PendingRemote {
  playerId: number;
  buffer: RemoteSnap[];
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

  private pushRemoteSnap(p: BinaryPlayerState): void {
    if (p.id === this.selfId || this.selfId === 0) return;

    const existing = this.remotes.get(p.id);
    const pending = this.pendingRemotes.get(p.id);
    const targetBuffer = existing
      ? existing.buffer
      : pending
      ? pending.buffer
      : null;

    if (targetBuffer) {
      if (targetBuffer.length >= MAX_BUFFER_SNAPSHOTS) {
        const recycledSnap = targetBuffer.shift()!;
        recycledSnap.t = performance.now();
        recycledSnap.x = p.x;
        recycledSnap.y = p.y;
        targetBuffer.push(recycledSnap);
      } else {
        targetBuffer.push({ t: performance.now(), x: p.x, y: p.y });
      }
    }
  }

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

    this.pendingRemotes.set(p.id, {
      playerId: p.playerId,
      buffer: [snap],
    });

    const remoteId = p.id;
    const playerId = p.playerId;
    void this.ensurePlayerTextureLoaded(playerId).then((textureKey) => {
      const pendingNow = this.pendingRemotes.get(remoteId);
      if (!pendingNow) return;
      this.pendingRemotes.delete(remoteId);
      if (this.remotes.has(remoteId)) return;

      const last = pendingNow.buffer[pendingNow.buffer.length - 1]!;
      const idleFrame = WALK_ANIM_FRAMES.down.start + 1;
      const sprite = this.add
        .sprite(last.x, last.y, textureKey, idleFrame)
        .setScale(2)
        .setDepth(10)
        .setAlpha(1);
      sprite.setOrigin(
        0.5,
        (WORLD_CHARACTER_SHEET_FRAME.frameHeight - 14) /
          WORLD_CHARACTER_SHEET_FRAME.frameHeight
      );
      sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);

      this.remotes.set(remoteId, {
        sprite,
        buffer: pendingNow.buffer,
        lastDir: "down",
        leaving: false,
        textureKey,
      });
    });
  }

  private removeRemote(id: number): void {
    this.pendingRemotes.delete(id);
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
   * 🟢 徹底消滅動畫重置抖動的反抖動插值 (Non-Resetting Animation Lerp)
   */
  private lerpRemotes(delta: number): void {
    const dt = delta / 1000;

    for (const rp of this.remotes.values()) {
      const buf = rp.buffer;

      // 網路卡頓嚴重時丟棄舊包
      if (buf.length > 6) {
        buf.splice(0, buf.length - 2);
      }

      if (buf.length === 0) {
        // 沒有任何包時靜止，切回靜止 Frame
        if (rp.sprite.anims.isPlaying) {
          rp.sprite.anims.stop();
          const idleFrame = WALK_ANIM_FRAMES[rp.lastDir].start + 1;
          rp.sprite.setFrame(idleFrame);
        }
        continue;
      }

      // 起步保護水墊：靜止狀態等 2 包建立水位才動
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

      // 到達當前點，消耗並繼續指向下一個點
      if (distToTarget <= 0.8) {
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

      const nextX = currentX + moveX;
      const nextY = currentY + moveY;

      rp.sprite.x = nextX;
      rp.sprite.y = nextY;
      rp.sprite.setDepth(nextY);

      // 🟢 修復核心：只有真實發生 > 0.5px 的顯著位移時，才計算並更新方向，防浮點數高頻重置動畫
      if (Math.hypot(moveX, moveY) > 0.5) {
        const newDir = directionFromDelta(moveX, moveY);
        rp.lastDir = newDir;

        const animKey = walkAnimKey(rp.textureKey, newDir);
        // 只有當前動畫 key 真的不同，或目前是靜止狀態時才重載 play()
        if (
          !rp.sprite.anims.isPlaying ||
          rp.sprite.anims.currentAnim?.key !== animKey
        ) {
          // 第二個參數 ignoreIfPlaying 為 true：如果動畫已在播放且 key 相同，絕對不重置 Frame 0！
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
