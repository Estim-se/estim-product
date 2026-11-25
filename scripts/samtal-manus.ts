// estim Samtal: writes docs/samtal/rollspel/manus.md (the scripts to read aloud) from rollspel.json.
// Usage: bun scripts/samtal-manus.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const dir = join(resolve(import.meta.dir, '..'), 'docs/samtal/rollspel');
const r = JSON.parse(readFileSync(join(dir, 'rollspel.json'), 'utf8')) as { employees: { name: string; phone: string }[]; calls: { id: string; title: string; to: string; from: string | null; lines: [string, string][]; fasit: { classification: string } }[] };
const employee = (phone: string) => r.employees.find(e => e.phone === phone)?.name ?? phone;
const out = [
  '# estim Samtal – rollspel att spela in',
  '',
  'Femton korta samtal på svenska. **A** är den anställda som svarar, **K** är den som ringer. Läs naturligt, gärna med två personer. Små avvikelser från manus gör inget, men säg namn, adresser, datum och nummer exakt som de står.',
  '',
  'Spara varje inspelning som `<id>.m4a`, `.mp3` eller `.wav` (till exempel `rollspel-01.m4a`) i en mapp **utanför** repot. Alla namn är påhittade och alla nummer ligger i PTS fiktiva serie.',
  '',
  ...r.calls.flatMap(c => [
    `## ${c.id}: ${c.title}`,
    '',
    `Till ${employee(c.to)} · ${c.from ? `från ${c.from}` : 'dolt nummer'}${c.fasit.classification === 'privat' ? ' · **privat samtal, ska filtreras bort**' : ''}`,
    '',
    ...c.lines.map(([who, text]) => `**${who}:** ${text}  `),
    '',
  ]),
].join('\n');
writeFileSync(join(dir, 'manus.md'), out);
console.log(`Skrev manus.md (${r.calls.length} samtal).`);
