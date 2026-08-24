/**
 * 九宮格 (AOI) 空間分割工具 — client / server 共用
 *
 * 地圖被切成固定大小的格子 (Grid)，每個玩家屬於一個格子。
 * AOI 視野 = 玩家所在格 + 周圍相鄰 8 格（最多 9 格）。
 * 只把位於這些格子內的玩家資訊傳給該玩家，減少無關的網路流量。
 */

/** 地圖寬度 (px)：158 tile × 32px */
export const MAP_WIDTH = 5056;
/** 地圖高度 (px)：105 tile × 32px */
export const MAP_HEIGHT = 3360;
/** X 軸格子數 */
export const GRID_COLS = 8;
/** Y 軸格子數 */
export const GRID_ROWS = 5;
/** 單一 Grid 寬度 (px) */
export const GRID_WIDTH = MAP_WIDTH / GRID_COLS;
/** 單一 Grid 高度 (px) */
export const GRID_HEIGHT = MAP_HEIGHT / GRID_ROWS;

/** 座標換算後的網格座標 */
export interface GridCoord {
  gx: number;
  gy: number;
}

/**
 * 把像素座標轉換成網格座標。
 * floor 取得該座標落在第幾格，再 clamp 到合法範圍 (0 ~ GRID_COLS-1)。
 */
export function toGrid(x: number, y: number): GridCoord {
  const gx = Math.min(Math.floor(x / GRID_WIDTH), GRID_COLS - 1);
  const gy = Math.min(Math.floor(y / GRID_HEIGHT), GRID_ROWS - 1);
  return { gx, gy };
}

/**
 * 網格座標轉成字串 Key，例：(1,2) -> "1_2"。
 * 用字串當 Map key，方便快速查找 / 比對。
 */
export function gridKey(gx: number, gy: number): string {
  return `${gx}_${gy}`;
}

/**
 * 回傳某格的中心格 + 相鄰 8 格的 gridKey 清單（含自己，最多 9 格）。
 * 邊界格子會被裁掉（例如 gx=0 沒有左邊的格子）。
 * 這就是該玩家的 AOI 視野範圍。
 */
export function getSurroundingGridKeys(gx: number, gy: number): string[] {
  const keys: string[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx >= 0 && nx < GRID_COLS && ny >= 0 && ny < GRID_ROWS) {
        keys.push(gridKey(nx, ny));
      }
    }
  }
  return keys;
}

/**
 * 從候選清單選出離 (px, py) 最近的 cap 個玩家。
 * 用插入式部分排序（維持長度 cap 的有序陣列），避免全量 sort。
 * 用平方距離避免 Math.hypot 的開根號成本。
 */
export function nearest<T extends { id: string; x: number; y: number }>(
  px: number,
  py: number,
  items: T[],
  cap: number
): T[] {
  if (items.length <= cap) return items;
  const keep: { item: T; d: number }[] = [];
  for (const item of items) {
    const d = (item.x - px) ** 2 + (item.y - py) ** 2;
    let i = 0;
    while (i < keep.length && keep[i].d <= d) i++;
    keep.splice(i, 0, { item, d });
    if (keep.length > cap) keep.pop();
  }
  return keep.map((k) => k.item);
}
