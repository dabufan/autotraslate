
// Minimal static copier: copies everything that isn't .ts from src/ to dist/
import fs from 'fs';
import path from 'path';

const SRC = 'src';
const DIST = 'dist';

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) {
      copyDir(s, d);
    } else {
      if (!s.endsWith('.ts')) {
        fs.copyFileSync(s, d);
      }
    }
  }
}
copyDir(SRC, DIST);
console.log('Static assets copied to dist/');
