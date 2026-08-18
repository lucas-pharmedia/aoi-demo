import type { Direction } from "../types";

/** Phaser `Text` 共用的 `fontFamily`（繁中優先）。 */
export const GAME_UI_FONT_FAMILY = "Cubic";

export const PLAYER_SPEED = 400;
export const PLAYER_SPRITE_TEXTURE_KEY = "player-sprite";
export const CHARACTER_SPRITE_SCALE = 2;

/** 世界區玩家行走圖共用的單格尺寸（畫素），須與實際 PNG 格線一致。 */
export const WORLD_CHARACTER_SHEET_FRAME = {
  frameWidth: 128,
  frameHeight: 128,
} as const;

/** 站立閒置時以 scaleY 正弦起伏模擬呼吸（錨點在腳底，視覺為上下微幅縮放） */
export const IDLE_BREATH = {
  angularSpeed: Math.PI * 1.15,
  scaleYAmplitude: 0.01,
} as const;

export const PLAYER_CAMERA_FOLLOW_LERP = { x: 0.1, y: 0.1 } as const;
export const PLAYER_CAMERA_ZOOM = 0.3;

export function walkAnimKey(textureKey: string, dir: Direction): string {
  return `${textureKey}-walk-${dir}`;
}

/** 行走動畫 key 與幀（單一來源，供鍵盤移動與點地行走共用） */
export const WALK_ANIM_FRAMES: Record<
  Direction,
  { start: number; end: number }
> = {
  down: { start: 0, end: 2 },
  left: { start: 4, end: 6 },
  right: { start: 8, end: 10 },
  up: { start: 12, end: 14 },
} as const;

export const GAME_DESIGN_SIZE = { width: 1920, height: 1080 } as const;

export const WALK_BY_CLICK_ENABLED = true;
