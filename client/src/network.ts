/**
 * 極速二進位 Network 模組
 *
 * 優化重點：
 *   1. 全 ArrayBuffer / DataView 解包：支援 16-bit 數字型 ID 與 Float32 坐標
 *   2. 保留 Packet Gap (掉幀/延遲) 5 秒統計監測
 *   3. 保留斷線自動重連 (Auto Reconnect) 機制
 *   4. Zero-Alloc sendMove：預留 9 Bytes Buffer，傳送位置 0 垃圾產生
 */

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
let handlers: Handlers | null = null;
let retryTimer: number | null = null;
let lastPacketAt: number | null = null;
let gapWindowStart = 0;
let gapBuckets = { g60: 0, g100: 0, g200: 0 };

// ----------------------------------------------------------------------
// Zero-Alloc 發送專用 Buffer (9 Bytes)
// ----------------------------------------------------------------------
const sendMoveBuffer = new ArrayBuffer(9);
const sendMoveView = new DataView(sendMoveBuffer);
sendMoveView.setUint8(0, 2); // Opcode 2 = Move

export function connect(url: string, h: Handlers): void {
  handlers = h;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer"; // 必須設定為 arraybuffer 以解二進位包

  ws.onopen = () => {
    console.log(`[network] connected (Binary Mode): ${url}`);
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (!handlers || !(ev.data instanceof ArrayBuffer)) return;

    // ------------------------------------------------------------------
    // Packet Gap 延遲與掉幀統計邏輯 (保留原功能)
    // ------------------------------------------------------------------
    const now = performance.now();
    if (lastPacketAt !== null) {
      const gap = now - lastPacketAt;
      if (gap > 200) {
        gapBuckets.g200++;
        console.log(`[PACKET] gap ${gap.toFixed(0)}ms`);
      } else if (gap > 100) {
        gapBuckets.g100++;
      } else if (gap > 60) {
        gapBuckets.g60++;
      }
    }
    lastPacketAt = now;
    if (gapWindowStart === 0) gapWindowStart = now;
    if (now - gapWindowStart >= 5000) {
      console.log(
        `[PACKET] 5s 摘要 60-100=${gapBuckets.g60} 100-200=${gapBuckets.g100} >200=${gapBuckets.g200}`
      );
      gapBuckets = { g60: 0, g100: 0, g200: 0 };
      gapWindowStart = now;
    }

    // ------------------------------------------------------------------
    // 二進位封包解碼 (Binary Unpacking)
    // ------------------------------------------------------------------
    const view = new DataView(ev.data);
    const opcode = view.getUint8(0);

    // 1. OP_INIT [1B Opcode][2B SelfId][4B X][4B Y]
    if (opcode === 1) {
      const selfId = view.getUint16(1, true);
      const x = view.getFloat32(3, true);
      const y = view.getFloat32(7, true);
      handlers.onInit({ selfId, x, y });
      return;
    }

    // 2. OP_MOVE (2), OP_ENTER (3), OP_UPDATE (5)
    // 結構: [1B Opcode][2B Count] + Count * [2B Id][4B X][4B Y]
    if (opcode === 2 || opcode === 3 || opcode === 5) {
      const count = view.getUint16(1, true);
      const players: BinaryPlayerState[] = [];
      let offset = 3;

      for (let i = 0; i < count; i++) {
        const id = view.getUint16(offset, true);
        const x = view.getFloat32(offset + 2, true);
        const y = view.getFloat32(offset + 6, true);
        players.push({ id, x, y });
        offset += 10;
      }

      if (opcode === 3) handlers.onEnter(players);
      else if (opcode === 2) handlers.onMove(players);
      else if (opcode === 5) handlers.onUpdate(players);
      return;
    }

    // 3. OP_LEAVE (4)
    // 結構: [1B Opcode][2B Count] + Count * [2B Id]
    if (opcode === 4) {
      const count = view.getUint16(1, true);
      const ids: number[] = [];
      let offset = 3;

      for (let i = 0; i < count; i++) {
        ids.push(view.getUint16(offset, true));
        offset += 2;
      }

      handlers.onLeave(ids);
      return;
    }
  };

  ws.onclose = () => {
    console.warn("[network] disconnected, retrying in 1s");
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      if (handlers) connect(url, handlers);
    }, 1000);
  };

  ws.onerror = () => ws?.close();
}

/** 極速 Zero-Alloc 發送移動封包 (Float32 點) */
export function sendMove(x: number, y: number): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  sendMoveView.setFloat32(1, x, true);
  sendMoveView.setFloat32(5, y, true);
  ws.send(sendMoveBuffer);
}
