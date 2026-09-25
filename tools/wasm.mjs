// Builds lib/fft.wasm from lib/fft.c.
//
//   node tools/wasm.mjs          build it
//   node tools/wasm.mjs --check  exit 1 if the committed binary is not what
//                                the source builds to
//
// The binary is committed, because the site has no build step and a browser
// cannot compile C. That makes it the one file in the repository nobody can
// read, so the build is fixed and exact -- the same compiler and flags give
// the same bytes -- and the self-test rebuilds it wherever clang is present
// and fails if the two differ. A binary that does not come from its source
// is caught rather than trusted.
//
// Needs clang with the wasm32 target and wasm-ld (LLVM 17 or later). Nothing
// here is needed to run the site.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'lib', 'fft.c');
const target = join(root, 'lib', 'fft.wasm');

export const FLAGS = [
  '--target=wasm32', '-O3', '-msimd128', '-ffp-contract=off',
  '-nostdlib', '-fno-builtin',
  '-Wl,--no-entry', '-Wl,--export=__heap_base', '-Wl,--strip-all',
];

export function clang() {
  for (const name of ['clang', 'clang-18', 'clang-17']) {
    try {
      const said = execFileSync(name, ['--version'], { encoding: 'utf8' });
      if (/clang version (\d+)/.test(said) && Number(/clang version (\d+)/.exec(said)[1]) >= 17) {
        return name;
      }
    } catch { /* not this one */ }
  }
  return null;
}

// The bytes the source builds to, or null where there is no compiler.
export function build() {
  const cc = clang();
  if (!cc) return null;
  const dir = mkdtempSync(join(tmpdir(), 'blinded-wasm-'));
  const out = join(dir, 'fft.wasm');
  try {
    execFileSync(cc, [...FLAGS, '-o', out, source], { stdio: 'pipe' });
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('wasm.mjs')) {
  const bytes = build();
  if (!bytes) {
    console.log('No clang 17+ with the wasm32 target here; lib/fft.wasm left as it is.');
    process.exit(process.argv.includes('--check') ? 0 : 1);
  }
  if (process.argv.includes('--check')) {
    const same = existsSync(target) && Buffer.compare(bytes, readFileSync(target)) === 0;
    console.log(same ? 'lib/fft.wasm is what lib/fft.c builds to'
      : 'lib/fft.wasm does NOT match lib/fft.c -- run: node tools/wasm.mjs');
    process.exit(same ? 0 : 1);
  }
  writeFileSync(target, bytes);
  console.log('wrote lib/fft.wasm (' + bytes.length + ' bytes)');
}
