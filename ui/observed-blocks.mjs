export const BLOCK_WINDOW = 40;

// Mirror the current observed headers. Rollbacks and eviction remove bodies and
// their search results together; no ledger state or history is persisted.
export function retainBlockBodies(previous, event, summaries) {
  const next = new Map();
  for (const summary of summaries.slice(-BLOCK_WINDOW)) {
    const body = event.type === 'block' && event.point.hash === summary.hash ? event : previous.get(summary.hash);
    if (body) next.set(summary.hash, body);
  }
  return next;
}

export function findTransactions(bodies, query) {
  const prefix = query.trim().toLowerCase();
  if (!prefix || !/^[0-9a-f]+$/.test(prefix)) return [];
  const matches = [];
  for (const [hash, block] of [...bodies].reverse()) {
    for (const tx of block.transactions) {
      if (tx.id.startsWith(prefix)) matches.push({ hash, id: tx.id });
    }
  }
  return matches;
}
