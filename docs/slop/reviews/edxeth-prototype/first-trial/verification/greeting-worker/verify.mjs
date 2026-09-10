import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const actual = readFileSync(new URL('../../greeting.txt', import.meta.url));
console.log(JSON.stringify({ length: actual.length, hex: actual.toString('hex'), bytes: [...actual] }));
assert.deepEqual(actual, Buffer.from('hello worker\n'));
assert.equal(actual.length, 13);
console.log('PASS: full Buffer equality and length 13');
