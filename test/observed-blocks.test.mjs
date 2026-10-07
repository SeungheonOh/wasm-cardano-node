import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCK_WINDOW, retainBlockBodies, findTransactions } from '../ui/observed-blocks.mjs';

const body = (hash, ids) => ({ type: 'block', point: { hash }, transactions: ids.map(id => ({ id })) });
test('transaction search locates its block, accepts ID prefixes, and includes all transactions', () => {
  const ids = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(64, '0'));
  const blocks = new Map([['a', body('a', ids)], ['b', body('b', ['abcdef'.padEnd(64, '0')])]]);
  assert.deepEqual(findTransactions(blocks, ids[99]), [{ hash: 'a', id: ids[99] }]);
  assert.equal(findTransactions(blocks, ' ABCDEF ')[0].hash, 'b');
  assert.deepEqual(findTransactions(blocks, ''), []);
  assert.deepEqual(findTransactions(blocks, 'not-an-id'), []);
});
test('rollback removes orphan transactions without removing retained block transactions', () => {
  const previous = new Map([['a', body('a', ['aaaa'])], ['b', body('b', ['bbbb'])]]);
  const current = retainBlockBodies(previous, { type: 'rollBackward' }, [{ hash: 'a' }]);
  assert.deepEqual(findTransactions(current, 'bbbb'), []);
  assert.equal(findTransactions(current, 'aaaa')[0].hash, 'a');
  assert.equal(retainBlockBodies(current, { type: 'rollBackward' }, []).size, 0);
});
test('header window eviction bounds memory, and late orphan bodies cannot re-enter search', () => {
  let bodies = new Map();
  const summaries = [];
  for (let i = 0; i <= BLOCK_WINDOW; i++) {
    const hash = String(i); summaries.push({ hash });
    bodies = retainBlockBodies(bodies, body(hash, [hash]), summaries);
  }
  assert.equal(bodies.size, BLOCK_WINDOW);
  assert(!bodies.has('0'));
  bodies = retainBlockBodies(bodies, body('orphan', ['aaaa']), summaries);
  assert(!bodies.has('orphan'));
  assert.deepEqual(findTransactions(bodies, 'aaaa'), []);
});
