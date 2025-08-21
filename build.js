// build.js
const { build } = require('esbuild');
const fs = require('fs');

const header = fs.readFileSync('./src/header.user.js', 'utf8'); 
// Dica: mantenha o bloco de metadados num arquivo separado "header.user.js"
// e o resto do código em "main.js", para o banner ficar limpo.

build({
  entryPoints: ['src/main.js'],
  bundle: false,
  minify: true,
  format: 'iife',
  target: ['chrome100','firefox100'],
  banner: { js: header }, // preserva o cabeçalho UserScript no topo
  outfile: 'dist/troop-reporter.user.js',
}).catch(() => process.exit(1));
