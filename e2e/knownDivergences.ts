// Mudlet spec assertions mudix deliberately does not satisfy.
//
// Every entry here is a place where matching desktop Mudlet would make this
// client *worse*, not a gap waiting to be closed. They are recorded here rather
// than edited out of the corpus because `src/scripting/lua/specs/` is a verbatim
// mirror of Mudlet's own tests (see its SYNCED.md) — a re-sync must be able to
// overwrite that tree without silently reverting a decision made here.
//
// These are **expected failures**, not skips: busted.spec.ts marks each with
// `test.fail()`, so a run stays green while one keeps failing and turns RED the
// moment one starts passing. That matters — an entry that quietly went stale
// would hide the day mudix grew the behaviour, or the day upstream rewrote the
// spec to test something else entirely. A guard test also checks every name here
// still matches a live it(), so a rename upstream cannot leave a dead entry
// papering over a real failure.
//
// Adding one is a decision to diverge from Mudlet. Write down *why matching
// would be wrong*, not just what fails — the next person needs to be able to
// disagree with the reasoning, which they cannot do from a symptom.

export interface KnownDivergence {
    /** Full `describe / describe / it` name, exactly as in busted.manifest.json. */
    name: string;
    /** Why mudix does not do this. Shown as the annotation on the expected failure. */
    reason: string;
}

export const KNOWN_DIVERGENCES: Record<string, KnownDivergence[]> = {
    Mapper: [
        {
            name: 'Tests saveMap and loadMap / Tests the saveMap argument contract / resolves a relative location against the profile directory',
            reason:
                'The spec asserts saveMap("x.dat") lands in the profile directory AND that io.exists("x.dat") '
                + 'is then false — i.e. that a relative path resolves somewhere the profile is not. That holds in '
                + 'Mudlet because its process working directory is wherever the binary was launched (a build or '
                + 'source tree for a spec run), which is exactly the mistake the spec is guarding against. mudix '
                + 'has one filesystem and the Lua working directory IS the profile directory, so the relative and '
                + 'absolute paths name the same file and the second assertion cannot hold while the first does. '
                + 'Matching would mean pointing the Lua cwd at the VFS root, which changes where every relative '
                + 'io.*/lfs call in every existing script and package writes — a far worse outcome than a profile-'
                + 'relative default that is, if anything, the friendlier of the two behaviours.',
        },
        {
            name: 'Tests saveMap and loadMap / Tests the saveMap argument contract / resolves a number the same way, Lua having made a name out of it',
            reason:
                'Same divergence as the relative-location spec above, asserted through saveMap(42): the name Lua '
                + 'coerces out of the number is handled identically, so it fails on the same io.exists() check for '
                + 'the same reason.',
        },
    ],
    Miscallaneous: [
        {
            name: 'Tests C++ functions in the Miscallaneous category / Tests the functionality of getProfiles / lists a profile that is not loaded',
            reason:
                'The spec mkdir()s a bare folder under the profiles directory and expects getProfiles() to list it. '
                + 'In Mudlet a folder IS a profile, so that is a fair test there. In mudix a profile is a record in '
                + 'the app store, and its VFS directory is named for the connection id rather than the profile name '
                + '— so a folder someone creates has no name, no address, and nothing to open. Listing it would make '
                + 'getProfiles() report a profile the connection screen does not show and the user cannot open, which '
                + 'inverts what this spec exists to protect (its own comment: such a folder "would be listed as a '
                + 'profile ... by the connection dialog"). Note that getProfiles() DOES list every profile that is '
                + 'not currently open — unloaded profiles are covered; only the folder-without-a-record case is not.',
        },
    ],
};

/** The recorded divergence for one it(), or undefined when it is expected to pass. */
export function knownDivergence(spec: string, name: string): KnownDivergence | undefined {
    return KNOWN_DIVERGENCES[spec]?.find(d => d.name === name);
}

/**
 * Whole areas of the corpus that can never run here, as opposed to the
 * individual assertions above.
 *
 * These do not *fail* — the specs detect their own missing fixture and call
 * `pending()`, so they skip. That makes them indistinguishable, from a count,
 * from the skips that are merely unconfigured: "no HTTP fixture server" is a gap
 * in our harness worth closing, while "no peer-to-peer TCP" is a fact about
 * browsers. Recording them here is what tells the two apart, so nobody spends a
 * day trying to light up a section that cannot be lit.
 *
 * `pendingReason` is a substring of the skip message the corpus actually emits
 * today. A guard in busted.spec.ts asserts each one still matches at least one
 * pending test — if upstream rewrites the gate, or mudix somehow grows the
 * feature, the marker stops matching and the entry gets revisited rather than
 * quietly describing a world that no longer exists.
 *
 * Not listed, because they are implemented rather than absent: the IRC *actions*
 * (openIRC/sendIrc/restartIrc) refuse with Mudlet's own "no client" answers and
 * their specs pass, and the IRC *settings* are ordinary profile data that
 * round-trips. Discord is likewise only half-absent — the API now answers every
 * gated call with Mudlet's "Discord API is not available" denial, which is what
 * the Networking_spec contract block asserts, and that block passes. Only the
 * presence traffic itself, below, is out of reach.
 */
export interface UnsupportedArea {
    /** Human name for the capability. */
    area: string;
    /** Spec whose pending tests this covers. */
    spec: string;
    /** Substring of the pending message that identifies a skip as this area's. */
    pendingReason: string;
    /** Roughly how many tests this accounts for, as of the last review. */
    approxTests: number;
    reason: string;
}

export const UNSUPPORTED_AREAS: UnsupportedArea[] = [
    {
        area: 'Discord Rich Presence (the IPC traffic)',
        spec: 'Discord',
        pendingReason: 'MUDLET_TEST_DISCORD_CAPTURE_FILE is not set',
        approxTests: 49,
        reason:
            'Rich presence is delivered over a local IPC socket to the Discord desktop app — a named pipe on '
            + 'Windows, a unix socket elsewhere. A browser tab can open neither, and no web API substitutes: '
            + 'Discord exposes no browser-reachable endpoint for presence. So the whole spec, which asserts '
            + 'against frames captured from a fake Discord IPC server, has nothing to talk to and never will. '
            + 'What IS reachable is the API contract that sits in front of it, and that part is implemented: '
            + 'every gated function answers (nil, "Discord API is not available"), the same denial Mudlet gives '
            + 'when discord-rpc fails to load, and Networking_spec asserts it.',
    },
    {
        area: 'MMCP (MudMaster Chat Protocol)',
        spec: 'Networking',
        pendingReason: 'MMCP peer fixture not running',
        approxTests: 44,
        reason:
            'MMCP is peer-to-peer chat between clients over direct TCP: each client both dials others and '
            + 'LISTENS on a port of its own. A browser tab cannot open a raw TCP socket, and certainly cannot '
            + 'accept an inbound connection — the proxy that carries the game connection is a tunnel to one '
            + 'known host, not a way to be dialed. Starting the peer fixture would not help: the specs would '
            + 'stop skipping and start failing. mudix binds mmcp.* as stubs that report an empty peer list (the '
            + 'true state of a client nobody can reach) and sets mudlet.supports.mmcp = false so feature-testing '
            + 'scripts route around it.',
    },
];
