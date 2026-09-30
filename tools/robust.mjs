// The benchmark, run as if on several other computers.
//
// The reader is sensitive to small differences in the pixels it is given, and
// two computers do not draw the same page to the same pixels: a word read
// right here was misread on a laptop, and one misread here was read right on
// a phone. A change that only works on this machine's pixels has not been
// shown to work. So the whole benchmark is run once as it is and once under
// each of a few small alterations (tools/bench.mjs, PERTURB), and the results
// are set side by side.
//
//   node tools/robust.mjs                 every alteration
//   node tools/robust.mjs blur jpeg       only these
//
// Nothing is saved as a baseline: this compares one version of the tool
// across pixels, not against its own history.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ALL = ['none', 'blur', 'gamma', 'jpeg', 'resample', 'contrast'];
const wanted = process.argv.slice(2);
const kinds = wanted.length ? wanted : ALL;
const script = fileURLToPath(new URL('./bench.mjs', import.meta.url));

const rows = new Map();
const totals = {};
for (const kind of kinds) {
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, PERTURB: kind === 'none' ? '' : kind, SAVE: '' },
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const out = run.stdout || '';
  if (process.env.RAW) writeFileSync(process.env.RAW + '-' + kind + '.txt', out + (run.stderr || ''));
  let name = null;
  for (const line of out.split('\n')) {
    const head = /^== ([^·]+?) ·.*search ([\d.]+)s · check ([\d.]+)s/.exec(line);
    if (head) { name = head[1].trim(); continue; }
    const key = /KEY: found (\d+) of (\d+) · false alarms (\d+)/.exec(line);
    if (key && name) {
      if (!rows.has(name)) rows.set(name, {});
      rows.get(name)[kind] = key[1] + '/' + key[2] + (key[3] !== '0' ? ' +' + key[3] + 'FA' : '');
    }
  }
  const all = /ALL: found (\d+) of (\d+) · false alarms (\d+)/.exec(out);
  const time = /TIME: search ([\d.]+)s · check ([\d.]+)s/.exec(out);
  totals[kind] = (all ? all[1] + '/' + all[2] + ' FA ' + all[3] : 'no result')
    + (time ? ' · ' + time[1] + 's + ' + time[2] + 's' : '');
  console.log(kind.padEnd(9), totals[kind]);
}

console.log('\n' + 'bench'.padEnd(26) + kinds.map(k => k.padEnd(12)).join(''));
for (const [name, cells] of rows) {
  console.log(name.slice(0, 25).padEnd(26) + kinds.map(k => String(cells[k] || '-').padEnd(12)).join(''));
}
