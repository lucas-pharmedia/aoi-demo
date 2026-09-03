import Phaser from "phaser";
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
} from "../../shared/grid.ts";
import { toGrid, getSurroundingGridIds } from "./utils/grid.ts";
import { FpsOverlay } from "./ui/fps.ts";

interface RemotePlayer {
  sprite: Phaser.GameObjects.Sprite;
  buffer: { t: number; x: number; y: number }[];
  lastDir: Direction;
}

interface FakeBot {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** 內插緩衝區：對齊正式 scene（伺服器 15 Hz） */
const BUFFER_DELAY_MS = 130;
const MAX_BUFFER_SNAPSHOTS = 120;
/** 模擬伺服器 tick */
const TICK_MS = 67;
const BOT_COUNT = 100;
const BOT_SPEED = 80;
const MARGIN = 80;

export class BenchScene extends Phaser.Scene {
  mapManager!: MapManager;
  playerManager: PlayerManager | null = null;
  private aoiOverlay!: Phaser.GameObjects.Graphics;
  private remotes = new Map<number, RemotePlayer>();
  private bots: FakeBot[] = [];
  private lastGridId = -1;
  private fpsOverlay!: FpsOverlay;

  constructor() {
    super("bench");
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

    this.playerManager.createPlayer({
      x: MAP_WIDTH / 2,
      y: MAP_HEIGHT / 2,
    });

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) =>
      this.onPointerDown(pointer)
    );

    this.scale.on("resize", () => {
      this.playerManager?.recenterCameraOnPlayer();
    });

    this.spawnBots();
    this.time.addEvent({
      delay: TICK_MS,
      loop: true,
      callback: () => this.tickBots(),
    });

    console.log(
      `[bench] ${BOT_COUNT} fake remotes @ ${Math.round(
        1000 / TICK_MS
      )} Hz — no network`
    );
  }

  private spawnBots(): void {
    for (let i = 1; i <= BOT_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const bot: FakeBot = {
        id: i,
        x: Phaser.Math.Between(MARGIN, MAP_WIDTH - MARGIN),
        y: Phaser.Math.Between(MARGIN, MAP_HEIGHT - MARGIN),
        vx: Math.cos(angle) * BOT_SPEED,
        vy: Math.sin(angle) * BOT_SPEED,
      };
      this.bots.push(bot);
      this.upsertRemote(bot.id, bot.x, bot.y);
    }
  }

  private tickBots(): void {
    const dt = TICK_MS / 1000;
    for (const b of this.bots) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.x < MARGIN || b.x > MAP_WIDTH - MARGIN) {
        b.vx *= -1;
        b.x = Phaser.Math.Clamp(b.x, MARGIN, MAP_WIDTH - MARGIN);
      }
      if (b.y < MARGIN || b.y > MAP_HEIGHT - MARGIN) {
        b.vy *= -1;
        b.y = Phaser.Math.Clamp(b.y, MARGIN, MAP_HEIGHT - MARGIN);
      }

      this.upsertRemote(b.id, b.x, b.y);
    }
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

  private upsertRemote(id: number, x: number, y: number): void {
    const snap = { t: performance.now(), x, y };
    const existing = this.remotes.get(id);
    if (existing) {
      existing.buffer.push(snap);
      if (existing.buffer.length > MAX_BUFFER_SNAPSHOTS)
        existing.buffer.shift();
      return;
    }

    const idleFrame = WALK_ANIM_FRAMES.down.start + 1;
    const sprite = this.add
      .sprite(x, y, PLAYER_SPRITE_TEXTURE_KEY, idleFrame)
      .setScale(2)
      .setDepth(10);
    sprite.setOrigin(
      0.5,
      (WORLD_CHARACTER_SHEET_FRAME.frameHeight - 14) /
        WORLD_CHARACTER_SHEET_FRAME.frameHeight
    );
    sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);

    this.remotes.set(id, {
      sprite,
      buffer: [snap],
      lastDir: "down",
    });
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

  private lerpRemotes(): void {
    const renderTime = performance.now() - BUFFER_DELAY_MS;
    for (const rp of this.remotes.values()) {
      const buf = rp.buffer;

      while (buf.length > 2 && buf[1].t < renderTime) buf.shift();

      const newest = buf[buf.length - 1];
      let x: number;
      let y: number;

      if (buf.length === 1) {
        x = newest.x;
        y = newest.y;
      } else {
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
          const t = Phaser.Math.Clamp((renderTime - s1.t) / seg, 0, 1);
          x = Phaser.Math.Linear(s1.x, s2.x, t);
          y = Phaser.Math.Linear(s1.y, s2.y, t);

          const tdx = s2.x - s1.x;
          const tdy = s2.y - s1.y;
          const moving = Math.hypot(tdx, tdy) > 0.5;
          if (moving) {
            const dir = directionFromDelta(tdx, tdy);
            rp.lastDir = dir;
            const animKey = walkAnimKey(PLAYER_SPRITE_TEXTURE_KEY, dir);
            rp.sprite.play(animKey, true);
          } else if (rp.sprite.anims.isPlaying) {
            rp.sprite.anims.stop();
            rp.sprite.setFrame(WALK_ANIM_FRAMES[rp.lastDir].start + 1);
          }
        } else {
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
    this.lerpRemotes();
    this.drawAoi();
  }
}
