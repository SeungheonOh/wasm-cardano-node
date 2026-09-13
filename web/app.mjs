import { connect } from './client.mjs';
const $ = id => document.getElementById(id);
const config = await fetch('/config.json').then(r => r.json());
$('url').value = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ouroboros`;
$('network').value = String(config.networkMagic);
$('peer').textContent = `Bridge destination: ${config.peerHost}:${config.peerPort}`;
let client, count = 0, txCount = 0;
function stopped(text) { $('state').textContent = text; $('connect').disabled = false; $('stop').disabled = true; }
$('connect').onclick = () => {
  client?.close();
  $('events').replaceChildren(); count = 0; txCount = 0;
  $('count').textContent = '0'; $('txs').textContent = '0'; $('slot').textContent = '—';
  $('state').textContent = 'Loading and connecting…'; $('connect').disabled = true; $('stop').disabled = false;
  try {
    client = connect({ url: $('url').value, networkMagic: Number($('network').value), blocks: $('blocks').checked,
      onError: error => stopped(error.message), onEvent: (event, stats) => {
        $('memory').textContent = `${(stats.memoryBytes / 1048576).toFixed(1)} MiB WASM memory`;
        $('received').textContent = `${(stats.receivedBytes / 1024).toFixed(1)} KiB received`;
        if (event.type === 'connected') $('state').textContent = `Connected · ${event.version}`;
        if (event.type === 'await') { $('state').textContent = 'At the tip · waiting for the next block'; return; }
        if (event.point?.slot) $('slot').textContent = event.point.slot;
        if (event.type === 'rollForward') $('count').textContent = String(++count);
        if (event.type === 'block') { txCount += event.transactions.length; $('txs').textContent = String(txCount); }
        $('empty').hidden = true;
        const li = document.createElement('li');
        li.classList.toggle('rollback', event.type === 'rollBackward');
        const type = document.createElement('span'); type.className = 'type';
        const labels = { connected: 'Connected', intersect: 'Start at tip', rollForward: 'New header',
          rollBackward: 'Rollback', block: 'Block body', blockUnavailable: 'Unavailable' };
        type.textContent = labels[event.type] ?? event.type;
        const body = document.createElement('div');
        body.textContent = event.type === 'block' ? `${event.era} · ${event.transactions.length} transactions`
          : event.point?.slot ? `Slot ${event.point.slot}` : event.version ?? 'Origin';
        if (event.point?.hash) { const hash = document.createElement('small'); hash.textContent = event.point.hash; body.append(hash); }
        if (event.type === 'block') {
          const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
          summary.textContent = 'Transaction IDs'; pre.textContent = event.transactions.map(tx => tx.id).join('\n') || 'No transactions in this block.';
          details.append(summary, pre); body.append(details);
        }
        const time = document.createElement('time'); time.textContent = new Date().toLocaleTimeString();
        li.append(type, body, time); $('events').prepend(li);
        while ($('events').children.length > 80) $('events').lastElementChild.remove();
      },
    });
  } catch (error) { stopped(error.message); }
};
$('stop').onclick = () => { client?.close(); stopped('Disconnected'); };
addEventListener('pagehide', () => client?.close());
