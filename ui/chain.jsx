import React, { useEffect, useRef, useState } from 'react';
import { connect } from '../web/client.mjs';
import { ChainMetrics, NETWORKS } from '../web/metrics.mjs';
import { parseRelayURL, relayBridgeURL } from '../web/relay-url.mjs';
import { Header, Network, Facts, Panel, MAINNET, peers, number, fixed, bytes, duration, elapsed } from './shared.jsx';
import { BlockModal, TransactionSearch } from './blocks.jsx';
import { BLOCK_WINDOW, retainBlockBodies } from './observed-blocks.mjs';

function Blocks({ model, snapshot, onOpen, children }) {
  const intervals = new Map(snapshot.intervals.map(({ block, seconds }) => [block.hash, seconds]));
  return <Panel title="Recent blocks" id="activity">{children}<div className="table-scroll"><table className="blocks"><thead><tr>
    {['Height', 'Slot', 'Transactions', 'Tx CBOR', 'Interval', 'Header → body'].map(label => <th key={label}>{label}</th>)}
  </tr></thead><tbody id="block-rows">{model.blocks.slice(-BLOCK_WINDOW).reverse().map(block => <tr key={block.hash} onClick={() => onOpen(block.hash)}>
    <td><button data-hash={block.hash} aria-label={`Inspect block ${block.height}`} aria-haspopup="dialog">{number(block.height)}</button></td>
    <td>{number(block.slot)}</td><td>{block.body ? block.txs : block.unavailable ? 'Unavailable' : '—'}</td>
    <td>{block.body ? bytes(block.bytes) : '—'}</td><td>{fixed(intervals.get(block.hash), ' s')}</td><td>{fixed(block.fetchMs, ' ms')}</td>
  </tr>)}</tbody></table></div><p id="blocks-empty" hidden={model.blocks.length > 0}>No blocks received.</p>
    <p><small>Intervals use consecutive observed slots.</small></p></Panel>;
}
function MetricSummary({ rows }) {
  return <dl className="metric-summary">{rows.map(([id, label, value, note]) => <div key={id}><dt>{label}</dt><dd id={id}>{value}</dd>{note && <small>{note}</small>}</div>)}</dl>;
}
function ChainFacts({ model: m, snapshot: s }) {
  const percent = s.clock ? s.clock.slotInEpoch / s.clock.epochLength * 100 : null;
  return <section id="chain" className="compact-panel" aria-labelledby="chain-title">
    <header className="panel-heading"><h2 id="chain-title">Chain</h2><span id="network-badge">{NETWORKS[m.magic]?.name ?? 'Custom'}</span></header>
    <MetricSummary rows={[
      ['height', 'Block height', number(m.height)], ['epoch', 'Epoch', s.clock?.epoch ?? '—'],
      ['tps', 'Tx / second', fixed(s.tps, '', 2)], ['tip-age', 'Tip age', s.tipAge === null ? '—' : `${s.tipAge < 0 ? '−' : ''}${duration(Math.abs(s.tipAge))}`],
    ]}/>
    <details className="metrics-details"><summary>Chain details</summary><Facts rows={[
      ['slot', 'Absolute slot', m.point?.slot ?? '—'], ['era', 'Era', m.era ?? '—'],
      ['epoch-percent', 'Epoch progress', fixed(percent, '%')],
      ['epoch-detail', 'Epoch slots', s.clock ? `${number(s.clock.slotInEpoch)} / ${number(s.clock.epochLength)} slots` : '—'],
      ['tip-health', 'Tip observation', s.tipAge < 0 ? 'Check local clock' : m.active ? 'Peer view' : 'Last observation'],
      ['count', 'Headers received', m.headers], ['txs', 'Transactions received', m.transactions],
      ['block-interval', 'Mean block interval', fixed(s.averageInterval, ' s'), <span id="interval-samples">{s.intervals.length ? `${s.intervals.length} consecutive intervals · last 120 blocks` : 'Needs two consecutive blocks'}</span>],
      ['density', 'Observed slot density', fixed(s.density, '%')],
      ['rollbacks', 'Rollback events', m.rollbacks, <span id="rollback-depth">Max observed depth: {m.deepestRollback} blocks{m.unknownRollbacks > 0 && ` · ${m.unknownRollbacks} outside window`}</span>],
      ['unavailable', 'Unavailable block bodies', m.unavailable],
    ]}/><p><small>One relay's view. Rollbacks include initial positioning. Slot gaps are normal. No ledger validation.</small></p></details>
  </section>;
}
function RelayFacts({ model: m, snapshot: s, relay }) {
  return <section id="relay" className="compact-panel" aria-labelledby="relay-title">
    <header className="panel-heading"><h2 id="relay-title">Relay</h2><span id="live-indicator" className={m.active ? 'connected' : undefined}>{m.active ? s.pingAge !== null && s.pingAge >= 25 ? 'Awaiting peer' : 'Connected' : m.ended === null ? 'Not connected' : 'Disconnected'}</span></header>
    <MetricSummary rows={[
      ['ping', 'Round trip', `${fixed(s.ping, ' ms')}${m.active && s.pingAge >= 25 ? ' · stale' : ''}`],
      ['peer-lead', 'Blocks behind', s.peerLead === null ? '—' : number(s.peerLead)],
      ['receive-rate', 'Receive / s', bytes(s.receiveRate)], ['memory', 'WASM memory', m.stats.memoryBytes ? `${(m.stats.memoryBytes / 1048576).toFixed(1)} MiB` : '—'],
    ]}/>
    <details className="metrics-details"><summary>Relay details</summary><Facts rows={[
      ['relay-host', 'Relay address', relay], ['uptime', 'Session time', elapsed(s.elapsed)],
      ['protocol-version', 'Node-to-node version', m.version?.replace(/^(NodeToNodeVersion_|NodeToNodeV_)/, 'v') ?? '—'],
      ['ping-mean', 'Mean round trip (last 30)', fixed(s.meanPing, ' ms')],
      ['fetch-time', 'Mean header → body time', fixed(s.meanFetch, ' ms')],
      ['received', 'Received', `${bytes(m.stats.receivedBytes)} received`], ['sent', 'Sent', `${bytes(m.stats.sentBytes)} sent`],
    ]}/></details>
  </section>;
}
function ProtocolEvents({ events }) {
  const labels = { connected: 'Connected', intersect: 'Start at tip', rollForward: 'New header', rollBackward: 'Rollback', block: 'Block body', blockUnavailable: 'Unavailable' };
  return <details className="protocol-panel" id="protocol"><summary>Protocol events <span>{events.length}</span></summary><p id="empty" hidden={events.length > 0}>No events.</p><ol id="events">{events.map(({ event, time, id }) => <li key={id} className={event.type === 'rollBackward' ? 'rollback' : undefined}>
    <span className="type">{labels[event.type] ?? event.type}</span><div>{event.type === 'block' ? `${event.era} · ${event.transactionCount} transactions` : event.point?.slot != null ? `Slot ${event.point.slot}` : event.version ?? 'Origin'}{event.point?.hash && <small>{event.point.hash}</small>}</div><time>{time}</time>
  </li>)}</ol><p><small>Latest 80 events.</small></p></details>;
}
export default function ChainApp({ initialHosted = false }) {
  const [model] = useState(() => new ChainMetrics());
  const [, refresh] = useState(0), client = useRef(), generation = useRef(0), eventId = useRef(0);
  const [config, setConfig] = useState(null), [magic, setMagic] = useState(MAINNET), [url, setURL] = useState(''), [bodies, setBodies] = useState(true);
  const [busy, setBusy] = useState(false), [state, setState] = useState('Loading connection settings…'), [relay, setRelay] = useState('—');
  const blockBodies = useRef(new Map());
  const [selected, setSelected] = useState(null), [events, setEvents] = useState([]), [session, setSession] = useState(0);
  const direct = config?.transport === 'tcp', hosted = initialHosted || (config?.app === 'cardano-live' && config?.bridgePath === '/ouroboros');
  const supported = !direct || location.protocol === 'isolated-app:';
  const render = () => refresh(value => value + 1);
  useEffect(() => {
    const abort = new AbortController();
    fetch('/config.json', { signal: abort.signal }).then(response => {
      if (!response.ok) throw new Error('Connection settings could not be loaded. Reload to try again.');
      return response.json();
    }).then(value => {
      setConfig(value); setMagic(value.networkMagic); model.reset(value.networkMagic);
      const tcp = value.transport === 'tcp' || value.bridgePath === '/ouroboros';
      setURL(tcp ? `tcp://${value.peerHost}:${value.peerPort}` : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ouroboros`);
      setState(value.transport === 'tcp' && location.protocol !== 'isolated-app:' ? 'Open the installed app to connect to this relay.' : 'Ready to connect');
    }).catch(error => { if (!abort.signal.aborted) setState(error.message); });
    const close = () => { generation.current++; client.current?.close(); };
    addEventListener('pagehide', close);
    return () => { abort.abort(); close(); removeEventListener('pagehide', close); };
  }, [model]);
  useEffect(() => { if (busy) { const timer = setInterval(render, 1000); return () => clearInterval(timer); } }, [busy]);
  function changeNetwork(value) {
    setMagic(value);
    const peer = config?.relays?.find(p => p.networkMagic === value);
    setURL(`tcp://${peer?.host ?? peers[value]}:${peer?.port ?? 3001}`);
    if (!model.headers && !model.active) { model.reset(value); render(); }
  }
  function stop(message = 'Disconnected') {
    generation.current++; client.current?.close(); client.current = null;
    model.stop(); setBusy(false); setState(message); render();
  }
  function start() {
    client.current?.close(); const current = ++generation.current;
    model.reset(magic, performance.now(), Date.now(), bodies); blockBodies.current = new Map(); setSelected(null); setEvents([]); setSession(value => value + 1);
    setBusy(true); setState('Loading and connecting…');
    try {
      const target = hosted ? parseRelayURL(url) : null;
      setRelay(hosted ? target.url.slice(6) : direct ? url.slice(6) : `${config.peerHost}:${config.peerPort}`);
      client.current = connect({ url: hosted ? relayBridgeURL(target.url) : url, networkMagic: magic, blocks: bodies,
        onError: error => { if (generation.current === current) stop(error.message); },
        onStats: stats => { if (generation.current === current) model.updateStats(stats); },
        onEvent: (event, stats) => {
          if (generation.current !== current) return;
          model.updateStats(stats); model.ingest(event); render();
          if (event.type === 'connected') setState(`Connected · ${event.version}`);
          if (event.type === 'keepAlive') return;
          if (event.type === 'await') { setState('At the tip · waiting for the next block'); return; }
          if (event.type === 'rollForward') setState('Receiving the next block');
          if (['rollForward', 'block', 'rollBackward'].includes(event.type)) blockBodies.current = retainBlockBodies(blockBodies.current, event, model.blocks);
          // Keep event summaries separate from the bounded block bodies.
          const { transactions, ...summary } = event;
          setEvents(previous => [{ event: { ...summary, transactionCount: transactions?.length }, time: new Date().toLocaleTimeString(), id: eventId.current++ }, ...previous].slice(0, 80));
        },
      });
    } catch (error) { stop(error.message); }
  }
  const snapshot = model.snapshot();
  function openBlock(hash, transactionId) {
    const block = model.blocks.find(block => block.hash === hash);
    if (block) setSelected({ hash, height: block.height, slot: block.slot, transactionId });
  }
  return <main><Header tab="chain" hosted={hosted}/>
    <section id="overview" aria-labelledby="overview-title"><header className="panel-heading"><h2 id="overview-title">Connection</h2><p id="state" role="status">{state}</p></header><div className="connection" id="connection-panel">
      <label className="endpoint"><span id="endpoint-label">{direct || hosted ? 'Relay address' : 'Connection URL'}</span><input id="url" aria-label={direct || hosted ? 'Relay address' : 'Connection URL'} value={url} spellCheck={false} placeholder="tcp://relay.example.org:3001" onChange={e => setURL(e.target.value)} disabled={busy}/></label>
      <Network value={magic} onChange={changeNetwork} disabled={busy || !config || (!direct && !hosted)}/>
      <label><input id="blocks" type="checkbox" checked={bodies} onChange={e => setBodies(e.target.checked)} disabled={busy}/>Include transactions</label>
      <button id="connect" onClick={start} disabled={busy || !config || !supported}>Connect</button><button id="stop" onClick={() => stop()} disabled={!busy}>Disconnect</button>
    </div>
      <p id="rollback-notice" role="status" hidden={!model.rollbackNotice}>{model.rollbackNotice}</p></section>
    <div className="columns"><ChainFacts model={model} snapshot={snapshot}/><RelayFacts model={model} snapshot={snapshot} relay={relay}/></div>
    <Blocks model={model} snapshot={snapshot} onOpen={openBlock}>
      <TransactionSearch key={session} bodies={blockBodies.current} blocks={model.blocks} onOpen={openBlock}/>
    </Blocks>
    <ProtocolEvents events={events}/>
    {selected && <BlockModal selected={selected} summary={model.blocks.slice(-BLOCK_WINDOW).find(block => block.hash === selected.hash)} body={blockBodies.current.get(selected.hash)} bodiesEnabled={model.bodies} active={busy} onClose={() => setSelected(null)}/>}
  </main>;
}
