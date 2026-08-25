const PING_INTERVAL_MS = 3000;
const PING_PROBE_TIMEOUT_MS = 10000;

/** How often the responsiveness beat ticks while a ping is outstanding. */
const BEAT_INTERVAL_MS = 100;
/**
 * The longest a beat may be late before the reading it spans is thrown away.
 *
 * The round trip is timed from `sendPing` to the moment the reply's handler
 * RUNS, and that handler runs on the same single thread as every trigger, alias
 * and script body — so a reply that arrived promptly but waited behind a long
 * Lua call is published as network latency. Mudlet had the same fault and the
 * same amplifier (Mudlet/Mudlet#10108): the shipped mapper paces itself with
 * `mmp.setmovetimer(getNetworkLatency())`, so an inflated reading makes the
 * client lengthen its own waits.
 *
 * The beat is delivered by the event loop, which is exactly what makes it a
 * usable witness: a beat that arrives late proves the loop was not running to
 * deliver it. A wait containing a gap this long cannot be told apart from a slow
 * network, so its reading is dropped and the last measured one stands. 250ms
 * against a 100ms beat is Mudlet's threshold.
 */
const MAX_BEAT_GAP_MS = 250;

export interface PingEventSource {
    on(event: 'gmcp.negotiated', handler: () => void): () => void;
    on(event: 'client.disconnect', handler: () => void): () => void;
    on(event: 'gmcp.core.ping', handler: () => void): () => void;
}

export class PingTracker {
    private timer: number | null = null;
    private probeTimer: number | null = null;
    private lastSentAt: number | null = null;
    private lastDuration: number | null = null;
    private supported = false;
    /** The responsiveness beat, live only while a ping is outstanding. */
    private beatTimer: number | null = null;
    private lastBeatAt: number | null = null;
    /** Longest interval the event loop went undelivered during the current
     *  wait — see {@link MAX_BEAT_GAP_MS}. */
    private worstBeatGapMs = 0;
    private readonly unsubs: Array<() => void>;

    constructor(
        private readonly sendPingCommand: (latencyMs: number) => void,
        private readonly onPing: (duration: number | null) => void,
        source: PingEventSource,
    ) {
        this.unsubs = [
            source.on('gmcp.negotiated', () => this.probe()),
            source.on('client.disconnect', () => this.stop()),
            source.on('gmcp.core.ping', () => this.handlePingResponse()),
        ];
    }

    destroy(): void {
        this.stop();
        for (const unsub of this.unsubs) unsub();
        this.unsubs.length = 0;
    }

    private probe() {
        if (this.supported || this.timer !== null || this.probeTimer !== null) return;
        this.sendPing();
        this.probeTimer = window.setTimeout(() => {
            this.probeTimer = null;
            this.lastSentAt = null;
            // The probe went unanswered, so there is no wait left to witness.
            this.stopBeat();
        }, PING_PROBE_TIMEOUT_MS);
    }

    private start() {
        if (this.timer !== null) return;
        this.timer = window.setInterval(() => this.sendPing(), PING_INTERVAL_MS);
    }

    private stop() {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.probeTimer !== null) {
            clearTimeout(this.probeTimer);
            this.probeTimer = null;
        }
        this.stopBeat();
        this.supported = false;
        this.lastSentAt = null;
        if (this.lastDuration !== null) {
            this.lastDuration = null;
            this.onPing(null);
        }
    }

    /** Sends the last round-trip we measured, per the GMCP spec's documented
     *  `Core.Ping <average latency>` form — 0 on the first probe, when there is
     *  nothing measured yet. The latency is informational to the server; what
     *  matters here is that the request always carries a body, since a bare
     *  `Core.Ping` makes servers that unconditionally JSON-parse the part after
     *  the module name choke on an empty string. */
    private sendPing() {
        this.lastSentAt = performance.now();
        this.startBeat();
        this.sendPingCommand(Math.round(this.lastDuration ?? 0));
    }

    /** Begin witnessing the event loop for the wait that starts now. */
    private startBeat() {
        this.stopBeat();
        this.lastBeatAt = performance.now();
        this.worstBeatGapMs = 0;
        this.beatTimer = window.setInterval(() => {
            const now = performance.now();
            this.recordBeatGap(now);
            this.lastBeatAt = now;
        }, BEAT_INTERVAL_MS);
    }

    private recordBeatGap(now: number) {
        if (this.lastBeatAt === null) return;
        const gap = now - this.lastBeatAt;
        if (gap > this.worstBeatGapMs) this.worstBeatGapMs = gap;
    }

    /** Stop the beat and answer the worst gap it saw, counting the stretch
     *  between the final beat and now — a stall that began after the last beat
     *  and ran until the reply is still a stall the reading spans. */
    private stopBeat(now?: number): number {
        if (now !== undefined) this.recordBeatGap(now);
        if (this.beatTimer !== null) {
            clearInterval(this.beatTimer);
            this.beatTimer = null;
        }
        this.lastBeatAt = null;
        return this.worstBeatGapMs;
    }

    private handlePingResponse() {
        if (this.lastSentAt === null) return;
        const now = performance.now();
        const duration = now - this.lastSentAt;
        const worstGap = this.stopBeat(now);
        this.lastSentAt = null;

        // A wait the client slept through is not a measurement of the network.
        // Drop it rather than substitute a guess: the previous reading is the
        // last figure that was actually measured, and holding it is the honest
        // answer. The reply still counts as a reply — the server answered, so
        // the latch and the interval below proceed either way.
        if (worstGap <= MAX_BEAT_GAP_MS) {
            this.lastDuration = duration;
            this.onPing(duration);
        }

        if (!this.supported) {
            this.supported = true;
            if (this.probeTimer !== null) {
                clearTimeout(this.probeTimer);
                this.probeTimer = null;
            }
            this.start();
        }
    }
}
