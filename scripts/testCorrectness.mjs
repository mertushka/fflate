import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deflateRawSync,
  deflateSync,
  gunzipSync as nodeGunzipSync,
  gzipSync as nodeGzipSync,
  inflateRawSync,
  inflateSync as nodeInflateSync
} from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const fflate = require(join(root, 'lib', 'index.cjs'));
const pako = require('pako');

const fixtures = [
  ['empty', new Uint8Array(0)],
  ['short', text('hello hello hello world world world')],
  ['unicode', fflate.strToU8('Snowman ☃, emoji 😀, and multilingual text Καλημέρα こんにちは')],
  ['mobyish', text('Call me Ishmael. Some years ago never mind how long precisely. '.repeat(20000))],
  ['random1k', random(1024)],
  ['random100k', random(100000)],
  ['zeros200k', new Uint8Array(200000)],
  ['zeros5m', new Uint8Array(5 * 1024 * 1024)],
  ['ramp200k', Uint8Array.from({ length: 200000 }, (_, i) => i & 255)],
  ['lowalpha2m', Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => 65 + ((i * 7) % 5))]
];

for (const [name, input] of fixtures) {
  for (const level of [0, 1, 6, 9]) {
    const raw = fflate.deflateSync(input, { level });
    equal(inflateRawSync(raw), input, `${name} deflateSync output`);
    equal(fflate.inflateSync(raw), input, `${name} inflateSync own raw level ${level}`);
    equal(fflate.inflateSync(deflateRawSync(input, { level })), input, `${name} inflateSync zlib raw level ${level}`);
    equal(fflate.inflateSync(pako.deflateRaw(input, { level })), input, `${name} inflateSync pako raw level ${level}`);

    const gz = fflate.gzipSync(input, { level, filename: `${name}.bin` });
    equal(nodeGunzipSync(gz), input, `${name} gzipSync output`);
    equal(fflate.gunzipSync(nodeGzipSync(input, { level })), input, `${name} gunzipSync node level ${level}`);
    equal(fflate.decompressSync(gz), input, `${name} decompressSync gzip level ${level}`);

    const zl = fflate.zlibSync(input, { level });
    equal(nodeInflateSync(zl), input, `${name} zlibSync output`);
    equal(fflate.unzlibSync(deflateSync(input, { level })), input, `${name} unzlibSync node level ${level}`);
    equal(fflate.decompressSync(zl), input, `${name} decompressSync zlib level ${level}`);

    equal(fflate.decompressSync(raw), input, `${name} decompressSync raw level ${level}`);
    equal(fflate.decompressSync(fflate.compressSync(input, { level })), input, `${name} compressSync alias level ${level}`);
  }
}

const dictionary = text('common prefix dictionary text repeated repeated ');
const payload = text('common prefix dictionary text repeated repeated payload payload payload');
const dictRaw = fflate.deflateSync(payload, { dictionary });
equal(fflate.inflateSync(dictRaw, { dictionary }), payload, 'raw dictionary roundtrip');
equal(fflate.inflateSync(deflateRawSync(payload, { dictionary }), { dictionary }), payload, 'zlib raw dictionary input');

await testCallbacks();
testSyncStreams();
await testAsyncStreams();
await testZipApis();
testStrings();
testErrors();

console.log(`correctness ok (${fixtures.length} fixtures, sync/callback/stream/zip/string/error APIs)`);

async function testCallbacks() {
  const sample = fixtures[3][1];
  const raw = await call(fflate.deflate, sample, { level: 6 });
  equal(await call(fflate.inflate, raw), sample, 'callback deflate/inflate');
  equal(await call(fflate.decompress, raw), sample, 'callback decompress raw');

  const gz = await call(fflate.gzip, sample, { level: 6 });
  equal(await call(fflate.gunzip, gz), sample, 'callback gzip/gunzip');
  equal(await call(fflate.decompress, gz), sample, 'callback decompress gzip');

  const zl = await call(fflate.zlib, sample, { level: 6 });
  equal(await call(fflate.unzlib, zl), sample, 'callback zlib/unzlib');
  equal(await call(fflate.decompress, zl), sample, 'callback decompress zlib');

  equal(await call(fflate.compress, sample, { level: 6 }), gz, 'callback compress alias');
}

function testSyncStreams() {
  const sample = fixtures[4][1];
  const raw = collectSyncStream(fflate.Deflate, sample, { level: 6 });
  equal(fflate.inflateSync(raw), sample, 'Deflate stream output');
  equal(collectSyncStream(fflate.Inflate, raw), sample, 'Inflate stream output');

  const gz = collectSyncStream(fflate.Gzip, sample, { level: 6 });
  equal(fflate.gunzipSync(gz), sample, 'Gzip stream output');
  equal(collectSyncStream(fflate.Gunzip, gz), sample, 'Gunzip stream output');

  const zl = collectSyncStream(fflate.Zlib, sample, { level: 6 });
  equal(fflate.unzlibSync(zl), sample, 'Zlib stream output');
  equal(collectSyncStream(fflate.Unzlib, zl), sample, 'Unzlib stream output');

  const compressed = collectSyncStream(fflate.Compress, sample, { level: 6 });
  equal(collectSyncStream(fflate.Decompress, compressed), sample, 'Compress/Decompress stream aliases');
}

async function testAsyncStreams() {
  const sample = fixtures[2][1];
  const raw = await collectAsyncStream(fflate.AsyncDeflate, sample, { level: 6 });
  equal(fflate.inflateSync(raw), sample, 'AsyncDeflate stream output');
  equal(await collectAsyncStream(fflate.AsyncInflate, raw), sample, 'AsyncInflate stream output');

  const gz = await collectAsyncStream(fflate.AsyncGzip, sample, { level: 6 });
  equal(fflate.gunzipSync(gz), sample, 'AsyncGzip stream output');
  equal(await collectAsyncStream(fflate.AsyncGunzip, gz), sample, 'AsyncGunzip stream output');

  const zl = await collectAsyncStream(fflate.AsyncZlib, sample, { level: 6 });
  equal(fflate.unzlibSync(zl), sample, 'AsyncZlib stream output');
  equal(await collectAsyncStream(fflate.AsyncUnzlib, zl), sample, 'AsyncUnzlib stream output');

  const compressed = await collectAsyncStream(fflate.AsyncCompress, sample, { level: 6 });
  equal(await collectAsyncStream(fflate.AsyncDecompress, compressed), sample, 'AsyncCompress/AsyncDecompress stream aliases');
}

async function testZipApis() {
  const files = {
    'hello.txt': text('hello zip world'),
    'data.bin': fixtures[4][1],
    nested: {
      'unicode.txt': fflate.strToU8('zip Καλημέρα こんにちは'),
      'stored.bin': [fixtures[1][1], { level: 0 }]
    }
  };
  const zipped = fflate.zipSync(files, { level: 6, comment: 'correctness' });
  const unzipped = fflate.unzipSync(zipped);
  equal(unzipped['hello.txt'], files['hello.txt'], 'zipSync hello.txt');
  equal(unzipped['data.bin'], files['data.bin'], 'zipSync data.bin');
  equal(unzipped['nested/unicode.txt'], files.nested['unicode.txt'], 'zipSync nested unicode');
  equal(unzipped['nested/stored.bin'], files.nested['stored.bin'][0], 'zipSync stored nested');

  const asyncZip = await call(fflate.zip, files, { level: 6 });
  const asyncUnzip = await call(fflate.unzip, asyncZip);
  equal(asyncUnzip['hello.txt'], files['hello.txt'], 'callback zip/unzip hello.txt');
  equal(asyncUnzip['nested/unicode.txt'], files.nested['unicode.txt'], 'callback zip/unzip nested unicode');
}

function testStrings() {
  const value = 'ASCII, emoji 😀, Greek Καλημέρα, Japanese こんにちは';
  equal(fflate.strToU8(fflate.strFromU8(fflate.strToU8(value))), fflate.strToU8(value), 'strToU8/strFromU8 roundtrip');
}

function testErrors() {
  throws(() => fflate.inflateSync(new Uint8Array([255, 255, 255])), 'invalid raw inflate throws');
  throws(() => fflate.gunzipSync(new Uint8Array([31, 139, 8, 0])), 'invalid gzip throws');
  throws(() => fflate.unzipSync(new Uint8Array([1, 2, 3, 4])), 'invalid zip throws');
}

function call(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, data) => err ? reject(err) : resolve(data));
  });
}

function collectSyncStream(Stream, input, opts) {
  const chunks = [];
  const stream = opts
    ? new Stream(opts, (chunk, final) => chunks.push(chunk))
    : new Stream((chunk, final) => chunks.push(chunk));
  pushChunks(stream, input);
  return concat(chunks);
}

function collectAsyncStream(Stream, input, opts) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = opts
      ? new Stream(opts, (err, chunk, final) => {
        if (err) reject(err);
        else {
          chunks.push(chunk);
          if (final) resolve(concat(chunks));
        }
      })
      : new Stream((err, chunk, final) => {
        if (err) reject(err);
        else {
          chunks.push(chunk);
          if (final) resolve(concat(chunks));
        }
      });
    pushChunks(stream, input);
  });
}

function pushChunks(stream, input) {
  const first = Math.max(0, Math.min(input.length, 17));
  const second = Math.max(first, Math.min(input.length, 8191));
  if (!input.length) stream.push(input, true);
  else {
    stream.push(input.slice(0, first), false);
    stream.push(input.slice(first, second), false);
    stream.push(input.slice(second), true);
  }
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

function random(length) {
  const out = new Uint8Array(length);
  let seed = 0x12345678;
  for (let i = 0; i < length; ++i) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] = seed >>> 24;
  }
  return out;
}

function equal(actual, expected, name) {
  if (actual.length != expected.length) {
    throw new Error(`${name}: length ${actual.length} != ${expected.length}`);
  }
  for (let i = 0; i < expected.length; ++i) {
    if (actual[i] != expected[i]) {
      throw new Error(`${name}: byte ${i} ${actual[i]} != ${expected[i]}`);
    }
  }
}

function throws(fn, name) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${name}: expected throw`);
}
