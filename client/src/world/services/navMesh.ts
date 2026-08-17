import type { PhaserNavMesh } from 'phaser-navmesh';
import { WALK_ANIM_FRAMES, walkAnimKey } from '../constants/gameConfig';
import { MAP_LAYERS } from '../constants/mapConfig';
import { Character } from '../entities/Character';
import { directionFromDelta, setSpriteIdleStandFrame } from './spriteWalk';
import type { Point } from '../types';

export type NavPoint = { x: number; y: number };

/** 從 start 到 end 的 navmesh 轉角點（不含貼腳重疊的第一點） */
export function computeNavWaypoints(
  navMesh: PhaserNavMesh | null | undefined,
  start: NavPoint,
  end: NavPoint
): NavPoint[] | null {
  if (!navMesh || !navMesh.isPointInMesh({ x: end.x, y: end.y })) return null;

  const path = navMesh.findPath(start, end);
  if (!path || path.length < 2) return null;

  const waypoints: NavPoint[] = [];
  for (const p of path) {
    const wp = { x: p.x, y: p.y };
    if (waypoints.length === 0 && Phaser.Math.Distance.Between(start.x, start.y, wp.x, wp.y) < 4) {
      continue;
    }
    waypoints.push(wp);
  }
  return waypoints.length ? waypoints : null;
}

/**
 * 從 object layer 隨機選一個帶 width/height 的矩形，在其範圍內取一點
 */
export function getRandomPointInNavMeshLayer(map: Phaser.Tilemaps.Tilemap): NavPoint {
  const layer = map.getObjectLayer(MAP_LAYERS.navMesh);
  if (!layer?.objects?.length) return { x: 0, y: 0 };

  const rects = layer.objects.filter(
    (
      o
    ): o is Phaser.Types.Tilemaps.TiledObject & {
      width: number;
      height: number;
    } => typeof o.width === 'number' && typeof o.height === 'number' && o.width > 0 && o.height > 0
  );
  if (rects.length === 0) return { x: 0, y: 0 };

  const obj = Phaser.Utils.Array.GetRandom(rects);
  const bx = obj.x ?? 0;
  const by = obj.y ?? 0;
  const w = obj.width;
  const h = obj.height;

  return {
    x: bx + Phaser.Math.FloatBetween(0, w),
    y: by + Phaser.Math.FloatBetween(0, h)
  };
}

/**
 * 依 navmesh 轉角點用 tween 移動 sprite（等速）；完成後設待機幀。
 * @returns 是否成功開始一段路徑 tween
 */
export function tweenSpriteAlongNavmeshPath(options: {
  character: Character;
  navMesh: PhaserNavMesh | undefined;
  target: Point;
  speed: number;
  textureKey: string;
  onComplete?: () => void;
}): boolean {
  const { character, navMesh, target, speed, textureKey, onComplete } = options;
  const sprite = character.sprite;
  const scene = sprite.scene;
  scene.tweens.killTweensOf(sprite);

  const start = { x: sprite.x, y: sprite.y };
  const waypoints = computeNavWaypoints(navMesh, start, target);
  if (!waypoints || waypoints.length === 0) {
    const currentDirection = character.direction;
    sprite.anims.stop();
    if (currentDirection) {
      sprite.setFrame(WALK_ANIM_FRAMES[currentDirection]?.start + 1);
    }
    onComplete?.();
    return false;
  }

  const tweens: Phaser.Types.Tweens.TweenBuilderConfig[] = [];
  let fromX = sprite.x;
  let fromY = sprite.y;
  let lastDx = 0;
  let lastDy = 1;
  for (const pt of waypoints) {
    const dist = Phaser.Math.Distance.Between(fromX, fromY, pt.x, pt.y);
    if (dist < 2) continue;

    const duration = Math.max(50, (dist / speed) * 1000);
    const dx = pt.x - fromX;
    const dy = pt.y - fromY;
    lastDx = dx;
    lastDy = dy;
    const direction = directionFromDelta(dx, dy);
    const animKey = walkAnimKey(textureKey, direction);

    tweens.push({
      targets: sprite,
      x: pt.x,
      y: pt.y,
      duration,
      ease: 'Linear',
      onStart: () => {
        character.direction = direction;
        sprite.play(animKey, sprite.anims.currentAnim?.key === animKey);
      }
    });

    fromX = pt.x;
    fromY = pt.y;
  }

  if (tweens.length === 0) {
    onComplete?.();
    return false;
  }

  const last = tweens[tweens.length - 1]!;
  last.onComplete = () => {
    setSpriteIdleStandFrame(sprite, lastDx, lastDy);
    onComplete?.();
  };

  scene.tweens.chain({
    targets: sprite,
    tweens
  });
  return true;
}