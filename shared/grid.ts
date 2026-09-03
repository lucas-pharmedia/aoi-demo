/**
 * 地圖 / 網格常數 — client 用（server 改由環境變數）
 */

export const MAP_WIDTH = 5056;
export const MAP_HEIGHT = 3360;

// 調整為合理的網格密度 (單格約 316x336 px)
export const GRID_COLS = 8;
export const GRID_ROWS = 5;
export const GRID_WIDTH = MAP_WIDTH / GRID_COLS;
export const GRID_HEIGHT = MAP_HEIGHT / GRID_ROWS;
