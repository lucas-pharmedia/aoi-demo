import {
  PLAYER_CAMERA_FOLLOW_LERP,
  PLAYER_CAMERA_ZOOM,
  PLAYER_SPEED,
  PLAYER_SPRITE_TEXTURE_KEY
} from '../constants/gameConfig';
import { Player } from '../entities/Player';
import { getRandomPointInNavMeshLayer } from '../services/navMesh';
import {
  directionFromDelta,
  resolveKeyboardAxesFromKeyStack
} from '../services/spriteWalk';
import type { JoystickAxes } from '../../ui/virtualJoystick';
import type { Direction, Point, WorldPlayfieldScene } from '../types';

export class PlayerManager {
  private player: Player | null = null;
  private cursorKeys: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  private keyStack: Direction[] = [];
  private joystickAxes: JoystickAxes | null = null;

  constructor(private readonly scene: WorldPlayfieldScene) {
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.cursorKeys?.left?.off('down');
      this.cursorKeys?.left?.off('up');
      this.cursorKeys?.right?.off('down');
      this.cursorKeys?.right?.off('up');
      this.cursorKeys?.up?.off('down');
      this.cursorKeys?.up?.off('up');
      this.cursorKeys?.down?.off('down');
      this.cursorKeys?.down?.off('up');
    });
  }

  getPlayer(): Player | null {
    return this.player;
  }

  destroyPlayer(): void {
    if (!this.player) return;
    const { sprite } = this.player;
    this.scene.cameras.main.stopFollow();
    this.scene.tweens.killTweensOf(sprite);
    sprite.destroy();
    this.player = null;
  }

  createPlayer(spawnPoint: Point, textureKey?: string): void {
    this.destroyPlayer();
    const { map, navMesh } = this.scene.mapManager;

    // 不論來源，最終必須落在可行走範圍；否則改用 navMesh 隨機點
    if (!navMesh?.isPointInMesh(spawnPoint)) {
      spawnPoint = getRandomPointInNavMeshLayer(map);
    }

    const resolvedKey = textureKey ?? PLAYER_SPRITE_TEXTURE_KEY;
    const player = Player.create({
      scene: this.scene,
      spawnPoint,
      textureKey: resolvedKey,
    });
    if (!player) {
      console.error('[PlayerManager] Player.create FAILED — missing texture', resolvedKey);
      return;
    }

    this.setupPlayerCamera(player.sprite);
    this.setupPlayerInput(player.sprite);
    this.player = player;
  }

  private setupPlayerCamera(sprite: Phaser.Physics.Arcade.Sprite): void {
    const camera = sprite.scene.cameras.main;
    camera.setZoom(PLAYER_CAMERA_ZOOM);
    camera.startFollow(sprite, true, PLAYER_CAMERA_FOLLOW_LERP.x, PLAYER_CAMERA_FOLLOW_LERP.y);
    camera.centerOn(sprite.x, sprite.y);
  }

  /** resize 後重對準相機（避免 bounds 更新後卡在左上角） */
  recenterCameraOnPlayer(): void {
    if (!this.player) return;
    const { sprite } = this.player;
    this.scene.cameras.main.centerOn(sprite.x, sprite.y);
  }

  private setupPlayerInput(sprite: Phaser.Physics.Arcade.Sprite): void {
    this.cursorKeys = this.scene.input.keyboard?.createCursorKeys() ?? null;
    if (!this.cursorKeys) return;
    const { left, right, up, down } = this.cursorKeys;
    const keys: Record<Direction, Phaser.Input.Keyboard.Key> = { left, right, up, down };
    Object.entries(keys).forEach(([name, key]) => {
      const direction = name as Direction;
      key.on('down', () => {
        this.keyStack = this.keyStack.filter((k) => k !== direction);
        this.keyStack.push(direction);
      });
      key.on('up', () => {
        this.keyStack = this.keyStack.filter((k) => k !== name);
      });
    });

    const { map } = this.scene.mapManager;
    this.scene.physics.world.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    sprite.setCollideWorldBounds(true);
  }

  /** HTML 虛擬搖桿寫入；死區／放開傳 null。搖桿優先於鍵盤。 */
  setJoystickAxes(axes: JoystickAxes | null): void {
    this.joystickAxes = axes;
  }

  /** 點擊空地走過去；若正在鍵盤／搖桿行走先停。 */
  walkToPoint(target: Point, onComplete?: () => void): void {
    if (!this.player) return;
    if (this.player.keyboardMoveActive) {
      this.player.stopKeyboardMove();
    }
    this.player.walkToPoint({ target, onComplete });
  }

  tick(): void {
    this.handleDirectionalMove();
    this.player?.tick();
  }

  private resolveMoveAxes(): {
    inputX: number;
    inputY: number;
    facing: Direction;
  } | null {
    const joy = this.joystickAxes;
    if (joy && (joy.x !== 0 || joy.y !== 0)) {
      return {
        inputX: joy.x,
        inputY: joy.y,
        facing: directionFromDelta(joy.x, joy.y),
      };
    }
    return resolveKeyboardAxesFromKeyStack(this.keyStack);
  }

  private handleDirectionalMove(): void {
    if (!this.player) return;

    const resolved = this.resolveMoveAxes();
    if (!resolved) {
      if (this.player.keyboardMoveActive) {
        this.player.stopKeyboardMove();
      }
      return;
    }

    const { inputX, inputY, facing } = resolved;
    const inputVector = new Phaser.Math.Vector2(inputX, inputY).normalize();
    const deltaSeconds = this.scene.game.loop.delta / 1000;
    const moveDistance = PLAYER_SPEED * deltaSeconds;
    const sprite = this.player.sprite;

    const nextX = sprite.x + inputVector.x * moveDistance;
    const nextY = sprite.y + inputVector.y * moveDistance;

    const canMoveX = this.canMoveTo(nextX, sprite.y);
    const canMoveY = this.canMoveTo(sprite.x, nextY);

    if (!canMoveX && !canMoveY) {
      this.player.stopKeyboardMove();
      return;
    }

    const finalX = canMoveX ? inputX : 0;
    const finalY = canMoveY ? inputY : 0;
    if (finalX === 0 && finalY === 0) {
      this.player.stopKeyboardMove();
      return;
    }

    const step = new Phaser.Math.Vector2(finalX, finalY).normalize().scale(moveDistance);
    this.player.applyKeyboardMotion(step.x, step.y, facing);
  }

  /** 錨點須在 navMesh 內，且 physics body 須完全在 world bounds 內（與 setCollideWorldBounds 一致）。 */
  private canMoveTo(x: number, y: number): boolean {
    const { navMesh } = this.scene.mapManager;
    if (!this.player || !navMesh) return false;
    const sprite = this.player.sprite;
    if (!this.isPlayerBodyWithinWorldAt(sprite, x, y)) return false;
    return navMesh.isPointInMesh({ x, y });
  }

  private isPlayerBodyWithinWorldAt(sprite: Phaser.Physics.Arcade.Sprite, worldX: number, worldY: number): boolean {
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    const dx = worldX - sprite.x;
    const dy = worldY - sprite.y;
    const left = body.x + dx;
    const top = body.y + dy;
    const { x: bx, y: by, width: bw, height: bh } = this.scene.physics.world.bounds;
    return left >= bx && top >= by && left + body.width <= bx + bw && top + body.height <= by + bh;
  }
}