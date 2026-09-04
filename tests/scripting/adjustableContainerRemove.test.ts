// @vitest-environment node
//
// Adjustable.Container:remove (issue #105).
//
// An adjustable container keeps its children in `self.Inside`, not in its own
// `windowList`. With no override of its own the call resolved up the chain to
// `Geyser.Container.remove`, which searches the outer container's `windowList`,
// found nothing, and returned — no error, no return value, the child still on
// screen and still in the container.
//
// Upstream defines the override (GeyserAdjustableContainer.lua:879 on
// development) at a commit newer than the vendored tree's pin, so mudix
// backports it in `LuaRuntime.installMudletLuaOverrides()`. These tests are what
// says the backport is still doing its job — and they go on passing unchanged
// once a re-sync brings the real one in.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('Adjustable.Container:remove', () => {
    let t: TestRuntime;

    beforeEach(async () => { t = await createTestRuntime(); });
    afterEach(() => { t.dispose(); });

    it('exists as the container class\'s own method', () => {
        // rawget, not a plain lookup: inheriting Geyser.Container.remove is
        // exactly the bug, and a plain lookup cannot tell the two apart.
        expect(t.run(
            `return type(rawget(Adjustable.Container, 'remove'))`,
        )).toBe('function');
    });

    it('removes a child that lives in the container\'s Inside', () => {
        expect(t.run(`
            local c = Adjustable.Container:new({name = "qaAdjRemove"})
            local label = Geyser.Label:new({name = "qaAdjChild"})
            c:add(label)
            local before = c.Inside.windowList["qaAdjChild"] ~= nil
            c:remove(label)
            local after = c.Inside.windowList["qaAdjChild"] ~= nil
            return tostring(before) .. "/" .. tostring(after)
        `)).toBe('true/false');
    });

    it('falls back to Geyser.remove for anything that is not an inside child', () => {
        // The container's own furniture — the title bar, the minimise and exit
        // labels, the Inside container itself — lives in the container's own
        // windowList, not in Inside. A straight redirect to self.Inside would
        // strand all of it, which is why upstream's override has two branches.
        expect(t.run(`
            local c = Adjustable.Container:new({name = "qaAdjOuter"})
            local furniture = c.adjLabel
            local before = c.windowList[furniture.name] ~= nil
            c:remove(furniture)
            return tostring(before) .. "/" .. tostring(c.windowList[furniture.name] ~= nil)
        `)).toBe('true/false');
    });
});
