/**
 * 九宮格 (AOI) 空間分割工具 — client / server 共用 (極速數字 ID 版)
 */

export const MAP_WIDTH = 5056;
export const MAP_HEIGHT = 3360;

// 調整為合理的網格密度 (單格約 316x336 px)
export const GRID_COLS = 8;
export const GRID_ROWS = 5;
export const GRID_WIDTH = MAP_WIDTH / GRID_COLS;
export const GRID_HEIGHT = MAP_HEIGHT / GRID_ROWS;

/**
 * 把像素座標轉換成 1D 網格數字 ID (0 ~ GRID_COLS * GRID_ROWS - 1)
 */
export function toGrid(x: number, y: number): number {
  const gx = Math.min(Math.floor(x / GRID_WIDTH), GRID_COLS - 1);
  const gy = Math.min(Math.floor(y / GRID_HEIGHT), GRID_ROWS - 1);
  return gy * GRID_COLS + gx; // 回傳數字 Index，完全避開字串物件產生
}

// 預先計算好每個 Grid ID 的周圍九宮格 ID，避免執行期重複運算與 Alloc 陣列
const SURROUNDING_CACHE: number[][] = new Array(GRID_COLS * GRID_ROWS);

for (let gy = 0; gy < GRID_ROWS; gy++) {
  for (let gx = 0; gx < GRID_COLS; gx++) {
    const id = gy * GRID_COLS + gx;
    const list: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx >= 0 && nx < GRID_COLS && ny >= 0 && ny < GRID_ROWS) {
          list.push(ny * GRID_COLS + nx);
        }
      }
    }
    SURROUNDING_CACHE[id] = list;
  }
}

/**
 * 直接取得九宮格 ID 陣列
 */
export function getSurroundingGridIds(gridId: number): number[] {
  return SURROUNDING_CACHE[gridId];
}
