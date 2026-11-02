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
    for (let round = 0; round < 5; round++) {
      const docs = rpc_(p, 'wh_delivery_claim', { p_token: p.DELIVERY_TOKEN, p_limit: 20 });
      if (!docs.length) break;
      for (const d of docs) {
        try {
          const name = d.file_name + '.pdf';
          const pdf = Utilities.newBlob(buildHtml(d), 'text/html', d.file_name + '.html').getAs('application/pdf').setName(name);
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
function esc_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function qty_(v) { const n = Number(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000); }
function table_(head, rows, numCols) {
  numCols = numCols || [];
  return '<table><thead><tr>' + head.map((h, i) => '<th' + (numCols.indexOf(i) >= 0 ? ' class="n"' : '') + '>' + esc_(h) + '</th>').join('') + '</tr></thead><tbody>' +
    (rows.length ? rows.map(r => '<tr>' + r.map((c, i) => '<td' + (numCols.indexOf(i) >= 0 ? ' class="n"' : '') + '>' + c + '</td>').join('') + '</tr>').join('')
      : '<tr><td colspan="' + head.length + '" class="muted">No items for this Job code</td></tr>') + '</tbody></table>';
}
function itemRows_(lines) { return lines.map(l => [esc_(l.number), esc_(l.name), '<b>' + qty_(l.qty) + '</b>', esc_(l.note)]); }

function buildHtml(d) {
  const corr = d.corrections || [];
  const latest = corr[0];
  let banner = '';
  if (d.cancelled) banner = '<div class="banner bad">CANCELLED' + (latest ? ' on ' + esc_(latest.at) + ' by ' + esc_(latest.by) : '') + '. Nothing on this document should be billed.</div>';
  else if (latest) banner = '<div class="banner">CORRECTED: correction ' + latest.seq + ' on ' + esc_(latest.at) + ' by ' + esc_(latest.by) + '. Bill the current items below; this replaces every earlier version of ' + esc_('D' + d.doc_id) + '.</div>';

  let body = '';
  if (corr.length) {
    body += '<h2>Current items' + (d.cancelled ? ' (none, cancelled)' : '') + '</h2>' + table_(['Item number', 'Item', 'Quantity', 'Note'], itemRows_(d.current), [2]);
    if (d.current_note) body += '<p><span class="muted">Cart note:</span> ' + esc_(d.current_note) + '</p>';
    for (const c of corr) {
      body += '<h2>' + (c.cancelled ? 'Cancellation' : 'Correction ' + c.seq) + ' · ' + esc_(c.at) + ' · ' + esc_(c.by) + '</h2>';
      if (c.correction_note) body += '<p><span class="muted">Correction note:</span> ' + esc_(c.correction_note) + '</p>';
      if ((c.note_before || '') !== (c.note_after || '')) body += '<p><span class="muted">Cart note changed from</span> "' + esc_(c.note_before) + '" <span class="muted">to</span> "' + esc_(c.note_after) + '"</p>';
      if (c.changes.length) body += table_(['Item number', 'Item', 'Before', 'After', 'Change'], c.changes.map(x => {
        const diff = Number(x.after) - Number(x.before);
        return [esc_(x.number), esc_(x.name) + (x.note ? '<div class="muted">' + esc_(x.note) + '</div>' : ''), qty_(x.before), '<b>' + qty_(x.after) + '</b>', (diff > 0 ? '+' : '') + qty_(diff)];
      }), [2, 3, 4]);
      else if (!c.cancelled) body += '<p class="muted">No quantity changes for this Job code.</p>';
    }
  }
  body += '<h2>' + (corr.length ? 'Original Cart ' : 'Cart ') + d.cart.id + ' · ' + esc_(d.cart.at) + '</h2>' +
    '<p><span class="muted">Entered by</span> ' + esc_(d.cart.entered_by) + (d.cart.on_behalf_of ? ' <span class="muted">on behalf of</span> ' + esc_(d.cart.on_behalf_of) : '') + '</p>' +
    (d.cart.note ? '<p><span class="muted">Cart note:</span> ' + esc_(d.cart.note) + '</p>' : '') +
    table_(['Item number', 'Item', 'Quantity', 'Note'], itemRows_(d.original), [2]);

  return '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#111;margin:0}' +
    'h1{font-size:15pt;margin:0 0 2pt}h2{font-size:11pt;margin:14pt 0 4pt;border-bottom:1px solid #999;padding-bottom:2pt}' +
    'p{margin:3pt 0}table{width:100%;border-collapse:collapse;margin-top:4pt}th,td{text-align:left;padding:3pt 5pt;border-bottom:1px solid #ccc;vertical-align:top}' +
    'th{font-size:8pt;text-transform:uppercase;color:#555}td.n,th.n{text-align:right}.muted{color:#666}' +
    '.meta td{border:0;padding:1pt 8pt 1pt 0}.banner{margin:8pt 0;padding:6pt 8pt;border:2px solid #b26a00;background:#fff3dc;font-weight:bold}' +
    '.banner.bad{border-color:#b42318;background:#fdecea}.foot{margin-top:16pt;font-size:8pt;color:#666}' +
    '</style></head><body>' +
    '<h1>Material usage · ' + esc_(d.job.name) + '</h1>' +
    '<table class="meta"><tr><td class="muted">Job code</td><td><b>' + esc_(d.job.full_name || d.job.name) + '</b></td></tr>' +
    '<tr><td class="muted">Cart</td><td><b>' + d.cart.id + '</b></td></tr>' +
    '<tr><td class="muted">Document</td><td><b>D' + d.doc_id + '</b> · version ' + esc_(d.version) + '</td></tr>' +
    (d.branch ? '<tr><td class="muted">Branch</td><td>' + esc_(d.branch) + '</td></tr>' : '') + '</table>' +
    banner + body +
    '<p class="foot">Take outs only. Made ' + esc_(d.generated_at) + ' (' + esc_(d.timezone) + '). File ' + esc_(d.file_name) + '.pdf</p>' +
    '</body></html>';
}

