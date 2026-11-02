// Renders sample billing documents with the Apps Script layout, to check how the PDFs look.
// Run: node tests/pdf-sample.mjs [outdir]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ctx = {}; vm.runInNewContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), ctx);
const { buildHtml } = ctx;
const { chromium } = require('playwright');
const out = process.argv[2] || 'test-results'; mkdirSync(out, { recursive: true });
const base = { branch: 'Branch One', timezone: 'America/Denver', generated_at: '2026-11-05 14:10', job: { id: 101, name: 'Main St Remodel', full_name: 'Acme Builders:Main St Remodel' },
  cart: { id: 123, at: '2026-11-03 07:42', entered_by: 'Sam Worker', on_behalf_of: null, note: 'Rough-in, second floor' } };
const orig = [{ number: 'C-0001', name: '12/2 NM-B wire, 250 ft', qty: 5, note: 'Kitchen' }, { number: 'C-0002', name: '1/2" EMT connector', qty: 20, note: '' }];
const samples = {
  'Main St Remodel_123_T1_261103_D457': { ...base, doc_id: 457, revision: 1, version: 'T1', cancelled: false, file_name: 'Main St Remodel_123_T1_261103_D457', current: orig, current_note: base.cart.note, corrections: [], original: orig },
  'Main St Remodel_123_C2_261105_D457': { ...base, doc_id: 457, revision: 3, version: 'C2', cancelled: false, file_name: 'Main St Remodel_123_C2_261105_D457',
    current: [{ ...orig[0], qty: 6 }, orig[1]], current_note: 'Rough-in, second floor and attic', original: orig,
    corrections: [
      { seq: 2, at: '2026-11-05 13:58', by: 'Alex Manager', correction_note: '', cancelled: false, note_before: 'Rough-in, second floor', note_after: 'Rough-in, second floor and attic', changes: [{ number: 'C-0001', name: '12/2 NM-B wire, 250 ft', before: 4, after: 6, note: 'Kitchen' }] },
      { seq: 1, at: '2026-11-04 08:15', by: 'Sam Worker', correction_note: 'Took 4, not 5', cancelled: false, note_before: 'Rough-in, second floor', note_after: 'Rough-in, second floor', changes: [{ number: 'C-0001', name: '12/2 NM-B wire, 250 ft', before: 5, after: 4, note: 'Kitchen' }] }] },
  'Main St Remodel_123_C3_261106_D457': { ...base, doc_id: 457, revision: 4, version: 'C3', cancelled: true, file_name: 'Main St Remodel_123_C3_261106_D457', current: [], current_note: '', original: orig,
    corrections: [{ seq: 3, at: '2026-11-06 09:01', by: 'Alex Manager', correction_note: 'Wrong job', cancelled: true, note_before: '', note_after: '', changes: orig.map(x => ({ ...x, before: x.qty, after: 0 })) }] },
};
const browser = await chromium.launch(); const page = await browser.newPage();
for (const [name, d] of Object.entries(samples)) {
  await page.setContent(buildHtml(d));
  await page.pdf({ path: `${out}/${name}.pdf`, format: 'Letter', margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
  await page.setViewportSize({ width: 816, height: 1056 }); await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}
await browser.close(); console.log('Rendered', Object.keys(samples).length, 'sample documents');
