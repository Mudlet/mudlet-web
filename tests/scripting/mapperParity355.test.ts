// @vitest-environment node
// Map widget behaviour pinned against desktop Mudlet PTB (issue #355).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { MAP_WIDGET_ID } from '../../src/ui/windows/types';

let env: TestRuntime;
beforeEach(async () => { env = await createTestRuntime(); });
afterEach(() => env.dispose());

const pair = (code: string) =>
    env.run(`local a, b = ${code}; return tostring(a) .. "|" .. tostring(b)`);

describe('openMapWidget takes the full dock words', () => {
    it.each(['right', 'Left', 'TOP', 'bottom', 'floating', 'FLOATING', ''])('accepts "%s"', (area) => {
        expect(pair(`openMapWidget(${JSON.stringify(area)})`)).toBe('true|nil');
        expect(env.session.windows.isVisible(MAP_WIDGET_ID)).toBe(true);
    });

    it('docks on the side the word names', () => {
        env.run('openMapWidget("Left")');
        expect(env.session.windows.isDocked(MAP_WIDGET_ID)).toBe(true);
        env.run('openMapWidget("floating")');
        expect(env.session.windows.isDocked(MAP_WIDGET_ID)).toBe(false);
    });

    it('still refuses a word that names no side', () => {
        expect(pair('openMapWidget("middle")'))
            .toBe('nil|docking option "middle" not available. available docking options are'
                + ' "t" top, "b" bottom, "r" right, "l" left and "f" floating');
    });
});

describe('removeMapMenu', () => {
    it('drops the events filed under the removed menus', () => {
        env.run(`
            addMapMenu("Top") addMapMenu("Sub", "Top") addMapMenu("Other")
            addMapEvent("evTop", "myEvTop", "Top") addMapEvent("evSub", "myEvSub", "Sub")
            addMapEvent("evOther", "myEvOther", "Other") addMapEvent("evRoot", "myEvRoot")
        `);
        expect(pair('removeMapMenu("Top")')).toBe('true|nil');
        expect(env.run(`
            local ks = {}
            for k in pairs(getMapEvents()) do ks[#ks + 1] = k end
            table.sort(ks)
            return table.concat(ks, ",")
        `)).toBe('evOther,evRoot');
        expect(env.run('return getMapMenus()["Sub"] == nil')).toBe(true);
    });

    it('refuses an empty menu name', () => {
        expect(pair('removeMapMenu("")')).toBe('nil|the menu name cannot be empty');
    });
});

describe('unHighlightRoom', () => {
    it('is true for any existing room, highlighted or not', () => {
        env.run('addRoom(1)');
        expect(env.run('return unHighlightRoom(1)')).toBe(true);
        env.run('highlightRoom(1, 255, 0, 0, 0, 255, 0, 1, 255, 255)');
        expect(env.run('return unHighlightRoom(1)')).toBe(true);
        expect(env.run('return unHighlightRoom(1)')).toBe(true);
        expect(env.api.map.getRoomHighlights().has(1)).toBe(false);
    });

    it('is false for a room that does not exist', () => {
        expect(env.run('return unHighlightRoom(99)')).toBe(false);
    });
});

describe('getMapViewInfo on a secondary view', () => {
    it('starts uncentred and follows setMapZoom through the view', () => {
        env.run(`
            area = addAreaName("V")
            for i = 1, 5 do addRoom(i) setRoomArea(i, area) setRoomCoordinates(i, i, 0, 0) end
            openMapWidget()
            v = createMapView(area)
        `);
        expect(env.run('return getMapViewInfo(v).centeredRoomId')).toBe(0);
        expect(env.run('return getMapViewInfo(v).zoom')).toBe(20);
        env.run('setMapZoom(6.5, 0, v)');
        expect(env.run('return getMapViewInfo(v).zoom')).toBe(6.5);
        expect(env.run('return getMapZoom(area, v)')).toBe(6.5);
        env.run('centerview(4, v)');
        expect(env.run('return getMapViewInfo(v).centeredRoomId')).toBe(4);
        expect(env.run('return getMapViewInfo(v).zoom')).toBe(6.5);
    });
});

describe('centerview before any map is open', () => {
    it('is refused and records no location', () => {
        env.run('addRoom(2)');
        expect(pair('centerview(2)')).toBe("nil|you haven't opened a map yet");
        env.run('openMapWidget()');
        expect(pair('getPlayerRoom()')).toBe('nil|the player does not have a valid roomID set');
        expect(pair('centerview(2)')).toBe('true|nil');
        expect(env.run('return getPlayerRoom()')).toBe(2);
    });
});

describe('map window title and exit colour defaults', () => {
    it('heads the map "Map - <profile>" and resets to that', () => {
        env.session.windows.profileName = 'Probe';
        env.run('openMapWidget()');
        expect(env.run('return getMapWindowTitle()')).toBe('Map - Probe');
        env.run('setMapWindowTitle("Custom")');
        expect(env.run('return getMapWindowTitle()')).toBe('Custom');
        // Reopening keeps the title it was given, in any dock form.
        env.run('openMapWidget("right")');
        expect(env.run('return getMapWindowTitle()')).toBe('Custom');
        env.run('setMapWindowTitle("")');
        expect(env.run('return getMapWindowTitle()')).toBe('Map - Probe');
        env.run('setMapWindowTitle("Custom") resetMapWindowTitle()');
        expect(env.run('return getMapWindowTitle()')).toBe('Map - Probe');
    });

    it('draws exits in light grey by default', () => {
        expect(env.run('local r, g, b = getMapRoomExitsColor(); return r .. "," .. g .. "," .. b'))
            .toBe('192,192,192');
    });
});
