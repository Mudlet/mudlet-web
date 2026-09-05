import { describe, it, expect } from 'vitest';
import { MapStore } from '../../src/map/MapStore';

describe('an area name with no area behind it', () => {
    // setAreaName on an unused id registers the name without instantiating the
    // area — Mudlet's areas come into being when a room is moved into one, so
    // from Lua this is the only way to reach a name with nothing behind it.
    it('registers, is listed, and can be deleted again', () => {
        const store = new MapStore();
        const orphan = 990000003;

        expect(store.getAreaTable()['SpecOrphanArea']).toBeUndefined();
        expect(store.setAreaName(orphan, 'SpecOrphanArea')).toBe(true);
        expect(store.getAreaTable()['SpecOrphanArea']).toBe(orphan);
        expect(store.deleteArea(orphan)).toBeNull();
        expect(store.getAreaTable()['SpecOrphanArea']).toBeUndefined();
    });

    it('still refuses to rename an area name that resolves to nothing', () => {
        const store = new MapStore();
        expect(store.setAreaName('NoSuchAreaName', 'Whatever')).toEqual({
            ok: false, err: 'setAreaName: area not found',
        });
    });
});

describe('addRoom refuses the sentinel ids', () => {
    // Zero and below are what getRoomArea and friends answer for "no such
    // room", so a room that IS one of them could never be told apart.
    it('refuses zero and negatives', () => {
        const store = new MapStore();
        expect(store.addRoom(0)).toBe(false);
        expect(store.roomExists(0)).toBe(false);
        expect(store.addRoom(-3)).toBe(false);
        expect(store.roomExists(-3)).toBe(false);
        expect(store.addRoom(1)).toBe(true);
    });
});
