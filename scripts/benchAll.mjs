import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const quick = Boolean(args.quick);

const suites = quick
  ? [
    ['benchInflate.mjs', ['--runtime', 'node', '--iterations', '40', '--rounds', '3', '--warmup', '10']],
    ['benchCompression.mjs', ['--iterations', '20', '--rounds', '3', '--warmup', '4']],
    ['benchZip.mjs', ['--iterations', '3', '--rounds', '3', '--warmup', '1']]
  ]
  : [
    ['benchInflate.mjs', ['--runtime', 'node']],
    ['benchCompression.mjs', []],
    ['benchZip.mjs', []]
  ];

for (let i = 0; i < suites.length; ++i) {
  const [script, scriptArgs] = suites[i];
  if (i) console.log('');
  await run(join(root, 'scripts', script), scriptArgs);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    parsed[key] = next && !next.startsWith('--') ? argv[++i] : true;
  }
  return parsed;
}

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code) reject(new Error(`${script} exited with ${code}`));
      else resolve();
    });
  });
}
