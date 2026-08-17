/**
 * 九宮格 (AOI) 空間分割工具
 *
 * 地圖被切成固定大小的格子 (Grid)，每個玩家屬於一個格子。
 * AOI 視野 = 玩家所在格 + 周圍相鄰 8 格（最多 9 格）。
 * 只把位於這些格子內的玩家資訊傳給該玩家，減少無關的網路流量。
 */

/** 地圖寬度 (px)：158 tile × 32px */
export const MAP_WIDTH = 5056;
/** 地圖高度 (px)：105 tile × 32px */
export const MAP_HEIGHT = 3360;
/** 單一 Grid 寬度 (px)：約 19.75 tile × 32px（8×3 格網） */
export const GRID_WIDTH = 632;
/** 單一 Grid 高度 (px)：35 tile × 32px（8×3 格網） */
export const GRID_HEIGHT = 1120;
/** X 軸格子數：5056/632 = 8 格 (0~7) */
export const GRID_COLS = 8;
/** Y 軸格子數：3360/1120 = 3 格 (0~2) */
export const GRID_ROWS = 3;

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
