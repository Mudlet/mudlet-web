/** One inbound ATCP (telnet option 200) message as desktop files it: `name`
 *  keys the Lua `atcp` table and names the event, `value` is what both carry. */
export interface AtcpMessage {
    name: string;
    value: string;
}

/** Split a decoded ATCP subnegotiation body the way Mudlet's
 *  `cTelnet::setATCPVariables` does. A body with a line feed is split at the
 *  first one, anything else at the first space; the dots come out of the name
 *  (`Char.Vitals` → `CharVitals`) and the line feeds out of the value; and when
 *  the first line held more than the name, the rest of it leads the value,
 *  space-separated — so `Char.Vitals H:1 M:2\nNL:3` files `"H:1 M:2 NL:3"`
 *  under `CharVitals`. Desktop removes every dot from that whole first line
 *  before splitting it, value half included, and so does this.
 *
 *  Null for `Client.Compose`, which desktop hands to its composer window and
 *  never puts in the table or raises. There is no composer here (the hello
 *  doesn't offer `composer 1`), so it is dropped. */
export function parseAtcpMessage(text: string): AtcpMessage | null {
    let name: string;
    let value: string;
    const lf = text.indexOf('\n');
    if (lf > -1) {
        name = text.slice(0, lf);
        value = text.slice(lf + 1);
    } else {
        const sp = text.indexOf(' ');
        name = sp > -1 ? text.slice(0, sp) : text;
        value = sp > -1 ? text.slice(sp + 1) : '';
    }
    if (name.startsWith('Client.Compose')) return null;

    name = name.replace(/\./g, '');
    value = value.replace(/\n/g, '');
    const sp = name.indexOf(' ');
    if (sp > -1) {
        value = name.slice(sp + 1) + ' ' + value;
        name = name.slice(0, sp);
    }
    return { name, value };
}
