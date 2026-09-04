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
    /** Full `describe / describe / it` name, exactly as busted reports it. */
    name: string;
    /** Why mudix does not do this. Shown as the annotation on the expected failure. */
    reason: string;
}

export const KNOWN_DIVERGENCES: Record<string, KnownDivergence[]> = {
    DB: [
        {
            name: 'Tests DB.lua functions / Tests the functionality of db.Database:_begin, db.Database:_commit, db.Database:_rollback and db.Database:_end / _commit answers false when the database engine refuses the commit',
            reason:
                'It is the SCENARIO that is out of reach here, not the behaviour. The spec provokes a refusal '
                + 'by opening a SECOND connection to the same database file and holding a read cursor on it, so '
                + 'SQLite answers the writer with SQLITE_BUSY. That needs two connections contending over one '
                + 'file and mudix has neither: a database lives in wasm memory (sqliteClient opens `:memory:` '
                + 'and persists by snapshotting the bytes into the profile VFS), and `open()` hands every caller '
                + 'naming the same path the one live handle — so the reader and the writer in this spec are '
                + 'literally the same connection, which cannot lock itself out. Reproducing it would mean an '
                + "OPFS-backed file with a connection per caller, the design sqliteClient's header rejects, "
                + 'putting a worker hop and async back on the trigger write path to earn one error message. '
                + 'What the spec is really guarding — that _commit reports a refusal instead of answering true '
                + 'over work that never landed — IS implemented and does happen here: SQLite refuses a COMMIT '
                + 'on a single connection whenever a DEFERRABLE constraint fails at the end of the '
                + 'transaction, or the database has outgrown what the wasm heap can still grow to. '
                + 'Luasql.lua propagates those, and tests/scripting/dbCommitRefusal.test.ts pins it.',
        },
    ],
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
    Media: (() => {
        // Three specs that need an utterance to FINISH. Everything up to that
        // point works and is asserted by the specs around these — the state goes
        // to speaking, the text is reported, the queue advances on demand.
        //
        // What cannot happen is the ending. Web Speech reports completion by
        // firing `end` on the utterance, and a browser delivers that through the
        // event loop — which a busted run, being one synchronous call, is
        // sitting on top of. Every other queue a spec waits on turned out to be
        // one mudix owns and could therefore pump by hand: its own timers, its
        // own replay scheduler, its own unzip. This one belongs to the platform,
        // and no amount of pumping reaches it.
        //
        // Recorded rather than worked around because the alternative is inventing
        // an ending: a watchdog that declares the utterance over after an
        // estimated duration would make these pass while telling every script a
        // time that has nothing to do with when the speech actually stopped.
        // (There is a real argument for such a watchdog — Chrome is known to drop
        // `end` for long utterances, which leaves the queue wedged for good — but
        // that is a fix for that bug, not for this, and it should be built and
        // judged as one.)
        const reason =
            'Needs the utterance to finish. Web Speech reports that by firing `end` through the '
            + "browser's event loop, which a synchronous busted run is sitting on top of — unlike the "
            + 'timer, replay and unzip queues, it is not one mudix owns and can pump by hand. Everything '
            + 'before the ending is implemented and is asserted by the neighbouring specs.';
        return [
            'Tests the text-to-speech Lua API / Tests the text-to-speech family / ttsSpeak speaks the text and reports it until the engine goes ready again',
            'Tests the text-to-speech Lua API / Tests the text-to-speech family / ttsPause holds the utterance and ttsResume runs it to the end',
            'Tests the text-to-speech Lua API / Tests the text-to-speech family / a queued line starts speaking when the current one ends',
        ].map(name => ({ name, reason }));
    })(),
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
    STT: [
        {
            name: 'stt bridge / getInfo / names the engine it would use',
            reason:
                'The spec pins getInfo().backend to "Vosk", and its own comment says why that is the right test '
                + 'THERE: "the contract worth holding is that the name is one this build actually has". mudix has '
                + 'none. Vosk is a native library Mudlet dlopen()s beside a language-model directory on disk, and '
                + 'neither survives the move to a browser tab — half of stt.* exists to manage exactly those two '
                + 'things (getLibraryPath, getPlatformKey, reloadLibrary, unloadLibrary). Answering "Vosk" to '
                + 'satisfy this line would be the very thing the spec guards against: a build claiming an engine '
                + 'it does not have. That is worse than a truthful "none", because backend is what a package reads '
                + 'to decide what it can do. Everything else in STT_spec passes, because the spec is written to '
                + 'run on a machine with no engine installed and mudix is permanently in that state: available() '
                + 'is false, mudlet.supports.stt is false, and every call refuses clearly — engine refusals also '
                + 'announcing on sysSTTError, a script\'s own mistakes not (Bridge.lua). If speech recognition is '
                + 'ever wired up here it will be the Web Speech API, so the honest name then is that — still not '
                + '"Vosk".',
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
        area: 'HTTP requests that wait for their own response',
        spec: 'Networking',
        pendingReason: 'MUDLET_TEST_HTTP_PORT is not set',
        approxTests: 21,
        reason:
            'These skip for a reason that reads as fixable and is not: starting the fixture server does not '
            + 'unblock them. A spec issues a request and then waits for the event reporting it, but the whole '
            + 'busted run is one synchronous call sitting on top of the browser event loop — so the fetch can '
            + 'never settle while the spec waits, and the event never arrives. The pump that stands in for the '
            + 'event loop drives the queues mudix owns (its timers, its replay scheduler, its unzip); a network '
            + 'round-trip is not one of them. It was tried: a fixture server, mounted same-origin on the dev '
            + 'server so even Set-Cookie would have been readable, changed nothing. Making them run needs a '
            + 'second, synchronous transport (XMLHttpRequest with async=false) — and then the specs would '
            + 'exercise that transport rather than the fetch path every real caller takes, which is not testing '
            + 'mudix but a shim written to satisfy the tests. What these specs would have checked — the response '
            + 'record on each event, and a nil upload body when a file is given — is covered instead by '
            + 'tests/scripting/httpResponseRecord.test.ts and httpFileUpload.test.ts, against the real path.',
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
