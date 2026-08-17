import Phaser from 'phaser';

/**
 * 對應 `public/assets/world/home/map-objects/*.png` 的 Phaser texture key（檔名不含副檔名）。
 * 新增／刪除圖檔時請同步更新此陣列。
 */
export const WORLD_HOME_TEXTURE_KEYS = [
  'map01', '01', '01_tv', '02', '02_tv', '03', '03_tv', '04', '04_tv',
  'bonsai1', 'bonsai2', 'decorate', 'desk', 'dish', 'fg', 'grass',
  'i', 'LINE', 'logo', 'map', 'wall'
] as const;
export type WorldHomeTextureKey = (typeof WORLD_HOME_TEXTURE_KEYS)[number];

/** Tiled GroundLayer 物件 `name` → 已載入的 texture key。 */
export function resolveHomeMapTextureKey(scene: Phaser.Scene, objectName: string | undefined): string | null {
  const name = objectName?.trim() ?? '';
  if (!name) return null;
  if ((WORLD_HOME_TEXTURE_KEYS as readonly string[]).includes(name) && scene.textures.exists(name)) {
    return name;
  }
  return null;
}