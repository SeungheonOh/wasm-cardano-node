export type ChainPoint = { origin: true } | { slot: string; hash: string };
export type ChainTip = { origin: true } | { point: ChainPoint; blockNo: string };
export type TransactionInput = { txId: string; index: number };
export type TransactionAsset = { policyId: string; nameHex: string; name: string | null; quantity: string };
export type TransactionOutput = {
  address: string; lovelace: string; assets: TransactionAsset[];
  datum: { type: 'hash' | 'inline' | 'supplemental'; hash: string; json?: string } | null;
  referenceScriptHash: string | null;
};
export type Transaction = {
  id: string; cborHex: string; sizeBytes: number;
  inputs: TransactionInput[]; outputs: TransactionOutput[];
  feeLovelace: string; outputLovelace: string; mint: TransactionAsset[];
  validity: { fromSlot: string | null; untilSlot: string | null };
  scriptValidity: 'not-applicable' | 'valid' | 'invalid';
  /** Exact JSON text preserves metadata and datum integers beyond JS's safe range. */
  metadataJson: string | null;
  requiredSigners: string[]; withdrawals: { address: string; lovelace: string }[];
  collateralInputs: TransactionInput[]; referenceInputs: TransactionInput[];
  totalCollateralLovelace: string | null; collateralReturn: TransactionOutput | null;
};
export type ChainEvent =
  | { type: 'connected'; networkMagic: number; version: string }
  | { type: 'intersect'; point: ChainPoint; tip: ChainTip }
  | { type: 'await' }
  | { type: 'keepAlive'; roundTripMs: number }
  | { type: 'rollForward'; point: ChainPoint; blockNo: string; tip: ChainTip }
  | { type: 'rollBackward'; point: ChainPoint; tip: ChainTip }
  | { type: 'block'; point: ChainPoint; era: string; transactions: Transaction[] }
  | { type: 'blockUnavailable'; point: ChainPoint };
export type StreamStats = { memoryBytes: number; receivedBytes: number; sentBytes: number };
export function connect(options: {
  /** ws(s):// byte bridge, or tcp://host:port in an installed Isolated Web App. */
  url: string;
  networkMagic?: number;
  epochSlots?: number;
  blocks?: boolean;
  onEvent: (event: ChainEvent, stats: StreamStats) => void | Promise<void>;
  /** Periodic transport counters, including when ChainSync is awaiting a block. */
  onStats?: (stats: StreamStats) => void | Promise<void>;
  onError?: (error: Error) => void;
}): { close(): void };
