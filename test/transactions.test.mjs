import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAda } from '../web/transactions.mjs';

test('ADA formatting preserves sub-ADA and amounts beyond safe JS integers', () => {
  assert.equal(formatAda('1'), '0.000001 ADA');
  assert.equal(formatAda('1000000'), '1 ADA');
  assert.equal(formatAda('9007199254740993'), '9,007,199,254.740993 ADA');
  assert.equal(formatAda('-1234567'), '−1.234567 ADA');
});
