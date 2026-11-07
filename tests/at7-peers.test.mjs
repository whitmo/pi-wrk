import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const { createAt7PeerRelay } = await createJiti(import.meta.url).import('../extensions/at7-peers.ts');

function peer(id = 'sender', name = 'writer') {
  const listeners = new Map();
  const published = [];
  let registration;
  let connected = true;
  let sessions = [{ id, name }, { id: 'target', name: 'BEACON' }];
  const pi = { events: { on: (name, fn) => listeners.set(name, fn), emit: (name, value) => { if (name === 'intercom:extension-register') registration = value; } } };
  const channel = { snapshot: () => ({ connected, supported: true }), listSessions: async () => sessions, publish: (payload, options) => published.push({ payload, options }) };
  const signals = [], acks = [];
  const relay = createAt7PeerRelay(pi, () => id, { onSignal: signal => signals.push(signal), onAck: ack => acks.push(ack) });
  return { relay, get registration() { return registration; }, ready: () => registration.onReady(channel), late: () => listeners.get('intercom:extension-registry-ready')?.({}), published, signals, acks, setSessions: value => { sessions = value; }, disconnect: () => { connected = false; } };
}
const item = { key: 'comment-key', source: 'file', location: 'src/a.ts:1', text: 'check', recipient: 'BEACON', author: 'someone', claimedBy: 'else' };

test('registers in either load order; resolves exact unique live agent, not tab', async () => {
  const h = peer();
  assert.equal(h.registration.namespace, 'pi-wrk-at7');
  h.late(); h.ready();
  assert.equal(await h.relay.send(item, '/sender'), 'offered');
  assert.equal(h.published[0].options.audience, 'capable');
  assert.equal(h.published[0].payload.target, 'target');
  h.setSessions([{ id: 'sender', name: 'writer' }, { id: 'target', name: 'BEACON' }, { id: 'other', name: 'BEACON' }]);
  assert.equal(await h.relay.send({ ...item, key: 'ambiguous' }, '/sender'), 'ambiguous');
  assert.equal(await h.relay.send({ ...item, key: 'tab', recipient: 'sensible-yak:term' }, '/sender'), 'unknown');
  assert.equal(await h.relay.send({ ...item, key: 'uuid', recipient: 'target' }, '/sender'), 'offered');
  h.setSessions([{ id: 'sender', name: 'writer' }, { id: 'target', name: 'BEACON' }, { id: 'other', name: 'target' }]);
  assert.equal(await h.relay.send({ ...item, key: 'uuid2', recipient: 'target' }, '/sender'), 'offered');
  h.setSessions([{ id: 'sender', name: 'writer' }]);
  assert.equal(await h.relay.send({ ...item, key: 'missing' }, '/sender'), 'unknown');
  h.disconnect();
  assert.equal(await h.relay.send(item, '/sender'), 'unavailable');
});

test('receiver uses broker provenance, filters target; sender only accepts matching target ACK', async () => {
  const sender = peer(); sender.ready();
  await sender.relay.send(item, '/sender');
  const signal = sender.published[0].payload;
  const receiver = peer('target', 'BEACON'); receiver.ready();
  receiver.registration.onEvent({ type: 'message', fromSessionId: 'sender', payload: { ...signal, sender: 'spoofed', target: 'other' } });
  assert.equal(receiver.signals.length, 0);
  receiver.registration.onEvent({ type: 'message', fromSessionId: 'sender', payload: { ...signal, sender: 'spoofed' } });
  assert.equal(receiver.signals[0].senderSessionId, 'sender');
  receiver.relay.ack(receiver.signals[0]);
  const ack = receiver.published[0].payload;
  sender.registration.onEvent({ type: 'message', fromSessionId: 'intruder', payload: ack });
  assert.equal(sender.acks.length, 0);
  sender.registration.onEvent({ type: 'message', fromSessionId: 'target', payload: ack });
  assert.equal(sender.acks.length, 1);
});
