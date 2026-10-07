import React, { useEffect, useRef, useState } from 'react';
import { Facts, number, bytes, fixed } from './shared.jsx';
import { BlockTransactions } from './transactions.jsx';
import { BLOCK_WINDOW, findTransactions } from './observed-blocks.mjs';

export function TransactionSearch({ bodies, blocks, onOpen }) {
  const [query, setQuery] = useState(''), [submitted, setSubmitted] = useState(false);
  const matches = findTransactions(bodies, query);
  return <div id="transaction-section" role="search" aria-label="Observed transactions">
    <form className="transaction-search" onSubmit={event => {
      event.preventDefault(); setSubmitted(true);
      if (matches.length === 1) onOpen(matches[0].hash, matches[0].id);
    }}><input id="transaction-search" type="search" aria-label="Search transactions" placeholder="Search transaction ID or prefix" autoComplete="off" spellCheck={false} value={query} onChange={event => { setQuery(event.target.value); setSubmitted(false); }}/>
      <button type="submit" disabled={!query.trim()}>Find transaction</button></form>
    <p className="search-scope"><small>Search the latest {BLOCK_WINDOW} observed blocks.</small></p>
    {query.trim() && <div role="status"><p className="note">{matches.length ? `${matches.length} match${matches.length === 1 ? '' : 'es'}${matches.length > 10 ? ' · showing first 10' : ''}` : submitted ? 'No matching transaction in the observed blocks.' : 'No matches in the observed blocks.'}</p>
      {matches.length > 0 && <ul className="search-results">{matches.slice(0, 10).map(match => <li key={`${match.hash}:${match.id}`}><button type="button" onClick={() => onOpen(match.hash, match.id)}><span className="hash">{match.id}</span><span>Block {number(blocks.find(block => block.hash === match.hash)?.height)}</span></button></li>)}</ul>}
    </div>}
  </div>;
}

export function BlockModal({ selected, summary, body, bodiesEnabled, active, onClose }) {
  const dialog = useRef();
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  useEffect(() => {
    if (!selected.transactionId || !body) return;
    const frame = requestAnimationFrame(() => dialog.current.querySelector('.tx-highlight')?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [selected.transactionId, body]);
  return <dialog id="block-modal" ref={dialog} aria-labelledby="block-modal-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="block-modal-content"><header className="modal-header"><h2 id="block-modal-title">Block {number(selected.height)}</h2><button type="button" autoFocus onClick={onClose} aria-label="Close block">Close</button></header>
      <div className="modal-scroll"><Facts rows={[
        ['block-hash', 'Hash', <span className="hash">{selected.hash}</span>], ['block-slot', 'Slot', number(selected.slot)],
        ['block-era', 'Era', body?.era.replace(/Era$/, '') ?? '—'], ['block-tx-count', 'Transactions', body?.transactions.length ?? '—'],
        ['block-bytes', 'Transaction CBOR', summary?.body ? bytes(summary.bytes) : '—'], ['block-fetch', 'Header → body', fixed(summary?.fetchMs, ' ms')],
      ]}/>
        <h3 className="modal-transactions-title">Transactions</h3>
        {!summary ? <p role="status">This block is no longer in the observed window. It was rolled back or replaced by newer observations.</p>
          : body ? body.transactions.length ? <BlockTransactions block={body} highlighted={selected.transactionId}/> : <p>No transactions in this block.</p>
            : <p role="status">{summary.unavailable ? 'The relay could not provide this block body.' : !bodiesEnabled ? 'Transaction fetching was disabled for this connection.' : active ? 'Waiting for the block body…' : 'The connection ended before the block body was received.'}</p>}
      </div>
    </div>
  </dialog>;
}
