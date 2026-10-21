// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GlobalEventChannel } from '../../src/scripting/GlobalEventChannel';

// Minimal BroadcastChannel stub: records posted messages and lets the test
// deliver a message to the instance's onmessage. The real cross-tab delivery is
// exercised in the browser; here we cover raise()'s validation + serialization
// and the incoming-dispatch wiring deterministically.
class FakeBroadcastChannel {
    static instances: FakeBroadcastChannel[] = [];
    posted: unknown[] = [];
    onmessage: ((e: { data: unknown }) => void) | null = null;
    closed = false;
    constructor(public name: string) { FakeBroadcastChannel.instances.push(this); }
    postMessage(data: unknown) { this.posted.push(data); }
    close() { this.closed = true; }
}

describe('GlobalEventChannel', () => {
    let original: typeof globalThis.BroadcastChannel | undefined;
    beforeEach(() => {
        original = globalThis.BroadcastChannel;
        FakeBroadcastChannel.instances = [];
        (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = FakeBroadcastChannel;
    });
    afterEach(() => {
        (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = original;
    });

    it('appends the sender profile name and posts serializable args', () => {
        const ch = new GlobalEventChannel(() => {}, () => 'MyProfile');
        const ok = ch.raise('combat', ['help', 42, true, null]);
        expect(ok).toBe(true);
        const bc = FakeBroadcastChannel.instances[0];
        expect(bc.posted).toEqual([
            { name: 'combat', args: ['help', 42, true, null, 'MyProfile'] },
        ]);
    });

    it('throws on a non-serializable arg type (matches Mudlet)', () => {
        const ch = new GlobalEventChannel(() => {}, () => 'P');
        expect(() => ch.raise('e', [{}])).toThrow(/bad argument #\d+ type/);
        expect(() => ch.raise('e', [() => 0])).toThrow(/bad argument #\d+ type/);
    });

    it('dispatches incoming messages to the onEvent callback', () => {
        const received: Array<[string, unknown[]]> = [];
        const ch = new GlobalEventChannel((name, args) => received.push([name, args]), () => 'P');
        const bc = FakeBroadcastChannel.instances[0];
        bc.onmessage?.({ data: { name: 'fromOther', args: ['x', 1, 'OtherProfile'] } });
        expect(received).toEqual([['fromOther', ['x', 1, 'OtherProfile']]]);
        // Ignores malformed payloads.
        bc.onmessage?.({ data: null });
        bc.onmessage?.({ data: { args: [] } });
        expect(received).toHaveLength(1);
        void ch;
    });

    it('close() tears down the channel', () => {
        const ch = new GlobalEventChannel(() => {}, () => 'P');
        const bc = FakeBroadcastChannel.instances[0];
        ch.close();
        expect(bc.closed).toBe(true);
        expect(bc.onmessage).toBeNull();
    });

    it('degrades to a no-op when BroadcastChannel is unavailable', () => {
        (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
        const ch = new GlobalEventChannel(() => {}, () => 'P');
        expect(ch.raise('e', ['x'])).toBe(true); // no throw, no channel
        expect(() => ch.close()).not.toThrow();
    });
});
