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

const T = { width: 1280, height: 800 };
const page = await newPage(T);
try {
  await step('setup screen', async () => { await page.goto(`http://localhost:${PORT}/`); await page.waitForSelector('#dk'); await shot(page, '01-setup'); });
  await step('wrong key refused', async () => { await page.fill('#dk', 'nope'); await tap(page, '[data-act=saveKey]'); await page.waitForFunction(() => /not accepted/.test(document.querySelector('#setupState').textContent)); });
  await step('connect and first Manager PIN', async () => {
    await page.fill('#dk', 'test-device-key'); await tap(page, '[data-act=saveKey]');
    await page.waitForSelector('text=Set a Manager PIN'); await shot(page, '02-first-manager');
    await tap(page, '[data-act=setPinFor]'); await pin(page, '2468'); await settle(page); await pin(page, '2468');
    await page.waitForSelector('text=Who is using the tablet?');
  });
  await step('sign in', async () => { await shot(page, '03-signin'); await tap(page, '.name:has-text("Alex Manager")'); await pin(page, '2468'); await page.waitForSelector('.tiles'); await shot(page, '04-home-manager'); });
  await step('set PINs for others', async () => {
    await tap(page, '[data-to=people]'); await page.waitForSelector('text=People and PINs');
    for (const n of ['Sam Worker', 'Robin Field']) { await page.locator('.li', { hasText: n }).locator('[data-act=setPinFor]').click(); await pin(page, '1357'); await settle(page); await pin(page, '1357'); await settle(page); }
    await shot(page, '05-people');
  });
  await step('locations and a custom field', async () => {
    await tap(page, '[data-act=go][data-to=home]'); await tap(page, '[data-to=setup2]');
    for (const n of ['Aisle 1', 'Shelf A']) { await tap(page, '[data-act=editLoc]'); await page.fill('[data-f=name]', n); if (n === 'Shelf A') await page.selectOption('[data-f=parent_id]', { label: 'Aisle 1' }); await tap(page, '[data-act=saveLoc]'); await settle(page); }
    await tap(page, '[data-act=editField]'); await page.fill('[data-f=name]', 'Calibration due'); await page.selectOption('[data-f=ftype]', 'date'); await settle(page);
    await page.fill('[data-f=alert_days]', '30'); await tap(page, '[data-act=saveField]'); await settle(page);
    await shot(page, '06-locations-fields');
  });
  await step('add catalogue items', async () => {
    await tap(page, '[data-act=go][data-to=home]'); await tap(page, '[data-to=catalogue]');
    const add = async (name, kind, counted, low) => {
      await tap(page, '[data-act=newItem]'); if (kind === 'equipment') { await tap(page, '[data-act=draftKind][data-k=equipment]'); if (counted) await page.check('[data-f=counted]'); }
      await page.fill('[data-in=draft][data-f=name]', name); await page.selectOption('[data-f=location_id]', { label: 'Aisle 1 › Shelf A' });
      if (low) await page.fill('[data-f=low_stock]', String(low)); await tap(page, '[data-act=saveItem]'); await settle(page);
    };
    await add('12/2 NM-B wire, 250 ft', 'consumable', false, 2); await add('1/2" EMT connector', 'consumable', false, 20);
    await add('Single-gang old-work box', 'consumable', false, 0); await add('32 ft extension ladder', 'equipment');
    await add('Scaffold frame', 'equipment', true);
    await page.waitForTimeout(800); await shot(page, '07-catalogue');
  });
  await step('initial counts', async () => {
    await tap(page, '[data-act=go][data-to=home]'); await tap(page, '[data-to=adjust]');
    for (const [q, n] of [['12/2', 10], ['EMT', 200], ['old-work', 150], ['Scaffold', 12]]) {
      await tap(page, '[data-act=edAdd]'); await page.fill('[data-in=ipQ]', q); await settle(page); await tap(page, '#ipRes .li'); await settle(page);
      await page.locator('[data-in=edQty]').last().fill(String(n));
    }
    await page.locator('[data-ch=edReason]').first().selectOption('Initial count');
    await shot(page, '08-adjust'); await tap(page, '[data-act=saveLe][data-key=adjust]'); await page.waitForSelector('.tiles');
  });
  await step('cart with two Job codes', async () => {
    await page.waitForTimeout(500); await tap(page, '.tile.hero');
    await page.fill('[data-in=cartQ]', 'wire'); await settle(page); await tap(page, '#finder .li');
    await tap(page, '[data-act=pickJob]'); await page.fill('[data-in=jobQ]', 'main st'); await settle(page); await tap(page, '#jobRes .li');
    await page.fill('[data-in=cartQ]', 'emt'); await settle(page); await tap(page, '#finder .li');
    await page.locator('[data-act=qty][data-d="1"]').last().click(); await page.locator('[data-act=qty][data-d="1"]').last().click();
    await page.fill('[data-in=cartQ]', 'old-work'); await settle(page); await tap(page, '#finder .li');
    await page.locator('[data-act=pickJob]').last().click(); await page.fill('[data-in=jobQ]', 'smith'); await settle(page); await tap(page, '#jobRes .li');
    await page.locator('[data-in=qtyIn]').last().fill('12'); await page.locator('[data-in=lineNote]').last().fill('Kitchen and baths');
    await page.fill('[data-in=cartNote]', 'Rough-in, second floor');
    await tap(page, '[data-act=mode][data-m=checkout]'); await settle(page); await tap(page, '#finder .li:has-text("ladder")');
    await shot(page, '09-cart'); await tap(page, '[data-act=review]'); await settle(page); await shot(page, '10-review');
    await tap(page, '[data-act=saveCart]'); await page.waitForSelector('.tiles'); await page.waitForTimeout(800);
    if (mock.db.carts.filter(c => c.kind === 'cart').length !== 1) throw new Error('cart not received by server');
    if (mock.db.docs.length !== 2) throw new Error('expected 2 billing documents, got ' + mock.db.docs.length);
  });
  await step('correct the Cart', async () => {
    await tap(page, '[data-to=entries]'); await page.waitForSelector('[data-act=openCart]'); await shot(page, '11-entries');
    await tap(page, '[data-act=openCart]'); await settle(page); await shot(page, '12-cart-detail');
    await tap(page, '[data-act=correctCart]'); await page.waitForSelector('text=Correcting Cart');
    await page.locator('[data-in=qtyIn]').first().fill('2');
    await tap(page, '[data-act=review]'); await page.fill('[data-in=corrNote]', 'Took 2, not 1'); await shot(page, '13-correction-review');
    await tap(page, '[data-act=saveCart]'); await page.waitForSelector('.tiles'); await page.waitForTimeout(800);
    if (!mock.db.carts.some(c => c.kind === 'correction')) throw new Error('correction not received');
  });
  await step('return and check in', async () => {
    await tap(page, '.tile.hero'); await tap(page, '[data-act=mode][data-m=return]'); await settle(page); await shot(page, '14-return');
    await tap(page, '[data-act=mode][data-m=checkin]'); await settle(page); await tap(page, '#finder .li'); await tap(page, '[data-act=review]'); await tap(page, '[data-act=saveCart]');
    await page.waitForSelector('.tiles'); await page.waitForTimeout(800);
    if (mock.db.items.find(i => i.name.includes('ladder')).status !== 'available') throw new Error('ladder not checked in');
  });
  await step('purchase order and receive', async () => {
    await tap(page, '[data-to=pos]'); await tap(page, '[data-act=editPo]'); await page.fill('[data-f=supplier]', 'Electrical Supply Co');
    await tap(page, '[data-act=edAdd]'); await page.fill('[data-in=ipQ]', 'EMT'); await settle(page); await tap(page, '#ipRes .li'); await page.locator('[data-in=edQty]').fill('100');
    await tap(page, '[data-act=savePo]'); await page.waitForTimeout(800); await shot(page, '15-pos');
    await tap(page, '[data-act=go][data-to=home]'); await tap(page, '[data-to=receive]'); await page.selectOption('[data-ch=rcvPo]', { index: 1 }); await settle(page);
    await page.locator('[data-in=edQty]').fill('60'); await shot(page, '16-receive'); await tap(page, '[data-act=saveLe][data-key=receive]'); await page.waitForSelector('.tiles');
  });
  await step('pick list', async () => {
    await page.waitForTimeout(500); await tap(page, '[data-to=picks]'); await tap(page, '[data-act=editPick]'); await page.fill('[data-in=pkF]', 'Oak Ave trim-out');
    await tap(page, '[data-act=pkJob]'); await page.fill('[data-in=jobQ]', 'oak'); await settle(page); await tap(page, '#jobRes .li');
    await tap(page, '[data-act=edAdd]'); await page.fill('[data-in=ipQ]', 'box'); await settle(page); await tap(page, '#ipRes .li');
    await tap(page, '[data-act=savePick]'); await page.waitForTimeout(800); await tap(page, '[data-act=go][data-to=pick]');
    await page.check('[data-ch=pickTick]'); await shot(page, '17-pick'); await tap(page, '[data-act=finishPick]'); await page.waitForSelector('text=Cart');
    await tap(page, '[data-act=review]'); await tap(page, '[data-act=saveCart]'); await page.waitForSelector('.tiles');
  });
  await step('stock count', async () => {
    await page.waitForTimeout(500); await tap(page, '[data-to=counts]'); await tap(page, '[data-act=newCount]'); await tap(page, '[data-act=createCount]'); await page.waitForTimeout(800);
    await tap(page, '[data-act=go][data-to=count]'); await page.locator('[data-in=countIn]').first().fill('9'); await shot(page, '18-count');
    await tap(page, '[data-act=submitCount]'); await page.waitForTimeout(800); await tap(page, '[data-to=counts]'); await tap(page, '[data-act=go][data-to=countReview]');
    await shot(page, '19-count-review'); await tap(page, '[data-act=applyCount]'); await page.waitForTimeout(800);
  });
  await step('alerts, reports, status', async () => {
    await tap(page, '[data-act=go][data-to=home]'); await tap(page, '[data-to=alerts]'); await shot(page, '20-alerts');
    await tap(page, '[data-act=go][data-to=home]'); await tap(page, '[data-to=reports]'); await tap(page, '[data-act=runReport]'); await page.waitForSelector('#rpOut table'); await shot(page, '21-report-transactions');
    await page.selectOption('[data-f=kind]', 'stock'); await tap(page, '[data-act=runReport]'); await settle(page); await shot(page, '22-report-stock');
    await tap(page, '[data-act=go][data-to=home]'); await tap(page, '[data-to=status]'); await shot(page, '23-status');
  });
  await step('item detail with QR', async () => {
    await tap(page, '[data-act=go][data-to=home]'); await tap(page, '[data-to=catalogue]'); await page.waitForTimeout(300); await tap(page, '#catList .li'); await settle(page); await shot(page, '24-item');
    await tap(page, '[data-act=close]'); await tap(page, '[data-act=labelMode]'); await tap(page, '[data-act=labelAll]'); await shot(page, '25-labels');
  });
  await step('offline entries queue and send later', async () => {
    await tap(page, '[data-act=go][data-to=home]');
    await page.context().setOffline(true); page.context().offlineFlag = true;
    await tap(page, '.tile.hero'); await tap(page, '[data-act=mode][data-m=take]'); await page.fill('[data-in=cartQ]', 'emt'); await settle(page); await tap(page, '#finder .li');
    await tap(page, '[data-act=pickJob]'); await page.fill('[data-in=jobQ]', 'service'); await settle(page); await tap(page, '#jobRes .li');
    const before = mock.db.carts.length; await tap(page, '[data-act=review]'); await tap(page, '[data-act=saveCart]'); await page.waitForTimeout(800);
    await shot(page, '26-offline-waiting');
    if (mock.db.carts.length !== before) throw new Error('should not have reached the server while offline');
    await page.context().setOffline(false); page.context().offlineFlag = false; await page.evaluate(() => sync()); await page.waitForTimeout(1200);
    if (mock.db.carts.length !== before + 1) throw new Error('queued cart was not sent after reconnecting');
  });
  await step('save unsent entries to a file and load them on another device', async () => {
    await page.evaluate(() => go('home'));
    await page.context().setOffline(true); page.context().offlineFlag = true;
    await tap(page, '.tile.hero'); await page.fill('[data-in=cartQ]', 'emt'); await settle(page); await tap(page, '#finder .li');
    await tap(page, '[data-act=pickJob]'); await page.fill('[data-in=jobQ]', 'smith'); await settle(page); await tap(page, '#jobRes .li');
    await tap(page, '[data-act=review]'); await tap(page, '[data-act=saveCart]'); await page.waitForTimeout(500);
    await tap(page, '[data-act=logout]'); await page.waitForSelector('text=not sent yet'); await shot(page, '28-signin-warning');
    await tap(page, '.name:has-text("Alex Manager")'); await pin(page, '2468'); await page.waitForSelector('.tiles');
    await tap(page, '[data-to=status]');
    const [dl] = await Promise.all([page.waitForEvent('download'), tap(page, '[data-act=exportOutbox]')]);
    const file = await dl.path(); const before = mock.db.carts.length;
    const other = await newPage(T);
    await other.goto(`http://localhost:${PORT}/`); await other.fill('#dk', 'test-device-key'); await tap(other, '[data-act=saveKey]');
    await other.waitForSelector('text=Who is using the tablet?'); await tap(other, '.name:has-text("Alex Manager")'); await pin(other, '2468');
    await other.waitForSelector('.tiles'); await tap(other, '[data-to=status]'); await shot(other, '29-status-unsent');
    await other.setInputFiles('[data-ch=importOutbox]', file); await other.waitForTimeout(1200);
    if (mock.db.carts.length !== before + 1) throw new Error('loaded entry was not sent');
    await page.context().setOffline(false); page.context().offlineFlag = false; await page.evaluate(() => sync()); await page.waitForTimeout(1200);
    if (mock.db.carts.length !== before + 1) throw new Error('the same entry was applied twice');
    await tap(page, '[data-act=go][data-to=home]');
  });
  await step('worker sign-in has no Manager tiles', async () => {
    await tap(page, '[data-act=logout]'); await tap(page, '.name:has-text("Sam Worker")'); await pin(page, '1357'); await page.waitForSelector('.tiles'); await shot(page, '27-home-user');
    if (await page.locator('[data-to=receive]').count()) throw new Error('worker sees Manager tiles');
  });
  // Phone width and dark mode
  const phone = await newPage({ width: 390, height: 844 }, { touch: true });
  await step('phone screens', async () => {
    await phone.goto(`http://localhost:${PORT}/`); await phone.fill('#dk', 'test-device-key'); await tap(phone, '[data-act=saveKey]');
    await phone.waitForSelector('text=Who is using the tablet?'); await shot(phone, '30-phone-signin');
    await tap(phone, '.name:has-text("Alex Manager")'); await pin(phone, '2468'); await phone.waitForSelector('.tiles'); await shot(phone, '31-phone-home');
    await tap(phone, '.tile.hero'); await phone.fill('[data-in=cartQ]', 'wire'); await settle(phone); await tap(phone, '#finder .li'); await shot(phone, '32-phone-cart');
    const w = await phone.evaluate(() => document.documentElement.scrollWidth); if (w > 390) throw new Error('phone page scrolls sideways: ' + w);
  });
  const dark = await newPage(T, { dark: true });
  await step('dark mode', async () => {
    await dark.goto(`http://localhost:${PORT}/`); await dark.fill('#dk', 'test-device-key'); await tap(dark, '[data-act=saveKey]');
    await dark.waitForSelector('text=Who is using the tablet?'); await tap(dark, '.name:has-text("Alex Manager")'); await pin(dark, '2468'); await dark.waitForSelector('.tiles'); await shot(dark, '40-dark-home');
  });
  const neutral = await newPage(T, { keepConfig: true });
  await step('neutral build shows placeholders', async () => { await neutral.goto(`http://localhost:${PORT}/`); await neutral.waitForSelector('#dk'); await shot(neutral, '50-as-built'); });
} catch (e) {
  await shot(page, 'zz-failure').catch(() => {});
} finally {
  await browser.close(); server.kill();
  console.log(steps.join('\n'));
  console.log(errors.length ? 'Browser errors:\n' + [...new Set(errors)].join('\n') : 'No browser errors');
  process.exitCode = steps.some(s => s.startsWith('FAIL')) || errors.length ? 1 : 0;
}
