declare module 'phaser-navmesh' {
  import Phaser from 'phaser';

  export interface Point {
    x: number;
    y: number;
  }

  export class PhaserNavMesh {
    isPointInMesh(point: Point): boolean;
    findPath(
      startPoint: Point,
      endPoint: Point,
    ): Phaser.Geom.Point[] | null;
    enableDebug(graphics: Phaser.GameObjects.Graphics): Phaser.GameObjects.Graphics | null;
    disableDebug(): void;
    isDebugEnabled(): boolean | null;
    debugDrawMesh(options?: {
      drawCentroid?: boolean;
      drawBounds?: boolean;
      drawNeighbors?: boolean;
      drawPortals?: boolean;
      palette?: number[];
    }): void;
    debugDrawPath(path: Point[], color?: number, thickness?: number, alpha?: number): void;
    destroy(): void;
  }

  export default class PhaserNavMeshPlugin extends Phaser.Plugins.ScenePlugin {
    buildMeshFromTiled(
      key: string,
      objectLayer: Phaser.Tilemaps.ObjectLayer,
      meshShrinkAmount?: number,
    ): PhaserNavMesh;
    buildMeshFromTilemap(
      key: string,
      tilemap: Phaser.Tilemaps.Tilemap,
      tilemapLayers?: Phaser.Tilemaps.TilemapLayer[],
      isWalkable?: (tile: Phaser.Tilemaps.Tile) => boolean,
      shrinkAmount?: number,
    ): PhaserNavMesh;
    removeMesh(key: string): void;
    removeAllMeshes(): void;
  }
}