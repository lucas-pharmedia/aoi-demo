import Phaser from 'phaser';
import type { PhaserNavMesh } from 'phaser-navmesh';
import type PhaserNavMeshPlugin from 'phaser-navmesh';
import {
  HOME_TILE_MAP_KEY,
  MAP_LAYERS,
  NAV_MESH_DEBUG
} from '../constants/mapConfig';
import { resolveHomeMapTextureKey } from '../constants/homeMapTextureKeys';
import type { Point, TiledCustomProperty } from '../types';

type SceneWithNavPlugin = Phaser.Scene & {
  navMeshPlugin: PhaserNavMeshPlugin;
};

type NavMeshPluginWithRemoval = PhaserNavMeshPlugin & {
  removeMesh?: (meshKey: string) => void;
};

/** Tiled 底圖物件所在 layer（不含於 {@link MAP_LAYERS} 以免與障礙邏輯混淆） */
const DEFAULT_GROUND_OBJECT_LAYER_NAME = 'GroundLayer';

/** 底圖必須畫在 POI 之下；勿用 Tiled 的 y 當 depth（會蓋住前景）。 */
const GROUND_MAP_IMAGE_DEPTH = -10_000;

export type MapManagerTextureResolver = (scene: Phaser.Scene, objectName: string | undefined) => string | null;

export type MapManagerInitOptions = {
  tilemapJsonKey: string;
  resolveMapTextureKey: MapManagerTextureResolver;
  /** 底圖 gid 物件所在 object layer 名稱（預設 `GroundLayer`） */
  groundObjectLayerName?: string;
};

const WORLD_HOME_DEFAULT_MAP_INIT: MapManagerInitOptions = {
  tilemapJsonKey: HOME_TILE_MAP_KEY,
  resolveMapTextureKey: resolveHomeMapTextureKey,
  groundObjectLayerName: DEFAULT_GROUND_OBJECT_LAYER_NAME
};

export class MapManager {
  private static readonly NAV_MESH_KEY_PREFIX = 'worldNavMesh';
  map!: Phaser.Tilemaps.Tilemap;
  navMesh!: PhaserNavMesh | undefined;
  private resolveMapTextureKey!: MapManagerTextureResolver;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly mapInitOptions?: Partial<MapManagerInitOptions>
  ) {}

  init(): void {
    const opts: MapManagerInitOptions = { ...WORLD_HOME_DEFAULT_MAP_INIT, ...this.mapInitOptions };
    this.resolveMapTextureKey = opts.resolveMapTextureKey;
    const groundLayerName = opts.groundObjectLayerName ?? DEFAULT_GROUND_OBJECT_LAYER_NAME;

    const map = this.scene.make.tilemap({ key: opts.tilemapJsonKey });
    this.map = map;

    this.createMapViewImagesFromObjectLayer(groundLayerName, {
      fixedDepth: GROUND_MAP_IMAGE_DEPTH
    });
    this.createMapViewImagesFromObjectLayer(MAP_LAYERS.obstacles);

    const navMeshLayer = map.getObjectLayer(MAP_LAYERS.navMesh);
    this.navMesh = undefined;

    if (navMeshLayer) {
      const plugin = (this.scene as SceneWithNavPlugin).navMeshPlugin as NavMeshPluginWithRemoval;
      const navMeshKey = `${MapManager.NAV_MESH_KEY_PREFIX}:${this.scene.scene.key}`;
      plugin.removeMesh?.(navMeshKey);
      this.navMesh = plugin.buildMeshFromTiled(navMeshKey, navMeshLayer, 12);

      this.scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        plugin.removeMesh?.(navMeshKey);
        this.destroy();
      });

      if (NAV_MESH_DEBUG) {
        this.navMesh.enableDebug(this.scene.add.graphics());
        this.navMesh.debugDrawMesh({
          drawCentroid: true,
          drawBounds: false,
          drawNeighbors: true,
          drawPortals: true
        });
      }
    }
  }

  private createMapViewImagesFromObjectLayer(
    layerName: string,
    options?: { alpha?: number; fixedDepth?: number }
  ): void {
    const layer = this.map.getObjectLayer(layerName);
    if (!layer) return;

    for (const obj of layer.objects) {
      if (obj.visible === false) continue;
      if (obj.gid === undefined) continue;
      const textureKey = this.resolveMapTextureKey(this.scene, obj.name);
      if (!textureKey) continue;

      const w = obj.width ?? 0;
      const h = obj.height ?? 0;
      if (w <= 0 || h <= 0) continue;

      const x = obj.x ?? 0;
      const yBottom = obj.y ?? 0;
      const cx = x + w / 2;
      const cy = yBottom - h / 2;

      const img = this.scene.add.image(cx, cy, textureKey);
      img.setDisplaySize(w, h);
      if (options?.alpha !== undefined) {
        img.setAlpha(options.alpha);
      }

      if (options?.fixedDepth !== undefined) {
        img.setDepth(options.fixedDepth);
      } else {
        img.setDepth(yBottom);
      }
    }
  }

  /** 世界座標命中 ObstaclesLayer 物件（陣列後段優先，等同較後繪製者在上層）。 */
  findObstacleObjectAtWorld(worldX: number, worldY: number): Phaser.Types.Tilemaps.TiledObject | null {
    const layer = this.map.getObjectLayer(MAP_LAYERS.obstacles);
    if (!layer) return null;
    const objects = layer.objects;
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i]!;
      if (obj.visible === false) continue;
      if (obj.polyline || obj.polygon) continue;
      // 前景整張圖（fg）會吃掉所有點擊，跳過
      if (obj.name === 'fg') continue;
      const rect = MapManager.getTiledObjectWorldHitRect(obj);
      if (rect && Phaser.Geom.Rectangle.Contains(rect, worldX, worldY)) return obj;
    }
    return null;
  }

  getCustomPropertyValue(obj: Phaser.Types.Tilemaps.TiledObject, propertyName: string): unknown {
    return obj.properties?.find((p: TiledCustomProperty) => p.name === propertyName)?.value;
  }

  /** 有 gid 時 (x,y) 為左下，否則為左上。 */
  static getTiledObjectWorldHitRect(obj: Phaser.Types.Tilemaps.TiledObject): Phaser.Geom.Rectangle | null {
    const x = obj.x ?? 0;
    const y = obj.y ?? 0;
    const w = obj.width ?? 0;
    const h = obj.height ?? 0;
    if (w <= 0 || h <= 0) return null;
    if (obj.gid !== undefined) {
      return new Phaser.Geom.Rectangle(x, y - h, w, h);
    }
    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  /** 走向障礙物：外接矩形底邊中心往上縮 12px（等同 navmesh shrink），確保落在可行走帶。 */
  getObstacleApproachPoint(obj: Phaser.Types.Tilemaps.TiledObject): Point {
    const r = MapManager.getTiledObjectWorldHitRect(obj);
    if (!r) return { x: obj.x ?? 0, y: obj.y ?? 0 };
    return { x: r.centerX, y: r.bottom - 12 };
  }

  destroy(): void {
    this.map?.destroy();
    this.navMesh = undefined;
  }
}