import { useCallback, useEffect, useState } from 'react';

/**
 * Real fullscreen — the browser's own, over the whole screen.
 *
 * This used to be a profile setting that hid the top toolbar and called that
 * "fullscreen mode". It was never fullscreen: the browser's chrome, tab strip
 * and the operating system's own furniture all stayed put, and what the player
 * actually got back was 44 pixels. Hiding the client's own bars is now what the
 * menu-bar and toolbar settings are for, and this is the Fullscreen API.
 *
 * Deliberately not persisted. Requesting fullscreen needs a user gesture, so a
 * profile that stored "fullscreen: true" could not honour it on load anyway —
 * it would come back as a setting that is on and visibly not in effect.
 */
export interface DocumentFullscreen {
    /** Whether the document is in fullscreen right now. */
    active: boolean;
    /** Whether the browser will allow it at all — false inside an iframe that
     *  was not given `allow="fullscreen"`, which is how this client is embedded
     *  in someone else's page. */
    available: boolean;
    toggle: () => void;
}

export function useDocumentFullscreen(): DocumentFullscreen {
    const [active, setActive] = useState(
        () => typeof document !== 'undefined' && document.fullscreenElement !== null,
    );

    // The player can leave fullscreen without going near the menu — Escape and
    // the browser's own F11 both do it — so the state is read back from the
    // document rather than tracked from the toggle.
    useEffect(() => {
        const onChange = () => setActive(document.fullscreenElement !== null);
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    const toggle = useCallback(() => {
        // Both calls reject rather than throw when the browser refuses (no
        // gesture, an iframe without permission). Nothing useful can be done
        // about it from here and an unhandled rejection would reach the
        // console as an error the player did not cause.
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else void document.documentElement.requestFullscreen().catch(() => {});
    }, []);

    return {
        active,
        available: typeof document !== 'undefined' && document.fullscreenEnabled,
        toggle,
    };
}
