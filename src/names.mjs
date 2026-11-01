import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { admitJob } from './store.mjs';

export function loadNameWords(path) {
  const verbs = new Set(), nouns = new Set();
  const rows = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (rows.shift() !== 'Word,Size,Part of Speech') throw new Error('invalid work-item words header');
  for (const row of rows) {
    const match = /^([^,]+),(\d+),([^,]+)$/.exec(row);
    if (!match) continue;
    const [, raw, size, part] = match;
    const word = raw.toLowerCase();
    if (!/^[a-z]+$/.test(word) || word.length !== Number(size) || /proper|name|article|pronoun/i.test(part)) continue;
    const categories = part.split('/').map(value => value.trim());
    if (categories.includes('Verb')) verbs.add(word);
    if (categories.includes('Noun')) nouns.add(word);
  }
  if (!verbs.size || !nouns.size) throw new Error('work-item words require verbs and nouns');
  return { verbs: [...verbs], nouns: [...nouns] };
}

export function generateName(words, randomIndex = randomInt) {
  return `${words.verbs[randomIndex(words.verbs.length)]}.${words.nouns[randomIndex(words.nouns.length)]}.${randomIndex(10)}`;
}

export function admitNamedJob(storeDir, input, words, randomIndex = randomInt, admit = admitJob) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { return admit(storeDir, { ...input, name: generateName(words, randomIndex) }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('could not allocate unique work-item name after 30 attempts');
}
