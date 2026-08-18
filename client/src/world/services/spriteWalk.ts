import { WALK_ANIM_FRAMES, walkAnimKey } from '../constants/gameConfig';
import type { Direction } from '../types';

export function directionFromDelta(dx: number, dy: number): Direction {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // 斜走優先上下：只有水平明顯主導 (ax > ay*1.5) 才面向左右
  if (ax > ay * 1.5) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

export type ResolvedKeyboardAxes = {
  inputX: number;
  inputY: number;
  /** 堆疊最後一鍵，用於臉向／動畫 */
  facing: Direction;
};

/**
 * 從後按優先的 keyStack 解出水平／垂直軸（各軸獨立取堆疊中最近一次）與臉向。
 * 無有效位移時回傳 null。
 */
export function resolveKeyboardAxesFromKeyStack(keyStack: Direction[]): ResolvedKeyboardAxes | null {
  if (keyStack.length === 0) return null;

  let inputX = 0;
  let inputY = 0;

  for (let i = keyStack.length - 1; i >= 0; i--) {
    const key = keyStack[i];
    if (inputX === 0) {
      if (key === 'left') inputX = -1;
      if (key === 'right') inputX = 1;
    }
    if (inputY === 0) {
      if (key === 'up') inputY = -1;
      if (key === 'down') inputY = 1;
    }
    if (inputX !== 0 && inputY !== 0) break;
  }

  if (inputX === 0 && inputY === 0) return null;

  const facing = keyStack[keyStack.length - 1]!;
  return { inputX, inputY, facing };
}

/** 停步時顯示該向行走列的「站立幀」（start+1） */
export function setSpriteIdleStandFrame(sprite: Phaser.Physics.Arcade.Sprite, dx: number, dy: number): void {
  const dir = directionFromDelta(dx, dy);
  sprite.anims.stop();
  sprite.setFrame(WALK_ANIM_FRAMES[dir].start + 1);
}

/** 為多個 texture 各註冊一組四向 walk 動畫。 */
export function registerSpriteWalkAnimationsForKeys(scene: Phaser.Scene, textureKeys: readonly string[]): void {
  for (const textureKey of textureKeys) {
    registerSpriteWalkAnimations(scene, textureKey);
  }
}

/** 為指定 texture 註冊四向 walk 動畫（主角 animPrefix 傳 "" → walk-down） */
export function registerSpriteWalkAnimations(scene: Phaser.Scene, textureKey: string): void {
  const dirs: Direction[] = ['down', 'left', 'right', 'up'];
  for (const dir of dirs) {
    const key = walkAnimKey(textureKey, dir);
    if (scene.anims.exists(key)) scene.anims.remove(key);
    const range = WALK_ANIM_FRAMES[dir];
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(textureKey, {
        start: range.start,
        end: range.end
      }),
      frameRate: 8,
      repeat: -1
    });
  }
}