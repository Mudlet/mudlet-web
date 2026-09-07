/**
 * Right-click context menu for OSC 8 hyperlinks (Mudlet's `config.menu`).
 *
 * Pure DOM — no scripting/session dependencies — so the renderer can build and
 * show it and tests can exercise it without the full engine. `run` executes a
 * selected item's action URI (the caller maps it to send/prompt/openUrl).
 */

import type { MenuItem, LinkTitle } from "../../mud/text/hyperlinkConfig";
import type { FormatColor } from "../../mud/text/FormatState";

const MENU_ID = "mudlet-popup-menu";

/** Render a parsed OSC 8 config colour as a CSS colour string. Config colours
 *  come from `mxpColor`, so they're rgb/hex in practice. */
function cssColor(c: FormatColor): string {
    if (c.space === "hex") return c.color;
    if (c.space === "rgb") return `rgb(${c.r}, ${c.g}, ${c.b})`;
    return "";
}

/**
 * Open the link's context menu at the event position. `menu` entries are either
 * separators (`{ separator: true }`) or `{ label, action }` pairs; `title`, when
 * present, is shown as an (optionally styled) header. Selecting an item runs its
 * action via `run` and closes the menu. Any open menu is replaced; clicking
 * outside dismisses it.
 */
export function openOsc8Menu(
    ev: MouseEvent,
    menu: MenuItem[],
    title: LinkTitle | undefined,
    run: (uri: string) => void,
): void {
    ev.preventDefault();
    document.getElementById(MENU_ID)?.remove();

    const box = document.createElement("div");
    box.id = MENU_ID;
    box.style.cssText = "position:fixed;z-index:9999;background:#1e1e1e;border:1px solid #444;border-radius:4px;padding:2px 0;box-shadow:0 2px 10px rgba(0,0,0,0.7);min-width:120px;font-family:monospace;font-size:13px";
    box.style.left = `${ev.clientX}px`;
    box.style.top = `${ev.clientY}px`;

    if (title?.text) {
        const header = document.createElement("div");
        header.textContent = title.text;
        const s = title.style;
        let css = "padding:5px 14px;white-space:nowrap;opacity:0.85;border-bottom:1px solid #444;";
        if (s?.foreground) css += `color:${cssColor(s.foreground)};`;
        if (s?.bold) css += "font-weight:bold;";
        if (s?.italic) css += "font-style:italic;";
        header.style.cssText = css;
        box.appendChild(header);
    }

    for (const entry of menu) {
        if (entry.separator) {
            const sep = document.createElement("div");
            sep.style.cssText = "height:1px;background:#444;margin:3px 0";
            box.appendChild(sep);
            continue;
        }
        if (!entry.action) continue;
        const action = entry.action;
        const item = document.createElement("div");
        item.textContent = entry.label ?? action;
        item.style.cssText = "padding:5px 14px;cursor:pointer;color:#ddd;white-space:nowrap";
        item.addEventListener("mouseenter", () => { item.style.background = "#2a4a6e"; });
        item.addEventListener("mouseleave", () => { item.style.background = ""; });
        item.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            box.remove();
            run(action);
        });
        box.appendChild(item);
    }

    document.body.appendChild(box);
    const dismiss = (e: MouseEvent): void => {
        if (!box.contains(e.target as Node)) {
            box.remove();
            document.removeEventListener("mousedown", dismiss);
        }
    };
    setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}
