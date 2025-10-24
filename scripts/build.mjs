import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { build, context } from 'esbuild';
import { copyStaticAssets } from './copy-static.mjs';

const fsp = fs.promises;
const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const DIST_DIR = path.join(ROOT, 'dist');

const isWatch = process.argv.includes('--watch');
const isProduction = process.env.NODE_ENV === 'production';
const sourcemap = isProduction ? false : 'inline';

const browserTargets = ['chrome110', 'edge110', 'firefox120', 'safari16'];

const moduleEntries = {
  'background/service_worker': path.join(SRC_DIR, 'background/service_worker.ts'),
  'options/options': path.join(SRC_DIR, 'options/options.ts'),
  'popup/popup': path.join(SRC_DIR, 'popup/popup.ts')
};

const contentEntry = {
  'content/contentScript': path.join(SRC_DIR, 'content/contentScript.ts')
};

async function cleanDist() {
  await fsp.rm(DIST_DIR, { recursive: true, force: true });
}

function shouldCopyStatic(filePath) {
  return !/\.(ts|tsx)$/.test(filePath);
}

async function watchStaticAssets() {
  if (!fs.watch) {
    console.warn('[static] fs.watch not available; static assets will not live-reload.');
    return;
  }
  const watchOptions = { recursive: true };
  try {
    const watcher = fs.watch(SRC_DIR, watchOptions, async (_event, filename) => {
      if (!filename) return;
      if (!shouldCopyStatic(filename)) return;
      const srcPath = path.join(SRC_DIR, filename);
      const distPath = path.join(DIST_DIR, filename);
      try {
        const stat = await fsp.stat(srcPath);
        if (stat.isDirectory()) return;
        await fsp.mkdir(path.dirname(distPath), { recursive: true });
        await fsp.copyFile(srcPath, distPath);
        console.log(`[static] copied ${filename}`);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          await fsp.rm(distPath, { force: true });
          console.log(`[static] removed ${filename}`);
        } else {
          console.error('[static] copy error', err);
        }
      }
    });
    console.log('[static] watching asset changes...');
    return watcher;
  } catch (err) {
    console.warn('[static] watch unavailable, continuing without live copy.', err);
    return undefined;
  }
}

async function buildModules() {
  const common = {
    bundle: true,
    minify: isProduction,
    sourcemap,
    target: browserTargets,
    logLevel: 'info'
  };

  if (isWatch) {
    const moduleCtx = await context({
      ...common,
      entryPoints: moduleEntries,
      outdir: DIST_DIR,
      format: 'esm',
      splitting: false,
      platform: 'browser'
    });
    const contentCtx = await context({
      ...common,
      entryPoints: contentEntry,
      outdir: DIST_DIR,
      format: 'iife',
      globalName: 'AutoTranslateContent',
      platform: 'browser'
    });
    await Promise.all([moduleCtx.watch(), contentCtx.watch()]);
    console.log('[esbuild] watching for changes...');
    return () => Promise.all([moduleCtx.dispose(), contentCtx.dispose()]);
  }

  await Promise.all([
    build({
      ...common,
      entryPoints: moduleEntries,
      outdir: DIST_DIR,
      format: 'esm',
      splitting: false,
      platform: 'browser'
    }),
    build({
      ...common,
      entryPoints: contentEntry,
      outdir: DIST_DIR,
      format: 'iife',
      globalName: 'AutoTranslateContent',
      platform: 'browser'
    })
  ]);
  console.log('[esbuild] build complete');
  return undefined;
}

async function main() {
  await cleanDist();
  await copyStaticAssets(SRC_DIR, DIST_DIR);
  const dispose = await buildModules();
  if (!isWatch) {
    return;
  }
  const staticWatcher = await watchStaticAssets();
  const shutdown = async () => {
    if (dispose) await dispose();
    if (staticWatcher) staticWatcher.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (pathToFileURL(process.argv[1] || '').href === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
