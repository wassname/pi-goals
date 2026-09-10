import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const actual = readFileSync(new URL('../greeting.txt', import.meta.url));
const expected = Buffer.from('hello worker\n', 'utf8');
assert.equal(actual.length, 13, 'greeting.txt must contain exactly 13 bytes');
assert.deepEqual(actual, expected, 'greeting.txt must contain exactly hello worker followed by LF');
console.log('PASS: greeting.txt equals hello worker\\n (13 bytes)');
