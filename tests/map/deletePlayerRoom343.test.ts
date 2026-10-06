// @vitest-environment node
//
// mudlet-web#343 item 2: deleting the room the player is in. Desktop's
// TRoomDB::removeRoom resets the player room to 0, so getPlayerRoom() answers 0
// and a room later created with the old id is not where the player is. Mudlet
// Web kept the stale id, and the player silently "returned" to the new room.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

let env: TestRuntime;
beforeEach(async () => {
    env = await createTestRuntime();
    env.run('openMapWidget(); addRoom(1); addRoom(2); setExit(1, 2, "north"); centerview(1)');
});
afterEach(() => env.dispose());

describe('mudlet-web#343 — deleting the player\'s room', () => {
    it('resets the player room to 0', () => {
        expect(env.run('return getPlayerRoom()')).toBe(1);
        env.run('deleteRoom(1)');
        expect(env.run('return getPlayerRoom()')).toBe(0);
    });

    it('does not put the player in a new room given the old id', () => {
        env.run('deleteRoom(1); addRoom(1)');
        expect(env.run('return getPlayerRoom()')).toBe(0);
        // The view's own marker no longer claims room 1 as the player's either.
        expect(env.api.map.getPlayerRoom()).toBe(null);
    });

    it('gotoRoom finds no path from room 0', () => {
        env.run('deleteRoom(1)');
        expect(env.run('local a = gotoRoom(2); return a')).toBe(false);
        expect(env.run('return select(2, gotoRoom(2))'))
            .toBe('gotoRoom: no path found from current room to room with id 2');
    });

    it('deleting the player\'s area resets it too', () => {
        env.run('local a = addAreaName("Gone"); setRoomArea(1, a); deleteArea(a)');
        expect(env.run('return getPlayerRoom()')).toBe(0);
    });

    it('deleting another room leaves the player where they are', () => {
        env.run('deleteRoom(2)');
        expect(env.run('return getPlayerRoom()')).toBe(1);
    });

    it('a player room never set still reads as unset', async () => {
        const fresh = await createTestRuntime();
        try {
            fresh.run('openMapWidget(); addRoom(1)');
            expect(fresh.run('local a, b = getPlayerRoom(); return a == nil and b'))
                .toBe('the player does not have a valid roomID set');
        } finally {
            fresh.dispose();
        }
    });
});
