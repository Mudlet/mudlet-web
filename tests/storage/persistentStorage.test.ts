import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ensurePersistentStorage,
    isPersisted,
    persistenceSupported,
    resetPersistenceRequest,
} from '../../src/storage/persistentStorage';

const original = Object.getOwnPropertyDescriptor(navigator, 'storage');

function stubStorage(value: unknown) {
    Object.defineProperty(navigator, 'storage', { value, configurable: true });
}

beforeEach(() => {
    resetPersistenceRequest();
    vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    if (original) Object.defineProperty(navigator, 'storage', original);
    else Reflect.deleteProperty(navigator as object, 'storage');
});

describe('persistentStorage', () => {
    it('reports no support when the API is missing', async () => {
        stubStorage(undefined);
        expect(persistenceSupported()).toBe(false);
        await expect(isPersisted()).resolves.toBe(false);
        await expect(ensurePersistentStorage()).resolves.toBe(false);
    });

    it('reports no support when only half the API exists', async () => {
        stubStorage({ persisted: async () => false });
        expect(persistenceSupported()).toBe(false);
        await expect(ensurePersistentStorage()).resolves.toBe(false);
    });

    it('requests persistence when not already granted', async () => {
        const persist = vi.fn(async () => true);
        stubStorage({ persisted: async () => false, persist });
        await expect(ensurePersistentStorage()).resolves.toBe(true);
        expect(persist).toHaveBeenCalledTimes(1);
    });

    it('does not re-request when storage is already persistent', async () => {
        const persist = vi.fn(async () => true);
        stubStorage({ persisted: async () => true, persist });
        await expect(ensurePersistentStorage()).resolves.toBe(true);
        expect(persist).not.toHaveBeenCalled();
    });

    // Firefox turns the request into a permission prompt — asking again on every
    // profile open would nag, so a refusal has to stick for the session.
    it('asks at most once per session, refusal included', async () => {
        const persist = vi.fn(async () => false);
        stubStorage({ persisted: async () => false, persist });
        const results = await Promise.all([
            ensurePersistentStorage(),
            ensurePersistentStorage(),
            ensurePersistentStorage(),
        ]);
        expect(results).toEqual([false, false, false]);
        expect(persist).toHaveBeenCalledTimes(1);
    });

    it('swallows a throwing implementation', async () => {
        stubStorage({
            persisted: async () => { throw new Error('nope'); },
            persist: async () => true,
        });
        await expect(isPersisted()).resolves.toBe(false);
        await expect(ensurePersistentStorage()).resolves.toBe(false);
    });
});
