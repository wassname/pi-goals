import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(root);
const run = mkdtempSync(join(root, 'evidence/count-worker/run-'));
console.log(`Evidence: ${run}`);
const save = (name, data) => writeFileSync(join(run, name), data);
function execute(name, command, args) {
  save(`${name}.command.json`, JSON.stringify({ command, args, cwd: root }, null, 2));
  const result = spawnSync(command, args, { cwd: root });
  save(`${name}.stdout`, result.stdout ?? Buffer.alloc(0));
  save(`${name}.stderr`, result.stderr ?? Buffer.alloc(0));
  save(`${name}.exit-status`, `${result.status}\n`);
  save(`${name}.process.json`, JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }));
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function test(name, args, expected) {
  const result = execute(name, process.execPath, ['count.mjs', ...args]);
  if (expected !== undefined) {
    assert.equal(result.status, 0, name);
    assert.deepEqual(result.stdout, Buffer.from(`${expected}\n`), name);
    assert.equal(result.stderr.length, 0, name);
  } else {
    assert.notEqual(result.status, 0, name);
    assert.equal(result.stdout.length, 0, name);
    assert.ok(result.stderr.length > 0, name);
  }
  console.log(`PASS: ${name}`);
  return result;
}
const identity = execute('identity', 'id', []);
assert.equal(identity.status, 0);
assert.notEqual(process.getuid(), 0, 'Permission test requires unprivileged execution');
save('identity.json', JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() }));
const fixture = name => join(run, name);
writeFileSync(fixture('empty'), Buffer.alloc(0));
writeFileSync(fixture('utf8'), 'é🙂\n'); // 2 + 4 + 1 = 7 UTF-8 bytes
writeFileSync(fixture('binary'), Buffer.from([0, 255, 128, 10, 13, 0]));
writeFileSync(fixture('denied'), 'private');
chmodSync(fixture('denied'), 0o000);
save('fixtures.json', JSON.stringify({ utf8: { text: 'é🙂\n', expectedBytes: 7 }, binary: { bytes: [0,255,128,10,13,0], expectedBytes: 6 }, deniedMode: '000' }, null, 2));
test('greeting', ['greeting.txt'], 13);
test('empty', [fixture('empty')], 0);
test('utf8', [fixture('utf8')], 7);
test('binary', [fixture('binary')], 6);
test('zero-args', []);
test('two-args', ['greeting.txt', fixture('empty')]);
test('nonexistent', [fixture('nonexistent')]);
let denial;
try { readFileSync(fixture('denied')); } catch (error) { denial = error.code; }
save('direct-read-denial.json', JSON.stringify({ uid: process.getuid(), code: denial }));
assert.equal(denial, 'EACCES');
const denied = test('permission-denied', [fixture('denied')]);
assert.match(denied.stderr.toString(), /EACCES/);
const ignored = execute('git-check-ignore', 'git', ['check-ignore', 'evidence/count-worker/', 'evidence/count-worker/verify.mjs', run]);
assert.equal(ignored.status, 0);
assert.equal(ignored.stdout.toString().trim().split('\n').length, 3);
const tracked = execute('git-tracked', 'git', ['ls-files', '--', 'evidence/']);
assert.equal(tracked.status, 0);
assert.equal(tracked.stdout.length, 0);
save('summary.json', JSON.stringify({ passed: true, cases: 8, evidenceIgnored: true, evidenceTracked: false }, null, 2));
console.log('PASS: all 8 CLI cases; genuine EACCES; evidence ignored and untracked');
