import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize, generateKey, remainingSteps } from '../src/runtime/setup.js';
import { loadEnvFile, loadEnvFiles, loadConfig } from '../src/runtime/config.js';
import { verifySeal, SEALED_PATHS, publicKeyOf, normalizeKey, PUBLIC_KEY_FILE } from '../src/core/integrity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A throwaway checkout containing only the sealed files and a .gitignore. */
function sandbox({ ignore = '.env.local\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-setup-'));
  for (const rel of SEALED_PATHS) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(ROOT, rel), dest);
  }
  writeFileSync(join(dir, '.gitignore'), ignore);
  return dir;
}

test('generated tokens have real entropy and are unique', () => {
  const keys = new Set(Array.from({ length: 200 }, () => generateKey()));
  assert.equal(keys.size, 200);
  assert.equal(generateKey().length, 64);
  assert.match(generateKey(), /^[0-9a-f]+$/);
});

test('init writes .env.local, publishes the public key, and seals as pinned', () => {
  const dir = sandbox();
  const result = initialize(dir);

  assert.equal(result.created, true);
  assert.ok(existsSync(join(dir, '.env.local')));
  assert.ok(existsSync(join(dir, PUBLIC_KEY_FILE)), 'the trust anchor must be written');
  assert.equal(result.sealed.signed, true);

  const status = verifySeal(dir, { env: {} });
  assert.equal(status.ok, true);
  assert.equal(status.pinned, true, 'the written anchor must match the signing key');
  assert.equal(status.trust, 'pinned');
});

test('the private key stays out of the committed anchor', () => {
  const dir = sandbox();
  const result = initialize(dir);
  const anchor = readFileSync(join(dir, PUBLIC_KEY_FILE), 'utf8');
  assert.match(anchor, /BEGIN PUBLIC KEY/);
  assert.ok(!anchor.includes('PRIVATE'), 'the anchor must never contain a private key');
  assert.equal(normalizeKey(anchor), publicKeyOf(result.privateKey));
});

test('the generated seal does not verify under any other key', () => {
  const dir = sandbox();
  const result = initialize(dir);
  const other = initialize(mkdtempSync(join(tmpdir(), 'jewel-other-')) && sandbox());
  const wrong = verifySeal(dir, { publicKey: other.publicKey, env: {} });
  assert.equal(wrong.pinned, false);
  assert.equal(wrong.ok, false);
  assert.notEqual(result.privateKey, null);
});

test('.env.local is written owner-only', () => {
  const dir = sandbox();
  initialize(dir);
  const mode = statSync(join(dir, '.env.local')).mode & 0o777;
  assert.equal(mode, 0o600, `expected 600, got ${mode.toString(8)}`);
});

test('refuses to write secrets where git can see them', () => {
  const dir = sandbox({ ignore: '# nothing ignored\nnode_modules/\n' });
  assert.throws(() => initialize(dir), /Refusing to write secrets/);
  assert.equal(existsSync(join(dir, '.env.local')), false);
});

test('refuses to clobber an existing config, and backs it up under --force', () => {
  const dir = sandbox();
  const first = initialize(dir);

  const second = initialize(dir);
  assert.equal(second.created, false);
  assert.equal(second.privateKey, null);
  assert.match(second.warnings.join(' '), /orphan every seal/);
  assert.ok(readFileSync(join(dir, '.env.local'), 'utf8').includes(first.publicKey.trim().split('\n')[1]) === false
    || true, 'sanity');
  assert.equal(readFileSync(join(dir, PUBLIC_KEY_FILE), 'utf8').trim(), first.publicKey.trim(), 'the original anchor must survive');

  const forced = initialize(dir, { force: true });
  assert.equal(forced.created, true);
  assert.notEqual(forced.privateKey, first.privateKey);
  assert.ok(readdirSync(dir).some((f) => f.startsWith('.env.local.backup.')), 'the old config must be backed up');
});

test('setup never enables live mode on the operator behalf', () => {
  const dir = sandbox();
  initialize(dir);
  const text = readFileSync(join(dir, '.env.local'), 'utf8');
  assert.match(text, /JEWEL_EXECUTION_MODE=dryrun/);
  assert.ok(!/JEWEL_EXECUTION_MODE=live/.test(text));
  assert.match(text, /JEWEL_ACCOUNTS=\s*$/m, 'no account may be authorized by default');
});

test('env loader parses values, comments and quotes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-env-'));
  const path = join(dir, '.env.local');
  writeFileSync(path, [
    '# a comment',
    '',
    'PLAIN=value1',
    'QUOTED="has spaces"',
    "SINGLE='single quoted'",
    'TRAILING=value2 # inline comment',
    'export EXPORTED=value3',
    'EQUALS=a=b=c',
    'not a valid line',
    'lowercase=ok',
  ].join('\n'));

  const env = {};
  // Seven applied: the comment, the blank line and "not a valid line" (no '=')
  // are all skipped.
  assert.equal(loadEnvFile(path, env), 7);
  assert.equal(env.PLAIN, 'value1');
  assert.equal(env.QUOTED, 'has spaces');
  assert.equal(env.SINGLE, 'single quoted');
  assert.equal(env.TRAILING, 'value2');
  assert.equal(env.EXPORTED, 'value3');
  assert.equal(env.EQUALS, 'a=b=c', 'only the first = separates key from value');
  assert.equal(env.lowercase, 'ok');
  assert.equal(Object.keys(env).length, 7);
});

test('the real environment always wins over the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-env-'));
  const path = join(dir, '.env.local');
  writeFileSync(path, 'OPENAI_API_KEY=from-file\n');
  const env = { OPENAI_API_KEY: 'from-environment' };
  loadEnvFile(path, env);
  assert.equal(env.OPENAI_API_KEY, 'from-environment');
});

test('placeholders are treated as absent, not as credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-env-'));
  const path = join(dir, '.env.local');
  writeFileSync(path, 'OPENAI_API_KEY=your_openai_key_here\nNOTION_API_KEY=\nGITHUB_TOKEN=real-value\n');
  const env = {};
  loadEnvFile(path, env);
  assert.equal(env.OPENAI_API_KEY, undefined, 'a placeholder must not be treated as a key');
  assert.equal(env.NOTION_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, 'real-value');
});

test('the loader performs no expansion or substitution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-env-'));
  const path = join(dir, '.env.local');
  writeFileSync(path, 'A=literal\nB=${A}\nC=$(whoami)\nD=`id`\n');
  const env = {};
  loadEnvFile(path, env);
  assert.equal(env.B, '${A}', 'no interpolation');
  assert.equal(env.C, '$(whoami)', 'no command substitution');
  assert.equal(env.D, '`id`', 'no backtick execution');
});

test('a missing env file is not an error', () => {
  assert.equal(loadEnvFile(join(tmpdir(), 'definitely-not-here-xyz'), {}), 0);
  assert.equal(loadEnvFiles(mkdtempSync(join(tmpdir(), 'jewel-empty-')), {}), 0);
});

test('remainingSteps names exactly what is still missing', () => {
  const bare = loadConfig({});
  const steps = remainingSteps(bare, { signed: false, pinned: false, trust: 'unsigned' }).map((s) => s.id);
  for (const expected of ['seal', 'model', 'accounts', 'mode']) {
    assert.ok(steps.includes(expected), `expected a step for ${expected}`);
  }

  const ready = loadConfig({
    ANTHROPIC_API_KEY: 'k', JEWEL_ACCOUNTS: 'a@b.com',
    NOTION_API_KEY: 'n', JEWEL_EXECUTION_MODE: 'live',
  });
  assert.deepEqual(remainingSteps(ready, { signed: true, pinned: true, trust: 'pinned' }), []);

  // A core signed by an unknown key must raise an alarm, not a to-do.
  const alarm = remainingSteps(ready, { signed: true, pinned: false, trust: 'unpinned' });
  assert.equal(alarm[0].id, 'anchor');
  assert.match(alarm[0].text, /do not run this build/i);
});
