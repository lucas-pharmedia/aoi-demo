import {
  PLAYER_SPEED,
  PLAYER_SPRITE_TEXTURE_KEY,
  walkAnimKey
} from '../constants/gameConfig';
import { Character } from '../entities/Character';
import type { Direction, Point, WorldPlayfieldScene } from '../types';

export class Player extends Character {
  private isKeyboardMoving = false;
  public isPathMoving = false;

  private constructor(
    scene: WorldPlayfieldScene,
    sprite: Phaser.Physics.Arcade.Sprite,
    textureKey: string
  ) {
    super({ scene, sprite, textureKey, walkSpeed: PLAYER_SPEED });
  }

  /** 是否正由鍵盤方向連續推進行走（放開後才為 false） */
  get keyboardMoveActive(): boolean {
    return this.isKeyboardMoving;
  }

  /**
   * 只建立角色 sprite；行走動畫由場景註冊。座標、身體、碰撞、攝影機由 {@link PlayerManager} 處理。
   * 圖集不存在時回傳 null。
   */
  static create(options: {
    scene: WorldPlayfieldScene;
    spawnPoint: Point;
    textureKey?: string;
  }): Player | null {
    const { scene, spawnPoint } = options;
    const textureKey = options.textureKey ?? PLAYER_SPRITE_TEXTURE_KEY;
    const sprite = Character.createScaledArcadeSprite(scene, spawnPoint, textureKey);
    if (!sprite) return null;
    const player = new Player(scene, sprite, textureKey);
    Character.applyOrigin(player);
    player.setIdleFrame();
    return player;
  }

  /** 未用鍵盤／路徑移動且無播放中動畫時視為閒置，才做呼吸縮放。 */
  protected override shouldApplyIdleBreath(): boolean {
    return !this.isKeyboardMoving && !this.isPathMoving && !this.sprite.anims.isPlaying;
  }

  /** 套用已由 Manager 依速度與 navMesh 算好的本幀位移（像素）。 */
  applyKeyboardMotion(deltaX: number, deltaY: number, facing: Direction): void {
    if (deltaX === 0 && deltaY === 0) return;
    if (!this.isKeyboardMoving) {
      this.sprite.scene.tweens.killTweensOf(this.sprite);
    }
    this.sprite.setPosition(this.sprite.x + deltaX, this.sprite.y + deltaY);
    this.direction = facing;
    this.sprite.play(walkAnimKey(this.getTextureKey(), facing), true);
    this.isKeyboardMoving = true;
    this.isPathMoving = false;
  }

  stopKeyboardMove(): void {
    this.sprite.stop();
    this.setIdleFrame();
    this.isKeyboardMoving = false;
  }

  override walkToPoint(options: { target: Point; onComplete?: () => void }): void {
    this.isPathMoving = true;
    const { onComplete, ...rest } = options;
    super.walkToPoint({
      ...rest,
      onComplete: () => {
        this.isPathMoving = false;
        onComplete?.();
      }
    });
  }
}