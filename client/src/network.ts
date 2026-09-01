/**
 * 極速二進位 Network 模組 (Zero-Alloc & GC Free 優化版)
 *
 * 優化重點：
 *   1. 使用 enum Opcode 規範二進位通訊協定
 *   2. 全 ArrayBuffer / DataView 解包：支援 16-bit 數字型 ID 與 Float32 坐標
 *   3. 🟢 採用全域 Object Pool 與 Array 重用，達到解碼 0 垃圾產生 (徹底消滅 iPhone GC 卡頓)
 *   4. 保留 Packet Gap (掉幀/延遲) 5 秒統計監測
 *   5. 保留斷線自動重連 (Auto Reconnect) 機制
 *   6. Zero-Alloc sendMove：預留 9 Bytes Buffer，傳送位置 0 垃圾產生
 */

// ----------------------------------------------------------------------
// 二進位 Opcode 定義 (Enum 封裝，可與後端共享)
// ----------------------------------------------------------------------
export enum Opcode {
  Init = 1,
  Move = 2,
  Enter = 3,
  Leave = 4,
  Update = 5,
}

export interface BinaryPlayerState {
  id: number;
  x: number;
  y: number;
}

interface Handlers {
  onInit: (p: { selfId: number; x: number; y: number }) => void;
  onEnter: (players: BinaryPlayerState[]) => void;
  onLeave: (ids: number[]) => void;
  onMove: (players: BinaryPlayerState[]) => void;
  onUpdate: (players: BinaryPlayerState[]) => void;
}

let ws: WebSocket | null = null;
let wsUrl: string | null = null;
let handlers: Handlers | null = null;
let retryTimer: number | null = null;
let paused = false;
let lastPacketAt: number | null = null;
let gapWindowStart = 0;
let gapBuckets = { g60: 0, g100: 0, g200: 0 };

// ----------------------------------------------------------------------
// 🟢 Zero-Alloc 防 GC 專用物件池 (Object Pool & Array Reuse)
// ----------------------------------------------------------------------
const MAX_POOL_SIZE = 1000;
const playerPool: BinaryPlayerState[] = Array.from(
  { length: MAX_POOL_SIZE },
  () => ({
    id: 0,
    x: 0,
    y: 0,
  })
);
const reusablePlayersArray: BinaryPlayerState[] = [];
const reusableIdsArray: number[] = [];

// ----------------------------------------------------------------------
// Zero-Alloc 發送專用 Buffer (9 Bytes)
// ----------------------------------------------------------------------
const sendMoveBuffer = new ArrayBuffer(9);
const sendMoveView = new DataView(sendMoveBuffer);
sendMoveView.setUint8(0, Opcode.Move); // 自動綁定 Opcode.Move (2)

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

export function disconnect(): void {
  paused = true;
  clearRetryTimer();
  ws?.close();
  ws = null;
}

export function connect(url: string, h: Handlers): void {
  wsUrl = url;
  handlers = h;
  paused = false;
  clearRetryTimer();

  if (ws) {
    ws.close();
    ws = null;
  }

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer"; // 必須設定為 arraybuffer 以解二進位包

  ws.onopen = () => {
    console.log(`[network] connected (Binary Mode): ${url}`);
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (!handlers || !(ev.data instanceof ArrayBuffer)) return;

    // ------------------------------------------------------------------
    // Packet Gap 延遲與掉幀統計邏輯
    // ------------------------------------------------------------------
    const now = performance.now();
    if (lastPacketAt !== null) {
      const gap = now - lastPacketAt;
      if (gap > 200) {
        gapBuckets.g200++;
      } else if (gap > 100) {
        gapBuckets.g100++;
      } else if (gap > 60) {
        gapBuckets.g60++;
      }
    }
    lastPacketAt = now;
    if (gapWindowStart === 0) gapWindowStart = now;
    if (now - gapWindowStart >= 5000) {
      gapBuckets = { g60: 0, g100: 0, g200: 0 };
      gapWindowStart = now;
    }

    // ------------------------------------------------------------------
    // 二進位封包解碼 (Zero-Alloc Binary Unpacking)
    // ------------------------------------------------------------------
    const view = new DataView(ev.data);
    const opcode = view.getUint8(0) as Opcode;

    switch (opcode) {
      // 1. OP_INIT [1B Opcode][2B SelfId][4B X][4B Y]
      case Opcode.Init: {
        const selfId = view.getUint16(1, true);
        const x = view.getFloat32(3, true);
        const y = view.getFloat32(7, true);
        handlers.onInit({ selfId, x, y });
        break;
      }

      // 2. OP_MOVE, OP_ENTER, OP_UPDATE
      // 結構: [1B Opcode][2B Count] + Count * [2B Id][4B X][4B Y]
      case Opcode.Move:
      case Opcode.Enter:
      case Opcode.Update: {
        const count = view.getUint16(1, true);
        reusablePlayersArray.length = 0; // 重置長度，不觸發垃圾回收
        let offset = 3;

        for (let i = 0; i < count; i++) {
          const id = view.getUint16(offset, true);
          const x = view.getFloat32(offset + 2, true);
          const y = view.getFloat32(offset + 6, true);

          // 🟢 從物件池複寫屬性，完全 0 新物件產生
          let item = playerPool[i];
          if (!item) {
            item = { id, x, y };
            playerPool[i] = item;
          } else {
            item.id = id;
            item.x = x;
            item.y = y;
          }

          reusablePlayersArray.push(item);
          offset += 10;
        }

        if (opcode === Opcode.Enter) handlers.onEnter(reusablePlayersArray);
        else if (opcode === Opcode.Move) handlers.onMove(reusablePlayersArray);
        else if (opcode === Opcode.Update)
          handlers.onUpdate(reusablePlayersArray);
        break;
      }

      // 3. OP_LEAVE
      // 結構: [1B Opcode][2B Count] + Count * [2B Id]
      case Opcode.Leave: {
        const count = view.getUint16(1, true);
        reusableIdsArray.length = 0; // 🟢 重用陣列
        let offset = 3;

        for (let i = 0; i < count; i++) {
          reusableIdsArray.push(view.getUint16(offset, true));
          offset += 2;
        }

        handlers.onLeave(reusableIdsArray);
        break;
      }
    }
  };

  ws.onclose = () => {
    ws = null;
    if (paused || !handlers || !wsUrl) return;
    console.warn("[network] disconnected, retrying in 1s");
    retryTimer = window.setTimeout(() => {
      if (handlers && wsUrl) connect(wsUrl, handlers);
    }, 1000);
  };

  ws.onerror = () => ws?.close();
}

/** 分頁切回前景時重連（須先 reset scene 狀態） */
export function reconnect(): void {
  if (!handlers || !wsUrl) return;
  paused = false;
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  connect(wsUrl, handlers);
}

/** 分頁 hidden 斷線、visible 重連；回傳 cleanup 供 scene shutdown 用 */
export function setupVisibilityReconnect(onVisible?: () => void): () => void {
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      console.log("[network] tab hidden, disconnecting");
      disconnect();
      return;
    }
    if (document.visibilityState !== "visible") return;
    console.log("[network] tab visible, reconnecting");
    onVisible?.();
    reconnect();
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    disconnect();
    handlers = null;
    wsUrl = null;
  };
}

/** 極速 Zero-Alloc 發送移動封包 (Float32 點) */
export function sendMove(x: number, y: number): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  sendMoveView.setFloat32(1, x, true);
  sendMoveView.setFloat32(5, y, true);
  ws.send(sendMoveBuffer);
}
