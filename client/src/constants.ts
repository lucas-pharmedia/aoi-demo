export const MAP_WIDTH = 5056;
export const MAP_HEIGHT = 3360;
export const GRID_WIDTH = 632;
export const GRID_HEIGHT = 1120;
export const GRID_COLS = 8;
export const GRID_ROWS = 3;

export interface GridCoord {
  gx: number;
  gy: number;
}

export function toGrid(x: number, y: number): GridCoord {
  const gx = Math.min(Math.floor(x / GRID_WIDTH), GRID_COLS - 1);
  const gy = Math.min(Math.floor(y / GRID_HEIGHT), GRID_ROWS - 1);
  return { gx, gy };
}

export function gridKey(gx: number, gy: number): string {
  return `${gx}_${gy}`;
}

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
