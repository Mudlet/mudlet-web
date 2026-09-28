// Time-zone details the way a C library or Qt reports them, which the browser
// only hands out piecemeal: `Date` knows the offset, `Intl` knows the zone's id
// and its short name.

// CLDR only gives a zone its letter abbreviation in the locales where people
// use it — "CET" is en-GB's, "IST" (India) en-IN's, "EST" en-US's — and an
// offset ("GMT+1") everywhere else. So the English locales are asked in turn and
// the first real abbreviation wins. Built once: formatters are not cheap, and
// os.date may be formatting a timestamp for every line.
const ABBREVIATION_LOCALES = ['en-US', 'en-GB', 'en-IN', 'en-AU', 'en-CA', 'en-NZ', 'en-IE', 'en-ZA', 'en-SG'];
let abbreviationFormatters: Intl.DateTimeFormat[] | null = null;

/** Short zone name in effect at `date` ("UTC", "EST", "CET") — what glibc's
 *  `%Z` and Qt's `t` format token print. A zone that has no letter
 *  abbreviation gets the numeric one tzdata gives it ("+03", "+0530"). */
export function timeZoneAbbreviation(date: Date): string {
    try {
        abbreviationFormatters ??= ABBREVIATION_LOCALES.map(l =>
            new Intl.DateTimeFormat(l, { timeZoneName: 'short' }));
        for (const f of abbreviationFormatters) {
            const name = f.formatToParts(date).find(p => p.type === 'timeZoneName')?.value;
            if (name && !/^(GMT|UTC)[+\-−]/.test(name)) return name;
        }
    } catch { /* no Intl time-zone data — fall through to the offset */ }
    const east = -date.getTimezoneOffset();
    const abs = Math.abs(east);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = abs % 60 ? String(abs % 60).padStart(2, '0') : '';
    return (east < 0 ? '-' : '+') + hh + mm;
}

/** The IANA id of the local zone ("Europe/Warsaw"), Qt's `tttt`. */
export function timeZoneId(): string {
    try {
        const id = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (id) return id;
    } catch { /* fall through */ }
    return 'UTC';
}

/** The local zone's offset from UTC at `date` as "+hhmm", or "+hh:mm" with
 *  `colon` — Qt's `tt` and `ttt`. */
export function timeZoneOffset(date: Date, colon = false): string {
    const east = -date.getTimezoneOffset();
    const abs = Math.abs(east);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return (east < 0 ? '-' : '+') + hh + (colon ? ':' : '') + mm;
}
