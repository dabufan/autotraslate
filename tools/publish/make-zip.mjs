
// tools/publish/make-zip.mjs
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';

const dist = 'dist';
if (!fs.existsSync(dist)) {
  console.error('dist/ not found. Run "npm run build" first.');
  process.exit(1);
}
const outDir = 'release';
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

const stamp = new Date().toISOString().replace(/[:.]/g,'-');
const outZip = path.join(outDir, `autotranslate-extension-${stamp}.zip`);
const output = fs.createWriteStream(outZip);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => console.log(`Created: ${outZip} (${archive.pointer()} bytes)`));
archive.on('warning', (err) => { if (err.code === 'ENOENT') console.warn(err); else throw err; });
archive.on('error', (err) => { throw err; });

archive.pipe(output);
archive.directory(dist, false);
await archive.finalize();
