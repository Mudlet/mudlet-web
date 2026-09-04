import { describe, it, expect } from 'vitest';
import { parseMudletHost, parseMudletProfile, applyProfileSettingsToHost } from '../../src/import/mudletHost';
import { MIN_CONSOLE_BUFFER_SIZE, MAX_CONSOLE_BUFFER_SIZE } from '../../src/mud/text/Console';

// A <Host> block with the real attribute/element values from a Mudlet 4.x
// profile export (test profile, 2026-06-26), trimmed to the fields mudix maps.
const HOST = `<Host autoClearCommandLineAfterSend="no" mEnableGMCP="yes" mEnableMSSP="yes" mEnableMSDP="no" mEnableMSP="yes" mEnableMTTS="yes" mEnableMNES="no" mEnableMXP="yes" mEnableNAWS="yes" mEnableCHARSET="yes" mEnableNEWENVIRON="yes" mServerMayRedefineColors="no" NetworkPacketTimeout="300">
  <name>test profile</name>
  <borderTopHeight>0</borderTopHeight>
  <borderBottomHeight>0</borderBottomHeight>
  <borderLeftWidth>0</borderLeftWidth>
  <borderRightWidth>0</borderRightWidth>
  <wrapAt>100</wrapAt>
  <wrapIndentCount>0</wrapIndentCount>
  <wrapHangingIndentCount>0</wrapHangingIndentCount>
  <mFgColor>#c0c0c0</mFgColor>
  <mBgColor alpha="255">#000000</mBgColor>
  <mCommandFgColor>#717100</mCommandFgColor>
  <mCommandBgColor>#000000</mCommandBgColor>
  <mCommandLineFgColor>#808080</mCommandLineFgColor>
  <mCommandLineBgColor>#000000</mCommandLineBgColor>
  <mBlack>#000000</mBlack>
  <mLightBlack>#808080</mLightBlack>
  <mRed>#800000</mRed>
  <mLightRed>#ff0000</mLightRed>
  <mBlue>#000080</mBlue>
  <mLightBlue>#0000ff</mLightBlue>
  <mGreen>#008000</mGreen>
  <mLightGreen>#00ff00</mLightGreen>
  <mYellow>#808000</mYellow>
  <mLightYellow>#ffff00</mLightYellow>
  <mCyan>#008080</mCyan>
  <mLightCyan>#00ffff</mLightCyan>
  <mMagenta>#800080</mMagenta>
  <mLightMagenta>#ff00ff</mLightMagenta>
  <mWhite>#c0c0c0</mWhite>
  <mLightWhite>#ffffff</mLightWhite>
  <mDisplayFont>Bitstream Vera Sans Mono,14,-1,5,400,0,0,0,0,0,0,0,0,0,0,1,,0,0</mDisplayFont>
  <mCommandSeparator>;;</mCommandSeparator>
</Host>`;

function host(xml: string): Element {
    return new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName('Host')[0];
}

describe('parseMudletHost', () => {
    const s = parseMudletHost(host(HOST));

    it('maps command-line, wrap, and prompt settings', () => {
        expect(s.commandSeparator).toBe(';;');
        expect(s.autoClearInput).toBe(false);
        expect(s.outputWrapAt).toBe(100);
        expect(s.outputWrapIndent).toBe(0);
        expect(s.outputWrapHangingIndent).toBe(0);
        expect(s.promptTimeoutMs).toBe(300);
        expect(s.serverRedefineColors).toBe(false);
    });

    it('maps foreground/background/command/input colors', () => {
        expect(s.outputForeground).toBe('#c0c0c0');
        expect(s.outputBackground).toBe('#000000');
        expect(s.commandEchoForeground).toBe('#717100');
        expect(s.commandEchoBackground).toBe('#000000');
        expect(s.inputForeground).toBe('#808080');
        expect(s.inputBackground).toBe('#000000');
    });

    it('maps the 16 ANSI colors into mudix palette order (dark 0–7, bright 8–15)', () => {
        expect(s.ansiPalette).toEqual([
            '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
            '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
        ]);
    });

    it('parses the display font family and size from the QFont spec', () => {
        expect(s.outputFont).toEqual({ kind: 'system', family: 'Bitstream Vera Sans Mono' });
        expect(s.fontSize).toBe(14);
    });

    it('maps the telnet protocol toggles', () => {
        expect(s.protocols).toEqual({
            gmcp: true, msdp: false, mssp: true, msp: true, mtts: true,
            mnes: false, mxp: true, naws: true, charset: true, newEnviron: true,
        });
    });

    it('omits borders when all four are zero', () => {
        expect(s.outputBorders).toBeUndefined();
    });

    it('sets borders when any is non-zero', () => {
        const withBorders = parseMudletHost(host(
            `<Host><borderTopHeight>5</borderTopHeight><borderBottomHeight>0</borderBottomHeight>` +
            `<borderLeftWidth>3</borderLeftWidth><borderRightWidth>0</borderRightWidth></Host>`,
        ));
        expect(withBorders.outputBorders).toEqual({ top: 5, bottom: 0, left: 3, right: 0 });
    });

    it('only sets fields actually present (missing → absent, not defaulted)', () => {
        const sparse = parseMudletHost(host(`<Host><mCommandSeparator>/</mCommandSeparator></Host>`));
        expect(sparse).toEqual({ commandSeparator: '/' });
    });

    // The three <Host> fields Mudlet 5.0 added. A profile written by 5.0 carries
    // them; one written by 4.22 does not, and must not acquire a default here.
    describe('Mudlet 5.0 fields', () => {
        it('maps enableOSC8Hyperlinks, mUndoServerWrap and undoServerWrapWidth', () => {
            const p = parseMudletHost(host(
                `<Host enableOSC8Hyperlinks="no" mUndoServerWrap="yes">` +
                `<undoServerWrapWidth>80</undoServerWrapWidth></Host>`,
            ));
            expect(p.osc8Hyperlinks).toBe(false);
            expect(p.undoServerWrap).toBe(true);
            expect(p.undoServerWrapWidth).toBe(80);
        });

        it('clamps the wrap width into Mudlet\'s 20–500 range rather than rejecting it', () => {
            const low = parseMudletHost(host(`<Host><undoServerWrapWidth>2</undoServerWrapWidth></Host>`));
            const high = parseMudletHost(host(`<Host><undoServerWrapWidth>9000</undoServerWrapWidth></Host>`));
            expect(low.undoServerWrapWidth).toBe(20);
            expect(high.undoServerWrapWidth).toBe(500);
        });

        it('leaves all three unset on a profile that predates them', () => {
            const p = parseMudletHost(host(HOST));
            expect(p.osc8Hyperlinks).toBeUndefined();
            expect(p.undoServerWrap).toBeUndefined();
            expect(p.undoServerWrapWidth).toBeUndefined();
        });

        it('round-trips back onto a <Host> element', () => {
            const el = host(`<Host><mCommandSeparator>;;</mCommandSeparator></Host>`);
            applyProfileSettingsToHost(el, {
                osc8Hyperlinks: false,
                undoServerWrap: true,
                undoServerWrapWidth: 80,
            });
            expect(parseMudletHost(el)).toMatchObject({
                osc8Hyperlinks: false,
                undoServerWrap: true,
                undoServerWrapWidth: 80,
            });
            expect(el.getAttribute('enableOSC8Hyperlinks')).toBe('no');
            expect(el.getAttribute('mUndoServerWrap')).toBe('yes');
        });

        it('writes nothing for fields the profile never set', () => {
            const el = host(`<Host />`);
            applyProfileSettingsToHost(el, { commandSeparator: ';;' });
            expect(el.hasAttribute('enableOSC8Hyperlinks')).toBe(false);
            expect(el.hasAttribute('mUndoServerWrap')).toBe(false);
            expect(el.querySelector(':scope > undoServerWrapWidth')).toBeNull();
        });
    });

    // Mudlet's "Main display size" preference pair (XMLimport.cpp:1148-1150,
    // XMLexport.cpp:617-618).
    describe('consoleBufferSize', () => {
        it('maps consoleBufferSize and useMaxConsoleBufferSize', () => {
            const p = parseMudletHost(host(
                `<Host><consoleBufferSize>25000</consoleBufferSize>` +
                `<useMaxConsoleBufferSize>yes</useMaxConsoleBufferSize></Host>`,
            ));
            expect(p.consoleBufferSize).toBe(25000);
            expect(p.useMaxConsoleBufferSize).toBe(true);
        });

        it('clamps the size into the range setBufferSize would apply anyway', () => {
            const low = parseMudletHost(host(`<Host><consoleBufferSize>5</consoleBufferSize></Host>`));
            const high = parseMudletHost(host(`<Host><consoleBufferSize>99999999</consoleBufferSize></Host>`));
            expect(low.consoleBufferSize).toBe(MIN_CONSOLE_BUFFER_SIZE);
            expect(high.consoleBufferSize).toBe(MAX_CONSOLE_BUFFER_SIZE);
        });

        it('leaves both unset on a profile that never wrote them', () => {
            const p = parseMudletHost(host(HOST));
            expect(p.consoleBufferSize).toBeUndefined();
            expect(p.useMaxConsoleBufferSize).toBeUndefined();
        });

        it('round-trips back onto a <Host> element', () => {
            const el = host(`<Host />`);
            applyProfileSettingsToHost(el, { consoleBufferSize: 25000, useMaxConsoleBufferSize: false });
            expect(el.querySelector(':scope > useMaxConsoleBufferSize')?.textContent).toBe('no');
            expect(parseMudletHost(el)).toMatchObject({
                consoleBufferSize: 25000,
                useMaxConsoleBufferSize: false,
            });
        });

        it('writes nothing when the profile never set them', () => {
            const el = host(`<Host />`);
            applyProfileSettingsToHost(el, { commandSeparator: ';;' });
            expect(el.querySelector(':scope > consoleBufferSize')).toBeNull();
            expect(el.querySelector(':scope > useMaxConsoleBufferSize')).toBeNull();
        });
    });
});

describe('parseMudletProfile', () => {
    it('bundles settings, automation, and variables from one profile XML', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <HostPackage>${HOST}</HostPackage>
  <TriggerPackage>
    <Trigger isActive="yes" isFolder="no">
      <name>hp</name>
      <script>echo("hi")</script>
      <regexCodeList><string>HP: (\\d+)</string></regexCodeList>
      <regexCodePropertyList><integer>1</integer></regexCodePropertyList>
    </Trigger>
  </TriggerPackage>
  <VariablePackage>
    <HiddenVariables />
    <Variable>
      <name>myVar</name>
      <keyType>4</keyType>
      <value>42</value>
      <valueType>3</valueType>
    </Variable>
  </VariablePackage>
</MudletPackage>`;
        const { settings, automation, variables } = parseMudletProfile(xml);

        expect(settings.commandSeparator).toBe(';;');
        expect(automation.triggers.map(t => t.name)).toContain('hp');
        expect(variables.variables.map(v => v.name)).toEqual(['myVar']);
        // The variable names become the seed for the profile save-list.
        expect(variables.variables[0]).toMatchObject({ valueType: 'number', value: '42' });
    });
});
