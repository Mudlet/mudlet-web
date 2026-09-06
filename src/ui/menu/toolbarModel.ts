/**
 * The button row as data, so a brand can rearrange it.
 *
 * The row used to be a fixed run of JSX with a `hide` list threaded through it,
 * which let a brand subtract and append and nothing else — no reordering, no
 * renaming, no putting its own command between two stock ones. A white-label
 * client is somebody else's product wearing this client's engine, and the shape
 * of its chrome is theirs to decide, so the row is now a list they are handed
 * and hand back.
 *
 * The menu bar's counterpart is `TopMenu[]` in `menuModel.ts`; the two
 * transforms in `BrandToolbarConfig` take and return these.
 */
import type { ReactNode } from 'react';
import type { MenuNode } from './menuModel';

/** A plain button. */
export interface ToolbarButtonItem {
    kind: 'button';
    /** Stable across renders — the React key, and what a brand matches on to
     *  find an item in the stock list. Stock ids are the `StockToolbarButton`
     *  names; a package's are `lua:<n>`, a host app's `host:<n>`. */
    id: string;
    label: ReactNode;
    icon?: ReactNode;
    title?: string;
    /** Drawn pressed. */
    checked?: boolean;
    disabled?: boolean;
    /** Extra class, for the few stock buttons with a look of their own (the
     *  recorder's pulsing dot, a package command's pulse). */
    className?: string;
    /** Custom properties, for a package's `setCommandPulse` colours. */
    style?: React.CSSProperties;
    run: () => void;
}

/** Qt's split button: a default action with the rest behind an arrow. */
export interface ToolbarSplitItem {
    kind: 'split';
    id: string;
    label: ReactNode;
    icon?: ReactNode;
    title?: string;
    checked?: boolean;
    /** Accessible name for the arrow half. */
    menuLabel: string;
    items: MenuNode[];
    run: () => void;
}

/** Anything that is not a button — the replay speed controls, or whatever a
 *  brand wants to drop into the row. Rendered as given. */
export interface ToolbarCustomItem {
    kind: 'custom';
    id: string;
    node: ReactNode;
}

export type ToolbarItem = ToolbarButtonItem | ToolbarSplitItem | ToolbarCustomItem;
