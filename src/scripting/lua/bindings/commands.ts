import type { BindingContext } from './context';
import { shortcutProblemMessage } from '../../../ui/commands/keySequence';
import { mxpColor } from '../../../mud/text/colorParsers';
import type { CommandSurface } from '../../../ui/commands/addonCommands';

/**
 * Mudlet's addon command API: the commands a package places on the client's own
 * surfaces, and the handful of things it can change about one afterwards.
 *
 * The argument CONTRACT is in Bridge.lua rather than here, because every
 * refusal names the Lua type of what it was handed ("surfaces has to be a list
 * of surface names and this one holds a boolean") and a value's Lua type is
 * precisely what does not survive the trip across wasmoon. What is left for
 * this side is everything that needs state or real parsing: the ids, the key
 * sequence, who already holds a key, and what the pulse will accept.
 */
export function installCommandBindings({ lua, api }: BindingContext): void {
    const registry = api.addonCommands;
    // Which keys Mudlet holds differs by platform, and so must the answer.
    registry.setPlatform(api.getOS());
    // The buffer search holds F3 only while it is switched on, so the registry
    // has to start from the profile's own setting rather than assume it off.
    registry.setSearchActive(api.getConfig('f3SearchEnabled') === true);

    // Returns the new command's id, or a STRING carrying the reason it was not
    // placed — Bridge.lua turns the second into Mudlet's (nil, why).
    lua.global.set('__addCommand', (
        name: unknown, icon: unknown, tooltip: unknown,
        menuPath: unknown, shortcut: unknown, surfaces: unknown,
    ): number | string => {
        const where = (surfaces as CommandSurface) ?? 'both';
        const path = String(menuPath ?? '');
        const keys = String(shortcut ?? '');

        // A command kept off the menu has nowhere to hang either of these, and
        // dropping them without a word is how a package ends up believing it
        // placed a shortcut that never existed.
        if (where === 'toolbar' && path) {
            return 'a menu path needs the menu, and this command is on the toolbar only';
        }
        if (where === 'toolbar' && keys) {
            return 'a shortcut hangs off the menu action, and this command is on the toolbar only';
        }

        const badSequence = shortcutProblemMessage(keys);
        if (badSequence) return badSequence;

        // Two things on one key is not a tie Qt breaks — it disables both — so
        // the second asker is refused and told who to ask about.
        const holder = registry.holderOf(keys);
        if (holder) return `the shortcut "${keys}" is already taken by "${holder}"`;

        return registry.add({
            name: String(name ?? ''),
            icon: String(icon ?? ''),
            tooltip: String(tooltip ?? ''),
            menuPath: path,
            shortcut: keys,
            surfaces: where,
        });
    });

    const asId = (id: unknown): number => Math.trunc(Number(id));

    lua.global.set('__removeCommand', (id: unknown) => registry.remove(asId(id)));
    lua.global.set('__enableCommand', (id: unknown) => registry.setEnabled(asId(id), true));
    lua.global.set('__disableCommand', (id: unknown) => registry.setEnabled(asId(id), false));
    lua.global.set('__setCommandChecked', (id: unknown, checked: unknown) =>
        registry.setChecked(asId(id), checked === true));
    lua.global.set('__setCommandIcon', (id: unknown, icon: unknown) =>
        registry.setIcon(asId(id), String(icon ?? '')));
    lua.global.set('__setCommandTooltip', (id: unknown, tooltip: unknown) =>
        registry.setTooltip(asId(id), String(tooltip ?? '')));

    /** The shortest pulse worth drawing. Anything under this restyles the
     *  button on every pass of the event loop and reads as a flicker rather
     *  than a pulse; zero would never stop. */
    const MIN_PULSE_MS = 50;

    // true, or a string with the reason — same shape as __addCommand.
    lua.global.set('__setCommandPulse', (
        id: unknown, on: unknown, colour: unknown, altColour: unknown, intervalMs: unknown,
    ): boolean | string => {
        const command = registry.get(asId(id));
        if (!command) return false;
        if (on !== true) return registry.setPulse(asId(id), null);
        // The pulse colours a BUTTON. A command that asked for the menu only
        // has none, and saying so is more use than pulsing nothing.
        if (!registry.hasButton(asId(id))) {
            return 'this command is on the menu only, so it has no button to colour';
        }

        const interval = Math.trunc(Number(intervalMs ?? 0)) || 0;
        if (interval < MIN_PULSE_MS) {
            return `a pulse interval of ${interval}ms is too short — ${MIN_PULSE_MS}ms is the shortest that reads as a pulse`;
        }

        // Both colours are parsed, not merely pasted into a style: a value
        // carrying its own declarations ("red; background-image: url(x)") would
        // otherwise ride into the stylesheet, and one Qt cannot read at all
        // paints the button black without a word.
        const parsed = [colour, altColour].map(c => mxpColor(String(c ?? '')));
        if (!parsed[0] || !parsed[1]) {
            const bad = !parsed[0] ? colour : altColour;
            return `'${String(bad ?? '')}' is not a colour this client can read`;
        }
        const rgb = (i: number) => {
            const c = parsed[i]!;
            return c.space === 'rgb' ? `rgb(${c.r},${c.g},${c.b})` : String(colour);
        };
        return registry.setPulse(asId(id), {
            colour: rgb(0), altColour: rgb(1), intervalMs: interval,
        });
    });

    lua.global.set('__getCommands', () => registry.list().map(c => ({
        id: c.id, name: c.name, icon: c.icon, tooltip: c.tooltip,
        menuPath: c.menuPath, shortcut: c.shortcut, surfaces: c.surfaces,
        enabled: c.enabled, checked: c.checked,
    })));
}
