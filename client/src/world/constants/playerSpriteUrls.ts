/**
 * 臨時測試：造型 ID → spritesheet URL（自 .temp/sprites-urls.ts 複製，勿從 .temp import）
 * 連線 `?player=1` ~ `?player=10` 對應此表。Enter 時再動態載入。
 */
export const PLAYER_SPRITE_URLS: Record<number, string> = {
  1: "https://pj-sat-knowledge-2026-summit-prod.s3.ap-east-2.amazonaws.com/summit/kiosk/sessions/o6BL9hd1QW7U/sprite/1785823309674.png",
  2: "https://pj-sat-knowledge-2026-summit-prod.s3.ap-east-2.amazonaws.com/summit/kiosk/sessions/gE2H1UolgDzP/sprite/1785822972970.png",
  3: "https://pj-sat-knowledge-2026-summit-prod.s3.ap-east-2.amazonaws.com/summit/kiosk/sessions/TOyqRDgL8myN/sprite/1784366217323.png",
  4: "https://pj-sat-knowledge-2026-summit-prod.s3.ap-east-2.amazonaws.com/summit/kiosk/sessions/7SJpbe9WADYq/sprite/1784366177623.png",
  5: "https://pj-sat-knowledge-2026-summit-prod.s3.ap-east-2.amazonaws.com/summit/kiosk/sessions/X2Vl9nxXVR4a/sprite/1784366114661.png",
  6: "https://pj-sat-knowledge-2026-summit-prod.s3.ap-east-2.amazonaws.com/summit/kiosk/sessions/dHYj7aGzHL66/sprite/1784366097651.png",
  7: "https://pj-sat-knowledge-2026-summit-prod.s3.ap-east-2.amazonaws.com/summit/kiosk/sessions/HuRsSC3clqXZ/sprite/1784366092022.png",
  8: "https://pj-sat-knowledge-2026-summit-prod.s3.ap-east-2.amazonaws.com/summit/kiosk/sessions/4cIlrKWWDPMy/sprite/1784366009162.png",
  9: "https://pj-sat-knowledge-2026-summit-prod.s3.ap-east-2.amazonaws.com/summit/kiosk/sessions/vxH4QezbxCZJ/sprite/1784365993910.png",
  10: "https://pj-sat-knowledge-2026-summit-prod.s3.ap-east-2.amazonaws.com/summit/kiosk/sessions/FTCaFKDcWdy8/sprite/1784365912330.png",
};

/** Phaser texture key：`player-sprite-1` … */
export function playerSpriteTextureKey(playerId: number): string {
  return `player-sprite-${playerId}`;
}

/** 有對應 URL 用遠端圖，否則退回本地預設 sheet */
export function resolvePlayerSpriteTextureKey(
  playerId: number,
  fallbackKey: string
): string {
  return PLAYER_SPRITE_URLS[playerId]
    ? playerSpriteTextureKey(playerId)
    : fallbackKey;
}

export function getPlayerSpriteUrl(playerId: number): string | undefined {
  return PLAYER_SPRITE_URLS[playerId];
}
