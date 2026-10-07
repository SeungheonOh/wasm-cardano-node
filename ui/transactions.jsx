import React, { useEffect, useRef, useState } from 'react';
import { formatAda } from '../web/transactions.mjs';

export function Raw({ title, children }) {
  return <details className="raw-detail"><summary>{title}</summary><pre>{children}</pre></details>;
}
function Copy({ label, value }) {
  const [text, setText] = useState(label), timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button className="copy-button" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setText('Copied'); } catch { setText('Copy unavailable'); }
    clearTimeout(timer.current); timer.current = setTimeout(() => setText(label), 1800);
  }}>{text}</button>;
}
function Assets({ assets }) {
  return <div className="asset-list"><small>Asset quantities in raw units</small>{assets.map((asset, i) => <div className="asset" key={i}>
    <strong>{BigInt(asset.quantity).toLocaleString('en-US')} × {asset.name && !/[\u0000-\u001f\u007f-\u009f]/.test(asset.name) ? asset.name : asset.nameHex || '(empty asset name)'}</strong>
    <small className="hash">Policy {asset.policyId}</small><small className="hash">Name hex {asset.nameHex || '(empty)'}</small>
  </div>)}</div>;
}
function Inputs({ title, inputs, children }) {
  return <section className="tx-section"><h4>{title} · {inputs.length}</h4>{inputs.map((input, i) => <div className="input-ref hash" key={i}>{input.txId}#{input.index}</div>)}{children}</section>;
}
export function Output({ output, title }) {
  return <div className="output"><div className="output-title"><span>{title}</span><strong>{formatAda(output.lovelace)}</strong></div>
    <div className="hash output-address">{output.address}</div>
    {!!output.assets.length && <Assets assets={output.assets}/>}
    {output.datum && <><small className="hash">{output.datum.type === 'inline' ? 'Inline datum' : 'Datum'} · {output.datum.hash}</small>{output.datum.json && <Raw title="Datum content">{output.datum.json}</Raw>}</>}
    {output.referenceScriptHash && <small className="hash">Reference script · {output.referenceScriptHash}</small>}
  </div>;
}
function TransactionContent({ tx, block }) {
  return <div className="tx-content">
    <div className="tx-identity"><div className="hash">{tx.id}</div><Copy label="Copy ID" value={tx.id}/></div>
    <p className="note">{block.era.replace(/Era$/, '')} · Slot {block.point.slot} · {tx.sizeBytes.toLocaleString()} bytes · Fee {formatAda(tx.feeLovelace)}</p>
    {tx.scriptValidity === 'invalid' && <p className="tx-warning">Marked script-invalid by the block. Regular outputs below are not applied; collateral is used instead.</p>}
    <div className="tx-flow"><Inputs title="Inputs" inputs={tx.inputs}><p className="note">Previous output references. Addresses and amounts require historical UTxO data.</p></Inputs>
      <section className="tx-section"><h4>Outputs · {tx.outputs.length}</h4><p className="note">Includes change outputs; this is not a payment total.</p>{tx.outputs.map((output, i) => <Output key={i} output={output} title={`Output #${i}`}/>)}</section></div>
    {!!tx.mint.length && <section className="tx-section"><h4>Mint / burn</h4><Assets assets={tx.mint}/></section>}
    <p className="note">Validity slots: {tx.validity.fromSlot ?? 'no lower bound'} → {tx.validity.untilSlot ? `${tx.validity.untilSlot} (exclusive)` : 'no upper bound'}</p>
    {tx.metadataJson && <Raw title="Transaction metadata">{tx.metadataJson}</Raw>}
    {!!tx.referenceInputs.length && <Inputs title="Reference inputs (not spent)" inputs={tx.referenceInputs}/>}
    {!!tx.collateralInputs.length && <Inputs title="Collateral inputs" inputs={tx.collateralInputs}/>}
    {tx.totalCollateralLovelace !== null && <p className="note">Total collateral: {formatAda(tx.totalCollateralLovelace)}</p>}
    {tx.collateralReturn && <Output output={tx.collateralReturn} title="Collateral return"/>}
    {!!tx.withdrawals.length && <section className="tx-section"><h4>Reward withdrawals</h4>{tx.withdrawals.map((w, i) => <p className="hash" key={i}>{w.address} · {formatAda(w.lovelace)}</p>)}</section>}
    {!!tx.requiredSigners.length && <Raw title="Required signer hashes">{tx.requiredSigners.join('\n')}</Raw>}
    <details className="raw-detail"><summary>Raw transaction CBOR</summary><pre>{tx.cborHex}</pre><Copy label="Copy CBOR" value={tx.cborHex}/></details>
  </div>;
}
function Transaction({ tx, block, highlighted }) {
  const [expanded, setExpanded] = useState(highlighted);
  useEffect(() => { if (highlighted) setExpanded(true); }, [highlighted]);
  const assetCount = tx.outputs.reduce((sum, output) => sum + output.assets.length, 0);
  return <details data-tx-id={tx.id} className={`tx-card${highlighted ? ' tx-highlight' : ''}`} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="tx-summary"><div className="tx-title"><span className="hash tx-id">{tx.id}</span>{highlighted && <span className="tx-badge">Search match</span>}</div>
      <div className="tx-overview"><strong>{formatAda(tx.outputLovelace)} in outputs</strong><span>{tx.inputs.length} inputs → {tx.outputs.length} outputs</span><span>Fee {formatAda(tx.feeLovelace)}</span></div>
      <div className="tx-tags"><span>Slot {block.point.slot}</span>{assetCount > 0 && <span>{assetCount} asset entries</span>}{!!tx.mint.length && <span>Mint / burn</span>}{tx.metadataJson && <span>Metadata</span>}{tx.scriptValidity === 'invalid' && <span className="tx-warning">Script-invalid</span>}</div>
    </summary>{expanded && <TransactionContent tx={tx} block={block}/>}
  </details>;
}
export function BlockTransactions({ block, highlighted }) {
  return <div id="transactions">{block.transactions.map(tx => <Transaction key={tx.id} tx={tx} block={block} highlighted={tx.id === highlighted}/>)}</div>;
}
