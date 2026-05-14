import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const args = parseArgs(process.argv.slice(2));
const iterations = Number(args.iterations || 8);
const rounds = Number(args.rounds || 5);
const warmup = Number(args.warmup || 2);
const level = Number(args.level || 6);

const fflatePath = join(root, 'lib', 'index.cjs');
if (!existsSync(fflatePath)) {
  throw new Error('Missing lib/index.cjs. Run npm run build:lib before benchmarking.');
}

const fflate = require(fflatePath);
const JSZip = require('jszip');
const files = makeFiles();
const fileNames = Object.keys(files).sort();
const inputBytes = fileNames.reduce((sum, name) => sum + files[name].length, 0);

const jszipCreated = await createWithJSZip();
const fflateCreated = createWithFflate();
await verifyZip(jszipCreated, 'JSZip create');
await verifyZip(fflateCreated, 'fflate create');

const tasks = [
  {
    name: 'Create ZIP',
    baseline: 'JSZip.generateAsync',
    candidate: 'fflate.zipSync',
    jszip: createWithJSZip,
    fflate: createWithFflate,
    outputBytes: {
      jszip: jszipCreated.length,
      fflate: fflateCreated.length
    }
  },
  {
    name: 'Extract ZIP',
    baseline: 'JSZip.loadAsync',
    candidate: 'fflate.unzipSync',
    jszip: () => extractWithJSZip(fflateCreated),
    fflate: () => extractWithFflate(fflateCreated),
    outputBytes: {
      jszip: inputBytes,
      fflate: inputBytes
    }
  }
];

const result = {
  type: 'zip',
  runtime: 'node',
  fileCount: fileNames.length,
  inputBytes,
  level,
  iterations,
  rounds,
  warmup,
  generatedAt: new Date().toISOString(),
  tasks: []
};

for (const task of tasks) {
  const summary = summarize(await runRounds({
    rounds,
    iterations,
    warmup,
    jszip: task.jszip,
    fflate: task.fflate
  }));
  summary.name = task.name;
  summary.baseline = task.baseline;
  summary.candidate = task.candidate;
  summary.outputBytes = task.outputBytes;
  summary.ratio = summary.medians.fflate / summary.medians.jszip;
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

function makeFiles() {
  return {
    'hello.txt': text('hello zip world\n'.repeat(1200)),
    'docs/story.txt': makeTextFixture(180000),
    'data/random.bin': random(96 * 1024),
    'data/ramp.bin': Uint8Array.from({ length: 128 * 1024 }, (_, i) => i & 255),
    'data/low-alpha.bin': Uint8Array.from({ length: 160 * 1024 }, (_, i) => 65 + ((i * 7) % 5))
  };
}

async function createWithJSZip() {
  const zip = new JSZip();
  for (const name of fileNames) zip.file(name, files[name]);
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level }
  });
}

function createWithFflate() {
  return fflate.zipSync(files, { level });
}

async function extractWithJSZip(data) {
  const zip = await JSZip.loadAsync(data);
  const chunks = [];
  for (const name of fileNames) {
    const file = zip.file(name);
    if (!file) throw new Error(`JSZip missing ${name}`);
    chunks.push(await file.async('uint8array'));
  }
  return concat(chunks);
}

function extractWithFflate(data) {
  const unzipped = fflate.unzipSync(data);
  return concat(fileNames.map(name => {
    const file = unzipped[name];
    if (!file) throw new Error(`fflate missing ${name}`);
    return file;
  }));
}

async function verifyZip(data, label) {
  const fflateOut = fflate.unzipSync(data);
  for (const name of fileNames) {
    if (!fflateOut[name]) throw new Error(`${label}: fflate missing ${name}`);
    assertEqual(fflateOut[name], files[name], `${label}: fflate ${name}`);
  }
  const jszip = await JSZip.loadAsync(data);
  for (const name of fileNames) {
    const file = jszip.file(name);
    if (!file) throw new Error(`${label}: JSZip missing ${name}`);
    assertEqual(await file.async('uint8array'), files[name], `${label}: JSZip ${name}`);
  }
}

async function runRounds({ rounds, iterations, warmup, jszip, fflate }) {
  const results = [];
  for (let r = 0; r < rounds; ++r) {
    if (r & 1) results.push([await bench('fflate', fflate, iterations, warmup), await bench('jszip', jszip, iterations, warmup)]);
    else results.push([await bench('jszip', jszip, iterations, warmup), await bench('fflate', fflate, iterations, warmup)]);
  }
  return results;
}

async function bench(name, fn, iterations, warmup) {
  let keep = 0;
  for (let i = 0; i < warmup; ++i) keep = keepResult(keep, await fn());
  const start = performance.now();
  for (let i = 0; i < iterations; ++i) keep = keepResult(keep, await fn());
  const elapsed = performance.now() - start;
  return { name, ops: iterations / elapsed * 1000, ms: elapsed / iterations, keep };
}

function keepResult(keep, result) {
  return (keep + result.length + (result[0] || 0) + (result[result.length - 1] || 0)) | 0;
}

function summarize(rounds) {
  const jszipValues = values(rounds, 'jszip');
  const fflateValues = values(rounds, 'fflate');
  return {
    medians: {
      jszip: median(jszipValues),
      fflate: median(fflateValues)
    },
    jszip: jszipValues,
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

function toMarkdown(result) {
  const lines = [
    `### ZIP Benchmark (${result.runtime})`,
    '',
    `Fixture: ${result.fileCount} files, ${result.inputBytes.toLocaleString()} total input bytes, level ${result.level}.`
  ];
  for (const task of result.tasks) {
    lines.push(
      '',
      `#### ${task.name}`,
      '',
      '| Library | Median ops/sec | Median ms/op | Output bytes | Relative |',
      '|---|---:|---:|---:|---:|',
      row(task.baseline, task.medians.jszip, task.outputBytes.jszip, 1),
      row(task.candidate, task.medians.fflate, task.outputBytes.fflate, task.ratio)
    );
  }
  return lines.join('\n');
}

function row(name, ops, outputBytes, ratio) {
  return `| ${name} | ${ops.toFixed(1)} | ${(1000 / ops).toFixed(2)} | ${outputBytes.toLocaleString()} | ${ratio.toFixed(2)}x |`;
}

function makeTextFixture(size) {
  const words = [
    'archive', 'folder', 'entry', 'record', 'central', 'directory', 'stream',
    'local', 'header', 'checksum', 'compressed', 'stored', 'comment', 'file',
    'path', 'buffer', 'payload', 'binary', 'sample', 'repeat', 'suffix'
  ];
  let seed = 0x94d049bb;
  let out = '';
  for (let i = 0; out.length < size; ++i) {
    let sentence = '';
    const len = 7 + (rand() % 16);
    for (let j = 0; j < len; ++j) {
      let word = words[rand() % words.length];
      if (!j) word = word[0].toUpperCase() + word.slice(1);
      sentence += (j ? ' ' : '') + word;
    }
    out += sentence + (rand() % 9 == 0 ? '!\n' : '. ');
  }
  return text(out.slice(0, size));

  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  }
}

function random(length) {
  const out = new Uint8Array(length);
  let seed = 0x12345678;
  for (let i = 0; i < length; ++i) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] = seed >>> 24;
  }
  return out;
}

function concat(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function text(value) {
  return new TextEncoder().encode(value);
}

function assertEqual(actual, expected, name) {
  if (actual.length != expected.length) throw new Error(`${name}: length ${actual.length} != ${expected.length}`);
  for (let i = 0; i < expected.length; ++i) {
    if (actual[i] != expected[i]) throw new Error(`${name}: byte ${i} ${actual[i]} != ${expected[i]}`);
  }
}
