// Compares an Anbud result with the reference calculation v2, post by post. No AI calls, no database.
//
//   bun scripts/compare-anbud-v2.ts --snapshot /tmp/anbud-verification/<tender>-<run>.json
//       A saved run from verify-anbud-pipeline.ts (quantities, matches and cost).
//   bun scripts/compare-anbud-v2.ts --documents <folder with the tender files>
//       Runs only the code part of the quantity engine on local files (no model answer): shows what code builds alone.
//   bun scripts/compare-anbud-v2.ts --documents <folder> --requirements <requirements.json> [--drawing-text <file>]
//       Requirements engine: builds the quantities from a saved model answer (or a hand-written list) with the object
//       model and type codes counted by code. --drawing-text adds a drawing transcription (type codes) when the
//       drawings have no text layer.
//   bun scripts/compare-anbud-v2.ts --catalog example
//       Catalog coverage of the built-in example catalog (seed with refreshed example values + additional types).
//   Add --json <file> to also write the comparison as JSON.
//
// Tender files and saved runs may contain customer data: keep them outside the repository.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { calculateTenderQuantities } from '../src/lib/tender-quantities';
import { readTenderDocument } from '../src/lib/tender-reading';
import { buildObjectModel } from '../src/lib/tender-object-model';
import { buildRoomList } from '../src/lib/tender-room-list';
import { typeCodesInText } from '../src/lib/tender-type-codes';
import { buildRequirementQuantities, decodeRequirements } from '../src/lib/tender-requirements';
import { exampleRoomRecipes } from '../src/lib/tender-room-recipes';
import { extractTenderPdfPageText } from '../src/lib/tender-pdf-text.server';
import { catalogCoverage, compareWithV2, formatCatalogCoverage, formatV2Comparison, type V2Snapshot } from '../src/test/helpers/v2-comparison';
import { ADDITIONAL_EXAMPLE_POST_TYPES, EXAMPLE_VALUE_UPDATES, SEEDED_EXAMPLE_POST_TYPES } from '../src/lib/tender-example-catalog';

const args = process.argv.slice(2), arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const snapshotPath = arg('--snapshot'), folder = arg('--documents'), jsonPath = arg('--json'), catalog = arg('--catalog');
if (catalog === 'example') {
  const seeded = SEEDED_EXAMPLE_POST_TYPES.map(t => { const u = EXAMPLE_VALUE_UPDATES.find(x => x.id === t.id); return u ? { ...t, ...u.to } : t; });
  console.log(formatCatalogCoverage(catalogCoverage([...seeded, ...ADDITIONAL_EXAMPLE_POST_TYPES])));
  process.exit(0);
}
if (!snapshotPath === !folder) throw Error('Use exactly one of --snapshot <file>, --documents <folder> or --catalog example.');

async function codeOnly(dir: string): Promise<V2Snapshot> {
  const requirementsPath = arg('--requirements'), drawingPath = arg('--drawing-text');
  const documents = [];
  let n = 1;
  for (const name of readdirSync(dir).sort()) {
    const type = name.toLowerCase().split('.').pop() ?? '';
    if (!['pdf', 'docx', 'xlsx'].includes(type)) continue;
    const bytes = new Uint8Array(readFileSync(`${dir}/${name}`));
    let text = '', pages: number | null = null;
    if (type === 'pdf') { const p = await extractTenderPdfPageText(bytes); pages = p.length; text = p.map((t, i) => `Fysisk sida: ${i + 1}\n${t}`).join('\n'); }
    else text = (await readTenderDocument(bytes, type)).text ?? '';
    documents.push({ id: `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`, file_name: name, file_type: type, page_count: pages, text });
  }
  if (requirementsPath) {
    const codes = [...documents.flatMap(d => typeCodesInText(d.text)), ...(drawingPath ? typeCodesInText(readFileSync(drawingPath, 'utf8')) : [])];
    const model = buildObjectModel(documents, codes, exampleRoomRecipes.separate_wc_min_area ?? null);
    const rooms = buildRoomList(documents);
    console.log(`Objektmodell: ${JSON.stringify(model?.counts ?? null)}, typkoder ${codes.length}, matchade ${model?.code_matches ?? 0}; rumsförteckning: ${rooms ? rooms.types.map(t => `${t.name} ${t.count}`).join(', ') : 'ingen'}`);
    return { quantities: buildRequirementQuantities(decodeRequirements(JSON.parse(readFileSync(requirementsPath, 'utf8'))), model, documents, exampleRoomRecipes, rooms), cost: null };
  }
  return { quantities: calculateTenderQuantities({ operands: [], items: [], assumptions: [] }, documents, null, true), cost: null };
}

const snapshot: V2Snapshot = snapshotPath ? JSON.parse(readFileSync(snapshotPath, 'utf8')) : await codeOnly(folder!);
const comparison = compareWithV2(snapshot);
console.log(formatV2Comparison(comparison));
if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ counts: comparison.counts, found: comparison.found, extras: comparison.extras.map(r => r.post), at_v2_prices: comparison.at_v2_prices, catalog_total: comparison.catalog_total, lines: comparison.lines.map(l => ({ nr: l.v2.nr, status: l.status, v2: l.v2.quantity, pipeline: l.quantity, in_total: l.in_total, rows: l.rows.map(r => r.post) })) }, null, 2));
