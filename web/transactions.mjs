const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function formatAda(lovelace) {
  const value = BigInt(lovelace), absolute = value < 0n ? -value : value;
  const decimals = (absolute % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${value < 0n ? '−' : ''}${(absolute / 1000000n).toLocaleString('en-US')}${decimals ? `.${decimals}` : ''} ADA`;
}

function expandable(title, text) {
  const details = node('details', 'raw-detail');
  details.append(node('summary', '', title), node('pre', '', text));
  return details;
}

function copyButton(label, value) {
  const button = node('button', 'copy-button', label);
  button.type = 'button';
  button.onclick = async () => {
    try { await navigator.clipboard.writeText(value); button.textContent = 'Copied'; }
    catch { button.textContent = 'Copy unavailable'; }
    setTimeout(() => { button.textContent = label; }, 1800);
  };
  return button;
}

function assetList(assets) {
  const list = node('div', 'asset-list');
  list.append(node('small', '', 'Asset quantities in raw units'));
  for (const asset of assets) {
    const item = node('div', 'asset');
    const printable = asset.name && !/[\u0000-\u001f\u007f-\u009f]/.test(asset.name);
    item.append(node('strong', '', `${BigInt(asset.quantity).toLocaleString('en-US')} × ${printable ? asset.name : asset.nameHex || '(empty asset name)'}`),
      node('small', 'hash', `Policy ${asset.policyId}`), node('small', 'hash', `Name hex ${asset.nameHex || '(empty)'}`));
    list.append(item);
  }
  return list;
}

function inputList(title, inputs) {
  const section = node('section', 'tx-section');
  section.append(node('h4', '', `${title} · ${inputs.length}`));
  for (const input of inputs) section.append(node('div', 'input-ref hash', `${input.txId}#${input.index}`));
  return section;
}

function outputCard(output, title) {
  const card = node('div', 'output');
  const top = node('div', 'output-title');
  top.append(node('span', '', title), node('strong', '', formatAda(output.lovelace)));
  card.append(top, node('div', 'hash output-address', output.address));
  if (output.assets.length) card.append(assetList(output.assets));
  if (output.datum) {
    card.append(node('small', 'hash', `${output.datum.type === 'inline' ? 'Inline datum' : 'Datum'} · ${output.datum.hash}`));
    if (output.datum.json) card.append(expandable('Datum content', output.datum.json));
  }
  if (output.referenceScriptHash) card.append(node('small', 'hash', `Reference script · ${output.referenceScriptHash}`));
  return card;
}

function transactionContent(tx, block) {
  const content = node('div', 'tx-content');
  const identity = node('div', 'tx-identity');
  identity.append(node('div', 'hash', tx.id), copyButton('Copy ID', tx.id));
  content.append(identity, node('p', 'note', `${block.era.replace(/Era$/, '')} · Slot ${block.point.slot} · ${tx.sizeBytes.toLocaleString()} bytes · Fee ${formatAda(tx.feeLovelace)}`));
  if (tx.scriptValidity === 'invalid') content.append(node('p', 'tx-warning', 'Marked script-invalid by the block. Regular outputs below are not applied; collateral is used instead.'));
  const flow = node('div', 'tx-flow');
  const inputs = inputList('Inputs', tx.inputs);
  inputs.append(node('p', 'note', 'Previous output references. Addresses and amounts require historical UTxO data.'));
  const outputs = node('section', 'tx-section');
  outputs.append(node('h4', '', `Outputs · ${tx.outputs.length}`),
    node('p', 'note', 'Includes any change outputs; this is not a payment total.'));
  tx.outputs.forEach((output, index) => outputs.append(outputCard(output, `Output #${index}`)));
  flow.append(inputs, outputs); content.append(flow);
  if (tx.mint.length) {
    const mint = node('section', 'tx-section');
    mint.append(node('h4', '', 'Mint / burn'), node('p', 'note', 'Raw asset quantities. Negative values are burns.'), assetList(tx.mint));
    content.append(mint);
  }
  const validity = tx.validity;
  content.append(node('p', 'note', `Validity slots: ${validity.fromSlot ?? 'no lower bound'} → ${validity.untilSlot ? `${validity.untilSlot} (exclusive)` : 'no upper bound'}`));
  if (tx.metadataJson) content.append(expandable('Transaction metadata', tx.metadataJson));
  if (tx.referenceInputs.length) content.append(inputList('Reference inputs (not spent)', tx.referenceInputs));
  if (tx.collateralInputs.length) content.append(inputList('Collateral inputs', tx.collateralInputs));
  if (tx.totalCollateralLovelace !== null) content.append(node('p', 'note', `Total collateral: ${formatAda(tx.totalCollateralLovelace)}`));
  if (tx.collateralReturn) content.append(outputCard(tx.collateralReturn, 'Collateral return'));
  if (tx.withdrawals.length) {
    const withdrawals = node('section', 'tx-section');
    withdrawals.append(node('h4', '', 'Reward withdrawals'));
    for (const withdrawal of tx.withdrawals) withdrawals.append(node('p', 'hash', `${withdrawal.address} · ${formatAda(withdrawal.lovelace)}`));
    content.append(withdrawals);
  }
  if (tx.requiredSigners.length) content.append(expandable('Required signer hashes', tx.requiredSigners.join('\n')));
  const raw = expandable('Raw transaction CBOR', tx.cborHex);
  raw.append(copyButton('Copy CBOR', tx.cborHex)); content.append(raw);
  return content;
}

export function transactionFeed(root, empty, search) {
  let entries = [];
  function filter() {
    const query = search.value.trim().toLowerCase();
    for (const entry of entries) entry.card.hidden = !entry.search.includes(query);
    empty.hidden = entries.some(entry => !entry.card.hidden);
    empty.textContent = entries.length ? 'No matching transactions in the recent feed.' : 'Waiting for transactions. Connect with “Include transactions” enabled.';
  }
  search.addEventListener('input', filter);
  return {
    reset() { entries = []; root.replaceChildren(); filter(); },
    add(block) {
      for (let index = block.transactions.length - 1; index >= 0; index--) {
        const tx = block.transactions[index], card = node('details', 'tx-card');
        const summary = node('summary', 'tx-summary');
        const title = node('div', 'tx-title'), badge = node('span', 'tx-badge', 'In block');
        title.append(node('span', 'hash tx-id', tx.id), badge);
        const overview = node('div', 'tx-overview');
        overview.append(node('strong', '', `${formatAda(tx.outputLovelace)} in outputs`),
          node('span', '', `${tx.inputs.length} inputs → ${tx.outputs.length} outputs`),
          node('span', '', `Fee ${formatAda(tx.feeLovelace)}`));
        const tags = node('div', 'tx-tags');
        tags.append(node('span', '', `Slot ${block.point.slot}`));
        const assets = tx.outputs.reduce((total, output) => total + output.assets.length, 0);
        if (assets) tags.append(node('span', '', `${assets} asset entries`));
        if (tx.mint.length) tags.append(node('span', '', 'Mint / burn'));
        if (tx.metadataJson) tags.append(node('span', '', 'Metadata'));
        if (tx.scriptValidity === 'invalid') tags.append(node('span', 'tx-warning', 'Script-invalid'));
        summary.append(title, overview, tags); card.append(summary);
        card.addEventListener('toggle', () => {
          if (card.open && card.children.length === 1) card.append(transactionContent(tx, block));
        });
        const searchable = [tx.id, ...tx.inputs.map(input => input.txId), ...tx.outputs.map(output => output.address),
          ...tx.outputs.flatMap(output => output.assets).concat(tx.mint).flatMap(asset => [asset.policyId, asset.name, asset.nameHex])].join(' ').toLowerCase();
        entries.unshift({ card, badge, point: block.point, search: searchable }); root.prepend(card);
        if (entries.length > 60) entries.pop().card.remove();
      }
      filter();
    },
    rollback(point) {
      for (const entry of entries) {
        if (point.origin || BigInt(entry.point.slot) > BigInt(point.slot) ||
          (entry.point.slot === point.slot && entry.point.hash !== point.hash)) {
          entry.card.classList.add('tx-rolled-back'); entry.badge.textContent = 'Rolled back';
        }
      }
    },
  };
}
