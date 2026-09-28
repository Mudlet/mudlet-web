const IAC = 0xFF, SB = 0xFA, SE = 0xF0;

/**
 * Closes a subnegotiation that runs into the next telnet command without its
 * IAC SE, the way Mudlet's `cTelnet::processSocketData` recovers one (#4385):
 * inside IAC SB, an IAC followed by anything but SE or a second IAC cannot be
 * part of the payload, so the SE is taken to have gone missing. The
 * subnegotiation is ended there and the IAC starts the next command.
 *
 * Done once, on the byte stream every inbound parser reads (the negotiator, the
 * ECHO scan, the option parser), by writing the missing SE back in — so they
 * all agree on where the subnegotiation ended, rather than one acting on the
 * command and another swallowing it into a payload. Stateful across frames: an
 * SB, or the IAC deciding it, can be split between two reads, and an IAC at the
 * end of a frame is passed on as it is, since the SE that may follow it goes
 * after it either way.
 */
export class SubnegotiationRepair {
    private inSb = false;
    private iac = false;
    private warned = false;

    reset(): void {
        this.inSb = false;
        this.iac = false;
        this.warned = false;
    }

    /** `data` is a Latin-1 byte-string; returns it with any missing IAC SE
     *  written back in. */
    process(data: string): string {
        let out: string[] | null = null;
        let copied = 0;
        for (let i = 0; i < data.length; i++) {
            const ch = data.charCodeAt(i);
            if (!this.iac) {
                if (ch === IAC) this.iac = true;
                continue;
            }
            this.iac = false;
            if (!this.inSb) {
                if (ch === SB) this.inSb = true;
                continue;
            }
            if (ch === SE) {
                this.inSb = false;
            } else if (ch !== IAC) {
                // The IAC before `ch` has already gone out (possibly in an
                // earlier frame), so the SE goes in after it, followed by an
                // IAC of its own to start the command it interrupted.
                out ??= [];
                out.push(data.slice(copied, i), '\xF0\xFF');
                copied = i;
                this.inSb = false;
                if (ch === SB) this.inSb = true;
                if (!this.warned) {
                    this.warned = true;
                    console.warn('TELNET: the server did not properly complete a subnegotiation. '
                        + 'Some data loss is likely - please mention this problem to the game admins.');
                }
            }
        }
        if (!out) return data;
        out.push(data.slice(copied));
        return out.join('');
    }
}
