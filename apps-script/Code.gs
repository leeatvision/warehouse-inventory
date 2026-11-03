/**
 * Warehouse billing delivery. Runs every 5 minutes in the Google account that owns the billing folder.
 * For every Cart and Job code with new or corrected Take outs, it saves one PDF into the folder and moves
 * the previous version of that document to Trash. Nothing is marked delivered until the PDF is saved,
 * so a failed run is simply retried 5 minutes later.
 *
 * Script properties (Project Settings > Script properties):
 *   SUPABASE_URL    https://<project>.supabase.co
 *   SUPABASE_KEY    the publishable key
 *   DELIVERY_TOKEN  the wh_delivery_token value from Supabase Vault
 *   FOLDER_ID       the billing folder's id (the part after /folders/ in its link)
 */

function setup() {
  const p = props_();
  DriveApp.getFolderById(p.FOLDER_ID).getName(); // fails here if the folder is wrong or not shared with this account
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'deliver').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('deliver').timeBased().everyMinutes(5).create();
  deliver();
  Logger.log('Set up: delivery runs every 5 minutes.');
}

function deliver() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a run is already going
  try {
    const p = props_();
    const folder = DriveApp.getFolderById(p.FOLDER_ID);
    const brand = loadBrand_(p);
    for (let round = 0; round < 5; round++) {
      const docs = rpc_(p, 'wh_delivery_claim', { p_token: p.DELIVERY_TOKEN, p_limit: 20 });
      if (!docs.length) break;
      for (const d of docs) {
        try {
          const name = d.file_name + '.pdf';
          const pdf = Utilities.newBlob(buildHtml(d, brand), 'text/html', d.file_name + '.html').getAs('application/pdf').setName(name);
          const file = folder.createFile(pdf);
          trashOlder_(folder, d, file.getId());
          rpc_(p, 'wh_delivery_confirm', { p_token: p.DELIVERY_TOKEN, p_doc: d.doc_id, p_revision: d.revision, p_file_id: file.getId(), p_file_name: name, p_error: null });
        } catch (e) {
          try { rpc_(p, 'wh_delivery_confirm', { p_token: p.DELIVERY_TOKEN, p_doc: d.doc_id, p_revision: d.revision, p_file_id: null, p_file_name: null, p_error: String(e && e.message || e) }); } catch (ignored) {}
          throw e; // stop this run; Google emails the account owner about repeated failures
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
}

// Move every earlier version of this document (same D number) to Trash, keeping the one just made.
function trashOlder_(folder, d, keepId) {
  const suffix = '_D' + d.doc_id + '.pdf';
  if (d.old_file_id && d.old_file_id !== keepId) {
    try { DriveApp.getFileById(d.old_file_id).setTrashed(true); } catch (e) { /* already gone or moved out of reach */ }
  }
  const it = folder.searchFiles('title contains "_D' + d.doc_id + '" and trashed = false');
  while (it.hasNext()) {
    const f = it.next();
    if (f.getId() !== keepId && f.getName().endsWith(suffix)) f.setTrashed(true);
  }
}

// The PDF's look (company name, colours, logo) comes from the database, so this script holds nothing company-specific.
// The logo is fetched once and kept for 6 hours.
function loadBrand_(p) {
  let brand = {};
  try { brand = rpc_(p, 'wh_delivery_brand', { p_token: p.DELIVERY_TOKEN }) || {}; } catch (e) { brand = {}; }
  if (brand.logo_url) {
    const cache = CacheService.getScriptCache(); const key = 'logo:' + brand.logo_url;
    let data = cache.get(key);
    if (!data) {
      try {
        const r = UrlFetchApp.fetch(brand.logo_url, { muteHttpExceptions: true });
        if (r.getResponseCode() === 200) {
          const blob = r.getBlob();
          data = 'data:' + (blob.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(blob.getBytes());
          if (data.length < 95000) cache.put(key, data, 21600);
        }
      } catch (e) { data = null; }
    }
    brand.logo = data || '';
  }
  return brand;
}

function props_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'DELIVERY_TOKEN', 'FOLDER_ID']) {
    if (!all[k]) throw new Error('Script property ' + k + ' is not set');
  }
  return all;
}

function rpc_(p, fn, args) {
  const r = UrlFetchApp.fetch(p.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'post', contentType: 'application/json', headers: { apikey: p.SUPABASE_KEY },
    payload: JSON.stringify(args), muteHttpExceptions: true,
  });
  const body = r.getContentText();
  if (r.getResponseCode() >= 300) throw new Error(fn + ' failed (' + r.getResponseCode() + '): ' + body.slice(0, 300));
  return JSON.parse(body);
}

// ------------------------------------------------------------------ the PDF
// Simple HTML and tables, because Google's HTML-to-PDF converter handles little else reliably.
function esc_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function qty_(v) { const n = Number(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000); }

function buildHtml(d, brand) {
  brand = brand || {};
  const accent = brand.accent || '#2563EB', ink = brand.accent_ink || '#1E3A8A', tint = brand.tint || '#EFF4FF';
  const INK = '#1E1E1E', MUT = '#5F6368', LINE = '#D9DCDF';
  const corr = d.corrections || [];
  const latest = corr[0];
  const job = d.job || {};
  const addr = job.address && job.address.lines && job.address.lines.length ? job.address : null;
  const sum = rows => rows.reduce((a, r) => a + Number(r.qty || 0), 0);

  const css = 'body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:' + INK + ';margin:0;line-height:1.35}' +
    'table{border-collapse:collapse;width:100%}td,th{vertical-align:top}' +
    '.lbl{font-size:7.5pt;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:' + MUT + '}' +
    '.mono{font-family:"Courier New",monospace;font-size:9pt}' +
    '.items th{font-size:7.5pt;letter-spacing:.06em;text-transform:uppercase;color:' + MUT + ';text-align:left;padding:6pt 8pt;border-bottom:1.5pt solid ' + INK + '}' +
    '.items td{padding:7pt 8pt;border-bottom:.75pt solid ' + LINE + '}' +
    '.items tr.alt td{background:#F7F8F8}' +
    '.items .q{text-align:right;font-weight:bold;font-size:12pt;white-space:nowrap}' +
    '.items .n{color:#3D3D3D;font-size:9pt}' +
    '.items .tot td{border-bottom:0;border-top:1.5pt solid ' + INK + ';font-weight:bold;padding-top:7pt}' +
    'h2{font-size:11pt;margin:18pt 0 6pt}h2 span{font-weight:normal;color:' + MUT + ';font-size:9.5pt}';

  function itemsTable(rows) {
    if (!rows.length) return '<p style="color:' + MUT + '">No items for this Job code.</p>';
    return '<table class="items"><tr><th style="width:22pt">#</th><th style="width:64pt">Item no.</th><th>Item</th>' +
      '<th style="text-align:right;width:52pt">Qty</th><th style="width:150pt">Note</th></tr>' +
      rows.map((r, i) => '<tr class="' + (i % 2 ? 'alt' : '') + '"><td style="color:' + MUT + '">' + (i + 1) + '</td><td class="mono">' + esc_(r.number) +
        '</td><td><b>' + esc_(r.name) + '</b></td><td class="q">' + qty_(r.qty) + '</td><td class="n">' + esc_(r.note) + '</td></tr>').join('') +
      '<tr class="tot"><td></td><td colspan="2">' + rows.length + (rows.length === 1 ? ' line' : ' lines') + '</td><td class="q">' + qty_(sum(rows)) + '</td><td></td></tr></table>';
  }
  function changesTable(c) {
    if (!c.changes.length) return '<p style="color:' + MUT + '">No quantity changes for this Job code.</p>';
    return '<table class="items"><tr><th style="width:64pt">Item no.</th><th>Item</th><th style="text-align:right;width:52pt">Before</th>' +
      '<th style="text-align:right;width:52pt">After</th><th style="text-align:right;width:60pt">Change</th></tr>' +
      c.changes.map(x => {
        const diff = Number(x.after) - Number(x.before);
        return '<tr><td class="mono">' + esc_(x.number) + '</td><td><b>' + esc_(x.name) + '</b>' + (x.note ? '<div class="n">' + esc_(x.note) + '</div>' : '') +
          '</td><td class="q" style="font-weight:normal;color:' + MUT + '">' + qty_(x.before) + '</td><td class="q">' + qty_(x.after) +
          '</td><td class="q" style="color:' + (diff > 0 ? ink : '#A33333') + '">' + (diff > 0 ? '+' : diff < 0 ? '&minus;' : '') + qty_(Math.abs(diff)) + '</td></tr>';
      }).join('') + '</table>';
  }

  const status = d.cancelled ? ['CANCELLED', '#FDEAEA', '#A33333'] : corr.length ? ['CORRECTED · VERSION ' + d.version, '#FDF3E0', '#7A4F00'] : ['TAKE OUT · VERSION ' + d.version, tint, ink];
  const meta = [['Cart', d.cart.id], ['Date', d.cart.at], ['Entered by', d.cart.entered_by]]
    .concat(d.cart.on_behalf_of ? [['For', d.cart.on_behalf_of]] : [])
    .concat([['Branch', d.branch_code || d.branch], ['Job code', String(job.full_name || job.name || '').replace(/\s*=>\s*/g, ' › ')]]);

  let banner = '';
  if (d.cancelled) banner = '<div style="margin-top:16pt;padding:9pt 12pt;border:1.5pt solid #C94040;background:#FDEAEA;color:#7A1F1F;font-weight:bold">Cancelled' +
    (latest ? ' on ' + esc_(latest.at) + ' by ' + esc_(latest.by) : '') + '. Nothing on this document should be billed. This replaces every earlier version of D' + d.doc_id + '.</div>';
  else if (latest) banner = '<div style="margin-top:16pt;padding:9pt 12pt;border:1.5pt solid #E8A020;background:#FDF3E0;color:#5C3B00;font-weight:bold">Corrected ' +
    corr.length + (corr.length === 1 ? ' time' : ' times') + ', last on ' + esc_(latest.at) + ' by ' + esc_(latest.by) +
    '. Bill the items below. This replaces every earlier version of D' + d.doc_id + '.</div>';

  let body = '<h2>' + (corr.length ? 'Items to bill (current)' : 'Items taken out') + '</h2>' + itemsTable(d.cancelled ? [] : d.current);
  const noteNow = d.current_note;
  if (noteNow) body += '<p style="margin-top:10pt;font-size:9.5pt"><span class="lbl">Cart note</span>&nbsp; ' + esc_(noteNow) + '</p>';
  corr.forEach(c => {
    body += '<h2>' + (c.cancelled ? 'Cancellation' : 'Correction ' + c.seq) + ' <span>· ' + esc_(c.at) + ' · ' + esc_(c.by) +
      (c.correction_note ? ' · “' + esc_(c.correction_note) + '”' : '') + '</span></h2>';
    if ((c.note_before || '') !== (c.note_after || '')) body += '<p style="font-size:9.5pt;color:' + MUT + ';margin:0 0 6pt">Cart note changed from “' +
      esc_(c.note_before) + '” to “' + esc_(c.note_after) + '”</p>';
    body += changesTable(c);
  });
  if (corr.length) body += '<h2>Original Cart ' + d.cart.id + ' <span>· ' + esc_(d.cart.at) + ' · ' + esc_(d.cart.entered_by) + '</span></h2>' +
    itemsTable(d.original) + (d.cart.note && d.cart.note !== noteNow ? '<p style="margin-top:8pt;font-size:9.5pt"><span class="lbl">Original Cart note</span>&nbsp; ' + esc_(d.cart.note) + '</p>' : '');

  const logo = brand.logo ? '<img src="' + brand.logo + '" style="height:46pt">' : '<div style="font-size:16pt;font-weight:bold">' + esc_(brand.company || '') + '</div>';
  return '<html><head><meta charset="utf-8"><style>' + css + '</style></head><body><div style="padding:36pt 40pt">' +
    '<table><tr><td style="width:55%">' + logo + '</td><td style="text-align:right"><div class="lbl">Material usage</div>' +
    '<div style="font-size:26pt;font-weight:bold;line-height:1.1">D' + d.doc_id + '</div>' +
    '<div style="display:inline-block;margin-top:4pt;padding:2pt 7pt;font-size:8pt;font-weight:bold;background:' + status[1] + ';color:' + status[2] + '">' + status[0] + '</div></td></tr></table>' +
    '<div style="height:4pt;background:' + accent + ';margin:14pt 0 16pt"></div>' +
    '<table><tr><td style="width:58%;padding-right:16pt"><div class="lbl">Job</div>' +
    '<div style="font-size:18pt;font-weight:bold;margin:2pt 0 1pt">' + esc_(job.name || ('Job code ' + job.id)) + '</div>' +
    (job.customer ? '<div style="color:' + MUT + ';font-size:10pt">' + esc_(String(job.customer).replace(/\s*=>\s*/g, ' › ')) + '</div>' : '') +
    '<div style="margin-top:8pt;padding:8pt 10pt;background:' + tint + '"><div class="lbl" style="color:' + ink + '">' +
    (addr ? (addr.source === 'site' ? 'Job site' : 'Billing address') : 'Job site') + '</div>' +
    (addr ? addr.lines.map(l => '<div style="font-size:11pt">' + esc_(l) + '</div>').join('') : '<div style="font-size:10pt;color:' + MUT + '">No address on file in QuickBooks</div>') +
    '</div></td><td><table style="font-size:9.5pt">' +
    meta.map(m => '<tr><td style="color:' + MUT + ';padding:2pt 10pt 2pt 0;white-space:nowrap">' + m[0] + '</td><td style="font-weight:bold;padding:2pt 0">' + esc_(m[1]) + '</td></tr>').join('') +
    '</table></td></tr></table>' + banner + body +
    '<table style="margin-top:28pt;border-top:.75pt solid ' + LINE + ';font-size:7.5pt;color:' + MUT + '"><tr><td style="padding-top:6pt">' +
    esc_(brand.company ? brand.company + ' · ' : '') + 'Take outs only · Made ' + esc_(d.generated_at) + ' (' + esc_(d.timezone) + ')</td>' +
    '<td style="padding-top:6pt;text-align:right">' + esc_(d.file_name) + '.pdf</td></tr></table></div></body></html>';
}
