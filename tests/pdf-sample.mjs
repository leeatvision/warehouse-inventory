// Renders sample billing documents with the Apps Script layout, to check how the PDFs look.
// Run: node tests/pdf-sample.mjs [outdir] [brand.json with company, accent, accent_ink, tint, logo (data URI)]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ctx = {}; vm.runInNewContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), ctx);
const { buildHtml } = ctx;
const { chromium } = require('playwright');
const out = process.argv[2] || 'test-results'; mkdirSync(out, { recursive: true });
const brand = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : {};
const base = { branch: 'Branch One', timezone: 'America/Denver', generated_at: '11/05/2026 2:10 PM', branch_code: 'B1',
  job: { id: 101, name: 'Main St Remodel', full_name: 'Acme Builders=>Main St Remodel', customer: 'Acme Builders', address: { source: 'site', lines: ['12 Main St', 'Springfield, ST 00001'] } },
  cart: { id: 123, at: '11/03/2026 7:42 AM', entered_by: 'Sam Worker', on_behalf_of: null, note: 'Rough-in, second floor' } };
const orig = [{ number: 'C-0001', name: '12/2 NM-B wire, 250 ft', qty: 5, note: 'Kitchen' }, { number: 'C-0002', name: '1/2" EMT connector', qty: 20, note: '' }];
const samples = {
  'Main St Remodel_11/03/2026_Take out by Sam Worker': { ...base, doc_id: 457, revision: 1, version: 'T1', cancelled: false, file_name: 'Main St Remodel_11/03/2026_Take out by Sam Worker', current: orig, current_note: base.cart.note, corrections: [], original: orig },
  'Main St Remodel_11/05/2026_Correction 2 by Alex Manager': { ...base, doc_id: 457, revision: 3, version: 'C2', cancelled: false, file_name: 'Main St Remodel_11/05/2026_Correction 2 by Alex Manager',
    current: [{ ...orig[0], qty: 6 }, orig[1]], current_note: 'Rough-in, second floor and attic', original: orig,
    corrections: [
      { seq: 2, at: '11/05/2026 1:58 PM', by: 'Alex Manager', correction_note: '', cancelled: false, note_before: 'Rough-in, second floor', note_after: 'Rough-in, second floor and attic', changes: [{ number: 'C-0001', name: '12/2 NM-B wire, 250 ft', before: 4, after: 6, note: 'Kitchen' }] },
      { seq: 1, at: '11/04/2026 8:15 AM', by: 'Sam Worker', correction_note: 'Took 4, not 5', cancelled: false, note_before: 'Rough-in, second floor', note_after: 'Rough-in, second floor', changes: [{ number: 'C-0001', name: '12/2 NM-B wire, 250 ft', before: 5, after: 4, note: 'Kitchen' }] }] },
  'Main St Remodel_11/06/2026_Cancelled by Alex Manager': { ...base, doc_id: 457, revision: 4, version: 'C3', cancelled: true, file_name: 'Main St Remodel_11/06/2026_Cancelled by Alex Manager', job: { ...base.job, address: null }, current: [], current_note: '', original: orig,
    corrections: [{ seq: 3, at: '11/06/2026 9:01 AM', by: 'Alex Manager', correction_note: 'Wrong job', cancelled: true, note_before: '', note_after: '', changes: orig.map(x => ({ ...x, before: x.qty, after: 0 })) }] },
};
const browser = await chromium.launch(); const page = await browser.newPage();
for (const [key, d] of Object.entries(samples)) { const name = key.replace(/\//g, "-");
  await page.setContent(buildHtml(d, brand));
  await page.pdf({ path: `${out}/${name}.pdf`, format: 'Letter', margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
  await page.setViewportSize({ width: 816, height: 1056 }); await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}
await browser.close(); console.log('Rendered', Object.keys(samples).length, 'sample documents');
