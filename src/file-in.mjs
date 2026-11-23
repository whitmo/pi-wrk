import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  constants, closeSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readlinkSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const LEASE_MS = 15_000;
const MAX_BYTES = 1_048_576;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const rootPath = storeDir => {
  const dir = resolve(storeDir);
  return basename(dir) === 'wrk' && basename(dirname(dir)) === '.agents'
    ? join(dirname(dir), 'pi', 'file-in') : join(dir, 'file-in');
};
const handlesPath = storeDir => join(rootPath(storeDir), 'handles');
const registryPath = storeDir => join(rootPath(storeDir), 'sessions');
const recordPath = (storeDir, id) => join(registryPath(storeDir), `${id}.json`);
const slug = text => String(text || 'pi').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 35) || 'pi';
const dirs = dir => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw Error('file-in directory cannot be a symlink');
};
const record = (storeDir, item) => {
  dirs(registryPath(storeDir));
  const path = recordPath(storeDir, item.sessionId);
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(item), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
};
function sessions(storeDir) {
  if (!existsSync(registryPath(storeDir))) return [];
  return readdirSync(registryPath(storeDir)).filter(n => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(n)).flatMap(n => {
    try {
      const item = JSON.parse(readFileSync(join(registryPath(storeDir), n), 'utf8'));
      return validId(item.sessionId) && validId(item.handle) ? [item] : [];
    } catch { return []; }
  });
}
export function listSessions(storeDir, now = Date.now()) {
  return sessions(storeDir).map(item => ({ ...item, live: !item.closed && now - item.updatedAt < LEASE_MS }));
}
export function addresses(storeDir, handle) {
  const handles = handlesPath(storeDir);
  const paths = key => ({ mailbox: join(handles, key), fifo: join(handles, `${key}.fifo`) });
  return { handles, ...(handle ? paths(handle) : {}), general: paths('general') };
}
function makeFifo(path) {
  dirs(dirname(path));
  if (!existsSync(path)) {
    const result = spawnSync('mkfifo', [path], { encoding: 'utf8' });
    if (result.status !== 0 && !existsSync(path)) throw Error(`mkfifo failed: ${result.stderr || result.error}`);
  }
  if (!lstatSync(path).isFIFO()) throw Error(`not a FIFO: ${path}`);
}
export function registerSession(storeDir, sessionId, name) {
  if (!validId(sessionId)) throw Error('invalid session ID');
  const previous = sessions(storeDir).find(s => s.sessionId === sessionId);
  let handle = previous?.handle;
  if (!handle) {
    const suffix = slug(sessionId).slice(-24);
    handle = `${slug(name)}-${suffix}`;
    if (sessions(storeDir).some(s => s.handle === handle)) handle = `${slug(name)}-${slug(sessionId)}`;
  }
  if (!validId(handle) || handle === 'general') throw Error('invalid file-in handle');
  const canonical = addresses(storeDir, handle);
  dirs(rootPath(storeDir));
  dirs(handlesPath(storeDir));
  dirs(canonical.mailbox);
  for (const sub of ['pending', 'processed', 'failed']) dirs(join(canonical.mailbox, sub));
  makeFifo(canonical.fifo);
  makeFifo(addresses(storeDir).general.fifo);
  const displayName = name === undefined ? (previous?.name === sessionId ? '' : previous?.name ?? '') : name;
  let alias = displayName ? `${slug(displayName)}-${slug(sessionId).slice(-8)}` : handle;
  if (sessions(storeDir).some(s => s.sessionId !== sessionId && (s.alias === alias || s.handle === alias)))
    alias = `${slug(displayName)}-${slug(sessionId).slice(-24)}`;
  if (alias !== handle) {
    const handleDir = handlesPath(storeDir);
    for (const [path, target] of [[join(handleDir, alias), handle], [join(handleDir, `${alias}.fifo`), `${handle}.fifo`]]) {
      try {
        if (readlinkSync(path) !== target) throw Error(`file-in name already taken: ${alias}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        symlinkSync(target, path);
      }
    }
  }
  record(storeDir, { sessionId, handle, alias, name: displayName || sessionId, updatedAt: Date.now(), closed: false });
  if (previous?.alias && previous.alias !== handle && previous.alias !== alias) {
    for (const path of [join(handlesPath(storeDir), previous.alias), join(handlesPath(storeDir), `${previous.alias}.fifo`)])
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) unlinkSync(path);
  }
  return { handle, ...addresses(storeDir, alias) };
}
export function closeSession(storeDir, sessionId) {
  const item = sessions(storeDir).find(s => s.sessionId === sessionId);
  if (item) record(storeDir, { ...item, closed: true });
}
function resolveHandle(storeDir, destination) {
  if (destination === 'general' || destination === addresses(storeDir).general.mailbox || destination === addresses(storeDir).general.fifo) return 'general';
  if (isAbsolute(destination)) {
    const file = basename(destination);
    const name = file.endsWith('.fifo') ? file.slice(0, -5) : file;
    if (destination !== addresses(storeDir, name).mailbox && destination !== addresses(storeDir, name).fifo)
      throw Error('address outside file-in handles');
    destination = name;
  }
  if (!validId(destination)) throw Error('invalid recipient handle');
  const recipient = sessions(storeDir).find(s => s.handle === destination || s.alias === destination);
  if (!recipient) throw Error(`unknown file-in handle: ${destination}`);
  return recipient.handle;
}
function writePending(storeDir, handle, content) {
  const mailbox = addresses(storeDir, handle).mailbox;
  dirs(rootPath(storeDir));
  dirs(handlesPath(storeDir));
  dirs(mailbox);
  const pending = join(mailbox, 'pending');
  dirs(pending);
  const file = `${Date.now()}-${randomUUID()}.md`, temp = join(pending, `.${file}.tmp`);
  writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
  renameSync(temp, join(pending, file));
  return join(pending, file);
}
export function sendMarkdown(storeDir, destination, content) {
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > MAX_BYTES) throw Error('file-in Markdown must be 1..1048576 bytes');
  const handle = resolveHandle(storeDir, destination);
  const targets = handle === 'general' ? listSessions(storeDir).filter(s => s.live).map(s => s.handle) : [handle];
  if (targets.length === 0) throw Error('no live file-in recipients');
  return targets.map(target => writePending(storeDir, target, content));
}
export function processMailbox(storeDir, sessionId, send) {
  const item = sessions(storeDir).find(s => s.sessionId === sessionId);
  if (!item) throw Error('session has no file-in handle');
  const mailbox = addresses(storeDir, item.handle).mailbox;
  const pending = join(mailbox, 'pending');
  const result = { delivered: 0, failed: 0 };
  for (const entry of readdirSync(pending, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.md')).sort((a,b) => a.name.localeCompare(b.name))) {
    const source = join(pending, entry.name);
    try {
      const text = readFileSync(source, 'utf8').trim();
      if (!text) throw Error('empty Markdown handoff');
      send(text);
      renameSync(source, join(mailbox, 'processed', entry.name));
      result.delivered++;
    } catch (error) {
      if (existsSync(source)) renameSync(source, join(mailbox, 'failed', entry.name));
      result.failed++;
    }
  }
  return result;
}
export function createPipeBroker(storeDir) {
  const readers = new Map();
  function poll() {
    const active = listSessions(storeDir).filter(s => s.live).map(s => s.handle);
    const wanted = new Set(['general', ...active]);
    for (const [handle, reader] of readers) if (!wanted.has(handle)) { closeSync(reader.fd); readers.delete(handle); }
    for (const handle of wanted) {
      if (readers.has(handle)) continue;
      const fifo = addresses(storeDir, handle).fifo;
      makeFifo(fifo);
      readers.set(handle, { fd: openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK), chunks: [], bytes: 0, overflow: false });
    }
    for (const [handle, reader] of readers) {
      const buffer = Buffer.allocUnsafe(8192);
      for (;;) {
        let count;
        try { count = readSync(reader.fd, buffer, 0, buffer.length, null); }
        catch (error) { if (error.code === 'EAGAIN') break; throw error; }
        if (count) {
          reader.bytes += count;
          if (reader.bytes > MAX_BYTES) reader.overflow = true;
          else reader.chunks.push(Buffer.from(buffer.subarray(0, count)));
          continue;
        }
        if (reader.bytes) {
          const content = reader.overflow ? null : Buffer.concat(reader.chunks).toString('utf8');
          reader.bytes = 0; reader.chunks = []; reader.overflow = false;
          if (content) {
            try { sendMarkdown(storeDir, handle, content); }
            catch (error) { console.error(`file-in pipe delivery failed for ${handle}: ${error}`); }
          }
        }
        break;
      }
    }
    // CIPR's original untargeted inbox is the general broadcast address.
    const inbox = rootPath(storeDir);
    if (!active.length) return; // Leave legacy messages durable until a recipient is live.
    for (const entry of readdirSync(inbox, { withFileTypes: true }).filter(e => e.isFile() && !e.name.startsWith('.'))) {
      const source = join(inbox, entry.name);
      try { if (Date.now() - statSync(source).mtimeMs < 250) continue; }
      catch { continue; } // The writer may have moved the file.
      const target = sub => {
        const dir = join(inbox, sub); dirs(dir);
        const path = join(dir, entry.name);
        return existsSync(path) ? join(dir, `${entry.name}.${randomUUID()}`) : path;
      };
      try {
        const content = readFileSync(source, 'utf8');
        sendMarkdown(storeDir, 'general', content);
        renameSync(source, target('processed'));
      } catch (error) {
        try { renameSync(source, target('failed')); }
        catch { console.error(`file-in legacy archive failed: ${source}`); }
        console.error(`file-in legacy delivery failed: ${error}`);
      }
    }
  }
  return { poll, close() { for (const reader of readers.values()) closeSync(reader.fd); readers.clear(); } };
}
