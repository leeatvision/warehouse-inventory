// Walks through the main screens in Chromium against the stand-in server and saves screenshots.
// Run: node scripts/build.mjs && node tests/smoke.mjs [outdir]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createMock } from './mock-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2] || 'test-results';
mkdirSync(out, { recursive: true });
const PORT = 8099;
const server = spawn(process.execPath, [new URL('../scripts/serve.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 600));

const mock = createMock();
const errors = [];
const browser = await chromium.launch();
async function newPage(viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: !!opts.touch, colorScheme: opts.dark ? 'dark' : 'light' });
  await ctx.route('**/config.js*', async route => {
    const r = await route.fetch(); let body = await r.text();
    if (!opts.keepConfig) body = body.replace(/"supabaseUrl": "[^"]*"/, '"supabaseUrl": "https://mock.supabase.test"').replace(/"supabaseKey": "[^"]*"/, '"supabaseKey": "test"');
    route.fulfill({ response: r, body });
  });
  await ctx.route('https://mock.supabase.test/rest/v1/rpc/*', async route => {
    if (ctx.offlineFlag) return route.abort('internetdisconnected');
    const fn = route.request().url().split('/').pop();
    const [status, body] = mock.handle(fn, JSON.parse(route.request().postData() || '{}'));
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/status of 401|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? '' : undefined));
  return page;
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const tap = (page, sel) => page.locator(sel).first().click();
async function pin(page, digits) { for (const d of digits) await page.locator(`.pinpad button[data-k="${d}"]`).click(); await page.locator('.pinpad button[data-k="ok"]').click().catch(() => {}); }
const settle = page => page.waitForTimeout(350);
const steps = [];
const step = async (name, fn) => { try { await fn(); steps.push('ok   ' + name); } catch (e) { steps.push('FAIL ' + name + ': ' + e.message.split('\n')[0]); throw e; } };

const T = { width: 1280, height: 800 };     // tablet, landscape
const D = { width: 1440, height: 900 };     // desktop
const P = { width: 390, height: 844 };      // phone
const nav = (page, to) => page.evaluate(t => go(t), to);
const job = async (page, q) => { await page.fill('[data-in=jobQ]', q); await settle(page); await tap(page, '#jobRes .row-i'); await settle(page); };
async function signIn(page, name, code) { await tap(page, `.row-i:has-text("${name}")`); await pin(page, code); await page.waitForSelector('.home'); }
async function connect(page) { await page.goto(`http://localhost:${PORT}/`); await page.fill('#dk', 'test-device-key'); await tap(page, '[data-act=saveKey]'); await page.waitForSelector("text=Who's working?"); }

const page = await newPage(T);
let cur = page;
try {
  await step('setup screen', async () => { await page.goto(`http://localhost:${PORT}/`); await page.waitForSelector('#dk'); await shot(page, '01-setup'); });
  await step('wrong key refused', async () => { await page.fill('#dk', 'nope'); await tap(page, '[data-act=saveKey]'); await page.waitForFunction(() => /not accepted/.test(document.querySelector('#setupState').textContent)); });
  await step('connect and first Manager PIN', async () => {
    await page.fill('#dk', 'test-device-key'); await tap(page, '[data-act=saveKey]');
    await page.waitForSelector('text=Set a Manager PIN'); await shot(page, '02-first-manager');
    await tap(page, '[data-act=setPinFor]'); await pin(page, '2468'); await settle(page); await pin(page, '2468');
    await page.waitForSelector("text=Who's working?");
  });
  await step('sign in', async () => { await shot(page, '03-signin'); await signIn(page, 'Alex Manager', '2468'); await shot(page, '04-home-tablet'); });
  await step('set PINs for others', async () => {
    await nav(page, 'people'); await page.waitForSelector('text=People and PINs');
    for (const n of ['Sam Worker', 'Robin Field']) { await page.locator('.li', { hasText: n }).locator('[data-act=setPinFor]').click(); await pin(page, '1357'); await settle(page); await pin(page, '1357'); await settle(page); }
    await shot(page, '05-people');
  });
  await step('locations and a custom field', async () => {
    await nav(page, 'setup2');
    for (const n of ['Aisle 1', 'Shelf A']) { await tap(page, '[data-act=editLoc]'); await page.fill('[data-f=name]', n); if (n === 'Shelf A') await page.selectOption('[data-f=parent_id]', { label: 'Aisle 1' }); await tap(page, '[data-act=saveLoc]'); await settle(page); }
    await tap(page, '[data-act=editField]'); await page.fill('[data-f=name]', 'Calibration due'); await page.selectOption('[data-f=ftype]', 'date'); await settle(page);
    await page.fill('[data-f=alert_days]', '30'); await tap(page, '[data-act=saveField]'); await settle(page);
    await shot(page, '06-locations-fields');
  });
  await step('add catalogue items', async () => {
    await tap(page, '.side [data-to=catalogue]');
    const add = async (name, kind, counted, low) => {
      await tap(page, '[data-act=newItem]'); if (kind === 'equipment') { await tap(page, '[data-act=draftKind][data-k=equipment]'); if (counted) await page.check('[data-f=counted]'); }
      await page.fill('[data-in=draft][data-f=name]', name); await page.selectOption('[data-f=location_id]', { label: 'Aisle 1 › Shelf A' });
      if (low) await page.fill('[data-f=low_stock]', String(low)); await tap(page, '[data-act=saveItem]'); await settle(page);
    };
    await add('12/2 NM-B wire, 250 ft', 'consumable', false, 2); await add('1/2" EMT connector', 'consumable', false, 20);
    await add('Single-gang old-work box', 'consumable', false, 0); await add('32 ft extension ladder', 'equipment');
    await add('Scaffold frame', 'equipment', true);
    await page.waitForTimeout(800); await shot(page, '07-catalogue-tablet');
  });
  await step('initial counts', async () => {
    await nav(page, 'adjust');
    for (const [q, n] of [['12/2', 10], ['EMT', 200], ['old-work', 150], ['Scaffold', 12]]) {
      await tap(page, '[data-act=edAdd]'); await page.fill('[data-in=ipQ]', q); await settle(page); await tap(page, '#ipRes .row-i'); await settle(page);
      await page.locator('[data-in=edQty]').last().fill(String(n));
    }
    await page.locator('[data-ch=edReason]').first().selectOption('Initial count');
    await shot(page, '08-adjust'); await tap(page, '[data-act=saveLe][data-key=adjust]'); await page.waitForSelector('.home');
  });
  await step('cart with two Job codes', async () => {
    await page.waitForTimeout(500); await tap(page, '.hero');
    await tap(page, '.job-card'); await job(page, 'main st');
    await page.fill('[data-in=cartQ]', 'wire'); await settle(page); await tap(page, '#finder [data-act=addItem]');
    await page.fill('[data-in=cartQ]', 'emt'); await settle(page); await tap(page, '#finder [data-act=addItem]');
    await page.locator('[data-act=qty][data-d="1"]').last().click(); await page.locator('[data-act=qty][data-d="1"]').last().click();
    await page.fill('[data-in=cartQ]', 'old-work'); await settle(page); await tap(page, '#finder [data-act=addItem]');
    await page.locator('[data-act=pickJob]').last().click(); await job(page, 'smith');
    await page.locator('[data-in=qtyIn]').last().fill('12'); await page.locator('[data-act=noteOpen]').last().click(); await page.locator('[data-in=lineNote]').last().fill('Kitchen and baths');
    await tap(page, '[data-act=mode][data-m=equipment]'); await settle(page); await tap(page, '.pick-card:has-text("ladder") [data-act=addItem]');
    await shot(page, '09-cart-tablet'); await tap(page, '[data-act=review]'); await page.waitForSelector('.review');
    await page.fill('[data-in=cartNote]', 'Rough-in, second floor'); await shot(page, '10-review');
    await tap(page, '[data-act=saveCart]'); await page.waitForSelector('.home'); await page.waitForTimeout(800);
    if (mock.db.carts.filter(c => c.kind === 'cart').length !== 1) throw new Error('cart not received by server');
    if (mock.db.docs.length !== 2) throw new Error('expected 2 billing documents, got ' + mock.db.docs.length);
    if (mock.db.carts.find(c => c.kind === 'cart').note !== 'Rough-in, second floor') throw new Error('cart note lost');
  });
  await step('correct the Cart', async () => {
    await tap(page, '.side [data-to=entries]'); await page.waitForSelector('[data-act=openCart]'); await shot(page, '11-entries');
    await tap(page, '[data-act=openCart]'); await settle(page); await shot(page, '12-cart-detail');
    await tap(page, '[data-act=correctCart]'); await page.waitForSelector('text=Correcting Cart');
    await page.locator('[data-in=qtyIn]').first().fill('2');
    await tap(page, '[data-act=review]'); await page.fill('[data-in=corrNote]', 'Took 2, not 1'); await shot(page, '13-correction-review');
    await tap(page, '[data-act=saveCart]'); await page.waitForSelector('.home'); await page.waitForTimeout(800);
    if (!mock.db.carts.some(c => c.kind === 'correction')) throw new Error('correction not received');
  });
  await step('return and check in', async () => {
    await tap(page, '.hero'); await tap(page, '[data-act=mode][data-m=return]'); await settle(page); await shot(page, '14-return');
    await tap(page, '[data-act=mode][data-m=equipment]'); await settle(page); await tap(page, '[data-act=addCheckin]'); await tap(page, '[data-act=review]'); await tap(page, '[data-act=saveCart]');
    await page.waitForSelector('.home'); await page.waitForTimeout(800);
    if (mock.db.items.find(i => i.name.includes('ladder')).status !== 'available') throw new Error('ladder not checked in');
  });
  await step('purchase order and receive', async () => {
    await nav(page, 'pos'); await tap(page, '[data-act=editPo]'); await page.fill('[data-f=supplier]', 'Electrical Supply Co');
    await tap(page, '[data-act=edAdd]'); await page.fill('[data-in=ipQ]', 'EMT'); await settle(page); await tap(page, '#ipRes .row-i'); await page.locator('[data-in=edQty]').fill('100');
    await tap(page, '[data-act=savePo]'); await page.waitForTimeout(800); await shot(page, '15-pos');
    await nav(page, 'receive'); await page.selectOption('[data-ch=rcvPo]', { index: 1 }); await settle(page);
    await page.locator('[data-in=edQty]').fill('60'); await shot(page, '16-receive'); await tap(page, '[data-act=saveLe][data-key=receive]'); await page.waitForSelector('.home');
  });
  await step('pick list', async () => {
    await page.waitForTimeout(500); await nav(page, 'picks'); await tap(page, '[data-act=editPick]'); await page.fill('[data-in=pkF]', 'Oak Ave trim-out');
    await tap(page, '[data-act=pkJob]'); await job(page, 'oak');
    await tap(page, '[data-act=edAdd]'); await page.fill('[data-in=ipQ]', 'box'); await settle(page); await tap(page, '#ipRes .row-i');
    await tap(page, '[data-act=savePick]'); await page.waitForTimeout(800); await tap(page, '[data-act=go][data-to=pick]');
    await page.check('[data-ch=pickTick]'); await shot(page, '17-pick'); await tap(page, '[data-act=finishPick]'); await page.waitForSelector('.cart-wide');
    await tap(page, '[data-act=review]'); await tap(page, '[data-act=saveCart]'); await page.waitForSelector('.home');
  });
  await step('stock count', async () => {
    await page.waitForTimeout(500); await nav(page, 'counts'); await tap(page, '[data-act=newCount]'); await tap(page, '[data-act=createCount]'); await page.waitForTimeout(800);
    await tap(page, '[data-act=go][data-to=count]'); await page.locator('[data-in=countIn]').first().fill('9'); await shot(page, '18-count');
    await tap(page, '[data-act=submitCount]'); await page.waitForTimeout(800); await nav(page, 'counts'); await tap(page, '[data-act=go][data-to=countReview]');
    await shot(page, '19-count-review'); await tap(page, '[data-act=applyCount]'); await page.waitForTimeout(800);
  });
  await step('alerts, reports, status, more', async () => {
    await nav(page, 'alerts'); await shot(page, '20-alerts');
    await nav(page, 'reports'); await tap(page, '[data-act=runReport]'); await page.waitForSelector('#rpOut table'); await shot(page, '21-report-transactions');
    await page.selectOption('[data-f=kind]', 'stock'); await tap(page, '[data-act=runReport]'); await settle(page); await shot(page, '22-report-stock');
    await nav(page, 'status'); await shot(page, '23-status');
    await tap(page, '.side [data-to=more]'); await shot(page, '23b-more-tablet');
  });
  await step('item detail with QR', async () => {
    await tap(page, '.side [data-to=catalogue]'); await page.waitForTimeout(300); await tap(page, '#catList .row-i'); await settle(page); await shot(page, '24-item');
    await tap(page, '[data-act=close]'); await tap(page, '[data-act=labelMode]'); await tap(page, '[data-act=labelAll]'); await shot(page, '25-labels');
  });
  await step('offline entries queue and send later', async () => {
    await nav(page, 'home');
    await page.context().setOffline(true); page.context().offlineFlag = true;
    await tap(page, '.hero'); await tap(page, '[data-act=mode][data-m=take]'); await page.fill('[data-in=cartQ]', 'emt'); await settle(page); await tap(page, '#finder [data-act=addItem]');
    await tap(page, '.job-card'); await job(page, 'service');
    const before = mock.db.carts.length; await tap(page, '[data-act=review]'); await tap(page, '[data-act=saveCart]'); await page.waitForTimeout(800);
    await shot(page, '26-offline-waiting');
    if (mock.db.carts.length !== before) throw new Error('should not have reached the server while offline');
    await page.context().setOffline(false); page.context().offlineFlag = false; await page.evaluate(() => sync()); await page.waitForTimeout(1200);
    if (mock.db.carts.length !== before + 1) throw new Error('queued cart was not sent after reconnecting');
  });
  await step('save unsent entries to a file and load them on another device', async () => {
    await nav(page, 'home');
    await page.context().setOffline(true); page.context().offlineFlag = true;
    await tap(page, '.hero'); await page.fill('[data-in=cartQ]', 'emt'); await settle(page); await tap(page, '#finder [data-act=addItem]');
    await tap(page, '.job-card'); await job(page, 'smith');
    await tap(page, '[data-act=review]'); await tap(page, '[data-act=saveCart]'); await page.waitForTimeout(500);
    await tap(page, '[data-act=logout]'); await page.waitForSelector('text=not sent yet'); await shot(page, '28-signin-warning');
    await signIn(page, 'Alex Manager', '2468'); await nav(page, 'status');
    const [dl] = await Promise.all([page.waitForEvent('download'), tap(page, '[data-act=exportOutbox]')]);
    const file = await dl.path(); const before = mock.db.carts.length;
    const other = await newPage(T); await connect(other); await signIn(other, 'Alex Manager', '2468');
    await nav(other, 'status'); await shot(other, '29-status-unsent');
    await other.setInputFiles('[data-ch=importOutbox]', file); await other.waitForTimeout(1200);
    if (mock.db.carts.length !== before + 1) throw new Error('loaded entry was not sent');
    await page.context().setOffline(false); page.context().offlineFlag = false; await page.evaluate(() => sync()); await page.waitForTimeout(1200);
    if (mock.db.carts.length !== before + 1) throw new Error('the same entry was applied twice');
    await nav(page, 'home');
  });
  await step('worker sign-in has no Manager tools', async () => {
    await tap(page, '[data-act=logout]'); await signIn(page, 'Sam Worker', '1357'); await shot(page, '27-home-user');
    await nav(page, 'more'); await settle(page);
    if (await page.locator('[data-to=receive]').count()) throw new Error('worker sees Manager tools');
  });
  const phone = await newPage(P, { touch: true }); cur = phone;
  await step('phone screens', async () => {
    await connect(phone); await shot(phone, '30-phone-signin');
    await signIn(phone, 'Alex Manager', '2468'); await shot(phone, '31-phone-home');
    await tap(phone, '.hero'); await tap(phone, '.job-card'); await job(phone, 'smith');
    await phone.fill('[data-in=cartQ]', 'wire'); await settle(phone); await shot(phone, '32a-phone-search');
    await tap(phone, '#finder .row-i'); await settle(phone);
    await phone.fill('[data-in=cartQ]', 'box'); await settle(phone); await tap(phone, '#finder .row-i'); await settle(phone); await shot(phone, '32-phone-cart');
    await tap(phone, '[data-act=review]'); await phone.waitForSelector('.review'); await shot(phone, '33-phone-review');
    await tap(phone, '.savebar [data-to=cart]'); await nav(phone, 'catalogue'); await settle(phone); await shot(phone, '34-phone-catalogue');
    await nav(phone, 'more'); await shot(phone, '35-phone-more');
    for (const s of ['home', 'catalogue', 'more', 'reports', 'entries']) {
      await nav(phone, s); await settle(phone);
      const w = await phone.evaluate(() => document.documentElement.scrollWidth); if (w > 390) throw new Error(s + ' scrolls sideways on a phone: ' + w);
    }
  });
  const desk = await newPage(D); cur = desk;
  await step('desktop screens', async () => {
    await connect(desk); await signIn(desk, 'Alex Manager', '2468'); await shot(desk, '40-desk-home');
    await tap(desk, '.side [data-to=catalogue]'); await settle(desk); await tap(desk, '#catList tr.click'); await settle(desk); await shot(desk, '41-desk-catalogue');
    await tap(desk, '.side [data-to=reports]'); await tap(desk, '[data-act=runReport]'); await desk.waitForSelector('#rpOut table'); await shot(desk, '42-desk-reports');
    await tap(desk, '.side [data-to=cart]'); await settle(desk); await shot(desk, '43-desk-cart');
  });
  const dark = await newPage(T, { dark: true }); cur = dark;
  await step('dark mode', async () => { await connect(dark); await signIn(dark, 'Alex Manager', '2468'); await shot(dark, '50-dark-home'); });
  const neutral = await newPage(T, { keepConfig: true });
  await step('neutral build shows placeholders', async () => { await neutral.goto(`http://localhost:${PORT}/`); await neutral.waitForSelector('#dk'); await shot(neutral, '60-as-built'); });
} catch (e) {
  await shot(cur, 'zz-failure').catch(() => {});
} finally {
  await browser.close(); server.kill();
  console.log(steps.join('\n'));
  console.log(errors.length ? 'Browser errors:\n' + [...new Set(errors)].join('\n') : 'No browser errors');
  process.exitCode = steps.some(s => s.startsWith('FAIL')) || errors.length ? 1 : 0;
}
