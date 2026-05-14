import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export async function runBrowserBench({ routes, html, timeout = 180000 }) {
  const chrome = findChrome();
  let resolveResult, rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const server = http.createServer((req, res) => {
    if (req.url == '/result' && req.method == 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.writeHead(204);
        res.end();
        try {
          const result = JSON.parse(body);
          if (result.error) rejectResult(new Error(result.error));
          else resolveResult(result);
        } catch (e) {
          rejectResult(e);
        }
      });
      return;
    }
    const route = routes[req.url];
    if (route) serve(res, route.type, route.body);
    else serve(res, 'text/html', html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = runChrome(chrome, `http://127.0.0.1:${server.address().port}/`);
  child.on('exit', code => {
    rejectResult(new Error(`Chrome exited with ${code}\n${child.stderrText()}`));
  });
  const timeoutId = setTimeout(() => {
    child.kill();
    rejectResult(new Error(`Chrome benchmark timed out\n${child.stderrText()}`));
  }, timeout);
  try {
    return await resultPromise;
  } finally {
    clearTimeout(timeoutId);
    child.kill();
    server.close();
  }
}

function serve(res, type, body) {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
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
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    url
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', chunk => err += chunk);
  child.on('error', e => {
    err += `\n${e.stack || e.message || e}`;
  });
  child.stderrText = () => err;
  return child;
}
