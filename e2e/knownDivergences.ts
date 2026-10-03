// Mudlet spec assertions Mudlet Web deliberately does not satisfy.
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
// would hide the day Mudlet Web grew the behaviour, or the day upstream rewrote the
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
    /** Why Mudlet Web does not do this. Shown as the annotation on the expected failure. */
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
                + 'source tree for a spec run), which is exactly the mistake the spec is guarding against. mudlet '
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
        {
            name: 'Tests saveJsonMap and loadJsonMap / Tests the audit of an imported JSON map / reads a custom line with no style or arrow as a plain solid line',
            reason:
                'Everything the spec asks of the IMPORT holds: the line reads back as a solid line with no arrow, '
                + 'and the style and arrow are stored rather than left absent (tests/map/mapLoadAudit.test.ts pins '
                + 'that on the store). What fails is how the spec LOOKS for them — it saves the map as format 19 '
                + 'with saveMap(path, 19) and searches the bytes for the v19 layout (upper-case exit keys, the '
                + 'colour as a list of ints, the style as a string). Mudlet Web writes format 20 only: '
                + 'mudlet-map-binary-reader reads 16-20 but every legacy model\'s write throws, by its author\'s '
                + 'decision, so saveMap accepts the version argument and writes 20 regardless (see the map format '
                + 'version row of docs/settings-divergence.md). Saving for an older Mudlet stays a job for desktop.',
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
        // one Mudlet Web owns and could therefore pump by hand: its own timers, its
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
            + 'timer, replay and unzip queues, it is not one mudlet owns and can pump by hand. Everything '
            + 'before the ending is implemented and is asserted by the neighbouring specs.';
        return [
            'Tests the text-to-speech Lua API / Tests the text-to-speech family / ttsSpeak speaks the text and reports it until the engine goes ready again',
            'Tests the text-to-speech Lua API / Tests the text-to-speech family / ttsPause holds the utterance and ttsResume runs it to the end',
            'Tests the text-to-speech Lua API / Tests the text-to-speech family / a queued line starts speaking when the current one ends',
        ].map(name => ({ name, reason }));
    })(),
    MXPTags: [
        {
            name: 'Tests the tags MXP handles / Tests what MXP tells the game about the client / answers a VERSION tag with the client name and its version',
            reason:
                'The spec pins the whole answer, CLIENT and all: `<VERSION MXP=1.0 CLIENT=Mudlet '
                + 'VERSION=…>`. This client answers CLIENT=MUDLET-WEB, and that is the one thing in the '
                + 'line it should not borrow. A game reads CLIENT to decide what to send — Discworld and '
                + 'the IRE games branch on it — so the name has to identify the client that will actually '
                + 'render what comes back. This is the same name it gives in TTYPE, in MNES and in GMCP\'s '
                + 'Core.Hello, which is what makes a server\'s logs and its per-client branches agree with '
                + 'each other; answering Mudlet here alone would leave a game told two different things '
                + 'about who it is talking to. Everything else the spec pins about the answer IS matched: '
                + 'the MXP=1.0 protocol version, the unquoted attribute form, the VERSION value, the '
                + 'ESC[1z secure prefix, and the STYLE a game can name and have carried on every answer '
                + 'afterwards (the last spec in this file, which passes). If Mudlet Web ever wants games to '
                + 'treat it as Mudlet proper, that is a decision about every one of those handshakes at '
                + 'once, not about this line.',
        },
    ],
    Miscallaneous: [
        {
            name: 'Tests C++ functions in the Miscallaneous category / Tests the functionality of getProfiles / lists a profile that is not loaded',
            reason:
                'The spec mkdir()s a bare folder under the profiles directory and expects getProfiles() to list it. '
                + 'In Mudlet a folder IS a profile, so that is a fair test there. In mudlet a profile is a record in '
                + 'the app store, and its VFS directory is named for the connection id rather than the profile name '
                + '— so a folder someone creates has no name, no address, and nothing to open. Listing it would make '
                + 'getProfiles() report a profile the connection screen does not show and the user cannot open, which '
                + 'inverts what this spec exists to protect (its own comment: such a folder "would be listed as a '
                + 'profile ... by the connection dialog"). Note that getProfiles() DOES list every profile that is '
                + 'not currently open — unloaded profiles are covered; only the folder-without-a-record case is not.',
        },
        {
            name: 'Tests C++ functions in the Miscallaneous category / The Miscallaneous specs clean up after themselves / leaves no file or folder of its own behind',
            reason:
                'The half of this spec that checks the profile itself runs and passes. The other half lists the '
                + 'PARENT of getMudletHomeDir() with lfs.dir(), and a profile VFS is mounted AT its own directory '
                + 'and cannot read above it — the same boundary, for the same reason, as the Package entry below: '
                + 'a profile reaching its siblings is what the mount exists to prevent. This used to pass only by '
                + 'accident: lfs.mkdir() was recursive, so the "lists a profile that is not loaded" spec above '
                + 'quietly created the profiles folder in the in-memory root when it made its scratch folder under '
                + 'it. lfs.mkdir() is now the non-recursive call LuaFileSystem makes (#233), that mkdir fails as '
                + 'it must, and lfs.dir() over the parent answers nil, which the spec\'s `for entry in lfs.dir(...)` '
                + 'calls. There is nothing of a profile\'s own that could be left up there to find.',
        },
    ],
    Package: [
        {
            name: 'Tests installing an archive whose config.lua will not run / refuses a name that trims down to a step out of the profile',
            reason:
                'The BEHAVIOUR this pins is implemented — an archive called "...mpackage" trims to ".." and is '
                + 'refused, because that name would be the folder holding every profile (see '
                + 'assertPackageNameStaysInProfile). What cannot run here is the spec\'s own instrumentation: it '
                + 'proves nothing was unpacked by listing that folder before and after, with lfs.dir() over the '
                + 'PARENT of getMudletHomeDir(). A profile VFS is mounted AT its own directory and cannot read '
                + 'above it, so lfs.dir() answers nil there and the spec\'s `for entry in lfs.dir(...)` calls it. '
                + 'That boundary is the point of the sandbox rather than an oversight: a profile reaching its '
                + 'siblings is what the mount exists to prevent, and opening it to satisfy a test would hand every '
                + 'script in every profile the run of the others. The refusal itself is covered by a unit test '
                + 'instead (tests/import/packageConfigRename.test.ts), which can assert it directly.',
        },
    ],
    Telnet: (() => {
        // Each of these specs offers a package at a URL nothing serves, checks
        // the offer reached the downloader, and then waits - pumping events for up to three
        // seconds - for the download to fail, so its notice cannot land in a later
        // test. The first two steps pass: the offer reaches the downloader - the
        // raw telnet form, a JSON one numbering its version, and only an offer
        // carrying both a version and a URL - the "Downloading and installing
        // package" notice is on the main console where getLines() reads it, and a
        // raw telnet offer is kept out of the gmcp table. The wait cannot: the download is a fetch, and a fetch settles
        // through the browser's event loop, which the synchronous busted run is
        // sitting on top of. That is the same wall as Networking's HTTP specs
        // (UNSUPPORTED_AREAS below), and the answer is the same: a synchronous XHR
        // just for the test build would test that shim rather than the path a game's
        // offer takes.
        const reason =
            'Needs the package download to finish. It is a fetch, which settles through the browser\'s '
            + 'event loop that a synchronous busted run is sitting on top of - pumpEvents drives the '
            + 'queues mudlet owns, not the network. Everything before the ending is matched here: the '
            + 'offer reaches the downloader (an incomplete one does not), its notice is on the main console, '
            + 'and a raw telnet offer leaves the gmcp table alone. The failure notice Mudlet posts ("Package download failed from ...") '
            + 'is implemented and is asserted instead by tests/scripting/clientGuiNotices.test.ts.';
        return [
            'Tests the Client.GUI package offer / acts on a Client.GUI offer sent as raw telnet rather than JSON (#7704)',
            'Tests the Client.GUI package offer / keeps a raw telnet Client.GUI out of the gmcp table (#7034)',
            'Tests the Client.GUI package offer / acts on a JSON Client.GUI offer whose version is a number',
            'Tests the Client.GUI package offer / ignores a Client.GUI offer that is missing its version or its URL',
        ].map(name => ({ name, reason }));
    })(),
    STT: [
        {
            name: 'stt bridge / getInfo / names the engine it would use',
            reason:
                'The spec pins getInfo().backend to "Vosk", and its own comment says why that is the right test '
                + 'THERE: "the contract worth holding is that the name is one this build actually has". mudlet has '
                + 'none. Vosk is a native library Mudlet dlopen()s beside a language-model directory on disk, and '
                + 'neither survives the move to a browser tab — half of stt.* exists to manage exactly those two '
                + 'things (getLibraryPath, getPlatformKey, reloadLibrary, unloadLibrary). Answering "Vosk" to '
                + 'satisfy this line would be the very thing the spec guards against: a build claiming an engine '
                + 'it does not have. That is worse than a truthful "none", because backend is what a package reads '
                + 'to decide what it can do. Everything else in STT_spec passes, because the spec is written to '
                + 'run on a machine with no engine installed and mudlet is permanently in that state: available() '
                + 'is false, mudlet.supports.stt is false, and every call refuses clearly — engine refusals also '
                + 'announcing on sysSTTError, a script\'s own mistakes not (Bridge.lua). If speech recognition is '
                + 'ever wired up here it will be the Web Speech API, so the honest name then is that — still not '
                + '"Vosk".',
        },
    ],
    Trigger: (() => {
        // Mudlet leaves `matches`, `multimatches` and `line` out of the globals
        // table until a script reads them (Mudlet/Mudlet's lazyCaptureGlobals,
        // on by default): a metatable on _G builds them on first read, and
        // getmetatable/setmetatable and their debug twins are replaced so that a
        // script handed that metatable switches the deferral off for the
        // session. It exists so that the C++ side does not build Lua tables for
        // the many scripts that never look at them.
        //
        // Mudlet Web sets all three up front on every dispatch, which is Mudlet
        // with the setting switched off — a mode Mudlet supports and keeps under
        // test in the same describe block ("sets matches, multimatches and line
        // up front when switched off", "takes Mudlet's handlers off the globals
        // metatable when switched off", "hands a fire what it is owed when
        // switched off during it" all pass here). Every case in that block that
        // is about what a script SEES — a fire's own tables, empty tables between
        // dispatches, assigning and clearing them, rawset, nested alias and
        // trigger passes, raising scripts, coroutines, setfenv(0), sandboxes,
        // policing metatables, finalisers — passes as well. What is listed here
        // is only the deferral observing itself: rawget() finding the names
        // absent mid-fire, Mudlet's handlers being present on _G's metatable,
        // and the setting's default.
        //
        // Matching it would mean installing handlers on the metatable of _G that
        // every read of a missing global in every package goes through, and
        // wrapping the four metatable accessors to guard them — the machinery
        // Mudlet needed several hundred lines of C++ and this describe block's twenty-odd
        // edge cases to make safe — to save work that here is a handful of
        // table pushes per fire. If profiling ever says those pushes matter,
        // this is the place to revisit, and these entries turn red the day it
        // is done.
        const reason =
            'Observes Mudlet\'s lazy capture globals (the lazyCaptureGlobals setting, on by default there): '
            + 'matches/multimatches/line left out of _G until read, via handlers on _G\'s metatable and '
            + 'guarded getmetatable/setmetatable. mudlet sets them up front on every dispatch, which is Mudlet '
            + 'with that setting off — a mode Mudlet supports and tests in the same block, and those cases pass '
            + 'here, as does every case about what a script sees. Only the deferral observing itself (rawget '
            + 'finding a name absent mid-fire, Mudlet\'s handlers on the metatable, the setting\'s default) '
            + 'fails. Matching it means a metatable on _G that every missing-global read in every package goes '
            + 'through, plus guarded metatable accessors, to save a few table pushes per fire. '
            + 'getConfig("lazyCaptureGlobals") answers false, and setConfig refuses true rather than claim it.';
        const lazy = 'Trigger processing / capture globals a script may never read / ';
        return [
            ...[
                'leaves them out of the globals table until a script reads them',
                'refuses a write through a userdata handed its metatable',
                'a metatable the globals table is given and then changed / still leaves them out when the metatable is only copied',
                'the handlers once the metatable is handed out / come off the globals metatable at the next line',
                'the lazyCaptureGlobals setting / is on by default',
                'the lazyCaptureGlobals setting / leaves them out again once switched back on',
            ].map(name => ({ name: lazy + name, reason })),
            {
                name: 'Trigger processing / triggers ruled out from a copy of their pattern / leaves the pinned filters alone when a trigger creates another trigger',
                reason:
                    'Reads getProfileStats().triggers.rootFilterEpoch, a test-mode-only counter of how often '
                    + 'TriggerUnit invalidated the per-pass copies of its root triggers\' bigram prefilters — the '
                    + 'summaries Mudlet uses to rule a trigger out of a line without running its pattern. mudlet '
                    + 'has no such prefilter (TriggerEngine runs each active pattern), so there are no pinned '
                    + 'copies to invalidate and no epoch to count; reporting one would be a number that measures '
                    + 'nothing. What the spec cares about for scripts — which triggers fire on a line when one '
                    + 'creates another mid-pass — is covered by the "triggers created while a line is being '
                    + 'processed" block, which passes. The sibling prefilter probes in TriggerFlood_spec '
                    + '(prescanWorkers) find the field absent and pend themselves; this one has no such gate '
                    + 'beyond MUDLET_TEST_MODE, which the busted build sets.',
            },
        ];
    })(),
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
 * pending test — if upstream rewrites the gate, or Mudlet Web somehow grows the
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
            + 'event loop drives the queues mudlet owns (its timers, its replay scheduler, its unzip); a network '
            + 'round-trip is not one of them. It was tried: a fixture server, mounted same-origin on the dev '
            + 'server so even Set-Cookie would have been readable, changed nothing. Making them run needs a '
            + 'second, synchronous transport (XMLHttpRequest with async=false) — and then the specs would '
            + 'exercise that transport rather than the fetch path every real caller takes, which is not testing '
            + 'mudlet but a shim written to satisfy the tests. What these specs would have checked — the response '
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
            + 'stop skipping and start failing. mudlet binds mmcp.* as stubs that report an empty peer list (the '
            + 'true state of a client nobody can reach) and sets mudlet.supports.mmcp = false so feature-testing '
            + 'scripts route around it.',
    },
];

/**
 * Divergences no spec in the corpus exercises, so neither list above can hold
 * them (both are checked against live spec output). Recorded so the decision
 * sits with the others, and so nobody re-files it as a bug.
 */
export interface PlatformDivergence {
    /** The Lua surface that behaves differently. */
    api: string;
    /** What a script sees on each client. */
    behaviour: string;
    /** Why Mudlet Web does not match. */
    reason: string;
    /** Where it was reported. */
    issue: string;
}

export const PLATFORM_DIVERGENCES: PlatformDivergence[] = [
    {
        api: 'os.clock()',
        behaviour:
            'Desktop: CPU time the whole process has used — stands still while idle (0.0 across an idle 1.5s '
            + 'tempTimer), advances for rendering and network work too. Mudlet Web: main-thread time in the '
            + 'tasks that read the clock — also stands still while idle and measures a benchmark inside one '
            + 'call the same, but misses work in tasks that never read it and starts near 0.',
        reason:
            'Desktop runs stock Lua 5.1, whose os.clock() is C clock(). A page has no CPU-time clock at all '
            + "(performance.now() is wall time, and emscripten's clock() is wall time since start, which is "
            + 'what os.clock used to report). The approximation counts main-thread '
            + 'time in the tasks that read the clock: the first reading in a task opens a segment and a '
            + 'microtask closes it once the synchronous Lua call has unwound. So idle time never counts and a '
            + 'benchmark inside one call measures as on desktop, but work in tasks that never read the clock '
            + '(rendering, other JS, Lua that ran without calling os.clock) is missing, and the value starts '
            + 'near 0 rather than at the CPU time the process had already used. Pinned by '
            + 'tests/scripting/textTimeUtilityParity.test.ts.',
        issue: '#294',
    },
    {
        api: 'string→number coercion of "0x"',
        behaviour: 'Desktop: "0x" + 1 raises (not a number). Mudlet Web: "0x" + 1 is 1.',
        reason:
            'Lua 5.1 parses a numeric string with strtod and, on a trailing "x", strtoul(s, 16). glibc stops '
            + "that strtoul after the \"0\" when no hex digit follows, so \"0x\" is not a number on desktop; the "
            + 'wasm Lua is built against musl, which consumes the bare prefix and yields 0. tonumber() is '
            + 'wrapped in Lua to answer nil as desktop does (#308), but the same C parse also runs for arithmetic '
            + 'coercion ("0x" + 1) and string.format("%d", "0x"), inside the VM where Lua cannot reach. Fixing '
            + 'those means patching luaO_str2d in the wasm build of wasmoon-lua5.1; a script would have to do '
            + 'arithmetic on a bare "0x" string to notice. Pinned by tests/scripting/textTimeUtilityParity.test.ts.',
        issue: '#294',
    },
    {
        api: 'string.dump / loadstring of precompiled chunks',
        behaviour:
            'Bytecode dumped by desktop Mudlet fails to load here with "binary string: bad header in '
            + 'precompiled chunk", and bytecode dumped here fails the same way on desktop. Source code, and '
            + 'string.dump/loadstring round-trips within one client, are unaffected.',
        reason:
            'A Lua 5.1 chunk header records the sizes of the C types the VM was built with, and lundump '
            + 'refuses any chunk whose header differs from its own. The WebAssembly Lua is a wasm32 build, '
            + 'so sizeof(size_t) is 4 where desktop\'s 64-bit build has 8 (header bytes `04 04 04 08 00` '
            + 'against `04 08 04 08 00`), and every string length inside the chunk is a size_t of that width. '
            + 'Closing it would mean transcoding chunks between the two layouts inside load/loadstring/'
            + 'loadfile/dofile/require AND emitting the 64-bit layout from string.dump, all for the rare .luac '
            + 'file or dumped function moved between clients. Lua 5.1 bytecode is also unverified (a malformed '
            + 'chunk can corrupt the VM), so widening what the loader accepts is not worth it for that.',
        issue: '#296',
    },
    {
        api: 'getModulePath on a module that came in with an imported desktop profile',
        behaviour:
            'Desktop answers with the <filepath> the profile recorded (e.g. C:/Users/me/modB.xml). Mudlet Web '
            + 'answers with the copy of that XML the import placed inside the profile\'s VFS '
            + '(/profiles/<id>/modB/modB.xml, or wherever the imported tree already held it). The module is '
            + 'otherwise a module on both: getModules lists it, getPackages does not, and its priority and '
            + 'sync flag carry over.',
        reason:
            'The recorded path is on the original machine\'s disk, which a browser cannot open; the module '
            + 'reloads from, and syncs to, the VFS copy. Reporting the old path would hand scripts a file that '
            + 'installModule/reinstall cannot read.',
        issue: '#279',
    },
    {
        api: 'string.sub / string.byte with a position of 2^31 or more',
        behaviour:
            'Desktop: ("abcdef"):sub(3, 2^33) is "cdef", ("abcdef"):sub(2^31) is "", and ("abc"):byte(1, 2^31) '
            + 'returns 97 98 99. Mudlet Web: "", the whole string, and nothing — the position narrows to INT_MIN '
            + 'before the C code sees it. Every position inside the 32-bit range, negative ones included, '
            + 'behaves exactly as on desktop.',
        reason:
            'This client runs Lua 5.1 compiled to wasm32, where lua_Integer is 32 bits; desktop builds it for a '
            + '64-bit host. The wasm cannot be rebuilt from here, so the only fix is a Lua wrapper in front of '
            + 'each function — and it was written and measured: it made both of these, among the hottest '
            + 'functions any script calls, about five times slower on every call (sub ~36ns -> ~190ns), to '
            + 'correct positions no real script uses, since a string two billion bytes long cannot exist in the '
            + 'first place. string.format, tonumber and table.insert — where the large values are real (gold, '
            + 'XP, epoch milliseconds) or the narrowing froze the tab — ARE corrected, by '
            + 'src/scripting/lua/WideIntegers.lua; tests/scripting/wideIntegers.test.ts pins those and this '
            + 'decision.',
        issue: '#275',
    },
    {
        api: 'registerAnonymousEventHandler during a dispatch of the same event',
        behaviour:
            'A handler registered while its event is being dispatched (directly, or from a nested event) runs '
            + 'in that same dispatch on desktop, which walks Other.lua\'s live handler table with pairs(). Mudlet '
            + 'Web snapshots each handler list before calling into it, so the new handler first runs on the next '
            + 'raise of the event. Killing a handler mid-dispatch behaves the same on both.',
        reason:
            'The snapshot (the dispatchEventToFunctions override in LuaRuntime\'s mudlet-lua-overrides) guards '
            + 'the EleUI2 GitUpdater regression: a package installed from a sysDownloadDone handler registers its '
            + 'own sysDownloadDone handler from sysInstallPackage, and a live walk hands it the very download that '
            + 'installed it, which it takes for a finished update and uninstalls the package. Desktop is safe '
            + 'from that only because Host::installPackage raises sysInstall/sysInstallPackage from a '
            + 'QTimer::singleShot(0), after the dispatch that asked for the install has finished, whereas '
            + 'ScriptingEngine.notifyPackageInstalled raises them synchronously. Dropping the snapshot needs the '
            + 'install events (sysInstall, sysInstallPackage, sysLuaInstallModule, sysSyncInstallModule) deferred '
            + 'the same way first, which reorders the profile-open bootstrap, held self-removals and UI installs.',
        issue: '#282',
    },
    {
        api: 'CSI n C (cursor forward) on the default background — getFgColor / getTextFormat',
        behaviour:
            'Both clients turn `ESC[nC` into n spaces painted with the foreground set to the background. When '
            + 'the background is the profile default, desktop resolves that to the profile\'s background colour '
            + '(getFgColor on the gap reports 0,0,0 on a stock profile, and an underline or strike-out in force '
            + 'is invisible across it); Mudlet Web leaves the foreground default (getFgColor reports the profile '
            + 'foreground, and the decoration shows). With any explicit background the two agree.',
        reason:
            'Desktop resolves colours to RGB as it decodes, from the Host. Mudlet Web\'s ANSI and MXP parsers '
            + 'keep a default colour as "default" so a later change of the profile colours repaints old output, '
            + 'and they run with no access to the profile — there is no colour value that means "the default '
            + 'background" to give the foreground. The gap is spaces, so only a decoration drawn through it and '
            + 'a script reading its colour back can tell.',
        issue: '#272',
    },
    {
        api: 'getLabelSizeHint, and Geyser.Label adjustSize / autoWidth / autoHeight built on it',
        behaviour:
            'Both clients size the hint the same way: the label\'s contents laid out unwrapped, with no '
            + 'document margin, plus the stylesheet\'s margin, border and padding, whatever box the label has '
            + 'now. The pixel values still differ by font: desktop under the PTB reported 62x13 for an 8pt '
            + '"Hello world" and 11x22 for an empty label, and the browser answers with what its own font '
            + 'measures (an empty label is a zero-width line of the label font).',
        reason:
            'The hint is a text measurement, and the two clients rasterise text with different engines and '
            + 'usually different fonts (Qt\'s font database against the browser\'s CSS font stack), so there '
            + 'is no shared number to match. The shape of the answer is what scripts rely on, and that is '
            + 'matched.',
        issue: '#283',
    },
    {
        api: 'Docked Geyser.UserWindow / openUserWindow: the size a new dock gets',
        behaviour:
            'Both clients lay a docked window out before openUserWindow returns, so getUserWindowSize, '
            + 'getMainWindowSize, getWindowGeometry and sysWindowResizeEvent already reflect the dock on the '
            + 'next line. The size of the dock differs: desktop gave a new right dock its minimum width (49 '
            + 'pixels in the report), Mudlet Web gives it the width of that side\'s dock area (300 pixels '
            + 'unless the player has dragged it), shared by every panel docked on that side.',
        reason:
            'The dock area is Mudlet Web\'s own layout, one resizable extent per side that the player sets and '
            + 'the profile remembers, not a Qt QDockWidget negotiating its size hint. Opening every new dock '
            + 'at a sliver would not make a script more portable (the width is still the player\'s to change '
            + 'on both clients) and would leave each new panel unusable until dragged open.',
        issue: '#283',
    },
    {
        api: 'debug.traceback / debug.getinfo, tail-called',
        behaviour:
            'A function that ends in `return debug.traceback(msg)` (or `return debug.getinfo(1)`) gets a '
            + '"(tail call): ?" frame at level 1 here where desktop shows that function\'s own line. Every other '
            + 'level, and every call that is not a tail call, matches.',
        reason:
            'These are Lua functions here (Bridge.lua), so they can present Mudlet Web\'s own Lua as C frames. A '
            + 'tail call to a Lua function replaces the caller\'s frame and Lua 5.1 keeps only a placeholder for '
            + 'it, so its line is gone before the override runs; desktop\'s C functions never replace a frame. '
            + 'Matching would mean writing them as C functions against the raw stack, for one cosmetic line.',
        issue: '#276',
    },
    {
        api: 'runtime errors inside Mudlet Web\'s own Lua',
        behaviour:
            'An error the Lua VM or a stock C function raises from inside Mudlet Web\'s own Lua - e.g. '
            + 'utf8.len({}), which fails inside string.len - is prefixed "[C]:<line>:", where desktop prefixes the '
            + 'calling script line (luaL_argerror) or nothing. Errors that code raises deliberately are '
            + 'positioned as desktop positions them.',
        reason:
            'Desktop\'s io/lfs/utf8/rex/yajl/luasql/lpeg and API are C; here they are Lua compiled under the chunk '
            + 'name "=[C]". Deliberate raises go through an error() that positions the way lua_error / luaL_error '
            + 'do, but an error raised by the VM itself, or by a stock C function such code calls, takes the '
            + 'position of the Lua frame that called it, and nothing sits between there and the script\'s pcall '
            + 'to rewrite it. Closing it means validating every argument up front in every shim.',
        issue: '#276',
    },
    {
        api: 'setActiveProfile(name)',
        behaviour:
            'For a profile open in another browser tab it answers true, as desktop does, but that tab is not '
            + 'brought to the front. For this tab\'s own profile it asks for window focus.',
        reason:
            'Each profile lives in its own browser tab, and browsers only let the user switch tabs - a page '
            + 'cannot focus another tab. The refusals (empty name, no such profile, not loaded) match.',
        issue: '#276',
    },
    {
        api: 'rex.config()',
        behaviour:
            'PCRE2_CONFIG_JIT is 0 and there is no PCRE2_CONFIG_JITTARGET; desktop\'s build reports 1 and its '
            + 'JIT target.',
        reason:
            'The table describes the PCRE2 library in use, and the WebAssembly build has no JIT (rex.jit_compile '
            + 'is not provided either). Reporting desktop\'s values would describe a library that is not there.',
        issue: '#276',
    },
    {
        api: 'lfs.lock / lfs.unlock',
        behaviour:
            'Always succeed on an open handle whose mode can carry the lock; desktop\'s fcntl lock can be refused '
            + 'by another process holding one.',
        reason:
            'A profile\'s files belong to the one tab holding its Web Lock, so no second holder of a record lock '
            + 'can exist to contend with. The argument checks and the closed-file error match.',
        issue: '#276',
    },
    {
        api: 'lfs.link / lfs.lock_dir / lfs.symlinkattributes',
        behaviour:
            'Work over the default IndexedDB filesystem; on a linked local folder they answer '
            + '`nil, "Operation not supported", 95` where desktop makes the link.',
        reason:
            'Links are a feature of the virtual filesystem backend. ZenFS\'s store backend implements them; the '
            + 'File System Access API behind a linked folder has no links at all.',
        issue: '#276',
    },
    {
        api: 'io.popen, io.stdout / io.stderr',
        behaviour:
            'io.popen raises "\'popen\' not supported". io.stdout / io.stderr writes go to the browser console '
            + 'rather than the process streams desktop writes to.',
        reason:
            'A browser page cannot start processes and has no standard streams; the console is the nearest '
            + 'equivalent, and the error is what a Lua built without popen raises.',
        issue: '#276',
    },
    {
        api: 'getPath() between equal-cost routes through different rooms',
        behaviour:
            'Desktop: when two routes of the same total weight reach the target through different '
            + 'intermediate rooms, which one speedWalkPath/speedWalkDir describe can change from one Mudlet run '
            + 'to the next. Mudlet Web: always the same route for the same map, but not necessarily the one a '
            + 'given desktop run picked. Two exits of equal cost from one room into the SAME room do match: the '
            + 'first of n,e,s,w,up,down,ne,se,sw,nw,in,out wins, then the alphabetically first special exit.',
        reason:
            'Desktop numbers its search vertices in QHash iteration order over the room map (TMap::initGraph), '
            + 'and its frontier breaks equal-priority ties by that vertex number. Qt seeds QHash per process, so '
            + 'the order — and with it the choice between equal routes — is not a property of the map and '
            + 'cannot be reproduced. The per-room tie (parallel exits into one room) is decided while the graph '
            + 'is built, in a fixed order, and is ported exactly in src/map/pathfinding.ts. Pinned by '
            + 'tests/scripting/mapperParity295.test.ts.',
        issue: '#295',
    },
    {
        api: 'getTextFormat() with nothing selected',
        behaviour:
            'Desktop: reads the character under the user cursor, which stays at column 0 of the last line the '
            + 'trigger engine ran on (or on the last character after moveCursorEnd). Mudlet Web: reads the '
            + 'character under its own cursor, which follows output on the main console and sits one past the '
            + 'last character after moveCursorEnd — so it can answer (nil, "current selection invalid…") where '
            + 'desktop answers a format table.',
        reason:
            'The two answers come from different cursor models rather than from getTextFormat: the main console '
            + "follows output until a trigger parks it, and moveCursorEnd's column was chosen so a following "
            + 'insertText appends. Both are wider changes than #277; the messages and the window-not-found case '
            + 'now match desktop. Pinned by tests/scripting/argContracts.test.ts.',
        issue: '#277',
    },
    {
        api: 'Discord setters, receiveMSP: bad argument types',
        behaviour:
            'Desktop: setDiscordState({}) and friends raise "bad argument" while Discord is enabled for the '
            + 'profile, and receiveMSP({}) raises while MSP is on. Mudlet Web: no raise.',
        reason:
            'Desktop answers (nil, msg) for the disabled feature before it looks at the arguments, so whether '
            + 'it raises depends on state Mudlet Web does not have (no Discord integration) or rarely has. '
            + 'The rest of the #277 sweep is enforced by src/scripting/lua/argContracts.ts.',
        issue: '#277',
    },
    {
        api: 'highlightRoom: missing alpha arguments',
        behaviour:
            'Desktop: highlightRoom with 8 arguments raises "bad argument #9 type (color1Alpha as number '
            + 'expected, got no value!)". Mudlet Web: the two alphas are optional; a wrongly typed one still raises.',
        reason:
            'Mudlet Web documented the alphas as optional (luaCompletions.ts) before #277, so scripts written '
            + 'here may omit them; refusing them now would break those scripts for no gain.',
        issue: '#277',
    },
];
