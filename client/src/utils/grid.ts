/**
 * 九宮格 (AOI) 空間分割 — client 版（常數來自 shared/grid）
 */

import {
  GRID_COLS,
  GRID_ROWS,
  GRID_WIDTH,
  GRID_HEIGHT,
} from "../../../shared/grid.ts";

/**
 * 把像素座標轉換成 1D 網格數字 ID (0 ~ GRID_COLS * GRID_ROWS - 1)
 */
export function toGrid(x: number, y: number): number {
  const gx = Math.min(Math.floor(x / GRID_WIDTH), GRID_COLS - 1);
  const gy = Math.min(Math.floor(y / GRID_HEIGHT), GRID_ROWS - 1);
  return gy * GRID_COLS + gx;
}

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

/** 直接取得九宮格 ID 陣列 */
export function getSurroundingGridIds(gridId: number): number[] {
  return SURROUNDING_CACHE[gridId];
}
