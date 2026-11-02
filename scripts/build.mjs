// Builds the site into dist/. Uses brand/ if it exists, otherwise brand-default/.
// REQUIRE_BRAND=1 makes a missing brand/ an error (the deploy workflow sets it). Plain Node, no packages.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'dist');
const hasBrand = existsSync(join(root, 'brand', 'brand.json'));
if (process.env.REQUIRE_BRAND === '1' && !hasBrand) {
  console.error('REQUIRE_BRAND=1 but there is no brand/brand.json. Refusing to build a placeholder site.');
  process.exit(1);
}
const brandDir = join(root, hasBrand ? 'brand' : 'brand-default');
const brand = JSON.parse(readFileSync(join(brandDir, 'brand.json'), 'utf8'));
for (const k of ['name', 'shortName', 'themeColor', 'backgroundColor', 'storagePrefix']) {
  if (!brand[k]) { console.error(`brand.json is missing "${k}"`); process.exit(1); }
}
let version;
try { version = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { version = 'dev'; }
version += '-' + Date.now().toString(36);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'src'), out, { recursive: true });
for (const f of ['brand.css', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
  if (!existsSync(join(brandDir, f))) { console.error(`${relative(root, brandDir)}/${f} is missing`); process.exit(1); }
  cpSync(join(brandDir, f), join(out, f));
}
if (brand.logo) {
  if (!existsSync(join(brandDir, brand.logo))) { console.error(`logo ${brand.logo} is missing`); process.exit(1); }
  cpSync(join(brandDir, brand.logo), join(out, brand.logo));
}

for (const f of brand.files || []) {
  if (!existsSync(join(brandDir, f))) { console.error(`brand file ${f} is missing`); process.exit(1); }
  cpSync(join(brandDir, f), join(out, f));
}

const config = { ...brand, version };
writeFileSync(join(out, 'config.js'), 'window.WH_BRAND = ' + JSON.stringify(config, null, 2) + ';\n');
writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
  name: brand.name, short_name: brand.shortName, description: brand.description || '',
  start_url: './', scope: './', display: 'standalone', orientation: 'any',
  background_color: brand.backgroundColor, theme_color: brand.themeColor,
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
}, null, 2));

const walk = d => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);
const files = ['./', ...walk(out).map(f => './' + relative(out, f)).filter(f => f !== './sw.js')];
const fill = s => s.replaceAll('%%VERSION%%', version).replaceAll('%%APP_NAME%%', brand.name.replace(/[<&]/g, ''))
  .replaceAll('%%THEME_COLOR%%', brand.themeColor).replaceAll('%%FILES%%', JSON.stringify(files));
for (const f of ['index.html', 'sw.js']) writeFileSync(join(out, f), fill(readFileSync(join(out, f), 'utf8')));
writeFileSync(join(out, '.nojekyll'), '');
console.log(`Built dist/ with ${hasBrand ? 'brand/' : 'brand-default/ (placeholders)'} · version ${version} · ${files.length} files`);
