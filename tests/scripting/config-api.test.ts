// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { useAppStore } from '../../src/storage/appStore';

const CONN = 'test-connection';

describe('setConfig / getConfig', () => {
    let h: TestRuntime;
    beforeAll(async () => { h = await createTestRuntime(); });
    afterAll(() => h.dispose());

    it('binds the base globals (Other.lua wrapper has something to capture)', () => {
        expect(h.run('return type(getConfig)')).toBe('function');
        expect(h.run('return type(setConfig)')).toBe('function');
    });

    it('round-trips a structured protocol toggle into profile.protocols', () => {
        h.run('setConfig("enableMSDP", true)');
        expect(useAppStore.getState().connectionProfile[CONN]?.protocols?.msdp).toBe(true);
        expect(h.run('return getConfig("enableMSDP")')).toBe(true);
        h.run('setConfig("enableMSDP", false)');
        expect(h.run('return getConfig("enableMSDP")')).toBe(false);
    });

    it('maps inverse "force off" keys to the negated protocol flag', () => {
        h.run('setConfig("specialForceMxpNegotiationOff", true)');
        expect(useAppStore.getState().connectionProfile[CONN]?.protocols?.mxp).toBe(false);
        expect(h.run('return getConfig("specialForceMxpNegotiationOff")')).toBe(true);
        expect(h.run('return getConfig("enableMXP")')).toBe(false);
    });

    it('maps specialForceCompressionOff to the negated mccp flag', () => {
        // Default: compression on, so force-off reads false.
        expect(h.run('return getConfig("specialForceCompressionOff")')).toBe(false);
        h.run('setConfig("specialForceCompressionOff", true)');
        expect(useAppStore.getState().connectionProfile[CONN]?.protocols?.mccp).toBe(false);
        expect(h.run('return getConfig("specialForceCompressionOff")')).toBe(true);
        h.run('setConfig("specialForceCompressionOff", false)');
        expect(useAppStore.getState().connectionProfile[CONN]?.protocols?.mccp).toBe(true);
        expect(h.run('return getConfig("specialForceCompressionOff")')).toBe(false);
    });

    it('routes autoClearInputLine to the autoClearInput field', () => {
        h.run('setConfig("autoClearInputLine", true)');
        expect(useAppStore.getState().connectionProfile[CONN]?.autoClearInput).toBe(true);
        expect(h.run('return getConfig("autoClearInputLine")')).toBe(true);
    });

    it('maps mapper keys to renderer settings', () => {
        h.run('setConfig("mapRoundRooms", true)');
        expect(useAppStore.getState().connectionProfile[CONN]?.mapper?.roomShape).toBe('roundedRectangle');
        expect(h.run('return getConfig("mapRoundRooms")')).toBe(true);
    });

    // Mudlet's setConfig takes the preferences spin-box scale (mapRoomSize 5 →
    // mRoomSize 0.5) while getConfig returns the internal double, and its exit
    // pen is 1/mLineSize * cellPx * mRoomSize. The renderer instead wants plain
    // map-unit roomSize/lineWidth. See docs/config-api.md § Map size units.
    it('translates Mudlet map sizes into renderer map units', () => {
        // Mudlet's own defaults.
        h.run('setConfig("mapRoomSize", 5)');
        h.run('setConfig("mapExitSize", 10)');
        const mapper = () => useAppStore.getState().connectionProfile[CONN]?.mapper;
        expect(mapper()?.roomSize).toBeCloseTo(0.5, 10);   // 5 / 10
        expect(mapper()?.lineWidth).toBeCloseTo(0.05, 10); // roomSize / mLineSize

        // getConfig reports Mudlet's internal doubles, not the setter's scale.
        expect(h.run('return getConfig("mapRoomSize")')).toBeCloseTo(0.5, 10);
        expect(h.run('return getConfig("mapExitSize")')).toBeCloseTo(10, 10);

        // A bigger mapExitSize means *thinner* exits (inverse divisor).
        h.run('setConfig("mapExitSize", 20)');
        expect(mapper()?.lineWidth).toBeCloseTo(0.025, 10);
        expect(h.run('return getConfig("mapExitSize")')).toBeCloseTo(20, 10);

        // Mudlet's exits scale with the room size, so changing mapRoomSize
        // rescales lineWidth and leaves the effective mapExitSize alone.
        h.run('setConfig("mapRoomSize", 10)');
        expect(mapper()?.roomSize).toBeCloseTo(1, 10);
        expect(mapper()?.lineWidth).toBeCloseTo(0.05, 10);
        expect(h.run('return getConfig("mapExitSize")')).toBeCloseTo(20, 10);

        // ...which also makes the table form order-independent (Other.lua walks
        // it with pairs(), so mapExitSize may land before mapRoomSize).
        h.run('setConfig{ mapExitSize = 10, mapRoomSize = 5 }');
        expect(mapper()?.roomSize).toBeCloseTo(0.5, 10);
        expect(mapper()?.lineWidth).toBeCloseTo(0.05, 10);

        // Non-positive sizes are ignored (but still "known key" → true).
        expect(h.run('return setConfig("mapRoomSize", 0)')).toBe(true);
        expect(h.run('return setConfig("mapExitSize", -1)')).toBe(true);
        expect(mapper()?.roomSize).toBeCloseTo(0.5, 10);
        expect(mapper()?.lineWidth).toBeCloseTo(0.05, 10);
    });

    it('applies showSentText as a three-state mode (never/script/always)', () => {
        // Boolean false → 'never': echoCommand emits nothing.
        h.run('setConfig("showSentText", false)');
        expect(h.session.showSentText).toBe('never');
        // The bare getConfig reads the legacy on/off form; the three-mode
        // string is the opt-in getConfig(key, true) shape.
        expect(h.run('return getConfig("showSentText")')).toBe(false);
        expect(h.run('return getConfig("showSentText", true)')).toBe('never');
        let before = h.mainOutput.length;
        h.session.echoCommand('look');
        expect(h.mainOutput.length).toBe(before);

        // Boolean true → 'script': send echoes by default, send(cmd,false) suppresses.
        h.run('setConfig("showSentText", true)');
        expect(h.session.showSentText).toBe('script');
        before = h.mainOutput.length;
        h.session.send('look', true);
        expect(h.mainOutput.length).toBe(before + 1);
        before = h.mainOutput.length;
        h.session.send('secret', false);
        expect(h.mainOutput.length).toBe(before); // suppressed (e.g. password)

        // 'always' → echoes even when the per-call echo flag is false.
        expect(h.run('return setConfig("showSentText", "always")')).toBe(true);
        expect(h.session.showSentText).toBe('always');
        expect(h.run('return getConfig("showSentText", true)')).toBe('always');
        before = h.mainOutput.length;
        h.session.send('look', false);
        expect(h.mainOutput.length).toBe(before + 1);

        // Explicit 'never' string round-trips; a bogus mode string is rejected.
        expect(h.run('return setConfig("showSentText", "never")')).toBe(true);
        expect(h.session.showSentText).toBe('never');
        expect(h.run('return setConfig("showSentText", "bogus")')).toBeNull();
        expect(h.session.showSentText).toBe('never');

        // Restore the default so later tests aren't affected.
        h.run('setConfig("showSentText", "script")');
    });

    it('never echoes a secret send, even under showSentText=always', () => {
        h.run('setConfig("showSentText", "always")');
        // A normal echo-suppressed send still echoes under 'always'…
        let before = h.mainOutput.length;
        h.session.send('look', false);
        expect(h.mainOutput.length).toBe(before + 1);
        // …but the secret path never does (passwords/credentials).
        before = h.mainOutput.length;
        h.session.sendSecret('hunter2');
        expect(h.mainOutput.length).toBe(before);
        h.run('setConfig("showSentText", "script")');
    });

    // Mudlet's mShowPanel: this hides dlgMapper's control bar (widget_panel),
    // NOT the map widget — that's openMapWidget/closeMapWidget. It must persist
    // per profile, as Mudlet keeps it in the profile XML.
    it('routes mapperPanelVisible to the persisted control-bar flag', () => {
        // Unset → Mudlet's default (shown).
        expect(h.run('return getConfig("mapperPanelVisible")')).toBe(true);

        expect(h.run('return setConfig("mapperPanelVisible", false)')).toBe(true);
        expect(h.run('return getConfig("mapperPanelVisible")')).toBe(false);
        expect(useAppStore.getState().connectionProfile[CONN]?.mapperPanelVisible).toBe(false);
        // The map window is a separate concern and must not have been touched.
        expect(h.session.windows.isVisible('map')).toBe(false);

        expect(h.run('return setConfig("mapperPanelVisible", true)')).toBe(true);
        expect(h.run('return getConfig("mapperPanelVisible")')).toBe(true);
        expect(useAppStore.getState().connectionProfile[CONN]?.mapperPanelVisible).toBe(true);
        expect(h.session.windows.isVisible('map')).toBe(false);
    });

    it('routes muteMediaAPI / muteMediaGame to the Sound and Video managers per origin', () => {
        // Defaults: both origins audible.
        expect(h.run('return getConfig("muteMediaAPI")')).toBe(false);
        expect(h.run('return getConfig("muteMediaGame")')).toBe(false);

        // Muting the API origin gates only 'api' on the live managers. Mudlet's
        // setMediaPlayersMuted leaves mediaType unset, which resolves to the
        // combined sound+music+video lists — so video rides the same gate.
        expect(h.run('return setConfig("muteMediaAPI", true)')).toBe(true);
        expect(h.session.sounds.isOriginMuted('api')).toBe(true);
        expect(h.session.videos.isOriginMuted('api')).toBe(true);
        expect(h.session.sounds.isOriginMuted('game')).toBe(false);
        expect(h.session.videos.isOriginMuted('game')).toBe(false);
        expect(h.run('return getConfig("muteMediaAPI")')).toBe(true);
        // ...and persists to the config bag so it survives a reload.
        expect(useAppStore.getState().connectionProfile[CONN]?.config?.muteMediaAPI).toBe(true);

        // The game origin is independent.
        expect(h.run('return setConfig("muteMediaGame", true)')).toBe(true);
        expect(h.session.sounds.isOriginMuted('game')).toBe(true);
        expect(h.session.videos.isOriginMuted('game')).toBe(true);
        expect(h.run('return getConfig("muteMediaGame")')).toBe(true);

        // Unmuting flips it back live.
        h.run('setConfig("muteMediaAPI", false)');
        expect(h.session.sounds.isOriginMuted('api')).toBe(false);
        expect(h.session.videos.isOriginMuted('api')).toBe(false);
        expect(h.run('return getConfig("muteMediaAPI")')).toBe(false);
        h.run('setConfig("muteMediaGame", false)');
        expect(h.session.sounds.isOriginMuted('game')).toBe(false);
        expect(h.session.videos.isOriginMuted('game')).toBe(false);
    });

    // The Settings modal writes the config bag directly (patchConfig) rather
    // than going through setConfig, so the gates have to track the store — the
    // toggles would otherwise not bite until a reload.
    it('applies a config-bag write from the Settings UI to the live managers', () => {
        const patch = (bag: Record<string, unknown>) => {
            const prev = useAppStore.getState().connectionProfile[CONN]?.config ?? {};
            useAppStore.getState().patchConnectionProfile(CONN, { config: { ...prev, ...bag } });
        };

        // "Mute all media" writes both keys at once, the way the derived row does.
        patch({ muteMediaAPI: true, muteMediaGame: true });
        expect(h.session.sounds.isOriginMuted('api')).toBe(true);
        expect(h.session.sounds.isOriginMuted('game')).toBe(true);
        expect(h.session.videos.isOriginMuted('api')).toBe(true);
        expect(h.session.videos.isOriginMuted('game')).toBe(true);
        // getConfig reads the live manager, so Lua sees the UI's change too.
        expect(h.run('return getConfig("muteMediaGame")')).toBe(true);

        patch({ muteMediaAPI: false, muteMediaGame: false });
        expect(h.session.sounds.isOriginMuted('api')).toBe(false);
        expect(h.session.videos.isOriginMuted('game')).toBe(false);
    });

    it('round-trips commandLineHistorySaveSize as a number (default 500)', () => {
        expect(h.run('return getConfig("commandLineHistorySaveSize")')).toBe(500);
        expect(h.run('return setConfig("commandLineHistorySaveSize", 50)')).toBe(true);
        expect(h.run('return getConfig("commandLineHistorySaveSize")')).toBe(50);
        expect(useAppStore.getState().connectionProfile[CONN]?.config?.commandLineHistorySaveSize).toBe(50);
    });

    it('defaults announceIncomingText on so the screen-reader mirror is not silently muted', () => {
        // ScreenReaderLog gates its ARIA live region on this key; a default-false
        // would mute the screen-reader path for everyone. Mudlet defaults it on.
        expect(h.run('return getConfig("announceIncomingText")')).toBe(true);
        expect(h.run('return setConfig("announceIncomingText", false)')).toBe(true);
        expect(h.run('return getConfig("announceIncomingText")')).toBe(false);
        expect(useAppStore.getState().connectionProfile[CONN]?.config?.announceIncomingText).toBe(false);
        // Restore so later tests see the default again.
        h.run('setConfig("announceIncomingText", true)');
    });

    it('persists unbacked keys for round-trip and validates enums', () => {
        // default before set (CONFIG_PERSIST_ONLY string key with an enum)
        expect(h.run('return getConfig("caretShortcut")')).toBe('none');
        expect(h.run('return setConfig("caretShortcut", "ctrltab")')).toBe(true);
        expect(h.run('return getConfig("caretShortcut")')).toBe('ctrltab');
        // out-of-range enum value is rejected
        expect(h.run('return setConfig("caretShortcut", "bogus")')).toBeNull();
        expect(h.run('return getConfig("caretShortcut")')).toBe('ctrltab');
    });

    it('routes the canonical / alias / charset / naws protocol keys', () => {
        // enableNEWENVIRON (Mudlet's canonical all-caps key) and the mudix alias
        // enableNewEnviron both drive protocols.newEnviron.
        h.run('setConfig("enableNEWENVIRON", false)');
        expect(useAppStore.getState().connectionProfile[CONN]?.protocols?.newEnviron).toBe(false);
        expect(h.run('return getConfig("enableNEWENVIRON")')).toBe(false);
        expect(h.run('return getConfig("enableNewEnviron")')).toBe(false);
        h.run('setConfig("enableNewEnviron", true)');
        expect(h.run('return getConfig("enableNEWENVIRON")')).toBe(true);

        // enableCHARSET / enableNAWS are the positive forms of the protocol flags.
        h.run('setConfig("enableCHARSET", false)');
        expect(useAppStore.getState().connectionProfile[CONN]?.protocols?.charset).toBe(false);
        expect(h.run('return getConfig("enableCHARSET")')).toBe(false);
        // ...and stay in sync with the deprecated inverse key.
        expect(h.run('return getConfig("specialForceCharsetNegotiationOff")')).toBe(true);

        h.run('setConfig("enableNAWS", false)');
        expect(useAppStore.getState().connectionProfile[CONN]?.protocols?.naws).toBe(false);
        expect(h.run('return getConfig("enableNAWS")')).toBe(false);
    });

    it('applies blankLinesBehaviour live on the session and rejects bad modes', () => {
        expect(h.run('return getConfig("blankLinesBehaviour")')).toBe('show');
        expect(h.session.blankLinesBehaviour).toBe('show');

        expect(h.run('return setConfig("blankLinesBehaviour", "hide")')).toBe(true);
        expect(h.session.blankLinesBehaviour).toBe('hide');
        expect(h.run('return getConfig("blankLinesBehaviour")')).toBe('hide');
        expect(useAppStore.getState().connectionProfile[CONN]?.config?.blankLinesBehaviour).toBe('hide');

        expect(h.run('return setConfig("blankLinesBehaviour", "replacewithspace")')).toBe(true);
        expect(h.session.blankLinesBehaviour).toBe('replacewithspace');

        // Unknown mode string is rejected, leaving the live value unchanged.
        expect(h.run('return setConfig("blankLinesBehaviour", "bogus")')).toBeNull();
        expect(h.session.blankLinesBehaviour).toBe('replacewithspace');

        // Restore the default so later tests / rendering aren't affected.
        h.run('setConfig("blankLinesBehaviour", "show")');
    });

    it('rejects writes to read-only keys and returns a value for them', () => {
        expect(h.run('return setConfig("logDirectory", "/x")')).toBeNull();
        expect(typeof h.run('return getConfig("logDirectory")')).toBe('string');
    });

    it('returns nil for unknown keys and false when setting them', () => {
        expect(h.run('return getConfig("totallyMadeUpKey")')).toBeNull();
        expect(h.run('return setConfig("totallyMadeUpKey", 1)')).toBeNull();
    });

    it('round-trips mapInfoColor as an {r,g,b,a} table with default alpha', () => {
        // Default before any set — Mudlet's mMapInfoBg {150,150,150,120}.
        expect(h.run('local c = getConfig("mapInfoColor"); return c[1]..","..c[2]..","..c[3]..","..c[4]'))
            .toBe('150,150,150,120');
        // Set with explicit alpha.
        expect(h.run('return setConfig("mapInfoColor", {10, 20, 30, 40})')).toBe(true);
        expect(useAppStore.getState().connectionProfile[CONN]?.config?.mapInfoColor)
            .toEqual({ r: 10, g: 20, b: 30, a: 40 });
        expect(h.run('local c = getConfig("mapInfoColor"); return c[1]..","..c[2]..","..c[3]..","..c[4]'))
            .toBe('10,20,30,40');
        // Alpha omitted defaults to 255.
        h.run('setConfig("mapInfoColor", {1, 2, 3})');
        expect(useAppStore.getState().connectionProfile[CONN]?.config?.mapInfoColor)
            .toEqual({ r: 1, g: 2, b: 3, a: 255 });
        // Out-of-range channel is rejected (Mudlet validates 0..255).
        expect(h.run('return setConfig("mapInfoColor", {300, 0, 0, 0})')).toBeNull();
        // A non-table value is the wrong TYPE, which Mudlet raises on rather
        // than reporting as a refusal.
        expect(() => h.run('return setConfig("mapInfoColor", "nope")')).toThrow();
    });

    // Mudlet's showMapInfo/hideMapInfo insert/remove a label in the enabled-set
    // (Host::mMapInfoContributors) without consulting the contributor registry,
    // so they always succeed and are set-only. See docs/config-api.md.
    describe('showMapInfo / hideMapInfo', () => {
        const enabled = (label: string) =>
            h.session.windows.mapStore.getMapInfoContributors()
                .find(c => c.label === label)?.enabled;

        it('toggles a registered contributor by label', () => {
            // Built-in seeding: "Full" on, "Short" off.
            expect(enabled('Short')).toBe(false);
            expect(h.run('return setConfig("showMapInfo", "Short")')).toBe(true);
            expect(enabled('Short')).toBe(true);
            expect(h.run('return setConfig("hideMapInfo", "Short")')).toBe(true);
            expect(enabled('Short')).toBe(false);
        });

        it('accepts a label nothing has registered yet and applies it on register', () => {
            // Unlike enableMapInfo, an unknown label is not an error...
            expect(h.run('return setConfig("showMapInfo", "Pending")')).toBe(true);
            expect(h.run('return enableMapInfo("Pending")')).toBeNull();
            // ...and the overlay comes up enabled the moment it registers.
            h.run('registerMapInfo("Pending", function() return "x" end)');
            expect(enabled('Pending')).toBe(true);
            h.run('killMapInfo("Pending")');
        });

        it('cancels a pending enable when hidden before the contributor exists', () => {
            h.run('setConfig("showMapInfo", "Later")');
            expect(h.run('return setConfig("hideMapInfo", "Later")')).toBe(true);
            h.run('registerMapInfo("Later", function() return "x" end)');
            expect(enabled('Later')).toBe(false);
            h.run('killMapInfo("Later")');
        });

        it('forgets the enabled state when the contributor is killed', () => {
            h.run('registerMapInfo("Doomed", function() return "x" end)');
            h.run('setConfig("showMapInfo", "Doomed")');
            expect(enabled('Doomed')).toBe(true);
            h.run('killMapInfo("Doomed")');
            // A later registration under the same label starts off, matching
            // Mudlet's removeContributor dropping the name from the set.
            h.run('registerMapInfo("Doomed", function() return "x" end)');
            expect(enabled('Doomed')).toBe(false);
            h.run('killMapInfo("Doomed")');
        });

        // Mudlet's enabled set lives on the Host and is untouched by script
        // teardown, so an overlay that was on comes back on when the reloaded
        // script re-registers it.
        it('survives a Lua teardown that sweeps the contributor away', () => {
            const store = h.session.windows.mapStore;
            h.run('registerMapInfo("Reloaded", function() return "x" end)');
            h.run('setConfig("showMapInfo", "Reloaded")');
            store.clearMapInfoContributors();
            expect(enabled('Reloaded')).toBeUndefined();
            h.run('registerMapInfo("Reloaded", function() return "x" end)');
            expect(enabled('Reloaded')).toBe(true);
            h.run('killMapInfo("Reloaded")');
            // Built-ins are native, so teardown leaves them (and their state) be.
            expect(enabled('Full')).toBe(true);
        });

        it('is set-only — getConfig reports both as invalid options', () => {
            expect(h.run('return getConfig("showMapInfo")')).toBeNull();
            expect(h.run('return getConfig("hideMapInfo")')).toBeNull();
        });

        it('raises on a label that is not string-coercible (Mudlet getVerifiedString)', () => {
            // getVerifiedString is checkStringArg is lua_isstring, which is TRUE
            // for a number — Mudlet takes setConfig("showMapInfo", 42) and
            // registers a contributor called "42". Only a value Lua will not
            // render as a string is a type error.
            expect(() => h.run('return setConfig("hideMapInfo", true)')).toThrow();
            expect(() => h.run('return setConfig("showMapInfo", {})')).toThrow();
            expect(h.run('return setConfig("showMapInfo", 42)')).toBe(true);
            h.session.windows.mapStore.clearMapInfoContributors();
            // An enum key takes the number too, and then rejects "1" the way it
            // rejects any unknown value: a (nil, errMsg) pair, not a raise.
            expect(h.run('return (setConfig("blankLinesBehaviour", 1))')).toBeNull();
        });
    });

    // askTlsAvailable is a typed ProfileSettings field, not a config-bag key:
    // the MSSP secure-port offer and the Settings checkbox both read it, and
    // declining the offer clears it. Routing it into the bag instead made the
    // key inert in both directions.
    it('routes askTlsAvailable to the typed profile field', () => {
        // Default is "still ask" even before anything has written the field.
        expect(h.run('return getConfig("askTlsAvailable")')).toBe(true);

        expect(h.run('return setConfig("askTlsAvailable", false)')).toBe(true);
        expect(useAppStore.getState().connectionProfile[CONN]?.askTlsAvailable).toBe(false);
        expect(h.run('return getConfig("askTlsAvailable")')).toBe(false);
        // Not the config bag — that slot is what nothing reads.
        expect(useAppStore.getState().connectionProfile[CONN]?.config?.askTlsAvailable).toBeUndefined();

        // A script can re-arm the offer after the user declined it.
        h.run('setConfig("askTlsAvailable", true)');
        expect(useAppStore.getState().connectionProfile[CONN]?.askTlsAvailable).toBe(true);
    });

    // Reads back a decline made through the UI rather than through setConfig.
    it('reflects an externally-cleared askTlsAvailable', () => {
        useAppStore.getState().patchConnectionProfile(CONN, { askTlsAvailable: false });
        expect(h.run('return getConfig("askTlsAvailable")')).toBe(false);
        useAppStore.getState().patchConnectionProfile(CONN, { askTlsAvailable: true });
    });

    // The telnet-layer keys stay in the config bag (ProfileSession feeds them to
    // MudSession from there). What matters at this level is that they round-trip
    // and land in the slot ProfileSession reads; the wire behaviour each one
    // drives is covered by tests/mud/connection/specialOptionsConfig.test.ts.
    it('round-trips the special telnet options into the config bag', () => {
        const bag = () => useAppStore.getState().connectionProfile[CONN]?.config ?? {};
        for (const key of [
            'inputLineStrictUnixEndings',
            'specialForceGAOff',
            'versionInTTYPE',
            'promptForVersionInTTYPE',
            'promptForMXPProcessorOn',
        ]) {
            expect(h.run(`return getConfig("${key}")`)).toBe(false);
            expect(h.run(`return setConfig("${key}", true)`)).toBe(true);
            expect(h.run(`return getConfig("${key}")`)).toBe(true);
            expect(bag()[key]).toBe(true);
            h.run(`setConfig("${key}", false)`);
            expect(h.run(`return getConfig("${key}")`)).toBe(false);
        }
    });

    it('supports the Other.lua table form and no-arg dump', () => {
        h.run('setConfig({ enableGMCP = false, f3SearchEnabled = true })');
        expect(h.run('return getConfig("enableGMCP")')).toBe(false);
        expect(h.run('return getConfig("f3SearchEnabled")')).toBe(true);
        // no-arg dump returns a table containing known keys
        const hasKey = h.run('local t = getConfig(); return t.enableGMCP ~= nil');
        expect(hasKey).toBe(true);
    });
});
