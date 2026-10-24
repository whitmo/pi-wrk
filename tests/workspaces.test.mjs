import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSwarmWorkspaces, integrateSwarm } from '../src/workspaces.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (result.status) throw new Error(`${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'wrk-swarm-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, 'add', 'base.txt'); git(root, 'commit', '-qm', 'base');
  return root;
}
function commit(workspace, name, content) {
  writeFileSync(join(workspace.projectRoot, name), content);
  git(workspace.projectRoot, 'add', name);
  git(workspace.projectRoot, 'commit', '-qm', name);
}

test('independent child commits combine in retained integration branch without changing original checkout', t => {
  const root = repo(t);
  const base = git(root, 'rev-parse', 'HEAD');
  const spaces = createSwarmWorkspaces({ projectRoot: root, cwd: root, id: 'job' });
  assert.equal(spaces.children.length, 2);
  assert.notEqual(spaces.children[0].projectRoot, spaces.children[1].projectRoot);
  assert.notEqual(spaces.integration.projectRoot, root);
  for (const [n, child] of spaces.children.entries()) commit(child, `child${n}.txt`, `own${n}\n`);
  const report = integrateSwarm(spaces);
  assert.match(report, /integrat/i);
  assert.match(report, /commits: 2/);
  assert.equal(readFileSync(join(spaces.integration.projectRoot, 'child0.txt'), 'utf8'), 'own0\n');
  assert.equal(readFileSync(join(spaces.integration.projectRoot, 'child1.txt'), 'utf8'), 'own1\n');
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('dirty and non-git roots are refused rather than shared with children', t => {
  const root = repo(t);
  writeFileSync(join(root, 'untracked'), 'dirty');
  assert.throws(() => createSwarmWorkspaces({ projectRoot: root, cwd: root }), /clean|dirty/i);
  const outside = mkdtempSync(join(tmpdir(), 'wrk-no-git-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => createSwarmWorkspaces({ projectRoot: outside, cwd: outside }), /git/i);
});

test('child without commits reports no changes and conflicting commits retain unresolved worktree', t => {
  const root = repo(t);
  const spaces = createSwarmWorkspaces({ projectRoot: root, cwd: root });
  assert.match(integrateSwarm(spaces), /commits: 0/);
  const other = createSwarmWorkspaces({ projectRoot: root, cwd: root });
  commit(other.children[0], 'base.txt', 'first\n');
  commit(other.children[1], 'base.txt', 'second\n');
  assert.throws(() => integrateSwarm(other), error => {
    assert.match(error.message, /conflict/i);
    assert.match(error.message, /wrk\/integration-/);
    assert.match(error.message, /\.agents\/worktrees/);
    return true;
  });
  assert.equal(readFileSync(join(root, 'base.txt'), 'utf8'), 'base\n');
  assert.equal(git(root, 'branch', '--show-current'), 'main');
  assert.match(git(other.integration.projectRoot, 'status', '--porcelain'), /^UU base.txt/m);
});
