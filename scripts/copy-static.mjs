import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

// Copies every non-TypeScript asset from src/ to dist/
export function copyStaticAssets(srcDir = 'src', destDir = 'dist') {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    const sourcePath = path.join(srcDir, entry);
    const targetPath = path.join(destDir, entry);
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      copyStaticAssets(sourcePath, targetPath);
      continue;
    }
    if (/\.(ts|tsx)$/.test(sourcePath)) continue;
    fs.copyFileSync(sourcePath, targetPath);
  }
}

if (process.argv[1]) {
  const invokedAsScript = pathToFileURL(process.argv[1]).href === import.meta.url;
  if (invokedAsScript) {
    copyStaticAssets();
    console.log('Static assets copied to dist/');
  }
}
