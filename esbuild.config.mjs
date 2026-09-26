import { readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import process from 'node:process';
import esbuild from 'esbuild';

const production = process.argv.includes('production');

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'node',
  logLevel: 'info',
  treeShaking: true,
  sourcemap: production ? false : 'inline',
  outfile: 'main.js',
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtinModules,
  ],
});

if (production) {
  await context.rebuild();
  await context.dispose();

  // LLM-GUIDE.md (011, "Für LLMs außerhalb von Obsidian"): guide.ts bundled
  // standalone (write:false, esm, no `obsidian` import there to worry about)
  // and imported via a data URL, so the file is rendered from the same
  // template the plugin writes into the vault — never a second copy of the
  // text (Wissen #542: a broken build must not leave this file stale either).
  const guideBundle = await esbuild.build({
    entryPoints: ['src/core/guide.ts'],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
  });
  const code = guideBundle.outputFiles[0].text;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const { renderGuide } = await import(dataUrl);
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  writeFileSync('LLM-GUIDE.md', renderGuide({ version: manifest.version }));
} else {
  await context.watch();
}
