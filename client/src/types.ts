export interface PlayerState {
  id: string;
  x: number;
  y: number;
}

export type ServerPacket =
  | { type: 'init'; selfId: string; x: number; y: number; width: number; height: number }
  | { type: 'enter'; players: PlayerState[] }
  | { type: 'leave'; players: string[] }
  | { type: 'move'; players: PlayerState[] }
  | { type: 'update'; players: PlayerState[] };

export type ClientPacket = { type: 'move'; x: number; y: number };