import { describe, it, expect } from 'vitest';
import { clientGuiDeclinesBaseUi, parseClientGuiPayload } from '../../src/import/remotePackageInstall';

const URL_ = 'https://example.com/gui.mpackage';

// GMCP `Client.GUI` asks the client to install a package from a URL. Mudlet
// accepts both the `{url, version}` object and the legacy two-line string, and
// acts on either only when it carries a version and a URL.
describe('parseClientGuiPayload', () => {
  it('reads the object shape', () => {
    expect(parseClientGuiPayload({ url: URL_, version: '3' })).toEqual({ url: URL_, version: '3' });
  });

  it('drops an object offer that names no version', () => {
    // handleGUIPackageInstallationAndUpgrade returns when either is empty
    expect(parseClientGuiPayload({ url: URL_ })).toBeNull();
  });

  it('reads the legacy raw-telnet shape as "<version>\\n<url>"', () => {
    // Version first — Mudlet's cTelnet fallback takes the version off line 0
    // and the url off line 1. Reading these the other way round would send the
    // version off to be downloaded as a URL.
    expect(parseClientGuiPayload(`3\n${URL_}`)).toEqual({ url: URL_, version: '3' });
    expect(parseClientGuiPayload(` 3 \r\n ${URL_} `)).toEqual({ url: URL_, version: '3' });
  });

  it('drops a half legacy pair rather than guessing which half it has', () => {
    expect(parseClientGuiPayload(`3\n`)).toBeNull();
    expect(parseClientGuiPayload(`\n${URL_}`)).toBeNull();
  });

  it('drops a lone line, which is neither half of the legacy pair for certain', () => {
    // Mudlet's raw telnet fallback needs two lines
    expect(parseClientGuiPayload(URL_)).toBeNull();
    expect(parseClientGuiPayload('5')).toBeNull();
  });

  it('accepts an unquoted numeric version', () => {
    // Servers using the field as a delivery counter often send it as a JSON
    // number. Dropping it left the install with no revision to compare, so
    // every connect looked like a fresh delivery.
    expect(parseClientGuiPayload({ url: URL_, version: 1 })).toEqual({ url: URL_, version: '1' });
    expect(parseClientGuiPayload({ url: URL_, version: 3.2 })).toEqual({ url: URL_, version: '3.2' });
    // Zero is a legitimate counter value, not an absent one.
    expect(parseClientGuiPayload({ url: URL_, version: 0 })).toEqual({ url: URL_, version: '0' });
  });

  it('drops an offer whose version it cannot render as a stable string', () => {
    expect(parseClientGuiPayload({ url: URL_, version: '' })).toBeNull();
    expect(parseClientGuiPayload({ url: URL_, version: true })).toBeNull();
    expect(parseClientGuiPayload({ url: URL_, version: null })).toBeNull();
    expect(parseClientGuiPayload({ url: URL_, version: { major: 3 } })).toBeNull();
    expect(parseClientGuiPayload({ url: URL_, version: NaN })).toBeNull();
  });

  it('rejects payloads without a usable url', () => {
    expect(parseClientGuiPayload({})).toBeNull();
    expect(parseClientGuiPayload({ url: '' })).toBeNull();
    expect(parseClientGuiPayload({ url: 42 })).toBeNull();
    expect(parseClientGuiPayload('')).toBeNull();
    expect(parseClientGuiPayload('\n3')).toBeNull();
    expect(parseClientGuiPayload(null)).toBeNull();
    expect(parseClientGuiPayload(undefined)).toBeNull();
    expect(parseClientGuiPayload(7)).toBeNull();
  });
});

// A game with an interface of its own can decline the starter UI with
// Client.GUI {"baseui": false} (cTelnet::parseGUIBaseUiDeclinedFromJSON).
describe('clientGuiDeclinesBaseUi', () => {
  it('reads false, and the string "false" in any case and padding, as a decline', () => {
    expect(clientGuiDeclinesBaseUi({ baseui: false })).toBe(true);
    expect(clientGuiDeclinesBaseUi({ baseui: ' False ' })).toBe(true);
    expect(clientGuiDeclinesBaseUi({ baseui: 'FALSE', url: URL_, version: '1' })).toBe(true);
  });

  it('takes anything else as keeping the starter UI', () => {
    expect(clientGuiDeclinesBaseUi({ baseui: true })).toBe(false);
    expect(clientGuiDeclinesBaseUi({ baseui: 'no' })).toBe(false);
    expect(clientGuiDeclinesBaseUi({ baseui: 0 })).toBe(false);
    expect(clientGuiDeclinesBaseUi({ other: false })).toBe(false);
    // the raw telnet form carries only a version and a URL
    expect(clientGuiDeclinesBaseUi(`false\n${URL_}`)).toBe(false);
    expect(clientGuiDeclinesBaseUi(null)).toBe(false);
  });
});
