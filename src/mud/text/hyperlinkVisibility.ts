/**
 * OSC 8 hyperlink `visibility` (Mudlet's THyperlinkVisibilityManager).
 *
 * Timer- and click-driven actions are wired directly onto the rendered link
 * element by {@link applyVisibility}:
 *   - **reveal**            — start hidden, reveal after `delayMs` (from render).
 *   - **conceal**           — start visible, conceal on click (now, or after
 *                             `delayMs`); with expire flags, arm instead.
 *   - **reveal-then-conceal** — reveal after `delayMs`, then conceal on click.
 *   - **deletesEntireLine** — conceal removes the whole output line.
 *
 * Expire-on-event links (conceal on the next user input / prompt / output after
 * being clicked) can't be driven from the element alone — they're tagged with
 * `data-osc-vis-*` attributes here, and {@link HyperlinkVisibilityController}
 * (owned by the session) conceals them when the matching session event fires.
 * The first occurrence of each trigger is skipped: it's the response to the very
 * command the click sent, not a fresh event.
 *
 * **The buffer half.** Hiding an element is not enough for a *delayed reveal*:
 * Mudlet writes such a link into its buffer as spaces and puts the text back
 * when the delay is up, so a script reading the line back (`getLines`) sees what
 * the player sees rather than the secret. {@link concealDelayedReveals} does the
 * same to a stored line here — see the section at the foot of this file.
 */

import type { VisibilitySettings } from "./hyperlinkConfig";
import type { AnsiAwareBuffer } from "./FormatState";

const OUTPUT_LINE_SELECTOR = ".output-msg";

/** trigger name → the `dataset` key holding its "skip the first occurrence" flag. */
const SKIP_KEY: Record<string, string> = {
    input: "oscVisSkipInput",
    prompt: "oscVisSkipPrompt",
    output: "oscVisSkipOutput",
};

function concealElement(el: HTMLElement, deleteLine: boolean): void {
    if (deleteLine) (el.closest(OUTPUT_LINE_SELECTOR) ?? el).remove();
    else el.style.visibility = "hidden";
}

/** Wire one link element's visibility behaviour. Call *after* the element's base
 *  style has been applied (it may set `visibility: hidden`, which a later
 *  `cssText` assignment would wipe). */
export function applyVisibility(el: HTMLElement, vis: VisibilitySettings): void {
    const delay = vis.delayMs && vis.delayMs > 0 ? vis.delayMs : 0;
    const deleteLine = vis.deletesEntireLine === true;
    const expires = (["input", "prompt", "output"] as const).filter((t) =>
        t === "input" ? vis.expireOnInput : t === "prompt" ? vis.expireOnPrompt : vis.expireOnOutput,
    );

    const conceal = (): void => concealElement(el, deleteLine);
    const reveal = (): void => { el.style.visibility = "visible"; };

    const armExpire = (): void => {
        el.dataset.oscVisExpire = expires.join(" ");
        if (deleteLine) el.dataset.oscVisDelete = "1";
        for (const t of expires) el.dataset[SKIP_KEY[t]] = "1";
    };

    // A delayed reveal the buffer already unconcealed must not start hidden all
    // over again: a re-render happens *after* its delay is up, so re-arming the
    // timer here would blank the text for a second delay's worth of seconds.
    const stillConcealed = delay > 0 && !revealedVisibilities.has(vis);

    switch (vis.action) {
        case "reveal":
            if (stillConcealed) { el.style.visibility = "hidden"; setTimeout(reveal, delay); }
            break;
        case "reveal-then-conceal":
            if (stillConcealed) { el.style.visibility = "hidden"; setTimeout(reveal, delay); }
            el.addEventListener("click", conceal);
            break;
        case "conceal":
            el.addEventListener("click", () => {
                if (expires.length > 0) armExpire();
                else if (delay > 0) setTimeout(conceal, delay);
                else conceal();
            });
            break;
    }
}

/**
 * Session-scoped driver for expire-on-event visibility links. The session calls
 * `onInput`/`onPrompt`/`onOutput` as those events occur; each conceals every
 * armed link whose trigger set includes that event (after skipping the first
 * occurrence). `getRoot` supplies the DOM subtree to scan (the live output).
 */
export class HyperlinkVisibilityController {
    constructor(private readonly getRoot: () => ParentNode | null) {}

    onInput(): void { this.fire("input"); }
    onPrompt(): void { this.fire("prompt"); }
    onOutput(): void { this.fire("output"); }

    private fire(trigger: "input" | "prompt" | "output"): void {
        const root = this.getRoot();
        if (!root) return;
        const skipKey = SKIP_KEY[trigger];
        // Snapshot — concealing with deleteLine removes nodes mid-iteration.
        for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-osc-vis-expire]"))) {
            const triggers = (el.dataset.oscVisExpire ?? "").split(" ");
            if (!triggers.includes(trigger)) continue;
            if (el.dataset[skipKey]) { delete el.dataset[skipKey]; continue; }
            concealElement(el, el.dataset.oscVisDelete === "1");
            el.removeAttribute("data-osc-vis-expire"); // fire once
        }
    }
}

// ── the buffer half: delayed reveals ────────────────────────────────────────
// Mudlet's THyperlinkVisibilityManager does not only style the link, it edits
// the buffer: `registerHyperlink` answers "this one starts concealed", TBuffer
// overwrites the link's characters with spaces (space for space, so every
// column index stays valid), and `performReveal` writes the text back when the
// delay is up. That is what makes `getLines()` show a reader what the player
// can see rather than the secret behind it.
//
// The bookkeeping is simpler here than there. Mudlet remembers a line NUMBER,
// so every buffer trim has to renumber the tracked links and a reveal has to
// bounds-check itself against a buffer that may have thrown the line away. A
// stored line is an object in mudix, so an entry holds the line itself: a trim
// cannot move it, and a line that scrolled out of history is simply a line
// nobody can see being written back to.

/** Reveals already performed, so a re-render of the line does not hide the text
 *  again for another delay. Keyed by the settings object, which every segment
 *  of one link shares by reference. */
const revealedVisibilities = new WeakSet<VisibilitySettings>();

/** A link whose text is currently spaces in a stored line, and when it is due
 *  to come back. */
interface PendingReveal {
    line: AnsiAwareBuffer;
    /** Column the link starts at. Concealment is space-for-space, so this stays
     *  correct however the line is re-rendered. */
    start: number;
    text: string;
    vis: VisibilitySettings;
    dueAt: number;
}

const pendingReveals: PendingReveal[] = [];
/** The one timer standing for the whole queue — always armed for the earliest
 *  entry still waiting, re-armed whenever the queue changes. */
let revealTimer: ReturnType<typeof setTimeout> | null = null;

function armRevealTimer(delay: number): void {
    if (revealTimer !== null) clearTimeout(revealTimer);
    revealTimer = setTimeout(() => { revealTimer = null; pumpDelayedReveals(); }, delay);
}

/**
 * Whether a link with these settings is written concealed and revealed later.
 *
 * Only the timed reveals are, unlike Mudlet, which also conceals a reveal armed
 * on an expire trigger. mudix drives expire triggers off the rendered element
 * (see {@link HyperlinkVisibilityController}), and that path only ever conceals
 * — a link the buffer blanked with nothing to un-blank it would lose its text
 * for good, which is worse than showing it early.
 */
export function startsConcealed(vis: VisibilitySettings): boolean {
    return (vis.action === "reveal" || vis.action === "reveal-then-conceal")
        && (vis.delayMs ?? 0) > 0;
}

/**
 * Blank out every delayed-reveal link on a freshly stored line and schedule the
 * text to come back. Called once per line as it enters a console's history.
 */
export function concealDelayedReveals(line: AnsiAwareBuffer): void {
    // Every line a console stores comes through here, and almost none of them
    // carry a link at all — so answer those without walking the segments twice.
    if (!line.hasVisibilityLink()) return;
    let column = 0;
    let scheduled = false;
    for (const run of line.toHyperlinkSegments()) {
        const start = column;
        column += run.text.length;
        const vis = run.hyperlink?.config?.visibility;
        if (!vis || !run.text.length) continue;
        if (!startsConcealed(vis) || revealedVisibilities.has(vis)) continue;

        pendingReveals.push({
            line, start, text: run.text, vis,
            dueAt: Date.now() + (vis.delayMs ?? 0),
        });
        // Space for space: the character count has to survive concealment or
        // every column a script holds on to (and every later reveal) is off.
        line.replace([start, column], " ".repeat(run.text.length));
        scheduled = true;
    }
    // The pump below is what a blocked event loop reaches (busted's
    // pumpEvents); this timer is what the app itself runs on.
    if (scheduled) armRevealTimer(0);
}

/**
 * Put back the text of every concealed link whose delay has elapsed, and arm a
 * timer for the earliest one still waiting. Returns true when a line changed.
 *
 * Also the hook the busted harness drives: a spec runs as one synchronous call
 * on top of the event loop, so no `setTimeout` of ours can fire until it
 * returns, and `pumpEvents` calls in here instead.
 */
export function pumpDelayedReveals(now: number = Date.now()): boolean {
    let changed = false;
    let next = Infinity;
    for (let i = pendingReveals.length - 1; i >= 0; i--) {
        const entry = pendingReveals[i];
        if (entry.dueAt > now) { next = Math.min(next, entry.dueAt); continue; }
        pendingReveals.splice(i, 1);
        revealedVisibilities.add(entry.vis);
        entry.line.replace([entry.start, entry.start + entry.text.length], entry.text);
        entry.line.rerender();
        changed = true;
    }
    if (next < Infinity) armRevealTimer(Math.max(0, next - now));
    return changed;
}

/** Drop everything still waiting — a profile teardown, or a test resetting
 *  between cases. The lines themselves are left as they are; they are going
 *  away with the console. */
export function resetDelayedReveals(): void {
    pendingReveals.length = 0;
    if (revealTimer !== null) { clearTimeout(revealTimer); revealTimer = null; }
}
