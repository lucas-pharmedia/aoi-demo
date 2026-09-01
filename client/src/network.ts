/**
 * 極速二進位 Network 模組 (Zero-Alloc & iOS 保活優化版)
 */

export enum Opcode {
  Init = 1,
  Move = 2,
  Enter = 3,
  Leave = 4,
  Update = 5,
  Ping = 6, // 🟢 新增 Ping 心跳 (1 Byte)
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
let heartbeatTimer: number | null = null;
let paused = false;
let lastPacketAt: number | null = null;
let gapWindowStart = 0;
let gapBuckets = { g60: 0, g100: 0, g200: 0 };

// ----------------------------------------------------------------------
// 🟢 1. Zero-Alloc 全域重用解包陣列與物件池
// ----------------------------------------------------------------------
const reusablePlayersArray: BinaryPlayerState[] = [];
const reusableIdsArray: number[] = [];

// ----------------------------------------------------------------------
// 🟢 2. Zero-Alloc 發送專用 Buffer (Move & Ping)
// ----------------------------------------------------------------------
const sendMoveBuffer = new ArrayBuffer(9);
const sendMoveView = new DataView(sendMoveBuffer);
sendMoveView.setUint8(0, Opcode.Move);

const pingBuffer = new Uint8Array([Opcode.Ping]).buffer;

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  // 🟢 每 2 秒發送 1-Byte 心跳，防止 iOS Safari 網卡休眠斷流
  heartbeatTimer = window.setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(pingBuffer);
    }
  }, 2000);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function disconnect(): void {
  paused = true;
  clearRetryTimer();
  stopHeartbeat();
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
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log(`[network] connected (Binary Mode): ${url}`);
    startHeartbeat();
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (!handlers || !(ev.data instanceof ArrayBuffer)) return;

    // 🟢 防禦性檢查：避免 DataView 讀取空封包越界
    if (ev.data.byteLength < 1) return;

    // ------------------------------------------------------------------
    // Packet Gap 延遲與掉幀統計邏輯
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
    const opcode = view.getUint8(0) as Opcode;

    switch (opcode) {
      // 1. OP_INIT [1B Opcode][2B SelfId][4B X][4B Y]
      case Opcode.Init: {
        if (ev.data.byteLength < 11) return;
        const selfId = view.getUint16(1, true);
        const x = view.getFloat32(3, true);
        const y = view.getFloat32(7, true);
        handlers.onInit({ selfId, x, y });
        break;
      }

      // 2. OP_MOVE, OP_ENTER, OP_UPDATE
      case Opcode.Move:
      case Opcode.Enter:
      case Opcode.Update: {
        if (ev.data.byteLength < 3) return;
        const count = view.getUint16(1, true);

        // 🟢 重用陣列，避免每幀產生物件垃圾 (Zero-Alloc Unpacking)
        reusablePlayersArray.length = 0;
        let offset = 3;

        for (let i = 0; i < count; i++) {
          if (offset + 10 > ev.data.byteLength) break;
          const id = view.getUint16(offset, true);
          const x = view.getFloat32(offset + 2, true);
          const y = view.getFloat32(offset + 6, true);

          reusablePlayersArray.push({ id, x, y });
          offset += 10;
        }

        if (opcode === Opcode.Enter) handlers.onEnter(reusablePlayersArray);
        else if (opcode === Opcode.Move) handlers.onMove(reusablePlayersArray);
        else if (opcode === Opcode.Update)
          handlers.onUpdate(reusablePlayersArray);
        break;
      }

      // 3. OP_LEAVE
      case Opcode.Leave: {
        if (ev.data.byteLength < 3) return;
        const count = view.getUint16(1, true);
        reusableIdsArray.length = 0;
        let offset = 3;

        for (let i = 0; i < count; i++) {
          if (offset + 2 > ev.data.byteLength) break;
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
    stopHeartbeat();
    if (paused || !handlers || !wsUrl) return;

    // 🟢 避峰重連：1s ~ 2.5s 隨機退避，避免伺服器遭重連海嘯打癱
    const jitter = 1000 + Math.random() * 1500;
    console.warn(
      `[network] disconnected, retrying in ${(jitter / 1000).toFixed(1)}s`
    );
    retryTimer = window.setTimeout(() => {
      if (handlers && wsUrl) connect(wsUrl, handlers);
    }, jitter);
  };

  ws.onerror = () => ws?.close();
}

export function reconnect(): void {
  if (!handlers || !wsUrl) return;
  paused = false;
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  connect(wsUrl, handlers);
}

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

export function sendMove(x: number, y: number): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  sendMoveView.setFloat32(1, x, true);
  sendMoveView.setFloat32(5, y, true);
  ws.send(sendMoveBuffer);
}
