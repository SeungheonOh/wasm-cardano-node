import React, { useEffect, useRef, useState } from 'react';
import { submission } from '../submit/client.mjs';
import { ERAS, MAX_FILE_BYTES, relayTarget, transactionInput } from '../submit/input.mjs';
import { hostedTarget } from '../submit/connection.mjs';
import { formatAda } from '../web/transactions.mjs';
import { Header, Network, Facts, MAINNET, peers, elapsed } from './shared.jsx';
import { Output } from './transactions.jsx';

export default function SubmitApp({ initialHosted = false }) {
  const [direct, setDirect] = useState(false);
  const [hosted, setHosted] = useState(initialHosted), [settingsReady, setSettingsReady] = useState(direct);
  const [cbor, setCBOR] = useState(''), [era, setEra] = useState(6), [magic, setMagic] = useState(MAINNET), [relay, setRelay] = useState(`tcp://${peers[MAINNET]}:3001`);
  const [phase, updatePhase] = useState('empty'), phaseRef = useRef('empty');
  const [data, setData] = useState(null), [error, setError] = useState(null), [filename, setFilename] = useState(''), [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState(['Waiting for a transaction', 'No transaction sent.']);
  const [stages, setStages] = useState([]), [log, setLog] = useState([]), [seconds, setSeconds] = useState(null), [health, setHealth] = useState(''), [memory, setMemory] = useState('');
  const client = useRef(), generation = useRef(0), bodySent = useRef(false), sendTarget = useRef(''), fileInput = useRef(), logId = useRef(0);
  const setPhase = value => { phaseRef.current = value; updatePhase(value); };
  const addLog = text => setLog(previous => [{ text, id: logId.current++, time: new Date().toLocaleTimeString([], { hour12: false }) }, ...previous].slice(0, 20));
  const stage = name => setStages(previous => previous.includes(name) ? previous : [...previous, name]);
  const sending = phase === 'sending';
  useEffect(() => {
    const abort = new AbortController();
    const capable = location.protocol === 'isolated-app:' && typeof TCPSocket === 'function';
    setDirect(capable);
    if (capable) setSettingsReady(true);
    if (!capable) void fetch('/config.json', { signal: abort.signal }).then(response => response.ok ? response.json() : null).then(config => {
      if (abort.signal.aborted) return;
      setHosted(config?.transport === 'websocket' && config?.submission === true && config?.bridgePath === '/ouroboros');
      setSettingsReady(true);
    }).catch(() => { if (!abort.signal.aborted) setSettingsReady(true); });
    const close = () => { generation.current++; client.current?.close(); };
    const preventDrop = event => event.preventDefault();
    addEventListener('pagehide', close); addEventListener('dragover', preventDrop); addEventListener('drop', preventDrop);
    return () => { abort.abort(); close(); removeEventListener('pagehide', close); removeEventListener('dragover', preventDrop); removeEventListener('drop', preventDrop); };
  }, []);
  function reset() {
    generation.current++; client.current?.close(); client.current = null; bodySent.current = false;
    setPhase('empty'); setData(null); setError(null); setMemory(''); setSeconds(null); setHealth(''); setLog([]); setStages([]);
    setStatus(['Waiting for a transaction', 'No transaction sent.']);
  }
  function fail(problem) {
    const wasSending = phaseRef.current === 'sending';
    client.current?.close(); client.current = null; setPhase('error'); setError(problem.message);
    setStatus([bodySent.current ? 'Sent · connection ended' : wasSending ? 'Exchange interrupted' : 'Check your transaction',
      wasSending ? problem.delivery === 'none' ? 'No transaction body was sent. Check the relay address and connection status.'
        : 'Delivery may be unknown. Receiving bytes does not establish relay acceptance or block inclusion.'
        : 'Load complete signed transaction CBOR and check the selected era.']);
    addLog(problem.message);
  }
  function onEvent(message) {
    if (message.type === 'progress') setSeconds(message.elapsedSeconds);
    if (message.type === 'loading') setStatus(['Reading transaction', 'Loading Cardano codecs…']);
    if (message.type === 'review') {
      setData(message); setPhase('ready'); stage('review'); setMemory(`${(message.memoryBytes / 1048576).toFixed(1)} MiB WASM`);
      setStatus(['Ready to submit', 'Review the transaction and destination. Nothing has been sent to a relay.']);
      addLog(`Decoded ${Object.keys(ERAS).find(name => ERAS[name] === message.era)} transaction locally`);
    }
    if (message.type === 'connecting') addLog(`Opening ${sendTarget.current}`);
    if (message.type === 'event') {
      const event = message.event;
      setMemory(`${(message.memoryBytes / 1048576).toFixed(1)} MiB WASM`);
      if (event.type === 'connected') {
        stage('connected'); setStatus(['Waiting for relay', 'The relay may wait about 60 seconds before requesting transactions. The connection stays open for up to 3 minutes.']);
        addLog(`Handshake complete · ${event.version}`);
      } else if (event.type === 'keepAlive') setHealth(`Relay response · ${Math.round(event.roundTripMs)} ms`);
      else if (event.type === 'announced') {
        stage('announced'); setStatus(['Transaction announced', 'Transaction ID and size sent. Waiting for a body request.']); addLog('Transaction ID and size written to the relay connection');
      } else if (event.type === 'sent') {
        bodySent.current = true; stage('sent'); setStatus(['Sent to relay', 'Transaction bytes written. Waiting for the relay to complete the exchange.']); addLog('Requested transaction bytes written to the relay connection');
      } else if (event.type === 'finished') {
        setStatus([event.sent ? 'Sent to relay' : 'Relay did not request this transaction', event.sent
          ? 'The relay completed the exchange. Acceptance and block inclusion are not confirmed by this protocol.'
          : 'The relay completed the exchange without requesting the body. No transaction body was sent on this connection.']);
        addLog('Relay completed the exchange');
      }
    }
    if (message.type === 'complete') { setPhase('done'); client.current = null; }
  }
  function inspect(source = cbor, name) {
    if (phaseRef.current === 'sending') return;
    reset();
    try {
      const input = transactionInput(source, era);
      setEra(input.era); setCBOR(input.cborHex); if (name) setFilename(`${name} · ${input.format}`);
      const current = generation.current;
      setPhase('loading'); setStatus(['Reading transaction', 'Loading Cardano codecs…']);
      client.current = submission({ ...input, onEvent: message => { if (generation.current === current) onEvent(message); },
        onError: problem => { if (generation.current === current) fail(problem); } });
    } catch (problem) { fail(problem); }
  }
  async function loadFiles(files) {
    if (phaseRef.current === 'sending') return;
    if (files.length !== 1) return fail(new Error('Drop one transaction file at a time.'));
    if (files[0].size > MAX_FILE_BYTES) return fail(new Error('Choose a transaction file up to 1 MiB.'));
    const file = files[0]; reset(); const current = generation.current;
    try { const source = new Uint8Array(await file.arrayBuffer()); if (current === generation.current) inspect(source, file.name); }
    catch (problem) { if (current === generation.current) fail(problem); }
  }
  function send() {
    try {
      const url = hosted ? hostedTarget(relay.trim(), magic) : relayTarget(relay.trim(), magic);
      sendTarget.current = relay.trim();
      client.current.send({ url, networkMagic: magic }); setPhase('sending');
      setStatus(['Connecting to relay', 'Waiting for the relay.']);
    } catch (problem) { fail(problem); }
  }
  function cancel() {
    generation.current++; client.current?.close(); client.current = null; setPhase('done');
    setStatus([bodySent.current ? 'Sent · connection closed' : 'Connection closed', 'The exchange was stopped. Data already transmitted cannot be recalled; delivery may be unknown.']);
    addLog('Connection closed by you');
  }
  const tx = data?.transaction;
  return <main><Header tab="submit" hosted={hosted}/>
    <p id="mode" hidden={hosted || direct}>{settingsReady ? 'Local inspection only' : 'Loading connection settings…'}</p>
    <aside id="install" hidden={direct || hosted || !settingsReady}><p>This preview can inspect CBOR. Open the installed app to submit.</p><details><summary>Installation</summary><p>Enable Isolated Web Apps and IWA developer mode in Chrome, then install <code>cardano-submit.swbn</code> from <code>chrome://web-app-internals</code>.</p><a href="/dist/cardano-submit.swbn" download>Download bundle</a></details></aside>
    <div className="submit-layout">
      <section className="transaction-panel" aria-labelledby="load-title">
        <header className="section-heading"><h2 id="load-title">Transaction</h2><button id="clear" disabled={sending || !settingsReady || (!cbor && !error)} onClick={() => { reset(); setCBOR(''); setFilename(''); fileInput.current.value = ''; }}>Clear</button></header>
        <fieldset id="dropzone" className={dragging ? 'dragging' : undefined} onDragOver={event => { event.preventDefault(); if (!sending) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void loadFiles(event.dataTransfer.files); }}>
          <legend>Load a file</legend><div className="file-picker">
            <button id="choose-file" type="button" disabled={sending || !settingsReady} onClick={() => fileInput.current.click()}>Choose file</button>
            <span>or drop CBOR, hex or signed JSON here</span>
          </div><input id="file" ref={fileInput} type="file" hidden disabled={sending || !settingsReady} accept=".cbor,.hex,.json,.signed,.tx,.txt,application/cbor,application/json,text/plain,application/octet-stream" onChange={event => { void loadFiles(event.target.files); }}/><p id="filename">{filename}</p>
        </fieldset>
        <p><label htmlFor="cbor">Or paste CBOR hex / JSON</label></p>
        <textarea id="cbor" rows={6} spellCheck={false} autoComplete="off" placeholder="84a40081825820…" value={cbor} disabled={sending || !settingsReady} onChange={event => { reset(); setCBOR(event.target.value); setFilename(''); }}/>
        <div className="review-actions connection"><label>Transaction era<select id="era" value={era} disabled={sending || !settingsReady} onChange={event => { reset(); setEra(Number(event.target.value)); }}>{Object.entries(ERAS).reverse().map(([name, value]) => <option key={name} value={value}>{name}</option>)}</select></label>
          <button id="inspect" onClick={() => inspect()} disabled={!settingsReady || sending || phase === 'loading' || !cbor.trim()}>{phase === 'loading' ? 'Reading transaction…' : 'Review transaction'}</button>
        </div>
        <p className="note">Files are reviewed automatically. Pasted content stays local until you submit.</p>
        <div id="ready" className="transaction-review" hidden={!tx}>{tx && <><h2>Review</h2><Facts rows={[
          ['tx-id', 'Transaction ID', <span className="hash">{tx.id}</span>], ['fee', 'Declared fee', formatAda(tx.feeLovelace)], ['size', 'Size', `${tx.sizeBytes.toLocaleString()} bytes`],
          ['witnesses', 'Key witnesses', data.keyWitnesses], ['counts', 'Inputs / outputs', `${tx.inputs.length} / ${tx.outputs.length}`],
        ]}/><p id="witness-note" className={data.keyWitnesses ? undefined : 'witness-warning'}>{data.keyWitnesses ? 'Witnesses are present. Signatures and ledger validity are not checked locally.' : 'No key signatures found. Sign wallet inputs before expecting acceptance.'}</p>
          <div id="details"><details open className="review-detail"><summary>Outputs <span>{tx.outputs.length} · {formatAda(tx.outputLovelace)}</span></summary><div id="outputs">{tx.outputs.map((output, i) => <Output key={i} output={output} title={`Output ${i}`}/>)}</div></details>
            <details className="review-detail"><summary>Input references <span>{tx.inputs.length}</span></summary><ul id="inputs" className="input-list">{tx.inputs.map((input, i) => <li key={i}>{input.txId}#{input.index}</li>)}</ul></details>
            <details className="review-detail" id="metadata-details" hidden={tx.metadataJson === null}><summary>Transaction metadata</summary><pre id="metadata">{tx.metadataJson}</pre></details>
            <details className="review-detail"><summary>Raw transaction CBOR</summary><pre id="raw">{tx.cborHex}</pre></details>
          </div>
        </>}</div>
      </section>
      <aside className="submission-column"><section className="submit-panel" aria-labelledby="send-title"><h2 id="send-title">Submit</h2>
        <div className="submission-destination connection"><Network value={magic} disabled={sending || !settingsReady} onChange={value => { setMagic(value); setRelay(`tcp://${peers[value]}:3001`); }}/>
          <label className="endpoint">Relay address<input id="relay" type="text" spellCheck={false} autoComplete="off" value={relay} disabled={sending || !settingsReady} onChange={e => setRelay(e.target.value)}/></label>
        </div>
        <p id="review-summary" hidden={!!tx}>Load and review a transaction to enable submission.</p>
        <div className="submit-actions"><button id="send" disabled={(!direct && !hosted) || phase !== 'ready'} onClick={send}>{sending ? 'Exchanging with relay…' : 'Submit transaction'}</button><button id="cancel" hidden={!sending} onClick={cancel}>Close connection</button></div>
        <p className="note">Delivery to a relay does not confirm ledger acceptance or block inclusion.</p>
        <div className="submission-status" hidden={phase === 'empty'}><h3 id="status-title" role="status" aria-live="polite">{status[0]}</h3>
          <p id="status-note">{status[1]}</p><p id="error" role="alert" hidden={!error}>{error}</p>
          <p className="connection" hidden={seconds === null && !health}><span id="elapsed">{seconds !== null ? `${elapsed(seconds).replace(/^0(?=\d:)/, '')} elapsed` : ''}</span><span id="health">{health}</span></p>
          <ol className="progress" hidden={stages.length === 0}>{[['review', 'Reviewed'], ['connected', 'Connected'], ['announced', 'ID announced'], ['sent', 'Body sent']].map(([name, label]) => <li key={name} data-stage={name} className={stages.includes(name) ? 'done' : undefined}>{label}</li>)}</ol>
          <details className="activity-log" hidden={log.length === 0}><summary>Connection log</summary><p id="memory">{memory}</p><ol id="log" className="log">{log.map(item => <li key={item.id}><time>{item.time}</time><span>{item.text}</span></li>)}</ol></details>
        </div>
      </section></aside>
    </div>
  </main>;
}
