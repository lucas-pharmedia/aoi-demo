import type { ClientPacket, PlayerState, ServerPacket } from './types.ts';

interface Handlers {
  onInit: (p: Extract<ServerPacket, { type: 'init' }>) => void;
  onEnter: (players: PlayerState[]) => void;
  onLeave: (ids: string[]) => void;
  onMove: (players: PlayerState[]) => void;
  onUpdate: (players: PlayerState[]) => void;
}

let ws: WebSocket | null = null;
let handlers: Handlers | null = null;
let retryTimer: number | null = null;
let lastPacketAt: number | null = null;

export function connect(url: string, h: Handlers): void {
  handlers = h;
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log(`[network] connected: ${url}`);
  };

  ws.onmessage = (ev) => {
    if (!handlers) return;
    const now = performance.now();
    if (lastPacketAt !== null) {
      const gap = now - lastPacketAt;
      // 超過 buffer 深度（100ms）→ 會造成畫面凍結
      if (gap > 100) console.log(`[PACKET] gap ${gap.toFixed(0)}ms`);
    }
    lastPacketAt = now;
    const msg = JSON.parse(ev.data) as ServerPacket;
    switch (msg.type) {
      case 'init':
        handlers.onInit(msg);
        break;
      case 'enter':
        handlers.onEnter(msg.players);
        break;
      case 'leave':
        handlers.onLeave(msg.players);
        break;
      case 'move':
        handlers.onMove(msg.players);
        break;
      case 'update':
        handlers.onUpdate(msg.players);
        break;
      case 'sync':
        if (msg.enters.length) handlers.onEnter(msg.enters);
        if (msg.leaves.length) handlers.onLeave(msg.leaves);
        if (msg.moves.length) handlers.onMove(msg.moves);
        break;
    }
  };

  ws.onclose = () => {
    console.warn('[network] disconnected, retrying in 1s');
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      if (handlers) connect(url, handlers);
    }, 1000);
  };

  ws.onerror = () => ws?.close();
}

export function sendMove(x: number, y: number): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const packet: ClientPacket = { type: 'move', x, y };
  ws.send(JSON.stringify(packet));
}
