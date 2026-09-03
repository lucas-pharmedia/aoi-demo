/**
 * Server 執行期設定（環境變數 + fallback）
 */

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid env ${key}=${raw}`);
  }
  return n;
}

export const MAP_WIDTH = envNumber("MAP_WIDTH", 5056);
export const MAP_HEIGHT = envNumber("MAP_HEIGHT", 3360);
export const GRID_COLS = envNumber("GRID_COLS", 8);
export const GRID_ROWS = envNumber("GRID_ROWS", 5);
export const GRID_WIDTH = MAP_WIDTH / GRID_COLS;
export const GRID_HEIGHT = MAP_HEIGHT / GRID_ROWS;

export const TICK_RATE = envNumber("TICK_RATE", 3);
export const TICK_MS = 1000 / TICK_RATE;
export const MAX_AOI_CAP = envNumber("MAX_AOI_CAP", 100);
