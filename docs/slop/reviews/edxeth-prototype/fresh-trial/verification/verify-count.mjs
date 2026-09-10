import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const project = fileURLToPath(new URL('../', import.meta.url));
const base = join(project, 'evidence/count');
mkdirSync(base, { recursive: true });
// Optional existing output directory; exclusive writes prevent overwriting evidence.
const output = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(base, 'run-'));
const fixtures = join(output, 'fixtures');
mkdirSync(fixtures);
const save = (name, data) => writeFileSync(join(output, name), data, { flag: 'wx' });
const fixture = (name, data) => {
  const path = join(fixtures, name);
  writeFileSync(path, data, { flag: 'wx' });
  return path;
};

const empty = fixture('empty', Buffer.alloc(0));
const utf8 = fixture('utf8', 'é🙂\n'); // 2 + 4 + 1 UTF-8 bytes
const binary = fixture('binary', Buffer.from([0, 255, 128, 13, 10, 0]));
const spaced = fixture('path with spaces.txt', ' a \n');
const unreadable = fixture('unreadable', 'denied\n');
chmodSync(unreadable, 0o000);

// Prove actual read denial under this invoking identity, rather than assuming
// chmod denies root. A privileged invocation fails this precondition explicitly.
let denial;
try {
  readFileSync(unreadable);
  denial = { readable: true };
} catch (error) {
  denial = { readable: false, code: error.code, message: error.message };
}
save('unreadability.json', JSON.stringify({
  uid: process.getuid?.(), gid: process.getgid?.(),
  groups: process.getgroups?.(), mode: '000', path: unreadable, ...denial,
}, null, 2) + '\n');
assert.equal(denial.readable, false, 'Read denial not established; run verifier as an unprivileged identity');
assert.equal(denial.code, 'EACCES', 'Expected real filesystem permission denial');

function check(name, args, expected) {
  const result = spawnSync(process.execPath, [join(project, 'count.mjs'), ...args], {
    cwd: project, timeout: 10000,
  });
  save(`${name}.stdout`, result.stdout ?? Buffer.alloc(0));
  save(`${name}.stderr`, result.stderr ?? Buffer.alloc(0));
  save(`${name}.exit`, `${result.status}\n`);
  if (result.error || result.signal) {
    save(`${name}.spawn.json`, JSON.stringify({ error: result.error?.message, signal: result.signal }) + '\n');
  }
  assert.ifError(result.error);
  assert.equal(result.signal, null);
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
}

check('greeting', [join(project, 'greeting.txt')], 13);
check('empty', [empty], 0);
check('utf8', [utf8], 7);
check('binary', [binary], 6);
check('spaces', [spaced], 4);
check('missing-args', []);
check('extra-args', [empty, binary]);
check('nonexistent', [join(fixtures, 'nonexistent')]);
check('unreadable', [unreadable]);
console.log(`PASS: all 9 cases; evidence: ${output}`);
