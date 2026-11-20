import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';

const invalid = () => { throw new Error('invalid pi-focus v1 snapshot'); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const field = (value, limit = 500) => {
  if (typeof value !== 'string' || [...value].length > limit) invalid();
  return value;
};
const id = value => {
  if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(field(value, 200))) invalid();
  return value;
};
const list = (value, limit = 8, length = 500) => {
  if (!Array.isArray(value) || value.length > limit) invalid();
  return value.map(item => field(item, length));
};
function container(value, kind, parentId) {
  if (!record(value) || value.kind !== kind || value.parentId !== parentId ||
      !Number.isInteger(value.revision) || value.revision < 1) invalid();
  const copy = { kind, parentId, id: id(value.id), revision: value.revision };
  for (const key of ['name', 'createdAt', 'updatedAt', 'goals', 'scope', 'constraints']) copy[key] = field(value[key]);
  if (!copy.name || !copy.createdAt || !copy.updatedAt) invalid();
  for (const key of ['planningDocs', 'refs', 'notes']) copy[key] = list(value[key]);
  if (value.activation !== undefined) {
    if (!record(value.activation)) invalid();
    copy.activation = {};
    for (const key of ['tools', 'monitors', 'scripts', 'agents']) {
      if (value.activation[key] !== undefined) copy.activation[key] = list(value.activation[key], key === 'tools' ? 128 : 8, key === 'tools' ? 200 : 500);
    }
    if (value.activation.loadoutPreset !== undefined) copy.activation.loadoutPreset = field(value.activation.loadoutPreset);
  }
  return copy;
}

export function normalizeFocus(value) {
  if (value === undefined) return undefined;
  if (!record(value) || value.version !== 1 || !['context', 'active'].includes(value.mode) ||
      !isAbsolute(value.sourceRoot ?? '') || !isAbsolute(value.sourceCwd ?? '') || !record(value.active)) invalid();
  const focus = container(value.active.focus, 'focus', null);
  const subfocus = value.active.subfocus === null ? null : container(value.active.subfocus, 'subfocus', focus.id);
  const copy = { version: 1, mode: value.mode, sourceRoot: field(value.sourceRoot, 4096),
    sourceCwd: field(value.sourceCwd, 4096), capturedAt: field(value.capturedAt), active: { focus, subfocus } };
  if (!copy.capturedAt) invalid();
  if (copy.mode === 'active') {
    if (typeof value.extensionPath !== 'string' || !isAbsolute(value.extensionPath)) throw new Error('pi-focus activation requires an absolute extension path');
    copy.extensionPath = field(value.extensionPath, 4096);
  }
  if (Buffer.byteLength(JSON.stringify(copy.active)) > 24000) invalid();
  return copy;
}

export function captureFocus(entries, sourceRoot, sourceCwd, mode = 'context', extensionPath) {
  if (!['context', 'active', 'none'].includes(mode)) throw new Error('invalid focus mode');
  if (mode === 'none') return undefined;
  const entry = [...entries].reverse().find(item => item.type === 'custom' && item.customType === 'pi-focus:binding');
  if (!entry || entry.data?.version === 1 && entry.data.active === null) {
    if (mode === 'active') throw new Error('pi-focus activation requires an active focus');
    return undefined;
  }
  if (entry.data?.version !== 1) invalid();
  // Match pi-focus's project boundary, which may be a nested .agents directory.
  for (let current = resolve(sourceCwd); ; current = dirname(current)) {
    if (existsSync(join(current, '.agents')) || existsSync(join(current, '.git'))) { sourceRoot = current; break; }
    if (dirname(current) === current) break;
  }
  const snapshot = normalizeFocus({ version: 1, mode, sourceRoot: resolve(sourceRoot), sourceCwd: resolve(sourceCwd),
    capturedAt: new Date().toISOString(), active: entry.data.active, ...(mode === 'active' ? { extensionPath } : {}) });
  if (mode === 'active') {
    try { if (!statSync(snapshot.extensionPath).isFile()) throw new Error('not a file'); }
    catch { throw new Error(`pi-focus extension unavailable: ${snapshot.extensionPath}`); }
  }
  return snapshot;
}

export function formatFocus(value) {
  const snapshot = normalizeFocus(value);
  if (!snapshot) return '';
  const path = ref => /^[a-z][a-z0-9+.-]*:/i.test(ref) || isAbsolute(ref) ? ref : resolve(snapshot.sourceRoot, ref);
  const lines = ['# Inherited focus', `Captured: ${snapshot.capturedAt}`, `Source project: ${snapshot.sourceRoot}`,
    'This is the submitting session’s focus snapshot, not its conversation.',
    'Focus declarations do not by themselves activate tools, loadouts, or runbooks.'];
  for (const item of [snapshot.active.focus, snapshot.active.subfocus].filter(Boolean)) {
    const dir = join(snapshot.sourceRoot, '.agents/focus/foci', snapshot.active.focus.id,
      ...(item.kind === 'subfocus' ? ['subfocuses', item.id] : []));
    lines.push(`\n${item.kind}: ${item.name} (${item.id}), revision ${item.revision}`);
    for (const key of ['goals', 'scope', 'constraints']) if (item[key]) lines.push(`${key}: ${item[key]}`);
    for (const key of ['planningDocs', 'refs']) if (item[key].length) lines.push(`${key}:\n${item[key].map(path).join('\n')}`);
    if (item.notes.length) lines.push(`notes:\n${item.notes.join('\n')}`);
    lines.push(`Focus directory: ${dir}`, `Knowledge base: ${join(dir, 'kb')}`, `State: ${join(dir, 'state')}`);
  }
  return lines.join('\n');
}
