const http = require('http');
const fs = require('fs').promises;
const path = require('path');

const FRAMES_ROOT = path.resolve(process.cwd(), 'frames');
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const cache = new Map();

async function listAnimationDirs() {
  try {
    const entries = await fs.readdir(FRAMES_ROOT, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(d => d.name);
  } catch {
    return [];
  }
}

async function loadAnimation(name) {
  const key = name;
  if (cache.has(key)) return cache.get(key);
  const base = path.join(FRAMES_ROOT, name);
  const metaPath = path.join(base, 'metadata.json');
  const artPath = path.join(base, 'art.txt');
  const result = { name, error: null, metadata: null, frames: [] };
  try {
    const [metaRaw, artRaw] = await Promise.all([
      fs.readFile(metaPath, 'utf8'),
      fs.readFile(artPath, 'utf8')
    ]);
    let metadata;
    try {
      metadata = JSON.parse(metaRaw);
    } catch {
      throw new Error('Invalid JSON in metadata.json');
    }
    if (!metadata || typeof metadata !== 'object') throw new Error('Invalid metadata content');
    if (typeof metadata.interval === 'number') metadata.interval = Math.floor(metadata.interval);
    if (typeof metadata.fps !== 'number' || metadata.fps <= 0) metadata.fps = metadata.fps;
    if (typeof metadata.loop !== 'boolean') metadata.loop = !!metadata.loop;
    if (typeof metadata.name !== 'string' || metadata.name.trim() === '') metadata.name = name;
    const normalizedRaw = artRaw.replace(/\r\n/g, '\n');
    const frames = normalizedRaw.split('\n====FRAME====\n');
    const allEmpty = frames.every(f => f.length === 0);
    if (frames.length === 0 || allEmpty) throw new Error('No frames found in art.txt');
    result.metadata = metadata;
    result.frames = frames;
    cache.set(key, result);
    return result;
  } catch (err) {
    result.error = err.message;
    cache.set(key, result);
    return result;
  }
}

async function buildListResponse() {
  const dirs = await listAnimationDirs();
  if (dirs.length === 0) return 'Available animations:\n(none found in frames/)\n';
  const lines = ['Available animations:'];
  await Promise.all(dirs.map(async d => {
    const anim = await loadAnimation(d);
    if (anim.error) {
      lines.push(`- ${d} (error: ${anim.error})`);
    } else {
      const m = anim.metadata;
      const intervalPart = typeof m.interval === 'number' && m.interval > 0 ? `, interval ${m.interval}ms` : '';
      lines.push(`- ${m.name} (${m.fps ? `fps ${m.fps}` : 'no fps'}${intervalPart}, loop ${m.loop}, frames ${anim.frames.length})`);
    }
  }));
  return lines.join('\n') + '\n';
}

function isBrowserUA(ua) {
  if (!ua) return false;
  const terminalPatterns = /(curl|wget|httpie|libwww-perl|python-requests|python-urllib|Go-http-client|php|node-fetch|fetch\(|http-client|http_client)/i;
  const browserPatterns = /(Mozilla\/|AppleWebKit|Chrome\/|Safari\/|Opera\/|Edg\/|Firefox\/|Gecko\/)/i;
  if (terminalPatterns.test(ua)) return false;
  if (browserPatterns.test(ua)) return true;
  return false;
}

function computeIntervalMs(metadata) {
  if (metadata && typeof metadata.interval === 'number' && metadata.interval > 0) {
    return Math.max(10, Math.floor(metadata.interval));
  }
  if (metadata && typeof metadata.fps === 'number' && metadata.fps > 0) {
    return Math.max(10, Math.round(1000 / metadata.fps));
  }
  return 100;
}

function streamFramesToResponse(res, animName) {
  const cached = cache.get(animName);
  if (!cached || cached.error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Error loading animation: ${cached ? cached.error : 'not cached'}\n`);
    return;
  }
  const anim = cached;
  const intervalMs = computeIntervalMs(anim.metadata);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no'
  });
  const hideCursor = '\x1b[?25l';
  const showCursor = '\x1b[?25h';
  const clearScreen = '\x1b[2J';
  const home = '\x1b[H';
  const frames = anim.frames;
  let idx = 0;
  let ended = false;
  let timer = null;
  res.on('close', () => {
    ended = true;
    if (timer) clearInterval(timer);
  });
  res.on('error', () => {
    ended = true;
    if (timer) clearInterval(timer);
  });
  try {
    res.write(hideCursor + clearScreen + home);
  } catch {
    ended = true;
  }
  const writeFrame = () => {
    if (ended) return;
    const frame = frames[idx] === undefined ? '' : frames[idx];
    try {
      res.write(clearScreen + home + frame);
    } catch {
      ended = true;
    }
    idx++;
    if (idx >= frames.length) {
      if (anim.metadata.loop) {
        idx = 0;
      } else {
        if (timer) clearInterval(timer);
        if (!ended) {
          try { res.write(showCursor); } catch {}
          try { res.end(); } catch {}
        }
      }
    }
  };
  timer = setInterval(() => {
    if (ended) {
      if (timer) clearInterval(timer);
      try { res.write(showCursor); } catch {}
      try { res.end(); } catch {}
      return;
    }
    writeFrame();
  }, intervalMs);
  writeFrame();
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    const url = req.url || '/';
    const ua = req.headers['user-agent'] || '';
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Only GET is supported\n');
      return;
    }
    if (url === '/list' || url === '/list/') {
      const body = await buildListResponse();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body);
      return;
    }
    const parts = url.split('?')[0].split('/').filter(Boolean);
    if (parts.length === 0) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Available endpoints:\n/list\n/<framename>\n');
      return;
    }
    const frameName = parts[0];
    const framePath = path.join(FRAMES_ROOT, frameName);
    try {
      const stat = await fs.stat(framePath);
      if (!stat.isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found\n');
        return;
      }
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }
    const anim = await loadAnimation(frameName);
    if (anim.error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Error loading animation: ${anim.error}\n`);
      return;
    }
    if (!cache.has(frameName)) cache.set(frameName, anim);
    const browser = isBrowserUA(ua);
    if (browser) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('Please curl this into the terminal. Use the /list endpoint to show available frames.');
      return;
    }
    streamFramesToResponse(res, frameName);
  } catch {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error\n');
    } catch {}
  }
});

server.listen(PORT, () => {
  console.log(`ASCII animation server listening on port ${PORT}`);
});
