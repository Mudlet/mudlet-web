// Regenerate the summary table in docs/settings-divergence.md from its own rows.
//
//   node scripts/settings-audit-count.mjs docs/settings-divergence.md
//
// then paste the output over the table under "## Summary".
//
// This exists because the counts were maintained by hand and drifted four times
// while the audit was being written — the last time by five settings across four
// pages, in a direction that flattered the result. The rows are the truth; the
// table is a summary of them, so it should be derived rather than remembered.
//
// The unit is a *setting*, not a table row. Most rows are one setting, but a few
// collapse a block of identical controls under one label ("The 16 ANSI colours",
// "Top / Bottom / Left / Right border") because listing sixteen near-identical
// rows would bury the page. Those are declared below; add to the list whenever a
// new row's label covers more than one control, or the total will quietly drift
// again in the other direction.
import fs from 'node:fs';

const BLOCK = [
    [/The 16 map ANSI colours/, 16],
    [/The 16 ANSI colours/, 16],
    [/Top \/ Bottom \/ Left \/ Right border/, 4],
    [/Foreground, Background/, 2],
    [/Command line foreground \/ background/, 2],
    [/Command foreground \/ background/, 2],
    [/Discord Rich Presence \(11 controls\)/, 11],
    [/MudMaster Chat \/ MMCP \(9 controls\)/, 9],
    [/Certificate: Issuer \/ Issued to \/ Expires \/ Serial/, 4],
    [/Connect to the game via proxy \(address, port, username, password\)/, 4],
    [/Icon size toolbars/, 1],
];

const PAGES = ['General', 'Input line', 'Main display', 'Editor', 'Color view', 'Mapper',
    'Mapper colors', 'Chat', 'Connection', 'Shortcuts', 'Accessibility', 'Special Options'];

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const counts = new Map(PAGES.map(p => [p, { '✅': 0, '📍': 0, '🚧': 0, '❌': 0, '⚠️': 0 }]));
let page = null;

for (const line of lines) {
    const h2 = line.match(/^## (.+)$/);
    if (h2) { page = PAGES.includes(h2[1]) ? h2[1] : null; continue; }
    if (!page || !line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    // | Desktop | mark | Mudlet Web |  →  cells[1] desktop, cells[2] mark
    const mark = cells[2];
    if (!['✅', '📍', '🚧', '❌', '⚠️'].includes(mark)) continue;
    let n = 1;
    for (const [re, size] of BLOCK) if (re.test(cells[1])) n = size;
    counts.get(page)[mark] += n;
}

const dash = (n) => (n === 0 ? '—' : String(n));
const tot = { '✅': 0, '📍': 0, '🚧': 0, '❌': 0, '⚠️': 0 };
const out = ['| Desktop page | ✅ | 📍 | 🚧 | ❌ |', '|---|---|---|---|---|'];
for (const p of PAGES) {
    const c = counts.get(p);
    for (const k of Object.keys(tot)) tot[k] += c[k];
    out.push(`| ${p} | ${dash(c['✅'])} | ${dash(c['📍'])} | ${dash(c['🚧'])} | ${dash(c['❌'])} |`);
}
out.push(`| **Total** | **${dash(tot['✅'])}** | **${dash(tot['📍'])}** | **${dash(tot['🚧'])}** | **${dash(tot['❌'])}** |`);
console.log(out.join('\n'));
console.log('\nalso ⚠️ (merged/partial rows, not counted above):', tot['⚠️']);
console.log('universe:', tot['✅'] + tot['📍'] + tot['🚧'] + tot['❌']);
