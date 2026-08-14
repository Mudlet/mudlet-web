// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createTestRuntime } from '../createTestRuntime';

// The Lua-side moveWindow/resizeWindow dedup (Bridge.lua) skips the JS crossing
// when geometry is unchanged. These guard that REAL moves still apply and a
// recycled name re-applies fresh after deletion.
describe('moveWindow/resizeWindow Lua-side dedup', () => {
    it('applies real moves/resizes and is a safe no-op when unchanged', async () => {
        const { session, run, dispose } = await createTestRuntime();
        const geo = () => {
            const l = session.labels.list('main').find(x => x.name === 'dd');
            return l ? { x: l.x, y: l.y, w: l.width, h: l.height } : null;
        };

        run('createLabel("dd", 0, 0, 10, 10, 1)');
        run('moveWindow("dd", 30, 40); resizeWindow("dd", 100, 50)');
        expect(geo()).toEqual({ x: 30, y: 40, w: 100, h: 50 });

        // A different position must apply (not be wrongly skipped).
        run('moveWindow("dd", 31, 40)');
        expect(geo()).toMatchObject({ x: 31, y: 40 });

        // Repeating the same geometry is a no-op but leaves state correct.
        run('moveWindow("dd", 31, 40); resizeWindow("dd", 100, 50)');
        expect(geo()).toEqual({ x: 31, y: 40, w: 100, h: 50 });

        dispose();
    });

    it('re-applies geometry after a name is deleted and recreated', async () => {
        const { session, run, dispose } = await createTestRuntime();
        const geo = () => {
            const l = session.labels.list('main').find(x => x.name === 'rc');
            return l ? { x: l.x, y: l.y } : null;
        };
        run('createLabel("rc", 0, 0, 10, 10, 1); moveWindow("rc", 50, 60)');
        expect(geo()).toMatchObject({ x: 50, y: 60 });
        run('deleteLabel("rc")');
        // Recreate at a different spot, then move to the OLD cached coords — the
        // cache was invalidated on delete, so this must actually apply.
        run('createLabel("rc", 5, 5, 10, 10, 1); moveWindow("rc", 50, 60)');
        expect(geo()).toMatchObject({ x: 50, y: 60 });
        dispose();
    });

    // deleteLabel used to be the ONLY place the cache was dropped, so a
    // miniconsole (or text edit, or command line) recreated under a recycled
    // name stayed stuck at its creation size for every coordinate it had held
    // before. Assert the invalidation contract directly on the memo table:
    // every creator and every deleter has to forget the name.
    it('forgets cached geometry for every widget family that creates or deletes', async () => {
        const { run, dispose } = await createTestRuntime();
        const cached = (name: string) => run(`return __mwGeo[${JSON.stringify(name)}] ~= nil`);

        // `reuseMoves` = calling the creator on a live name repositions the
        // existing widget. createLabel is the odd one out: it refuses outright
        // and moves nothing, so keeping the cached entry is correct there.
        const families = [
            { create: 'createMiniConsole("w", 0, 0, 10, 10)', del: 'deleteMiniConsole("w")', reuseMoves: true },
            { create: 'createLabel("w", 0, 0, 10, 10, 1)', del: 'deleteLabel("w")', reuseMoves: false },
            { create: 'createCommandLine("w", 0, 0, 10, 10)', del: 'deleteCommandLine("w")', reuseMoves: true },
            { create: 'createTextEdit("w", 0, 0, 10, 10)', del: 'deleteTextEdit("w")', reuseMoves: true },
        ];
        for (const { create, del, reuseMoves } of families) {
            run(create);
            run('moveWindow("w", 7, 8)');
            expect(cached('w'), `${create} should cache after a move`).toBe(true);
            run(del);
            expect(cached('w'), `${del} must invalidate`).toBe(false);

            if (reuseMoves) {
                // Creation writes geometry straight to JS behind the cache's
                // back, so reusing a live name has to invalidate as well.
                run(create);
                run('moveWindow("w", 7, 8)');
                run(create);
                expect(cached('w'), `${create} must invalidate on reuse`).toBe(false);
                run(del);
            }
        }

        dispose();
    });
});
