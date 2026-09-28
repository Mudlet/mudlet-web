import { describe, it, expect } from 'vitest';
import { centerviewAreaChange } from '../../src/ui/windows/panels/mapAreaChange';

describe('sysMapAreaChanged on centerview', () => {
    it('is raised on the first centerview even into the area already on show', () => {
        // openMapWidget() restores area 1; desktop still reports (1, -2).
        expect(centerviewAreaChange(true, 1, 1)).toEqual([1, -2]);
        expect(centerviewAreaChange(true, null, 1)).toEqual([1, -2]);
    });

    it('is raised on a later centerview only when the area changes', () => {
        expect(centerviewAreaChange(false, 1, 1)).toBeNull();
        expect(centerviewAreaChange(false, 1, 2)).toEqual([2, 1]);
        expect(centerviewAreaChange(false, null, 2)).toEqual([2, -1]);
    });
});
