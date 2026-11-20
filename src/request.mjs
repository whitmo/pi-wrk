import { parseDocument, isMap, isScalar } from 'yaml';

const SELECTORS = { a: ['agent', ['name', 'model']], q: ['queue', ['name']], sh: ['shell', ['command']] };
const QUEUE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function removeSeparator(text) {
  return /^\s/.test(text) ? text.slice(1) : text;
}

function consumeMap(text, type) {
  const start = type.length + 1;
  if (text[start] !== '{') throw new Error(`invalid ${type} selector`);
  let depth = 0, quote = null, escaped = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\' && quote === '"') escaped = true;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0 || (text[end] && !/\s/.test(text[end]))) throw new Error(`invalid ${type} selector`);
  const doc = parseDocument(text.slice(type.length + 1, end), { uniqueKeys: true, strict: true });
  if (doc.errors.length || !isMap(doc.contents)) throw new Error(`invalid ${type} YAML selector`);
  const fields = {};
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key) || pair.key.tag || typeof pair.key.value !== 'string' ||
        !SELECTORS[type][1].includes(pair.key.value) ||
        !isScalar(pair.value) || pair.value.tag || typeof pair.value.value !== 'string') {
      throw new Error(`invalid ${type} selector key or value`);
    }
    fields[pair.key.value] = pair.value.value;
  }
  if (type === 'q') {
    if (!QUEUE_NAME.test(fields.name ?? '') || fields.name === '..' || fields.name.includes('..'))
      throw new Error('invalid queue name');
  } else if (type === 'sh') {
    if (!fields.command?.trim()) throw new Error('empty shell command');
  } else if (!fields.name?.trim() && !fields.model?.trim()) {
    throw new Error('empty agent selector');
  }
  return [fields, removeSeparator(text.slice(end))];
}

export function parseRequest(text, { alias = '&' } = {}) {
  if (typeof text !== 'string') throw new TypeError('request text must be a string');
  if (!['&', 'bg', 'wrk'].includes(alias)) throw new Error('invalid command alias');
  let lifetime = 'session', runner = alias === 'bg' ? 'agent' : 'router';
  let options = {}, queue = null, source = text;
  const flags = {};
  while (/^--(?:lifetime|focus)(?=\s|$)/.test(source)) {
    const match = /^--(lifetime|focus)\s+(\S+)(?=\s|$)/.exec(source);
    if (!match) throw new Error('invalid lifetime or focus');
    const [, flag, value] = match;
    if (flags[flag] || !(flag === 'focus' ? ['context', 'active', 'none'] : ['session', 'independent']).includes(value))
      throw new Error(`invalid or duplicate ${flag}`);
    flags[flag] = value;
    source = removeSeparator(source.slice(match[0].length));
  }
  lifetime = flags.lifetime ?? lifetime;
  const focus = flags.focus ? { focusMode: flags.focus } : {};
  if (!source.trim()) {
    if (alias === 'wrk') throw new Error('empty task');
    return { runner: 'agent', prompt: '', options, queue, lifetime, handoff: true, ...focus };
  }
  // The prefix is the only control surface. The remainder is opaque user text.
  if (/^[A-Za-z][\w-]*:\{/.test(source) && !/^(?:a|q|sh):\{/.test(source))
    throw new Error('unknown selector');
  if (source.startsWith('q:')) {
    [options, source] = consumeMap(source, 'q');
    queue = options.name;
    options = {};
    if (/^[A-Za-z][\w-]*:\{/.test(source) && !/^(?:a|sh):\{/.test(source))
      throw new Error('unknown selector');
  }
  let explicitRunner = false;
  for (const type of ['a', 'sh']) {
    if (source.startsWith(`${type}:`)) {
      [options, source] = consumeMap(source, type);
      runner = SELECTORS[type][0];
      explicitRunner = true;
      break;
    }
  }
  if (!explicitRunner) {
    for (const keyword of ['bg', 'swarm', 'council', 'todo']) {
      if (source === keyword || (source.startsWith(keyword) && /\s/.test(source[keyword.length] ?? ''))) {
        runner = keyword === 'bg' ? 'agent' : keyword;
        source = removeSeparator(source.slice(keyword.length));
        break;
      }
    }
  }
  if (!source.trim() && runner !== 'todo' && !(runner === 'shell' && options.command))
    throw new Error('empty explicit task');
  if (runner === 'shell' && flags.focus && flags.focus !== 'none') throw new Error('focus is not supported for shell jobs');
  return { runner, prompt: source, options, queue, lifetime, handoff: false, ...focus };
}
