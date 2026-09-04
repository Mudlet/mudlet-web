import type { ProfileSettings } from '../storage/schema';
import { serializeMudletXml, type SerializeInput } from './mudletXmlExport';
import { serializeVariablePackage, type MudletVariablePackage } from './mudletVariables';
import { applyProfileSettingsToHost } from './mudletHost';

// Link mode (phase 2): write the live mudix state back into a linked Mudlet
// profile's XML *DOM-preservingly*. We parse the profile's current save, replace
// only the parts we model — the six automation packages and the VariablePackage —
// and leave everything else (the entire <HostPackage>/<Host> with its ~130
// settings, and any element we don't understand) byte-for-byte untouched. This is
// what keeps a round-trip from silently stripping a user's Mudlet configuration.

// The automation packages we own and regenerate. HostPackage and any unknown
// sibling are preserved.
const OWNED_PACKAGE_TAGS = new Set([
    'ScriptPackage', 'TriggerPackage', 'AliasPackage',
    'TimerPackage', 'KeyPackage', 'ActionPackage', 'VariablePackage',
]);

/**
 * Re-parse a fragment we serialized ourselves. A failure here means the serializer
 * emitted something invalid, and grafting the partial tree `DOMParser` hands back
 * would put a `<parsererror>` blob and a truncated package into the user's own
 * Mudlet profile — the file desktop then refuses to load. Refuse the write-back
 * instead: the caller keeps the previous save, which is at least loadable.
 *
 * Note the guard cannot be `if (root)`: on a parse error Chrome still resolves
 * `getElementsByTagName('MudletPackage')[0]` against the partial tree.
 */
function parseOwnFragment(xml: string, what: string): Element {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error(`${what} serialized to invalid XML: ${err.textContent?.split('\n')[0]}`);
    const root = doc.documentElement;
    if (!root) throw new Error(`${what} serialized to an empty document`);
    return root;
}

/**
 * Produce the updated profile XML: the base save with its automation + variable
 * packages replaced by `trees` / `variables`, the modeled `<Host>` settings
 * updated in place from `settings`, and HostPackage's unmodeled fields (plus any
 * unknown element) carried over verbatim. Throws if the base XML is malformed.
 */
export function buildLinkedWriteback(
    baseXml: string,
    trees: SerializeInput,
    variables: MudletVariablePackage,
    settings?: Partial<ProfileSettings>,
): string {
    const doc = new DOMParser().parseFromString(baseXml, 'text/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error(`base profile XML parse error: ${err.textContent?.split('\n')[0]}`);
    const root = doc.getElementsByTagName('MudletPackage')[0];
    if (!root) throw new Error('base profile XML has no <MudletPackage> root');

    // Update the modeled Host settings in place (unmodeled fields preserved).
    const host = doc.getElementsByTagName('Host')[0];
    if (host && settings) applyProfileSettingsToHost(host, settings);

    // Drop the packages we own; HostPackage and unknown siblings stay.
    for (const child of Array.from(root.children)) {
        if (OWNED_PACKAGE_TAGS.has(child.tagName)) child.remove();
    }

    // Graft freshly-serialized automation packages (with per-node <packageName>
    // preserved, so package associations survive the round-trip).
    const autoRoot = parseOwnFragment(serializeMudletXml(trees), 'automation packages');
    for (const child of Array.from(autoRoot.children)) {
        root.appendChild(doc.importNode(child, true));
    }

    // Graft the variable package (indent '' so the parsed fragment has no stray
    // leading whitespace node).
    const varRoot = parseOwnFragment(serializeVariablePackage(variables, ''), 'variable package');
    if (varRoot.tagName === 'VariablePackage') {
        root.appendChild(doc.importNode(varRoot, true));
    }

    return new XMLSerializer().serializeToString(doc);
}

/** Two-digit zero-pad. */
function p2(n: number): string {
    return String(n).padStart(2, '0');
}

/** Mudlet's profile-save filename stamp for `date`: `YYYY-MM-DD#HH-mm-ss`. */
export function mudletTimestamp(date: Date): string {
    return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`
        + `#${p2(date.getHours())}-${p2(date.getMinutes())}-${p2(date.getSeconds())}`;
}
