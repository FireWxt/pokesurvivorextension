// Builds dist/pokesurvivor-run-tracker-<version>-{chrome,firefox}.zip for the Chrome Web Store and Firefox Add-ons.
// No dependencies: writes a standard zip with Node's zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const FILES = ['manifest.json', 'background.js', 'content.js', 'stats.js', 'popup.html', 'popup.css', 'popup.js', 'icons', '_locales'];

function list(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.statSync(abs).isDirectory()) return [rel];
  return fs.readdirSync(abs).flatMap((name) => list(path.posix.join(rel, name)));
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const header = (sig, central) => {
      const b = Buffer.alloc(central ? 46 : 30);
      let o = 0;
      const u32 = (v) => { b.writeUInt32LE(v >>> 0, o); o += 4; };
      const u16 = (v) => { b.writeUInt16LE(v, o); o += 2; };
      u32(sig);
      if (central) u16(20);           // version made by
      u16(20);                        // version needed
      u16(0x0800);                    // UTF-8 names
      u16(8);                         // deflate
      u16(0); u16(0x21);              // time / date (1980-01-01): reproducible builds
      u32(crc); u32(deflated.length); u32(data.length);
      u16(nameBuf.length); u16(0);
      if (central) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
      return b;
    };
    const local = Buffer.concat([header(0x04034b50, false), nameBuf, deflated]);
    centrals.push(Buffer.concat([header(0x02014b50, true), nameBuf]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

// manifest.json is Chrome's. Firefox doesn't run MV3 service workers: it gets background
// scripts instead (Chrome warns about that key in MV3), plus its add-on id.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const firefoxManifest = {
  ...manifest,
  background: { scripts: ['stats.js', 'background.js'] },
  browser_specific_settings: { gecko: { id: 'pokesurvivor-run-tracker@extension', strict_min_version: '121.0' } },
};

const files = FILES.flatMap(list).sort().map((name) => ({ name, data: fs.readFileSync(path.join(ROOT, name)) }));
const builds = {
  chrome: files,
  firefox: files.map((f) => (f.name === 'manifest.json' ? { name: f.name, data: Buffer.from(JSON.stringify(firefoxManifest, null, 2) + '\n') } : f)),
};

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
for (const [browser, entries] of Object.entries(builds)) {
  const out = path.join(ROOT, 'dist', `pokesurvivor-run-tracker-${manifest.version}-${browser}.zip`);
  fs.writeFileSync(out, zip(entries));
  console.log(`${path.relative(ROOT, out)} (${entries.length} files)`);
}
