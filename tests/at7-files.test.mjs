import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const { collectFileMessages } = await createJiti(import.meta.url).import('../extensions/at7-files.ts');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args]);

test('tracked symlink pointing outside the worktree is never read as a work file', async t => {
  const root = mkdtempSync(join(tmpdir(), 'at7-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'at7-private-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  git(root, 'init', '-q');
  writeFileSync(join(outside, 'private.txt'), '# @@7 never read');
  symlinkSync(join(outside, 'private.txt'), join(root, 'pointer'));
  git(root, 'add', 'pointer');
  assert.deepEqual(await collectFileMessages(root, 'all', new Set()), []);
});

test('changed scope only collects added comment markers across staged, unstaged and untracked files', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'at7-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(root, 'old file.ts'), '// @@7 old message\nold line\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'seed');
  writeFileSync(join(root, 'old file.ts'), '// @@7 old message\nchanged line\n// @@7 fresh unstaged\n');
  writeFileSync(join(root, 'staged.ts'), '# @@7 staged request\n');
  git(root, 'add', 'staged.ts');
  mkdirSync(join(root, 'space dir'));
  writeFileSync(join(root, 'space dir', 'untracked.ts'), '/* @@7 untracked ask */\nconst x = "@@7 not a comment";\nordinary prose @@7\n// @@7\n');
  writeFileSync(join(root, 'ignored.txt'), '// @@7 ignored\n');
  const found = await collectFileMessages(root, 'changed', new Set());
  assert.deepEqual(found.map(({ location, text }) => [location, text]).sort(), [
    ['old file.ts:3', 'fresh unstaged'], ['space dir/untracked.ts:1', 'untracked ask'], ['staged.ts:1', 'staged request'],
  ]);
  assert.deepEqual(await collectFileMessages(root, 'changed', new Set(found.map(item => item.key))), []);
  const all = await collectFileMessages(root, 'all', new Set());
  assert.equal(all.some(item => item.location === 'old file.ts:1' && item.text === 'old message'), true);
  assert.equal(all.some(item => item.location.includes('ignored')), false);
});

test('comment tags describe an addressed message, not terminal input', async () => {
  const { message } = await createJiti(import.meta.url).import('../extensions/at7-files.ts');
  const tagged = message('file', 'src/a.ts:1', '// @@7:@BEACON @@7:+writer @@7::BEACON check');
  assert.equal(tagged?.recipient, 'BEACON');
  assert.equal(tagged?.author, 'writer');
  assert.equal(tagged?.claimedBy, 'BEACON');
  assert.equal(tagged?.text, 'check');
  assert.equal(message('file', 'src/a.ts:1', '// @@7 check')?.text, 'check');
  assert.equal(message('file', 'src/a.ts:1', '// @@7:@agent#1.v_2-x check')?.recipient, 'agent#1.v_2-x');
  assert.equal(message('file', 'src/a.ts:1', '// @@7:@sensible-yak:term check'), undefined);
  assert.equal(message('file', 'src/a.ts:1', '// @@7:@BEACON'), undefined);
  assert.equal(message('zellij', 'tab', '@@7 hello')?.text, 'hello');
});
