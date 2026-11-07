import type { At7Message } from './at7-files.ts';

type Signal = { kind: 'signal'; key: string; target: string; senderSessionId: string; root: string; item: At7Message };
type Ack = { kind: 'ack'; key: string; target: string };
type Session = { id: string; name?: string };
type Channel = { snapshot(): { connected: boolean; supported: boolean }; listSessions(): Promise<Session[]>; publish(payload: Signal | Ack, options: { audience: 'capable' }): void };
type Event = { type: string; fromSessionId?: string; payload?: unknown };
type Bus = { events: { on(name: string, fn: () => void): unknown; emit(name: string, payload: unknown): void } };

export function createAt7PeerRelay(pi: Bus, identity: () => string | undefined, handlers: { onSignal(signal: Signal): void; onAck(ack: Ack): void }) {
  let channel: Channel | undefined;
  const offered = new Map<string, string>();
  const pinned = new Map<string, string>();
  const registration = {
    namespace: 'pi-wrk-at7', ownerEligible: false,
    onReady(ready: Channel) { channel = ready; },
    onEvent(event: Event) {
      if (event.type !== 'message' || !event.fromSessionId || !identity() || !event.payload || typeof event.payload !== 'object') return;
      const payload = event.payload as Partial<Signal> | Partial<Ack>;
      if (payload.kind === 'signal' && payload.target === identity() && typeof payload.key === 'string' &&
          payload.item?.source === 'file' && typeof payload.item.recipient === 'string' && typeof payload.item.key === 'string' && typeof payload.item.text === 'string' &&
          typeof payload.item.location === 'string' && typeof payload.root === 'string' &&
          payload.key === JSON.stringify([event.fromSessionId, payload.item.key]))
        handlers.onSignal({ ...payload, kind: 'signal', senderSessionId: event.fromSessionId } as Signal);
      if (payload.kind === 'ack' && payload.target === identity() && typeof payload.key === 'string' && offered.get(payload.key) === event.fromSessionId) {
        offered.delete(payload.key);
        pinned.delete(payload.key);
        handlers.onAck({ kind: 'ack', key: payload.key, target: payload.target! });
      }
    },
  };
  pi.events.on('intercom:extension-registry-ready', () => { if (!channel) pi.events.emit('intercom:extension-register', registration); });
  pi.events.emit('intercom:extension-register', registration);
  async function listPeers(): Promise<Session[] | undefined> {
    if (!channel?.snapshot().connected || !channel.snapshot().supported) return undefined;
    try { return await channel.listSessions(); }
    catch { return undefined; }
  }
  return {
    listPeers,
    async send(item: At7Message, root: string, options?: { sessions?: Session[]; pinnedTarget?: string; onResolved?(id: string): void }): Promise<'offered' | 'unavailable' | 'unknown' | 'ambiguous'> {
      const self = identity();
      if (!self || !channel?.snapshot().connected || !channel.snapshot().supported) return 'unavailable';
      const sessions = options ? options.sessions : await listPeers();
      if (!sessions) return 'unavailable';
      const key = JSON.stringify([self, item.key]);
      const prior = options?.pinnedTarget ?? pinned.get(key);
      const byId = sessions.filter(peer => peer.id !== self && peer.id === (prior ?? item.recipient));
      const matches = (prior || byId.length) ? byId : sessions.filter(peer => peer.id !== self && peer.name === item.recipient);
      if (matches.length !== 1) return matches.length ? 'ambiguous' : 'unknown';
      const target = matches[0].id;
      if (!prior) options?.onResolved?.(target);
      pinned.set(key, target);
      try {
        offered.set(key, target);
        channel.publish({ kind: 'signal', key, senderSessionId: self, target, root, item }, { audience: 'capable' });
        return 'offered';
      } catch { offered.delete(key); return 'unavailable'; }
    },
    ack(signal: Signal) {
      if (!channel?.snapshot().connected || !channel.snapshot().supported || !identity()) return;
      try { channel.publish({ kind: 'ack', key: signal.key, target: signal.senderSessionId }, { audience: 'capable' }); }
      catch { /* retry after reconnect on next owner turn */ }
    },
  };
}
export type At7Signal = Signal;
