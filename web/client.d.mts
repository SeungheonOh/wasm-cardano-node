export type ChainPoint = { origin: true } | { slot: string; hash: string };
export type ChainTip = { origin: true } | { point: ChainPoint; blockNo: string };
export type ChainEvent =
  | { type: 'connected'; networkMagic: number; version: string }
  | { type: 'intersect'; point: ChainPoint; tip: ChainTip }
  | { type: 'await' }
  | { type: 'rollForward'; point: ChainPoint; blockNo: string; tip: ChainTip }
  | { type: 'rollBackward'; point: ChainPoint; tip: ChainTip }
  | { type: 'block'; point: ChainPoint; era: string; transactions: { id: string; cborHex: string }[] }
  | { type: 'blockUnavailable'; point: ChainPoint };
export type StreamStats = { memoryBytes: number; receivedBytes: number };
export function connect(options: {
  url: string;
  networkMagic?: number;
  epochSlots?: number;
  blocks?: boolean;
  onEvent: (event: ChainEvent, stats: StreamStats) => void | Promise<void>;
  onError?: (error: Error) => void;
}): { close(): void };
