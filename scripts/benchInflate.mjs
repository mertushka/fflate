import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const args = parseArgs(process.argv.slice(2));
const runtime = args.runtime || 'node';
const iterations = Number(args.iterations || (runtime == 'browser' ? 140 : 220));
const rounds = Number(args.rounds || 5);
const warmup = Number(args.warmup || 35);
const minRatio = args['min-ratio'] == null ? 0 : Number(args['min-ratio']);
const targetSize = Number(args.size || 1232923);

if (!['node', 'browser'].includes(runtime)) {
  throw new Error(`Unsupported runtime "${runtime}". Use --runtime node or --runtime browser.`);
}

const fixture = makeFixture(targetSize);
const input = new TextEncoder().encode(fixture);
const pako = require('pako');
const compressed = pako.deflateRaw(input);

const result = runtime == 'browser'
  ? await benchBrowser({ fixture, compressed, iterations, rounds, warmup })
  : await benchNode({ compressed, iterations, rounds, warmup });

result.runtime = runtime;
result.inputBytes = input.length;
result.compressedBytes = compressed.length;
result.ratio = result.medians.fflate / result.medians.pako;
result.generatedAt = new Date().toISOString();

const markdown = toMarkdown(result);
console.log(markdown);

if (args.json) writeFileSync(join(root, args.json), JSON.stringify(result, null, 2) + '\n');
if (args.markdown) writeFileSync(join(root, args.markdown), markdown + '\n');
if (minRatio && result.ratio < minRatio) {
  throw new Error(`fflate/pako ratio ${result.ratio.toFixed(3)} is below required ${minRatio}`);
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

function makeFixture(size) {
  const words = [
    'whale', 'voyage', 'captain', 'harbor', 'lantern', 'deck', 'ocean', 'wind',
    'sailor', 'island', 'chapter', 'silver', 'weather', 'midnight', 'current',
    'story', 'signal', 'compass', 'cabin', 'anchor', 'horizon', 'rope', 'water',
    'watch', 'north', 'south', 'morning', 'quiet', 'storm', 'journal', 'plain',
    'strange', 'distance', 'vessel', 'ordinary', 'course', 'account', 'almost'
  ];
  let seed = 0x9e3779b9;
  let out = '';
  for (let i = 0; out.length < size; ++i) {
    let sentence = '';
    const len = 8 + (rand() % 18);
    for (let j = 0; j < len; ++j) {
      let word = words[rand() % words.length];
      if (!j) word = word[0].toUpperCase() + word.slice(1);
      sentence += (j ? ' ' : '') + word;
      if (j && j % (5 + (rand() % 6)) == 0) sentence += ',';
    }
    out += sentence + (rand() % 9 == 0 ? '!\n' : '. ');
    if (i % 11 == 10) out += '\n';
  }
  return out.slice(0, size);

  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  }
}

async function benchNode({ compressed, iterations, rounds, warmup }) {
  const fflatePath = join(root, 'lib', 'index.cjs');
  if (!existsSync(fflatePath)) {
    throw new Error('Missing lib/index.cjs. Run npm run build:lib before benchmarking.');
  }
  const fflate = require(fflatePath);
  const check = fflate.inflateSync(compressed);
  assertEqual(check, input, 'fflate.inflateSync');
  const roundResults = runRounds({
    rounds,
    iterations,
    warmup,
    pako: () => pako.inflateRaw(compressed),
    fflate: () => fflate.inflateSync(compressed)
  });
  return summarize(roundResults);
}

async function benchBrowser({ fixture, compressed, iterations, rounds, warmup }) {
  const chrome = findChrome();
  const fflateBundle = readFileSync(join(root, 'umd', 'index.js'));
  const pakoBundle = readFileSync(join(root, 'node_modules', 'pako', 'dist', 'pako.min.js'));
  const compressedArray = Array.from(compressed);
  const html = `<!doctype html><meta charset="utf-8"><pre id="out">running</pre>
<script src="/pako.js"></script><script src="/fflate.js"></script><script src="/data.js"></script>
<script>
(function(){
  const input = new TextEncoder().encode(BENCH_TEXT);
  const compressed = new Uint8Array(BENCH_COMPRESSED);
  const check = fflate.inflateSync(compressed);
  if (check.length !== input.length) throw new Error('bad length');
  for (let i = 0; i < input.length; ++i) if (check[i] !== input[i]) throw new Error('bad byte ' + i);
  function bench(name, fn, n, warmup) {
    let keep = 0;
    for (let i = 0; i < warmup; ++i) keep = (keep + fn()[0]) | 0;
    const start = performance.now();
    for (let i = 0; i < n; ++i) keep = (keep + fn()[0]) | 0;
    const elapsed = performance.now() - start;
    return { name, ops: n / elapsed * 1000, ms: elapsed / n, keep };
  }
  const roundResults = [];
  for (let r = 0; r < ${rounds}; ++r) {
    if (r & 1) roundResults.push([bench('fflate', () => fflate.inflateSync(compressed), ${iterations}, ${warmup}), bench('pako', () => pako.inflateRaw(compressed), ${iterations}, ${warmup})]);
    else roundResults.push([bench('pako', () => pako.inflateRaw(compressed), ${iterations}, ${warmup}), bench('fflate', () => fflate.inflateSync(compressed), ${iterations}, ${warmup})]);
  }
  document.getElementById('out').textContent = JSON.stringify({ rounds: roundResults });
})();
</script>`;
  const server = http.createServer((req, res) => {
    if (req.url == '/pako.js') serve(res, 'application/javascript', pakoBundle);
    else if (req.url == '/fflate.js') serve(res, 'application/javascript', fflateBundle);
    else if (req.url == '/data.js') serve(res, 'application/javascript', `var BENCH_TEXT=${JSON.stringify(fixture)};var BENCH_COMPRESSED=${JSON.stringify(compressedArray)};`);
    else serve(res, 'text/html', html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const dom = await runChrome(chrome, `http://127.0.0.1:${server.address().port}/`);
    const match = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!match) throw new Error(`No benchmark result in Chrome output:\n${dom.slice(0, 500)}`);
    return summarize(JSON.parse(decodeEntities(match[1])).rounds);
  } finally {
    server.close();
  }
}

function serve(res, type, body) {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
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
  for (let i = 0; i < warmup; ++i) keep = (keep + fn()[0]) | 0;
  const start = performance.now();
  for (let i = 0; i < iterations; ++i) keep = (keep + fn()[0]) | 0;
  const elapsed = performance.now() - start;
  return { name, ops: iterations / elapsed * 1000, ms: elapsed / iterations, keep };
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
  const pakoMs = 1000 / result.medians.pako;
  const fflateMs = 1000 / result.medians.fflate;
  return [
    `### Inflate Benchmark (${result.runtime})`,
    '',
    `Fixture: ${result.inputBytes.toLocaleString()} bytes input, ${result.compressedBytes.toLocaleString()} bytes deflateRaw.`,
    '',
    '| Library | Median ops/sec | Median ms/op | Relative |',
    '|---|---:|---:|---:|',
    `| pako.inflateRaw | ${result.medians.pako.toFixed(1)} | ${pakoMs.toFixed(2)} | 1.00x |`,
    `| fflate.inflateSync | ${result.medians.fflate.toFixed(1)} | ${fflateMs.toFixed(2)} | ${result.ratio.toFixed(2)}x |`
  ].join('\n');
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const finder = process.platform == 'win32' ? 'where.exe' : 'which';
    const found = spawnSync(finder, [candidate], { encoding: 'utf8' });
    if (!found.status) return found.stdout.trim().split(/\r?\n/)[0];
  }
  throw new Error('Chrome was not found. Set CHROME_BIN or install google-chrome/chromium.');
}

function runChrome(chrome, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--dump-dom',
      url
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Chrome benchmark timed out\n${err}`));
    }, 180000);
    child.stdout.on('data', chunk => out += chunk);
    child.stderr.on('data', chunk => err += chunk);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code) reject(new Error(`Chrome exited with ${code}\n${err}`));
      else resolve(out);
    });
  });
}

function decodeEntities(value) {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
