import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, dirname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr?.trim() || result.stdout?.trim() || result.error?.message}`);
  return result.stdout.trim();
}

export function createAt7Workspace(projectRoot, workingDirectory) {
  const root = realpathSync(projectRoot);
  const cwd = realpathSync(workingDirectory);
  const inside = relative(root, cwd);
  if (inside === '..' || inside.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(inside))
    throw new Error('@@7 cwd must be inside its owner checkout');
  if (git(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('@@7 requires a Git checkout root');
  const branch = `wrk/at7-${randomUUID()}`;
  const path = mkdtempSync(join(tmpdir(), 'wrk-at7-'));
  try { git(root, ['worktree', 'add', '-b', branch, path, 'HEAD']); }
  catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
  const target = join(path, inside);
  return { projectRoot: path, cwd: existsSync(target) ? target : path, branch };
}

/** Never force-remove worktrees with local changes; the branch keeps committed results. */
export function cleanupAt7Workspace(projectRoot, workspace) {
  const root = realpathSync(projectRoot);
  const path = realpathSync(workspace);
  if (!path.startsWith(realpathSync(tmpdir()) + sep) || !/^wrk-at7-[\w-]+$/.test(basename(path)))
    throw new Error('@@7 cleanup refused an unrecognized worktree');
  if (git(root, ['rev-parse', '--show-toplevel']) !== root ||
      !git(root, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${path}`))
    throw new Error('@@7 cleanup refused a foreign worktree');
  if (git(path, ['status', '--porcelain'])) return false;
  git(root, ['worktree', 'remove', '--', path]);
  return true;
}

export function createSwarmWorkspaces(job) {
  if (!isAbsolute(job.projectRoot) || !isAbsolute(job.cwd)) throw new Error('swarm requires absolute checkout paths');
  const root = realpathSync(job.projectRoot);
  const cwd = realpathSync(job.cwd);
  const inside = relative(root, cwd);
  if (inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside))
    throw new Error('swarm requires a checkout cwd inside project root');
  let checkout;
  try { checkout = git(root, ['rev-parse', '--show-toplevel']); }
  catch { throw new Error('swarm requires a git checkout'); }
  if (checkout !== root) throw new Error('swarm project root must be git checkout root');
  if (git(root, ['status', '--porcelain'])) throw new Error('swarm requires a clean git checkout (dirty root refused)');
  const base = git(root, ['rev-parse', 'HEAD']);
  // Local runtime worktrees must not dirty the submitting checkout or
  // require a tracked .gitignore edit.
  const exclude = resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']));
  const pattern = '/.agents/worktrees/wrk-*/';
  mkdirSync(dirname(exclude), { recursive: true });
  if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').split('\n').includes(pattern))
    appendFileSync(exclude, `\n${pattern}\n`);
  const directory = join(root, '.agents', 'worktrees');
  mkdirSync(directory, { recursive: true });
  const create = role => {
    const id = randomUUID();
    const branch = `wrk/${role}-${id}`;
    const path = join(directory, `wrk-${role}-${id}`);
    git(root, ['worktree', 'add', '-b', branch, path, base]);
    return { projectRoot: path, cwd: join(path, relative(root, cwd)), branch };
  };
  const integration = create('integration');
  const children = [create('child'), create('child')];
  return { base, integration, children };
}

export function integrateSwarm(workspaces) {
  const { base, integration, children } = workspaces;
  let count = 0;
  for (const child of children) {
    if (git(child.projectRoot, ['branch', '--show-current']) !== child.branch ||
        git(child.projectRoot, ['status', '--porcelain']))
      throw new Error(`swarm child has uncommitted changes or switched branch; retained ${child.branch} at ${child.projectRoot}`);
    git(child.projectRoot, ['merge-base', '--is-ancestor', base, child.branch]);
    const commits = git(child.projectRoot, ['rev-list', '--reverse', `${base}..${child.branch}`]).split('\n').filter(Boolean);
    for (const commit of commits) {
      try { git(integration.projectRoot, ['cherry-pick', commit]); }
      catch (error) {
        throw new Error(`swarm integration conflict; retained ${integration.branch} at ${integration.projectRoot}; child ${child.branch} at ${child.projectRoot}: ${error.message}`);
      }
      count++;
    }
  }
  return `integration branch ${integration.branch} at ${integration.projectRoot}; commits: ${count}; children: ${children.map(child => `${child.branch} at ${child.projectRoot}`).join(', ')}`;
}
