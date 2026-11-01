import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNameWords, generateName, admitNamedJob } from '../src/names.mjs';
import { storePath, listJobs } from '../src/store.mjs';

test('CSV categories include either order, exclude proper names and articles, and deduplicate', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wrk-words-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'words.csv');
  writeFileSync(path, 'Word,Size,Part of Speech\nact,3,Noun / Verb\nact,3,Verb / Noun\nbake,4,Verb\nrock,4,Noun\nfake,4,Verb,extra\nAda,3,Noun (Proper / Name)\na,1,Article / Determiner\nhe,2,Pronoun\ninvalid,2,Verb\n');
  const words = loadNameWords(path);
  assert.deepEqual(words.verbs, ['act', 'bake']);
  assert.deepEqual(words.nouns, ['act', 'rock']);
  assert.equal(generateName(words, () => 0), 'act.act.0');
  assert.equal(generateName(words, max => max - 1), 'bake.rock.9');
});

test('bounded retries pick a new candidate after a collision, then fail visibly at exhaustion', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wrk-claims-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = { ownerId: 'owner', projectRoot: dir, cwd: dir, request: { runner: 'agent', prompt: 'work', lifetime: 'session' } };
  const words = { verbs: ['act'], nouns: ['rock'] };
  const first = admitNamedJob(storePath(dir), input, words, () => 0);
  let n = 0;
  const second = admitNamedJob(storePath(dir), input, words, max => max === 10 && n++ > 0 ? 1 : 0);
  assert.equal(first.name, 'act.rock.0');
  assert.equal(second.name, 'act.rock.1');
  assert.throws(() => admitNamedJob(storePath(dir), input, words, () => 0), /unique.*name/i);
  assert.equal(listJobs(storePath(dir)).length, 2);
});
