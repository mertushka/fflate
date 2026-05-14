import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  gunzipSync,
  inflateRawSync,
  inflateSync
} from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const args = parseArgs(process.argv.slice(2));
const iterations = Number(args.iterations || 80);
const rounds = Number(args.rounds || 5);
const warmup = Number(args.warmup || 10);
const level = Number(args.level || 6);
const targetSize = Number(args.size || 1232923);

const fflatePath = join(root, 'lib', 'index.cjs');
if (!existsSync(fflatePath)) {
  throw new Error('Missing lib/index.cjs. Run npm run build:lib before benchmarking.');
}

const fflate = require(fflatePath);
const pako = require('pako');
const input = makeFixture(targetSize);

const tasks = [
  {
    name: 'Raw DEFLATE',
    baseline: 'pako.deflateRaw',
    candidate: 'fflate.deflateSync',
    pako: () => pako.deflateRaw(input, { level }),
    fflate: () => fflate.deflateSync(input, { level }),
    verify: output => inflateRawSync(output)
  },
  {
    name: 'GZIP',
    baseline: 'pako.gzip',
    candidate: 'fflate.gzipSync',
    pako: () => pako.gzip(input, { level }),
    fflate: () => fflate.gzipSync(input, { level }),
    verify: output => gunzipSync(output)
  },
  {
    name: 'Zlib',
    baseline: 'pako.deflate',
    candidate: 'fflate.zlibSync',
    pako: () => pako.deflate(input, { level }),
    fflate: () => fflate.zlibSync(input, { level }),
    verify: output => inflateSync(output)
  }
];

const result = {
  type: 'compression',
  runtime: 'node',
  inputBytes: input.length,
  level,
  iterations,
  rounds,
  warmup,
  generatedAt: new Date().toISOString(),
  tasks: []
};

for (const task of tasks) {
  const pakoOutput = task.pako();
  const fflateOutput = task.fflate();
  assertEqual(task.verify(pakoOutput), input, task.baseline);
  assertEqual(task.verify(fflateOutput), input, task.candidate);

  const summary = summarize(runRounds({
    rounds,
    iterations,
    warmup,
    pako: task.pako,
    fflate: task.fflate
  }));
  summary.name = task.name;
  summary.baseline = task.baseline;
  summary.candidate = task.candidate;
  summary.outputBytes = {
    pako: pakoOutput.length,
    fflate: fflateOutput.length
  };
  summary.ratio = summary.medians.fflate / summary.medians.pako;
  result.tasks.push(summary);
}

const markdown = toMarkdown(result);
console.log(markdown);

if (args.json) writeFileSync(join(root, args.json), JSON.stringify(result, null, 2) + '\n');
if (args.markdown) writeFileSync(join(root, args.markdown), markdown + '\n');

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

function makeFixture(size) {
  const words = [
    'archive', 'buffer', 'window', 'stream', 'literal', 'header', 'packet',
    'checksum', 'length', 'table', 'binary', 'worker', 'sample', 'payload',
    'match', 'prefix', 'repeat', 'symbol', 'block', 'stored', 'dynamic',
    'static', 'offset', 'codec', 'decode', 'encode', 'branch', 'memory'
  ];
  let seed = 0x6d2b79f5;
  let out = '';
  for (let i = 0; out.length < size; ++i) {
    let sentence = '';
    const len = 7 + (rand() % 20);
    for (let j = 0; j < len; ++j) {
      let word = words[rand() % words.length];
      if (!j) word = word[0].toUpperCase() + word.slice(1);
      sentence += (j ? ' ' : '') + word;
      if (j && j % (4 + (rand() % 7)) == 0) sentence += ',';
    }
    out += sentence + (rand() % 10 == 0 ? '!\n' : '. ');
    if (i % 13 == 12) out += '\n';
  }
  return new TextEncoder().encode(out.slice(0, size));

  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  }
}

function runRounds({ rounds, iterations, warmup, pako, fflate }) {
  const results = [];
  for (let r = 0; r < rounds; ++r) {
    if (r & 1) results.push([bench('fflate', fflate, iterations, warmup), bench('pako', pako, iterations, warmup)]);
    else results.push([bench('pako', pako, iterations, warmup), bench('fflate', fflate, iterations, warmup)]);
  }
  return results;
}

function bench(name, fn, iterations, warmup) {
  let keep = 0;
  for (let i = 0; i < warmup; ++i) keep = keepResult(keep, fn());
  const start = performance.now();
  for (let i = 0; i < iterations; ++i) keep = keepResult(keep, fn());
  const elapsed = performance.now() - start;
  return { name, ops: iterations / elapsed * 1000, ms: elapsed / iterations, keep };
}

function keepResult(keep, result) {
  return (keep + result.length + (result[0] || 0) + (result[result.length - 1] || 0)) | 0;
}

function summarize(rounds) {
  const pakoValues = values(rounds, 'pako');
  const fflateValues = values(rounds, 'fflate');
  return {
    medians: {
      pako: median(pakoValues),
      fflate: median(fflateValues)
    },
    pako: pakoValues,
    fflate: fflateValues,
    rounds
  };
}

function values(rounds, name) {
  const out = [];
  for (const round of rounds) {
    for (const result of round) {
      if (result.name == name) out.push(result.ops);
    }
  }
  return out.sort((a, b) => a - b);
}

function median(values) {
  return values[values.length >> 1];
}

function assertEqual(actual, expected, name) {
  if (actual.length != expected.length) throw new Error(`${name} returned ${actual.length} bytes, expected ${expected.length}`);
  for (let i = 0; i < expected.length; ++i) {
    if (actual[i] != expected[i]) throw new Error(`${name} byte mismatch at ${i}`);
  }
}

function toMarkdown(result) {
  const lines = [
    `### Compression Benchmark (${result.runtime})`,
    '',
    `Fixture: ${result.inputBytes.toLocaleString()} bytes input, level ${result.level}.`
  ];
  for (const task of result.tasks) {
    lines.push(
      '',
      `#### ${task.name}`,
      '',
      '| Library | Median ops/sec | Median ms/op | Output bytes | Relative |',
      '|---|---:|---:|---:|---:|',
      row(task.baseline, task.medians.pako, task.outputBytes.pako, 1),
      row(task.candidate, task.medians.fflate, task.outputBytes.fflate, task.ratio)
    );
  }
  return lines.join('\n');
}

function row(name, ops, outputBytes, ratio) {
  return `| ${name} | ${ops.toFixed(1)} | ${(1000 / ops).toFixed(2)} | ${outputBytes.toLocaleString()} | ${ratio.toFixed(2)}x |`;
}
