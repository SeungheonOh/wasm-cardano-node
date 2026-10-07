import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToString } from 'react-dom/server';

export async function buildUI() {
  const root = new URL('../', import.meta.url);
  await build({ absWorkingDir: root.pathname,
    entryPoints: { 'chain-ui': 'ui/chain-entry.jsx', 'submit-ui': 'ui/submit-entry.jsx' }, outdir: 'dist', outExtension: { '.js': '.mjs' },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' }, external: ['../web/*.mjs', '../submit/*.mjs'],
  });
  // Render the same components at build time. Static hosting serves the full
  // interface immediately; hydration attaches handlers without replacing it.
  await build({ absWorkingDir: root.pathname, entryPoints: ['ui/chain.jsx', 'ui/submit.jsx'], outdir: 'build/ui-ssr', outExtension: { '.js': '.mjs' },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic',
  });
  for (const [app, folder] of [['chain', 'web'], ['submit', 'submit']]) {
    const { default: App } = await import(new URL(`build/ui-ssr/${app}.mjs?build=${Date.now()}`, root));
    const template = await readFile(new URL(`${folder}/index.html`, root), 'utf8');
    for (const hosted of [false, true]) {
      const html = template.replace('<html lang="en">', `<html lang="en" data-hosted="${hosted}">`)
        .replace('<!--app-->', renderToString(React.createElement(App, { initialHosted: hosted })));
      await writeFile(new URL(`dist/${app}${hosted ? '-hosted' : ''}.html`, root), html);
    }
  }
  const notices = await Promise.all(['react', 'react-dom', 'scheduler'].map(async name => {
    const pkgRoot = new URL(`node_modules/${name}/`, root);
    const pkg = JSON.parse(await readFile(new URL('package.json', pkgRoot), 'utf8'));
    return `${name} ${pkg.version}\n\n${await readFile(new URL('LICENSE', pkgRoot), 'utf8')}`;
  }));
  await writeFile(new URL('dist/UI_LICENSES.txt', root), notices.join('\n\n'));
}
if (process.argv[1] === new URL(import.meta.url).pathname) await buildUI();
