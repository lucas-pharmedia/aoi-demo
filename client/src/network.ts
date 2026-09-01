/**
 * 極速二進位 Network 模組 (Zero-Alloc & Ping-Pong 心跳保活版)
 *
 * 重點功能：
 *   1. 【Ping-Pong 心跳保活】：每 1 秒自動發送 1-Byte 心跳包（Opcode.Ping），
 *      維持上行流量，徹底解決 iOS Safari 在靜止時因省電機制導致的 WebSocket 下行緩衝區塞車 (Socket Stall)。
 *   2. 【Zero-Alloc 解碼】：採用 Object Pool 物件池與全域陣列重用，解碼過程 0 垃圾產生，消除 GC Pause。
 *   3. 【雙向效能診斷】：持續監測 CPU / 主執行緒卡死 (Main Thread Blocked) 與網路封包斷層 (Packet Gap)。
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

// ----------------------------------------------------------------------
// 🟢 1. 主執行緒 (CPU / GC) 心跳診斷監測器
// ----------------------------------------------------------------------
let lastFrameTime =
  typeof performance !== "undefined" ? performance.now() : Date.now();

if (typeof window !== "undefined") {
  const checkFrame = () => {
    const now = performance.now();
    const frameDelta = now - lastFrameTime;

    // 單個影格超過 500ms，代表主執行緒被硬性凍結 (100% 為 GC 或 CPU 卡死)
    if (frameDelta > 500) {
      console.error(
        `[DIAGNOSTIC] 🚨 Main Thread (CPU/GC) Blocked for ${frameDelta.toFixed(
          0
        )}ms!`
      );
    }

    lastFrameTime = now;
    requestAnimationFrame(checkFrame);
  };
  requestAnimationFrame(checkFrame);
}

// ----------------------------------------------------------------------
// 🟢 2. Zero-Alloc 防 GC 物件池 (Object Pool & Array Reuse)
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
// 🟢 3. Zero-Alloc 發送專用 Buffer (Move & Ping)
// ----------------------------------------------------------------------
// Move 封包 (9 Bytes): [1B Opcode][4B Float32 X][4B Float32 Y]
const sendMoveBuffer = new ArrayBuffer(9);
const sendMoveView = new DataView(sendMoveBuffer);
sendMoveView.setUint8(0, Opcode.Move);

// Ping 心跳封包 (1 Byte): [1B Opcode.Ping]
const pingBuffer = new Uint8Array([Opcode.Ping]).buffer;

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

// ----------------------------------------------------------------------
// 🟢 4. Ping-Pong 心跳計時器管理 (專治 iOS Safari 靜止斷流)
// ----------------------------------------------------------------------
function startHeartbeat(): void {
  stopHeartbeat();
  // 每 1000ms 發送 1-Byte Ping 保持雙向 TCP 活性，防止 iOS 網卡進入省電緩衝佇列
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
    console.log(`[network] connected (Binary Mode + Ping Heartbeat): ${url}`);
    startHeartbeat(); // 🟢 連線成功，立即啟動 Ping 心跳
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (!handlers || !(ev.data instanceof ArrayBuffer)) return;

    // ------------------------------------------------------------------
    // Packet Gap (網路封包抵達間隔) 診斷監測
    // ------------------------------------------------------------------
    const now = performance.now();
    if (lastPacketAt !== null) {
      const gap = now - lastPacketAt;
      if (gap > 600) {
        console.warn(`[PACKET] ⚠️ gap ${gap.toFixed(0)}ms`);
      }
    }
    lastPacketAt = now;

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
      case Opcode.Move:
      case Opcode.Enter:
      case Opcode.Update: {
        const count = view.getUint16(1, true);
        reusablePlayersArray.length = 0; // 重置長度，零垃圾產生
        let offset = 3;

        for (let i = 0; i < count; i++) {
          const id = view.getUint16(offset, true);
          const x = view.getFloat32(offset + 2, true);
          const y = view.getFloat32(offset + 6, true);

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
      case Opcode.Leave: {
        const count = view.getUint16(1, true);
        reusableIdsArray.length = 0;
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
    stopHeartbeat(); // 🟢 斷線時停止心跳
    if (paused || !handlers || !wsUrl) return;
    console.warn("[network] disconnected, retrying in 1s");
    retryTimer = window.setTimeout(() => {
      if (handlers && wsUrl) connect(wsUrl, handlers);
    }, 1000);
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
