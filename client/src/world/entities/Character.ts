import { CHARACTER_SPRITE_SCALE, IDLE_BREATH, WALK_ANIM_FRAMES } from '../constants/gameConfig';
import { getRandomPointInNavMeshLayer, tweenSpriteAlongNavmeshPath } from '../services/navMesh';
import type { Direction, Point, WorldPlayfieldScene } from '../types';

/**
 * 角色 spritesheet 每幀底部透明留白（來源圖像座標系）。
 * - 調大：腳底錨點往上、碰撞框同步往上
 * - 調小：腳底錨點往下
 */
const CHARACTER_FOOT_BOTTOM_PADDING_PX = 14;

type CharacterOptions = {
  textureKey: string;
  walkSpeed: number;
  scene: WorldPlayfieldScene;
  sprite: Phaser.Physics.Arcade.Sprite;
};
/**
 * 玩家與 NPC 共用的移動／深度排序邏輯。
 * 子類別以各自的 `static create` 建立 sprite 後呼叫建構式。
 */
export abstract class Character {
  readonly sprite: Phaser.Physics.Arcade.Sprite;
  private walkSpeed: number;
  private textureKey: string;
  private scene: WorldPlayfieldScene;
  public direction: Direction = 'down';
  private breathPhase = Phaser.Math.FloatBetween(0, Math.PI * 2);
  protected baseScale: number = CHARACTER_SPRITE_SCALE;

  protected constructor(options: CharacterOptions) {
    this.scene = options.scene;
    this.sprite = options.sprite;
    this.textureKey = options.textureKey;
    this.walkSpeed = options.walkSpeed;
  }

  protected getTextureKey(): string {
    return this.textureKey;
  }

  /** 預設：依 y 排序。子類別可 `override`（例如飛行中不改 depth）。 */
  tick(): void {
    if (!this.sprite.active) return;
    this.sprite.setDepth(this.sprite.y);
    this.updateIdleBreath(this.scene.game.loop.delta);
  }

  /** 子類別決定是否在站立閒置時套用呼吸縮放（預設關閉）。 */
  protected shouldApplyIdleBreath(): boolean {
    return false;
  }

  private updateIdleBreath(deltaMs: number): void {
    const base = this.baseScale;
    if (!this.shouldApplyIdleBreath()) {
      this.sprite.setScale(base);
      return;
    }
    const dt = deltaMs / 1000;
    this.breathPhase += IDLE_BREATH.angularSpeed * dt;
    const wobble = Math.sin(this.breathPhase) * IDLE_BREATH.scaleYAmplitude;
    this.sprite.setScale(base, base * (1 + wobble));
  }

  setIdleFrame() {
    this.sprite.anims.stop();
    this.sprite.setFrame(WALK_ANIM_FRAMES[this.direction].start + 1);
  }

  walkToPoint(options: { target: Point; onComplete?: () => void }): void {
    const { navMesh } = this.scene.mapManager;
    const { target, onComplete } = options;
    if (!navMesh) return;
    tweenSpriteAlongNavmeshPath({
      character: this,
      navMesh,
      target,
      speed: this.walkSpeed,
      textureKey: this.textureKey,
      onComplete: () => {
        onComplete?.();
      }
    });
  }

  /** 供子類別 `static create` 使用：確認圖集已載入。 */
  protected static assertTextureExists(scene: Phaser.Scene, textureKey: string): boolean {
    if (scene.textures.exists(textureKey)) return true;
    console.error(`${textureKey}：圖集不存在`);
    return false;
  }

  /** 建立已縮放的 Arcade sprite；圖集不存在時回傳 null。 */
  protected static createScaledArcadeSprite(
    scene: WorldPlayfieldScene,
    spawnPoint: Point,
    textureKey: string
  ): Phaser.Physics.Arcade.Sprite | null {
    if (!Character.assertTextureExists(scene, textureKey)) return null;
    const sprite = scene.physics.add.sprite(spawnPoint.x, spawnPoint.y, textureKey);
    sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    sprite.setScale(CHARACTER_SPRITE_SCALE);
    const bodyW = 20;
    const bodyH = 3;
    sprite.setBodySize(bodyW, bodyH);
    sprite.setOffset((sprite.width - bodyW) / 2, sprite.height - bodyH - CHARACTER_FOOT_BOTTOM_PADDING_PX);
    return sprite;
  }

  /** 出生後共用的待機幀與碰撞 body（玩家／NPC 相同）。 */
  protected static applyOrigin(character: Character): void {
    const { height } = character.sprite;
    const originY = height > 0 ? (height - CHARACTER_FOOT_BOTTOM_PADDING_PX) / height : 1;
    character.sprite.setOrigin(0.5, Phaser.Math.Clamp(originY, 0, 1));
  }
}