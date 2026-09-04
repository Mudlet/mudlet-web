import { createContext, useContext } from 'react';
import { resolveTheme } from '../utils/systemTheme';
import { useAppStore } from './appStore';
import { selectProfileField, type ClientSettings, type EditorSettings, type ProfileSettings, type Theme } from './schema';

/**
 * Active profile id, provided by ProfileSession. `null` outside a profile
 * (e.g. on the connection screen) — settings consumers fall through to
 * PROFILE_DEFAULTS in that case.
 */
export const ConnectionIdContext = createContext<string | null>(null);

export function useConnectionId(): string | null {
    return useContext(ConnectionIdContext);
}

/** Read one ProfileSettings field for the active profile (from context). */
export function useProfileField<K extends keyof ProfileSettings>(key: K): ProfileSettings[K] {
    const id = useConnectionId();
    return useAppStore(s => selectProfileField(s, id, key));
}

/** Read one ClientSettings field. */
export function useClientField<K extends keyof ClientSettings>(key: K): ClientSettings[K] {
    return useAppStore(s => s.client[key]);
}

/** The theme actually in effect: the active profile's override if it has one,
 *  else the launcher theme. Use anywhere a profile-scoped component needs the
 *  current theme (e.g. CodeMirror editors). Outside a profile (no context) it
 *  resolves to the launcher theme. */
export function useEffectiveTheme(): Theme {
    const id = useConnectionId();
    const stored = useAppStore(s => (id ? s.connectionProfile[id]?.theme : undefined) ?? s.client.theme);
    // Resolved, never the raw stored value: 'system' is a choice rather than a
    // palette, and every caller wants something it can look a palette up by
    // (the script editor's syntax colours, the JSON viewer). App.tsx owns
    // repainting on an OS flip; these re-render along with it.
    return resolveTheme(stored);
}

/** The script editor's display options, each falling back to its default.
 *  Returns a stable-shaped object, so read the individual fields in a
 *  dependency array rather than the object itself. */
export function useEditorSettings(): Required<EditorSettings> {
    const stored = useProfileField('editor');
    return {
        autocomplete:     stored?.autocomplete ?? true,
        showWhitespace:   stored?.showWhitespace ?? false,
        showControlChars: stored?.showControlChars ?? false,
        showItemIds:      stored?.showItemIds ?? false,
    };
}
