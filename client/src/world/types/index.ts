import type Phaser from 'phaser';
import type { MapManager } from '../managers/MapManager';
import type { PlayerManager } from '../managers/PlayerManager';

export type Direction = 'down' | 'left' | 'right' | 'up';

export type Point = { x: number; y: number };

export type FrameRange = { start: number; end: number };
export type SpriteWalkFrames = Record<Direction, FrameRange>;

export interface TiledCustomProperty {
  name: string;
  type: string;
  value: unknown;
}

/** 世界探索區（有 Tilemap + NavMesh + 玩家）場景共用介面。 */
export interface WorldPlayfieldScene extends Phaser.Scene {
  mapManager: MapManager;
  playerManager: PlayerManager | null;
}