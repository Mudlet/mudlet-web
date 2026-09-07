/** A value that can cross the global-event channel. Mudlet's raiseGlobalEvent
 *  accepts only these (string/number/boolean/nil) — tables and functions can't
 *  cross a profile boundary. nil is represented as null. */
export type GlobalEventArg = string | number | boolean | null;

interface GlobalEventMessage {
    name: string;
    args: GlobalEventArg[];
}

/**
 * Cross-tab transport for Mudlet's `raiseGlobalEvent` — delivers an event to
 * every OTHER open profile. Each profile lives in its own browser tab (the
 * per-profile lock guarantees one tab per profile), so "other profiles" means
 * "other tabs". A `BroadcastChannel` carries the event; crucially it does NOT
 * echo a message back to the sender's own channel object, which matches Mudlet's
 * rule that the sending profile never receives its own global event.
 *
 * Degrades to a no-op when BroadcastChannel is unavailable (legacy browser).
 */
export class GlobalEventChannel {
    private channel: BroadcastChannel | null = null;

    constructor(
        /** Called when a global event arrives from another tab — dispatch it
         *  locally (through the runtime's emitEvent) so handlers fire. */
        private readonly onEvent: (name: string, args: GlobalEventArg[]) => void,
        /** This profile's name, appended to outgoing events (see `raise`). */
        private readonly senderName: () => string,
    ) {
        if (typeof BroadcastChannel === 'undefined') return;
        this.channel = new BroadcastChannel('mudlet:global-events');
        this.channel.onmessage = (e: MessageEvent) => {
            const msg = e.data as GlobalEventMessage | null;
            if (!msg || typeof msg.name !== 'string') return;
            this.onEvent(msg.name, Array.isArray(msg.args) ? msg.args : []);
        };
    }

    /**
     * Raise a global event in all other tabs' profiles. Mirrors Mudlet: accepts
     * string/number/boolean/nil args only (throws otherwise, surfacing as a Lua
     * error), and appends the sending profile's name as the final argument so
     * handlers can tell which profile it came from. Returns true.
     */
    raise(name: string, args: unknown[]): boolean {
        const out: GlobalEventArg[] = [];
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === null || a === undefined) {
                out.push(null);
            } else if (typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') {
                out.push(a);
            } else {
                throw new Error(
                    `raiseGlobalEvent: bad argument type #${i + 1} (boolean, number, string or nil expected, got ${typeof a}!)`,
                );
            }
        }
        out.push(this.senderName());
        this.channel?.postMessage({ name, args: out } satisfies GlobalEventMessage);
        return true;
    }

    close(): void {
        if (this.channel) {
            this.channel.onmessage = null;
            this.channel.close();
            this.channel = null;
        }
    }
}
