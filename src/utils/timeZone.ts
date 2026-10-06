// Time-zone details the way a C library or Qt reports them, which the browser
// only hands out piecemeal: `Date` knows the offset, `Intl` knows the zone's id
// and its short name.

// glibc's %Z (and Qt's `t`, which asks the C library for the local zone) prints
// the abbreviation tzdata gives the zone at that moment. tzdata keeps letters
// only where people really use them — "EST", "CET", "IST" — and numbers
// everywhere else: Kathmandu is "+0545", Dubai "+04", Singapore "+08". The
// browser has no tzdata abbreviations to offer: Intl's short names are CLDR's,
// which invents some tzdata dropped ("NPT", "GST", "SGT"), lacks most outside
// a locale that uses them, and none at all for an offset a zone has since
// stopped using (London's year-round BST of 1968–71, New York before 1970).
// So the letters come from this table: per zone, the abbreviation for each
// offset (minutes east of UTC) in standard and in daylight time, as tzdata's
// rules name them. A zone or offset it doesn't list gets the numeric form,
// which is also what tzdata uses for every zone it doesn't name.

type ZoneNames = { std: Record<number, string>; dst: Record<number, string> };

const names = (std: Record<number, string>, dst: Record<number, string> = {}): ZoneNames => ({ std, dst });
const US_EASTERN = names({ [-300]: 'EST' }, { [-240]: 'EDT' });
const US_CENTRAL = names({ [-360]: 'CST' }, { [-300]: 'CDT' });
const US_MOUNTAIN = names({ [-420]: 'MST' }, { [-360]: 'MDT' });
const US_PACIFIC = names({ [-480]: 'PST' }, { [-420]: 'PDT' });
const US_ALASKA = names({ [-540]: 'AKST' }, { [-480]: 'AKDT' });
const US_HAWAII = names({ [-600]: 'HST' }, { [-540]: 'HDT' });
const ATLANTIC = names({ [-240]: 'AST' }, { [-180]: 'ADT' });
const NEWFOUNDLAND = names({ [-210]: 'NST' }, { [-150]: 'NDT' });
const GMT = names({ 0: 'GMT' });
const WESTERN_EU = names({ 0: 'WET', 60: 'CET' }, { 60: 'WEST', 120: 'CEST' });
const CENTRAL_EU = names({ 60: 'CET' }, { 120: 'CEST' });
const EASTERN_EU = names({ 120: 'EET' }, { 180: 'EEST' });
const MOSCOW = names({ 180: 'MSK', 240: 'MSK' }, { 240: 'MSD' });
const AUS_EASTERN = names({ 600: 'AEST' }, { 660: 'AEDT' });
const AUS_CENTRAL = names({ 570: 'ACST' }, { 630: 'ACDT' });
const AUS_WESTERN = names({ 480: 'AWST' }, { 540: 'AWDT' });
const NEW_ZEALAND = names({ 720: 'NZST' }, { 780: 'NZDT' });
const CENTRAL_AFRICA = names({ 120: 'CAT' });
const EAST_AFRICA = names({ 180: 'EAT' });
const WEST_AFRICA = names({ 60: 'WAT' });
const SOUTH_AFRICA = names({ 120: 'SAST' });
const UTC = names({ 0: 'UTC' });

/** Zones named by one or more of the rule sets above (an Indiana zone has
 *  been both Eastern and Central, so its names are the two merged). */
const ZONE_GROUPS: [string[], ZoneNames[]][] = [
    [['UTC', 'Etc/UTC', 'Etc/UCT', 'UCT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu'], [UTC]],
    [['GMT', 'Etc/GMT', 'Etc/GMT+0', 'Etc/GMT-0', 'Etc/GMT0', 'GMT0', 'GMT+0', 'GMT-0', 'Etc/Greenwich', 'Greenwich',
        'Africa/Abidjan', 'Africa/Accra', 'Africa/Bamako', 'Africa/Banjul', 'Africa/Bissau', 'Africa/Conakry',
        'Africa/Dakar', 'Africa/Freetown', 'Africa/Lome', 'Africa/Monrovia', 'Africa/Nouakchott',
        'Africa/Ouagadougou', 'Africa/Sao_Tome', 'Atlantic/Reykjavik', 'Atlantic/St_Helena', 'Iceland',
        'America/Danmarkshavn'], [GMT]],
    [['Europe/London', 'Europe/Belfast', 'Europe/Guernsey', 'Europe/Isle_of_Man', 'Europe/Jersey', 'GB', 'GB-Eire'],
        [names({ 0: 'GMT', 60: 'BST' }, { 60: 'BST', 120: 'BDST' })]],
    [['Europe/Dublin', 'Eire'], [names({ 0: 'GMT', 60: 'IST' }, { 0: 'GMT', 60: 'IST' })]],
    [['Europe/Lisbon', 'Portugal', 'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Faroe', 'Atlantic/Faeroe', 'WET'],
        [WESTERN_EU]],
    [['Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Brussels',
        'Europe/Vienna', 'Europe/Zurich', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Warsaw',
        'Europe/Prague', 'Europe/Budapest', 'Europe/Belgrade', 'Europe/Zagreb', 'Europe/Ljubljana', 'Europe/Sarajevo',
        'Europe/Skopje', 'Europe/Bratislava', 'Europe/Luxembourg', 'Europe/Monaco', 'Europe/Malta', 'Europe/Andorra',
        'Europe/Gibraltar', 'Europe/Tirane', 'Europe/Vaduz', 'Europe/San_Marino', 'Europe/Vatican',
        'Europe/Podgorica', 'Europe/Busingen', 'Arctic/Longyearbyen', 'Atlantic/Jan_Mayen', 'Africa/Ceuta',
        'Africa/Tunis', 'Africa/Algiers', 'Poland', 'CET', 'MET'], [CENTRAL_EU]],
    [['Europe/Athens', 'Europe/Bucharest', 'Europe/Helsinki', 'Europe/Kiev', 'Europe/Kyiv', 'Europe/Riga',
        'Europe/Sofia', 'Europe/Tallinn', 'Europe/Vilnius', 'Europe/Chisinau', 'Europe/Tiraspol', 'Europe/Mariehamn',
        'Europe/Uzhgorod', 'Europe/Zaporozhye', 'Europe/Nicosia', 'Asia/Nicosia', 'Asia/Famagusta', 'Asia/Beirut',
        'Asia/Gaza', 'Asia/Hebron', 'Africa/Cairo', 'Egypt', 'Africa/Tripoli', 'Libya', 'Europe/Kaliningrad', 'EET'],
        [EASTERN_EU]],
    [['Europe/Moscow', 'W-SU', 'Europe/Simferopol'], [MOSCOW]],
    [['Asia/Jerusalem', 'Asia/Tel_Aviv', 'Israel'], [names({ 120: 'IST' }, { 180: 'IDT', 240: 'IDDT' })]],
    [['Asia/Kolkata', 'Asia/Calcutta'], [names({ 330: 'IST' })]],
    [['Asia/Karachi'], [names({ 300: 'PKT' }, { 360: 'PKST' })]],
    [['Asia/Hong_Kong', 'Hongkong'], [names({ 480: 'HKT' }, { 540: 'HKST' })]],
    [['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Macau', 'Asia/Macao', 'Asia/Taipei',
        'PRC', 'ROC'], [names({ 480: 'CST' }, { 540: 'CDT' })]],
    [['Asia/Tokyo', 'Japan'], [names({ 540: 'JST' }, { 600: 'JDT' })]],
    [['Asia/Seoul', 'ROK'], [names({ 540: 'KST' }, { 600: 'KDT' })]],
    [['Asia/Pyongyang'], [names({ 510: 'KST', 540: 'KST' })]],
    [['Asia/Manila'], [names({ 480: 'PST' }, { 540: 'PDT' })]],
    [['Asia/Jakarta', 'Asia/Pontianak'], [names({ 420: 'WIB' })]],
    [['Asia/Makassar', 'Asia/Ujung_Pandang'], [names({ 480: 'WITA' })]],
    [['Asia/Jayapura'], [names({ 540: 'WIT' })]],
    [['Australia/Sydney', 'Australia/Melbourne', 'Australia/Hobart', 'Australia/Currie', 'Australia/Canberra',
        'Australia/ACT', 'Australia/NSW', 'Australia/Victoria', 'Australia/Tasmania', 'Australia/Brisbane',
        'Australia/Lindeman', 'Australia/Queensland', 'Antarctica/Macquarie'], [AUS_EASTERN]],
    [['Australia/Adelaide', 'Australia/South', 'Australia/Broken_Hill', 'Australia/Yancowinna', 'Australia/Darwin',
        'Australia/North'], [AUS_CENTRAL]],
    [['Australia/Perth', 'Australia/West'], [AUS_WESTERN]],
    [['Pacific/Auckland', 'NZ', 'Antarctica/McMurdo', 'Antarctica/South_Pole'], [NEW_ZEALAND]],
    [['Africa/Johannesburg', 'Africa/Maseru', 'Africa/Mbabane'], [SOUTH_AFRICA]],
    [['Africa/Maputo', 'Africa/Harare', 'Africa/Lusaka', 'Africa/Lubumbashi', 'Africa/Gaborone', 'Africa/Blantyre',
        'Africa/Bujumbura', 'Africa/Kigali', 'Africa/Windhoek', 'Africa/Juba', 'Africa/Khartoum'],
        [CENTRAL_AFRICA, EAST_AFRICA]],
    [['Africa/Nairobi', 'Africa/Addis_Ababa', 'Africa/Asmara', 'Africa/Asmera', 'Africa/Dar_es_Salaam',
        'Africa/Djibouti', 'Africa/Kampala', 'Africa/Mogadishu', 'Indian/Antananarivo', 'Indian/Comoro',
        'Indian/Mayotte'], [EAST_AFRICA]],
    [['Africa/Lagos', 'Africa/Kinshasa', 'Africa/Luanda', 'Africa/Douala', 'Africa/Libreville', 'Africa/Malabo',
        'Africa/Niamey', 'Africa/Porto-Novo', 'Africa/Bangui', 'Africa/Brazzaville', 'Africa/Ndjamena'],
        [WEST_AFRICA]],
    [['America/New_York', 'US/Eastern', 'EST5EDT', 'EST', 'America/Detroit', 'US/Michigan', 'America/Toronto',
        'America/Montreal', 'Canada/Eastern', 'America/Nipigon', 'America/Thunder_Bay', 'America/Iqaluit',
        'America/Nassau', 'America/Jamaica', 'Jamaica', 'America/Panama', 'America/Cayman', 'America/Atikokan',
        'America/Coral_Harbour', 'America/Port-au-Prince'], [US_EASTERN]],
    [['America/Indiana/Indianapolis', 'America/Indianapolis', 'America/Fort_Wayne', 'US/East-Indiana',
        'America/Indiana/Marengo', 'America/Indiana/Vevay', 'America/Indiana/Vincennes', 'America/Indiana/Winamac',
        'America/Indiana/Petersburg', 'America/Indiana/Knox', 'US/Indiana-Starke', 'America/Knox_IN',
        'America/Indiana/Tell_City', 'America/Kentucky/Louisville', 'America/Louisville',
        'America/Kentucky/Monticello', 'America/Cancun', 'America/Grand_Turk'], [US_EASTERN, US_CENTRAL, ATLANTIC]],
    [['America/Chicago', 'US/Central', 'CST6CDT', 'America/Winnipeg', 'Canada/Central', 'America/Rainy_River',
        'America/Rankin_Inlet', 'America/Resolute', 'America/Menominee', 'America/North_Dakota/Center',
        'America/North_Dakota/New_Salem', 'America/North_Dakota/Beulah', 'America/Mexico_City', 'Mexico/General',
        'America/Matamoros', 'America/Monterrey', 'America/Merida', 'America/Bahia_Banderas',
        'America/Chihuahua', 'America/Ojinaga', 'America/Regina', 'Canada/Saskatchewan', 'America/Swift_Current',
        'America/Belize', 'America/Costa_Rica', 'America/El_Salvador', 'America/Guatemala',
        'America/Tegucigalpa', 'America/Managua'], [US_CENTRAL, US_MOUNTAIN]],
    [['America/Havana', 'Cuba'], [names({ [-300]: 'CST' }, { [-240]: 'CDT' })]],
    [['America/Denver', 'US/Mountain', 'MST7MDT', 'MST', 'America/Shiprock', 'Navajo', 'America/Boise',
        'America/Edmonton', 'Canada/Mountain', 'America/Yellowknife', 'America/Cambridge_Bay', 'America/Inuvik',
        'America/Ciudad_Juarez', 'America/Phoenix', 'US/Arizona', 'America/Creston', 'America/Hermosillo',
        'America/Mazatlan', 'Mexico/BajaSur'], [US_MOUNTAIN, US_CENTRAL]],
    [['America/Whitehorse', 'Canada/Yukon', 'America/Dawson', 'America/Dawson_Creek', 'America/Fort_Nelson'],
        [US_PACIFIC, US_MOUNTAIN]],
    [['America/Los_Angeles', 'US/Pacific', 'PST8PDT', 'America/Vancouver', 'Canada/Pacific', 'America/Tijuana',
        'America/Ensenada', 'America/Santa_Isabel', 'Mexico/BajaNorte'], [US_PACIFIC]],
    [['America/Anchorage', 'US/Alaska', 'America/Juneau', 'America/Sitka', 'America/Yakutat', 'America/Nome',
        'America/Metlakatla'], [US_ALASKA, US_PACIFIC]],
    [['America/Adak', 'America/Atka', 'US/Aleutian', 'Pacific/Honolulu', 'US/Hawaii', 'HST', 'Pacific/Johnston'],
        [US_HAWAII]],
    [['America/Halifax', 'Canada/Atlantic', 'America/Glace_Bay', 'America/Moncton', 'America/Goose_Bay',
        'America/Thule', 'Atlantic/Bermuda', 'America/Puerto_Rico', 'America/Santo_Domingo', 'America/Barbados',
        'America/Martinique', 'America/Anguilla', 'America/Antigua', 'America/Aruba', 'America/Curacao',
        'America/Dominica', 'America/Grenada', 'America/Guadeloupe', 'America/Kralendijk',
        'America/Lower_Princes', 'America/Marigot', 'America/Montserrat', 'America/Port_of_Spain',
        'America/St_Barthelemy', 'America/St_Kitts', 'America/St_Lucia', 'America/St_Thomas',
        'America/St_Vincent', 'America/Tortola', 'America/Virgin'], [ATLANTIC]],
    [['America/St_Johns', 'Canada/Newfoundland'], [NEWFOUNDLAND]],
    [['Pacific/Guam', 'Pacific/Saipan'], [names({ 600: 'ChST' })]],
    [['Pacific/Pago_Pago', 'Pacific/Midway', 'Pacific/Samoa', 'US/Samoa'], [names({ [-660]: 'SST' })]],
];

const ZONE_NAMES = new Map<string, ZoneNames>();
for (const [zones, sets] of ZONE_GROUPS) {
    const merged = names(Object.assign({}, ...sets.map(s => s.std)), Object.assign({}, ...sets.map(s => s.dst)));
    for (const zone of zones) ZONE_NAMES.set(zone, merged);
}

let localZone: string | undefined;
let localZoneFor: string | undefined;
/** The IANA id of the zone `Date` formats local time in. Re-read when the
 *  process's TZ changes, so a test (or node) switching zones is followed. */
function localTimeZone(): string | undefined {
    const tz = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TZ;
    if (localZone === undefined || tz !== localZoneFor) {
        try { localZone = new Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { localZone = undefined; }
        localZoneFor = tz;
    }
    return localZone;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
/** The zone's offset east of UTC at `date`, in seconds. Intl's "longOffset"
 *  carries the seconds a zone's local mean time had ("GMT-04:56:02"), which
 *  `getTimezoneOffset` rounds away. */
function offsetSeconds(date: Date, zone: string | undefined): number {
    if (zone) {
        try {
            let f = offsetFormatters.get(zone);
            if (!f) {
                f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
                offsetFormatters.set(zone, f);
            }
            const name = f.formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? '';
            const m = /^GMT(?:([+\-−])(\d{1,2}):?(\d{2})(?::?(\d{2}))?)?$/.exec(name);
            if (m) {
                if (!m[1]) return 0;
                const s = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0);
                return m[1] === '+' ? s : -s;
            }
        } catch { /* an unknown zone — fall back to the local one */ }
    }
    return -date.getTimezoneOffset() * 60;
}

/** Short zone name in effect at `date` ("UTC", "EST", "CET") — what glibc's
 *  `%Z` and Qt's `t` format token print. A zone tzdata gives no letters gets
 *  its numeric abbreviation ("+03", "+0545"); a time before the zone adopted
 *  standard time is its local mean time, "LMT". `timeZone` is an IANA id; the
 *  local zone when omitted. */
export function timeZoneAbbreviation(date: Date, timeZone?: string): string {
    const zone = timeZone ?? localTimeZone();
    const seconds = offsetSeconds(date, zone);
    if (seconds % 60 !== 0) return 'LMT';
    const east = seconds / 60;
    const table = zone ? ZONE_NAMES.get(zone) : undefined;
    if (table) {
        // tm_isdst: the offset is ahead of the year's standard one, which is
        // the smaller of January's and July's (true in either hemisphere).
        const jan = new Date(date.getTime()); jan.setUTCMonth(0, 1);
        const jul = new Date(date.getTime()); jul.setUTCMonth(6, 1);
        const std = Math.min(offsetSeconds(jan, zone), offsetSeconds(jul, zone)) / 60;
        const [first, second] = east > std ? [table.dst, table.std] : [table.std, table.dst];
        const name = first[east] ?? second[east];
        if (name) return name;
    }
    const abs = Math.abs(east);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = abs % 60 ? String(abs % 60).padStart(2, '0') : '';
    return (east < 0 ? '-' : '+') + hh + mm;
}

/** The zone's long display name in effect at `date` ("Coordinated Universal
 *  Time", "Central European Summer Time") — Qt 6's `tttt`, which prints
 *  `QTimeZone::displayName(when, LongName, locale)` (not the IANA id) and falls
 *  back to the abbreviation when there is none. Desktop asks the system
 *  locale; the English name is used here, as for the abbreviation. */
let longNameFormatter: Intl.DateTimeFormat | null = null;
export function timeZoneLongName(date: Date): string {
    try {
        longNameFormatter ??= new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' });
        const name = longNameFormatter.formatToParts(date).find(p => p.type === 'timeZoneName')?.value;
        if (name) return name;
    } catch { /* no Intl time-zone data — fall through to the abbreviation */ }
    return timeZoneAbbreviation(date);
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
