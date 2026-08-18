import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeThrown } from '../../src/utils/describeThrown';

describe('describeThrown', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('renders an Error as its bare message, unchanged', () => {
        expect(describeThrown(new Error('boom'))).toBe('boom');
        expect(describeThrown(new TypeError('bad type'))).toBe('bad type');
    });

    it('falls back to the Error name when the message is empty', () => {
        expect(describeThrown(new RangeError())).toBe('RangeError');
    });

    it('passes a thrown string through', () => {
        expect(describeThrown('lua:1: attempt to index a nil value'))
            .toBe('lua:1: attempt to index a nil value');
    });

    it('never renders a plain object as "[object Object]"', () => {
        expect(describeThrown({ code: 'ENOENT', path: '/x' }))
            .toBe('{"code":"ENOENT","path":"/x"}');
    });

    it('names the constructor of a non-plain object', () => {
        class HttpFailure { constructor(public status = 503) {} }
        expect(describeThrown(new HttpFailure())).toBe('HttpFailure {"status":503}');
    });

    it('lists own keys when the value will not serialise', () => {
        const cyclic: Record<string, unknown> = { a: 1 };
        cyclic.self = cyclic;
        expect(describeThrown(cyclic)).toBe('{a, self}');
    });

    it('describes an object with no serialisable or enumerable properties', () => {
        expect(describeThrown(Object.create(null))).toBe('[object Object]');
    });

    it('handles the primitive non-string throws', () => {
        expect(describeThrown(null)).toBe('null');
        expect(describeThrown(undefined)).toBe('undefined');
        expect(describeThrown(42)).toBe('42');
        expect(describeThrown(false)).toBe('false');
    });

    it('records the live value in devtools only for an opaque throw with a label', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const raw = { x: 1 };

        describeThrown(raw);                        // opaque, but unlabelled
        describeThrown(new Error('boom'), 'timer "t"');  // labelled, but an Error
        describeThrown('plain', 'timer "t"');            // labelled, but a string
        expect(spy).not.toHaveBeenCalled();

        describeThrown(raw, 'timer "Update top bar"');
        expect(spy).toHaveBeenCalledWith(
            '[mudix] non-Error value thrown out of timer "Update top bar":', raw);
    });
});
