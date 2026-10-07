import React from 'react';

export const MAINNET = 764824073;
export const peers = { 764824073: 'backbone.cardano.iog.io', 2: 'preview-node.play.dev.cardano.org', 1: 'preprod-node.play.dev.cardano.org' };
export const number = value => value == null ? '—' : BigInt(value).toLocaleString('en-US');
export const fixed = (value, suffix = '', digits = 1) => value == null ? '—' : `${value.toFixed(digits)}${suffix}`;
export const bytes = n => n < 1024 ? `${Math.round(n)} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`;
export const duration = seconds => seconds < 60 ? `${Math.floor(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60 % 60)}m`;
export const elapsed = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
export function Header({ tab, hosted }) {
  return <header className="app-header"><nav id="app-tabs" aria-label="Application" hidden={!hosted}>
    <a href="/" aria-current={tab === 'chain' ? 'page' : undefined}>Chain</a>
    <a href="/submit/" aria-current={tab === 'submit' ? 'page' : undefined}>Submit transaction</a>
  </nav></header>;
}
export function Network({ value, onChange, disabled }) {
  return <label>Network<select id="network" value={value} onChange={event => onChange(Number(event.target.value))} disabled={disabled}>
    <option value={MAINNET}>Mainnet</option><option value={2}>Preview</option><option value={1}>Preprod</option>
  </select></label>;
}
export function Facts({ rows }) {
  return <table className="facts"><tbody>{rows.map(([id, label, value, note]) => <tr key={id}>
    <th scope="row">{label}</th><td>{note ? <><span id={id}>{value}</span><br/><small>{note}</small></> : <span id={id}>{value}</span>}</td>
  </tr>)}</tbody></table>;
}
export function Panel({ title, id, children }) {
  return <section id={id} aria-labelledby={`${id}-title`}><h2 id={`${id}-title`}>{title}</h2>{children}</section>;
}
