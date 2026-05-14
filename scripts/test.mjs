import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const uvu = join(root, 'node_modules', 'uvu', 'bin.js');
const child = spawn(process.execPath, [uvu, '-b', '-r', 'ts-node/register', 'test'], {
  cwd: root,
  env: {
    ...process.env,
    TS_NODE_PROJECT: 'test/tsconfig.json'
  },
  stdio: 'inherit'
});

child.on('exit', code => {
  process.exit(code ?? 1);
});

child.on('error', err => {
  console.error(err);
  process.exit(1);
});
