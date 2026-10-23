/*
 * انسخ هذا الملف بالكامل داخل محرر Worker ثم اضغط Deploy.
 * اربط قاعدة D1 باسم DB وأضف Secret باسم ADMIN_SECRET (32 حرفاً أو أكثر).
 * افتح رابط Worker وأضف /admin، ثم اضغط تهيئة الجداول مرة واحدة.
 * اضغط جمع دفعة للتجربة، ثم أضف Cron كل عشر دقائق من إعدادات Worker.
 * يصدر كود الموافقة من لوحة الإدارة ويستبدل برابط السورس من /activate.
 * لا يحتاج الملف إلى GitHub أو R2 أو تثبيت مكتبات.
 * الربط التلقائي الآمن مع تطبيقك خطوة منفصلة عن روابط الموافقات الخارجية.
 *
 * ONE Cloudflare Worker. No npm, GitHub, R2, or SQL copy/paste.
 * Bind a D1 database as DB. Add a Secret named ADMIN_SECRET (32+ characters).
 * Paste this entire file into worker.js, Deploy, then open /admin.
 * Click Initialize once. Click Collect to test. Add a Cron every ten minutes.
 * Real collection requires sufficient Workers CPU/subrequest quotas (Paid recommended).
 * Source links are revocable bearer credentials, not uncopyable app identity.
 */

const CONFIG = {
  name: 'مكتبة التطبيقات والألعاب',
  identifier: 'com.hassan.feather.catalog',
  appsPerRun: 6,
  // Turn this off if you only want IPAOMTK.
  iosvizor: true,
};
const DAY = 86400;
const AGENT = 'FeatherCatalog/2.0';
const ENC = new TextEncoder();
const DEC = new TextDecoder();
const HOSTS = new Set([
  'ipaomtk.com', 'www.ipaomtk.com', 'file.ipaomtk.com',
  'iosvizor.com', 'www.iosvizor.com', 'dl.iosvizor.net',
]);
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS jobs (url TEXT PRIMARY KEY, kind TEXT NOT NULL, revision TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL DEFAULT 0, touched INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, error TEXT)",
  'CREATE INDEX IF NOT EXISTS jobs_due ON jobs(kind,due,touched)',
  'CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, days INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS throttle (key TEXT PRIMARY KEY, n INTEGER NOT NULL, expires INTEGER NOT NULL)',
];

class Fault extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const now = () => Math.floor(Date.now() / 1000);
const q = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', ENC.encode(value))))
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyAdmin(supplied, secret) {
  const a = await crypto.subtle.digest('SHA-256', ENC.encode(supplied));
  const b = await crypto.subtle.digest('SHA-256', ENC.encode('Bearer ' + secret));
  return crypto.subtle.timingSafeEqual(a, b);
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function rawJsonResponse(jsonString, status = 200) {
  return new Response(jsonString, { status, headers: JSON_HEADERS });
}

async function body(req) {
  if (Number(req.headers.get('Content-Length')) > 4096) throw new Fault('الطلب كبير', 413);
  let data;
  try {
    data = JSON.parse(DEC.decode(await bytes(req.body, 4096)));
  } catch {
    throw new Fault('JSON غير صالح', 400);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Fault('JSON غير صالح');
  return data;
}

async function bytes(stream, limit) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Response exceeds byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function initialize(env) {
  await env.DB.batch(SCHEMA.map(sql => env.DB.prepare(sql)));
  await q(env, "INSERT OR IGNORE INTO settings(key,value) VALUES('lock','0')").run();
  const seeds = [{ url: 'https://ipaomtk.com/sitemap_index.xml', kind: 'map', revision: '' }];
  if (CONFIG.iosvizor) {
    for (const type of ['apps', 'games']) {
      seeds.push({ url: 'https://iosvizor.com/ar/' + type + '/', kind: 'list', revision: '' });
    }
  }
  await enqueue(env, seeds);
  await catalogue(env, true);
}

async function enqueue(env, jobs) {
  if (!jobs.length) return;
  await q(
    env,
    `INSERT INTO jobs(url,kind,revision)
    SELECT json_extract(value,'$.url'),json_extract(value,'$.kind'),json_extract(value,'$.revision') FROM json_each(?) WHERE 1
    ON CONFLICT(url) DO UPDATE SET
    due=CASE WHEN excluded.revision<>'' AND excluded.revision<>jobs.revision THEN 0 ELSE jobs.due END,
    revision=CASE WHEN excluded.revision<>'' THEN excluded.revision ELSE jobs.revision END`,
    JSON.stringify(jobs)
  ).run();
}

async function status(env) {
  return {
    apps: (await q(env, 'SELECT count(*) AS n FROM apps').first()).n,
    queue: (await q(env, 'SELECT kind,count(*) AS total,sum(touched=0) AS new,sum(failures>0) AS failed FROM jobs GROUP BY kind').all()).results,
    recentErrors: (await q(env, 'SELECT url,error,failures FROM jobs WHERE error IS NOT NULL ORDER BY touched DESC LIMIT 6').all()).results,
    lastRun: JSON.parse((await q(env, "SELECT value FROM settings WHERE key='report'").first())?.value || 'null'),
    grants: (await q(env, 'SELECT id,expires,revoked FROM grants ORDER BY expires DESC LIMIT 30').all()).results,
  };
}

async function catalogue(env, forceRebuild = false) {
  if (!forceRebuild) {
    const cached = await q(env, "SELECT value FROM settings WHERE key='catalogue_json'").first();
    if (cached?.value) return cached.value;
  }
  const rawApps = [];
  let cursor = '';
  while (true) {
    const rows = (await q(env, 'SELECT id,data FROM apps WHERE id>? ORDER BY id LIMIT 250', cursor).all()).results;
    for (const row of rows) rawApps.push(row.data);
    if (rows.length < 250) break;
    cursor = rows[rows.length - 1].id;
  }
  const jsonString = `{"name":${JSON.stringify(CONFIG.name)},"identifier":${JSON.stringify(CONFIG.identifier)},"website":"https://ipaomtk.com/","apps":[${rawApps.join(',')}],"news":[]}`;
  await q(
    env,
    "INSERT INTO settings(key,value) VALUES('catalogue_json',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    jsonString
  ).run();
  return jsonString;
}

async function handle(req, env) {
  try {
    const url = new URL(req.url), path = url.pathname;
    if (req.method === 'GET' && ['/', '/admin', '/activate'].includes(path)) return page(path === '/activate');
    if (!env.DB || !env.ADMIN_SECRET || env.ADMIN_SECRET.length < 32)
      throw new Fault('أضف D1 بالاسم DB وSecret بالاسم ADMIN_SECRET بطول 32 حرفاً على الأقل', 503);

    if (path.startsWith('/admin/') && req.method === 'POST') {
      const supplied = req.headers.get('Authorization') || '';
      if (!(await verifyAdmin(supplied, env.ADMIN_SECRET))) throw new Fault('مفتاح الإدارة غير صحيح', 401);
      if (path === '/admin/init') {
        await initialize(env);
        return response({ ok: true, message: 'تمت التهيئة. اضغط جمع دفعة.' });
      }
      if (path === '/admin/status') return response(await status(env));
      if (path === '/admin/collect') return response(await collect(env));
      if (path === '/admin/source') return rawJsonResponse(await catalogue(env));

      const input = await body(req);
      if (path === '/admin/code') {
        const days = Number(input.days);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new Fault('اختر من 1 إلى 365 يوماً');
        const code = token(), expires = now() + 3600;
        await q(env, 'INSERT INTO codes(hash,expires,days) VALUES(?,?,?)', await hash(code), expires, days).run();
        return response({ code, activate: url.origin + '/activate', codeExpires: new Date(expires * 1000).toISOString() });
      }
      if (path === '/admin/revoke') {
        await q(env, 'UPDATE grants SET revoked=1 WHERE id=?', String(input.id || '')).run();
        return response({ ok: true });
      }
    }

    if (path === '/redeem' && req.method === 'POST') {
      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      const bucket = await hash(ip + ':' + Math.floor(now() / 60));
      const counter = await q(
        env,
        'INSERT INTO throttle(key,n,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET n=n+1 RETURNING n',
        bucket,
        now() + 120
      ).first();
      if (counter.n > 12) throw new Fault('انتظر دقيقة وأعد المحاولة', 429);

      const input = await body(req);
      if (typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.code)) throw new Fault('كود غير صالح', 401);
      const code = await q(env, 'DELETE FROM codes WHERE hash=? AND expires>? RETURNING days', await hash(input.code), now()).first();
      if (!code) throw new Fault('الكود مستعمل أو منتهي أو غير صحيح', 401);

      const access = token(), id = crypto.randomUUID(), expires = now() + code.days * DAY;
      await q(env, 'INSERT INTO grants(id,hash,expires) VALUES(?,?,?)', id, await hash(access), expires).run();
      return response({ sourceURL: url.origin + '/s/' + access + '/repo.json', grantId: id, expires: new Date(expires * 1000).toISOString() });
    }

    const match = path.match(/^\/s\/([A-Za-z0-9_-]{43})\/repo\.json$/);
    if (match && ['GET', 'HEAD'].includes(req.method)) {
      const grant = await q(env, 'SELECT id FROM grants WHERE hash=? AND expires>? AND revoked=0', await hash(match[1]), now()).first();
      if (!grant) throw new Fault('الرابط ملغي أو منتهي', 403);
      if (req.method === 'HEAD') return new Response(null, { status: 200, headers: JSON_HEADERS });
      return rawJsonResponse(await catalogue(env));
    }

    return response({ error: 'Not found' }, 404);
  } catch (error) {
    console.error(error.message);
    return response(
      { error: error instanceof Fault ? error.message : 'تعذر التنفيذ. تأكد من DB واضغط تهيئة، ثم راجع سجلات Worker عند استمرار الخطأ.' },
      error.status || 500
    );
  }
}

export default {
  fetch: handle,
  async scheduled(_event, env) {
    if (!env.DB) throw new Error('Bind D1 as DB');
    await collect(env);
  },
};

function cleanURL(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !HOSTS.has(url.hostname))
    throw new Error('Unsupported upstream host: ' + url.hostname);
  url.hash = '';
  return url.href;
}

function decode(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, key) => {
    if (key[0] === '#') {
      const num = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[key.toLowerCase()] || m;
  });
}

function links(html, base) {
  const result = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    try {
      result.push(cleanURL(decode(m[2]), base));
    } catch {
      /* Ignore advertisements and external links. */
    }
  }
  return [...new Set(result)];
}

function robotsAllows(text, url) {
  const groups = [];
  let group = null, hasRules = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase(), value = m[2].trim();
    if (key === 'user-agent') {
      if (!group || hasRules) {
        group = { agents: [], rules: [] };
        groups.push(group);
        hasRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow'].includes(key)) {
      group.rules.push([key, value]);
      hasRules = true;
    }
  }
  const ranked = groups.map(g => ({
    ...g,
    rank: Math.max(-1, ...g.agents.map(a => (a === '*' ? 0 : AGENT.toLowerCase().startsWith(a) ? a.length : -1))),
  }));
  const best = Math.max(-1, ...ranked.map(g => g.rank));
  let length = -1, allowed = true;
  const u = new URL(url), target = u.pathname + u.search;
  for (const g of ranked.filter(g => best >= 0 && g.rank === best)) {
    for (const [key, rule] of g.rules) {
      if (!rule) continue;
      const terminal = rule.endsWith('$');
      const expression = (terminal ? rule.slice(0, -1) : rule)
        .split('*')
        .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const size = rule.replace(/[*$]/g, '').length;
      if (new RegExp('^' + expression + (terminal ? '$' : '')).test(target) && (size > length || (size === length && key === 'allow'))) {
        length = size;
        allowed = key === 'allow';
      }
    }
  }
  return allowed;
}

class Upstream {
  constructor() {
    this.robots = new Map();
    this.last = 0;
    this.deadline = Date.now() + 75000;
    this.lastResolvedUrl = '';
  }
  async raw(url, headers = {}, redirects = 0, isRange = false) {
    url = cleanURL(url);
    if (Date.now() > this.deadline) throw new Error('Batch time budget reached');
    if (!isRange) {
      const gap = 1000 - (Date.now() - this.last);
      if (gap > 0) await new Promise(resolve => setTimeout(resolve, gap));
      this.last = Date.now();
    }
    const result = await fetch(url, {
      headers: { 'User-Agent': AGENT, 'Accept-Encoding': 'identity', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      const destination = cleanURL(result.headers.get('Location'), url);
      await result.body?.cancel();
      if (redirects >= 4) throw new Error('Too many redirects');
      if (new URL(destination).pathname !== '/robots.txt') await this.permitted(destination);
      return this.raw(destination, headers, redirects + 1, isRange);
    }
    this.lastResolvedUrl = url;
    return result;
  }
  async permitted(url) {
    const origin = new URL(url).origin;
    if (!this.robots.has(origin)) {
      const r = await this.raw(origin + '/robots.txt');
      if ([404, 410].includes(r.status)) {
        await r.body?.cancel();
        this.robots.set(origin, '');
      } else {
        if (!r.ok) {
          await r.body?.cancel();
          throw new Error('robots.txt HTTP ' + r.status);
        }
        this.robots.set(origin, DEC.decode(await bytes(r.body, 256000)));
      }
    }
    if (!robotsAllows(this.robots.get(origin), url)) throw new Error('robots.txt disallows ' + new URL(url).pathname);
  }
  async text(url, xml = false) {
    await this.permitted(url);
    const r = await this.raw(url);
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error('Upstream HTTP ' + r.status);
    }
    const type = r.headers.get('Content-Type') || '';
    if (!(xml ? /xml|text\/plain/i : /html/i).test(type)) {
      await r.body?.cancel();
      throw new Error('Unexpected page type');
    }
    return DEC.decode(await bytes(r.body, xml ? 8000000 : 4000000));
  }
  async range(url, start, end, expectedSize, skipPermit = false) {
    if (!skipPermit) await this.permitted(url);
    const r = await this.raw(url, { Range: 'bytes=' + start + '-' + end }, 0, true);
    const finalUrl = this.lastResolvedUrl || url;
    const m = (r.headers.get('Content-Range') || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (r.status !== 206 || !m || Number(m[1]) !== start || Number(m[2]) !== end || (expectedSize && Number(m[3]) !== expectedSize)) {
      await r.body?.cancel();
      throw new Error('IPA server must support exact HTTP Range (206)');
    }
    const data = await bytes(r.body, end - start + 1);
    if (data.length !== end - start + 1) throw new Error('Truncated IPA range');
    return { data, size: Number(m[3]), finalUrl };
  }
}

async function discover(client, job) {
  if (job.kind === 'map') {
    const xml = await client.text(job.url, true), index = /<sitemapindex\b/i.test(xml), items = [];
    const regex = index ? /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi : /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
    for (const match of xml.matchAll(regex)) {
      const loc = match[1].match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)?.[1];
      if (!loc) continue;
      let url;
      try {
        url = cleanURL(decode(loc.trim()), job.url);
      } catch {
        continue;
      }
      const u = new URL(url);
      if (u.hostname !== 'ipaomtk.com' || u.search) continue;
      if (!(index ? /^\/post-sitemap\d*\.xml$/ : /^\/[^/.]+\/$/).test(u.pathname)) continue;
      const revision = decode(match[1].match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i)?.[1]?.trim() || '');
      items.push({ url, kind: index ? 'map' : 'app', revision });
    }
    if (!items.length) throw new Error('No sitemap entries found; website structure may have changed');
    return items;
  }
  const html = await client.text(job.url), items = [];
  for (const url of links(html, job.url)) {
    const u = new URL(url);
    if (u.hostname !== 'iosvizor.com' || u.search) continue;
    if (/^\/ar\/(apps|games)\/[^/]+\/[^/]+\/$/.test(u.pathname) && !u.pathname.includes('/page/'))
      items.push({ url, kind: 'app', revision: '' });
    else if (/^\/ar\/(apps|games)\/(?:[^/]+\/)?(?:page\/\d+\/)?$/.test(u.pathname))
      items.push({ url, kind: 'list', revision: '' });
  }
  if (!items.length) throw new Error('No listing entries found; blocked or changed page');
  return items;
}

function plist(data) {
  if (DEC.decode(data.slice(0, 8)) !== 'bplist00') {
    const text = DEC.decode(data).replace(/<!--[\s\S]*?-->/g, ''), result = {};
    const tags = /<\/?(dict|array|key|string|integer|real|data|date|true|false)\b[^>]*>/g;
    let match, depth = 0, key = '', capture = null;
    while ((match = tags.exec(text))) {
      const tag = match[1], closing = match[0][1] === '/', selfClosing = /\/>$/.test(match[0]);
      if (tag === 'dict' || tag === 'array') {
        if (!closing) {
          if (depth === 1) key = '';
          depth++;
          if (selfClosing) depth--;
        } else depth--;
      } else if (depth === 1) {
        if (!closing && ['key', 'string', 'integer'].includes(tag)) {
          capture = { tag, start: tags.lastIndex };
          if (selfClosing) {
            if (tag === 'key') key = '';
            else if (key) {
              result[key] = '';
              key = '';
            }
            capture = null;
          }
        } else if (closing && capture?.tag === tag) {
          const value = decode(text.slice(capture.start, match.index));
          if (tag === 'key') key = value;
          else if (key) {
            result[key] = value;
            key = '';
          }
          capture = null;
        } else if (!closing && tag !== 'key') key = '';
      }
    }
    return result;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  function uint(pos, size) {
    if (size < 1 || size > 8 || pos < 0 || pos + size > data.length) throw new Error('Invalid binary plist bounds');
    let n = 0n;
    for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(view.getUint8(pos + i));
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Binary plist integer too large');
    return Number(n);
  }
  const trailer = data.length - 32, os = uint(trailer + 6, 1), rs = uint(trailer + 7, 1);
  const count = uint(trailer + 8, 8), top = uint(trailer + 16, 8), table = uint(trailer + 24, 8);
  if (count < 1 || count > 100000 || top >= count || os < 1 || os > 8 || rs < 1 || rs > 8 || table < 8 || table + count * os > trailer)
    throw new Error('Invalid binary plist trailer');
  function object(id) {
    if (id >= count) throw new Error('Invalid plist reference');
    const pos = uint(table + id * os, os);
    if (pos < 8 || pos >= table) throw new Error('Invalid plist offset');
    const marker = uint(pos, 1), type = marker >> 4;
    let length = marker & 15, start = pos + 1;
    if (length === 15 && [5, 6, 13].includes(type)) {
      const m = uint(start++, 1);
      if (m >> 4 !== 1 || (m & 15) > 3) throw new Error('Invalid plist length');
      const size = 2 ** (m & 15);
      length = uint(start, size);
      start += size;
    }
    return { type, length, start };
  }
  function scalar(id) {
    const o = object(id), size = o.type === 6 ? o.length * 2 : o.type === 1 ? 2 ** o.length : o.length;
    if (o.start + size > table) throw new Error('Invalid plist object bounds');
    if (o.type === 5) return DEC.decode(data.slice(o.start, o.start + size));
    if (o.type === 6) return new TextDecoder('utf-16be').decode(data.slice(o.start, o.start + size));
    if (o.type === 1) return String(uint(o.start, size));
    return '';
  }
  const root = object(top), result = {};
  if (root.type !== 13 || root.start + root.length * rs * 2 > table) throw new Error('Expected plist dictionary');
  const wanted = new Set(['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion', 'CFBundleDisplayName', 'CFBundleName', 'MinimumOSVersion']);
  for (let i = 0; i < root.length; i++) {
    const key = scalar(uint(root.start + i * rs, rs));
    if (wanted.has(key)) result[key] = scalar(uint(root.start + (root.length + i) * rs, rs));
  }
  return result;
}

async function ipaMetadata(client, url) {
  const first = await client.range(url, 0, 0);
  const size = first.size, targetUrl = first.finalUrl;
  if (!Number.isSafeInteger(size) || size < 22 || size > 0xffffffff) throw new Error('Unsupported IPA size / ZIP64');

  const tail = (await client.range(targetUrl, Math.max(0, size - 65557), size - 1, size, true)).data;
  const t = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let p = tail.length - 22; p >= 0; p--) {
    if (t.getUint32(p, true) === 0x06054b50 && p + 22 + t.getUint16(p + 20, true) === tail.length) {
      end = p;
      break;
    }
  }
  if (end < 0) throw new Error('ZIP directory not found');

  const cdSize = t.getUint32(end + 12, true), cdStart = t.getUint32(end + 16, true);
  if (t.getUint16(end + 4, true) !== 0 || t.getUint16(end + 6, true) !== 0 || cdSize > 2000000 || cdStart === 0xffffffff || cdStart + cdSize > size)
    throw new Error('Unsupported ZIP directory / ZIP64');

  const cd = (await client.range(targetUrl, cdStart, cdStart + cdSize - 1, size, true)).data;
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  let entry;
  for (let p = 0; p < cd.length; ) {
    if (p + 46 > cd.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const nl = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    const next = p + 46 + nl + extra + comment;
    if (next > cd.length) throw new Error('Invalid ZIP entry length');
    const name = DEC.decode(cd.slice(p + 46, p + 46 + nl));
    if (/^Payload\/[^/]+\.app\/Info\.plist$/.test(name)) {
      if (entry) throw new Error('Multiple main apps in IPA');
      entry = {
        flags: v.getUint16(p + 8, true),
        method: v.getUint16(p + 10, true),
        compressed: v.getUint32(p + 20, true),
        uncompressed: v.getUint32(p + 24, true),
        offset: v.getUint32(p + 42, true),
        nl,
      };
    }
    p = next;
  }
  if (!entry || entry.flags & 1 || entry.compressed > 2000000 || entry.uncompressed > 2000000 || !entry.compressed)
    throw new Error('Missing, encrypted or oversized Info.plist');

  const chunkEnd = Math.min(size - 1, entry.offset + 30 + entry.nl + 256 + entry.compressed);
  const chunk = (await client.range(targetUrl, entry.offset, chunkEnd, size, true)).data;
  const h = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (h.getUint32(0, true) !== 0x04034b50) throw new Error('Invalid local ZIP header');

  const localDataOffset = 30 + h.getUint16(26, true) + h.getUint16(28, true);
  let data;
  if (localDataOffset + entry.compressed <= chunk.length) {
    data = chunk.slice(localDataOffset, localDataOffset + entry.compressed);
  } else {
    const start = entry.offset + localDataOffset;
    if (start + entry.compressed > size) throw new Error('Invalid plist data bounds');
    data = (await client.range(targetUrl, start, start + entry.compressed - 1, size, true)).data;
  }

  if (entry.method === 8) data = await bytes(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')), 2000000);
  else if (entry.method !== 0) throw new Error('Unsupported ZIP compression');
  if (data.length !== entry.uncompressed) throw new Error('Wrong plist length');

  const meta = plist(data), version = meta.CFBundleShortVersionString || meta.CFBundleVersion;
  if (!meta.CFBundleIdentifier || !version) throw new Error('IPA has no real bundle ID or version');
  return { meta, version, size };
}

function pageInfo(html, base) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const a of m[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[a[1].toLowerCase()] = decode(a[3]);
    meta[attrs.property || attrs.name] = attrs.content;
  }
  const heading = decode((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, '')).trim();
  const fallbackImg = html.match(/<img\b[^>]*\b(?:data-)?src\s*=\s*(["'])(https?:\/\/[^"']+\.(?:png|jpe?g|webp)[^"']*)\1/i)?.[2];
  const icon = meta['og:image'] || meta['twitter:image'] || fallbackImg;
  if (!heading || !icon) throw new Error('App title or icon missing');
  const iconURL = new URL(icon, base);
  if (iconURL.protocol !== 'https:') throw new Error('Invalid icon URL');
  return { heading, icon: iconURL.href };
}

function versionRank(a, b) {
  const x = a.match(/\d+/g) || [], y = b.match(/\d+/g) || [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = Number(x[i] || 0) - Number(y[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function collectApp(env, client, url) {
  const html = await client.text(url), info = pageInfo(html, url);
  const all = links(html, url);
  const isIPA = link => new URL(link).pathname.toLowerCase().endsWith('.ipa');
  let download = all.find(isIPA);
  if (!download) {
    const intermediate = all.find(link => new URL(link).hostname === new URL(url).hostname && new URL(link).pathname.includes('/download/'));
    if (!intermediate) throw new Error('Public download page missing');
    download = links(await client.text(intermediate), intermediate).find(isIPA);
  }
  if (!download) throw new Error('Public IPA link missing');
  const { meta, version, size } = await ipaMetadata(client, download), id = meta.CFBundleIdentifier;
  const previousRow = await q(env, 'SELECT data FROM apps WHERE id=?', id).first();
  const previous = previousRow ? JSON.parse(previousRow.data) : null;
  if (previous && versionRank(version, previous.version) < 0) return { id, version, skippedOlder: true };
  const same = previous?.version === version && previous.downloadURL === download && previous.size === size;
  const date = same ? previous.versionDate : new Date().toISOString();
  const build = { version, date, downloadURL: download, size };
  if (meta.MinimumOSVersion) build.minOSVersion = meta.MinimumOSVersion;
  const app = {
    name: meta.CFBundleDisplayName || meta.CFBundleName || info.heading,
    bundleIdentifier: id,
    developerName: 'المطوّر الأصلي — راجع صفحة المصدر',
    iconURL: info.icon,
    localizedDescription: 'صفحة المصدر: ' + url,
    versions: [build],
    version,
    versionDate: date,
    downloadURL: download,
    size,
  };
  await q(
    env,
    'INSERT INTO apps(id,data,updated) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated',
    id,
    JSON.stringify(app),
    now()
  ).run();
  return { id, version };
}

async function collect(env) {
  const lock = String(now() + 180), t = now();
  const acquired = await q(env, "UPDATE settings SET value=? WHERE key='lock' AND CAST(value AS INTEGER)<=? RETURNING value", lock, t).first();
  if (!acquired) return { busy: true, message: 'دفعة أخرى تعمل الآن؛ انتظر ثم حدّث الحالة.' };
  const client = new Upstream(), report = { started: new Date().toISOString(), discovered: 0, added: [], errors: [] };
  async function process(job) {
    try {
      if (job.kind === 'app') report.added.push(await collectApp(env, client, job.url));
      else {
        const jobs = await discover(client, job);
        await enqueue(env, jobs);
        report.discovered += jobs.length;
      }
      await q(env, 'UPDATE jobs SET due=?,touched=?,failures=0,error=NULL WHERE url=?', now() + DAY, now(), job.url).run();
    } catch (e) {
      const message = String(e.message).slice(0, 350);
      report.errors.push({ url: job.url, error: message });
      await q(
        env,
        'UPDATE jobs SET due=?,touched=?,failures=failures+1,error=? WHERE url=?',
        now() + Math.min(DAY, 3600 * 2 ** Math.min(job.failures, 4)),
        now(),
        message,
        job.url
      ).run();
    }
  }
  try {
    for (let i = 0; i < 2 && Date.now() < client.deadline - 15000; i++) {
      const job = await q(env, "SELECT * FROM jobs WHERE kind<>'app' AND due<=? ORDER BY (kind='map') DESC,due,touched,url LIMIT 1", now()).first();
      if (!job) break;
      await process(job);
    }
    for (let i = 0; i < CONFIG.appsPerRun && Date.now() < client.deadline - 15000; i++) {
      const job = await q(env, "SELECT * FROM jobs WHERE kind='app' AND due<=? ORDER BY due,(touched>0) DESC,touched,url LIMIT 1", now()).first();
      if (!job) break;
      await process(job);
    }
    if (report.added.some(item => !item.skippedOlder)) {
      await catalogue(env, true);
    }
    report.finished = new Date().toISOString();
    await q(env, "INSERT INTO settings(key,value) VALUES('report',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(report)).run();
    await env.DB.batch([
      q(env, 'DELETE FROM throttle WHERE expires<?', now()),
      q(env, 'DELETE FROM codes WHERE expires<?', now()),
    ]);
    return report;
  } finally {
    await q(env, "UPDATE settings SET value='0' WHERE key='lock' AND value=?", lock).run();
  }
}

function page(activate) {
  const nonce = token();
  const html = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>إدارة سورس التطبيقات</title>
  <style nonce="${nonce}">*{box-sizing:border-box}body{font:17px system-ui;background:#10131b;color:white;padding:24px 14px}main{max-width:650px;margin:auto}h1{font-size:27px}p{line-height:1.8;color:#c6d0e5}input,button{font:inherit;padding:13px;width:100%;margin:7px 0;border-radius:10px;border:1px solid #4a5876}input{background:#1a2131;color:white}button{background:#8ab4ff;color:#10213b;font-weight:bold;cursor:pointer}button:disabled{opacity:0.5;cursor:not-allowed}pre{padding:16px;background:#1a2131;white-space:pre-wrap;overflow-wrap:anywhere;direction:ltr;text-align:left;border-radius:12px}label{display:block;margin-top:18px}</style>
  <main><h1>${activate ? 'تفعيل السورس' : 'إدارة سورس التطبيقات'}</h1>
  ${
    activate
      ? '<p>أدخل كود الموافقة للحصول على رابط خاص. الكود يستعمل مرة واحدة.</p><label>كود الموافقة</label><input id="code" dir="ltr" autocomplete="off"><button data-action="redeem">تفعيل الكود</button>'
      : '<p>ابدأ بالتهيئة مرة واحدة، ثم اجمع دفعة وحدّث الحالة. لا تشارك مفتاح الإدارة.</p><label>مفتاح الإدارة</label><input id="secret" type="password" autocomplete="off"><button data-action="init">تهيئة الجداول</button><button data-action="collect">جمع دفعة</button><button data-action="status">تحديث الحالة</button><label>صلاحية رابط السورس بالأيام (1–365)</label><input id="days" type="number" value="30" min="1" max="365"><button data-action="code">إصدار كود موافقة</button><label>معرّف الرابط Grant ID لإلغائه</label><input id="grant" dir="ltr"><button data-action="revoke">إلغاء الرابط</button>'
  }
  <p>الرابط الخاص قابل للنسخ والمشاركة حتى إلغائه أو انتهاء صلاحيته. استخدامه في عميل خارجي يتطلب دعم صيغة السورس.</p><pre id="out" aria-live="polite">جاهز</pre></main>
  <script nonce="${nonce}">
  const out = document.getElementById('out');
  const secretInput = document.getElementById('secret');
  if (secretInput) {
    secretInput.value = sessionStorage.getItem('admin_sec') || '';
    secretInput.oninput = () => sessionStorage.setItem('admin_sec', secretInput.value);
  }
  document.querySelectorAll('button').forEach(button => button.onclick = async () => {
    document.querySelectorAll('button').forEach(b => b.disabled = true);
    out.textContent = 'جاري التنفيذ... أبقِ الصفحة مفتوحة أثناء الجمع.';
    try {
      const action = button.dataset.action, headers = { 'Content-Type': 'application/json' };
      if (secretInput) headers.Authorization = 'Bearer ' + secretInput.value;
      const data = action === 'code' ? { days: Number(document.getElementById('days').value) }
        : action === 'revoke' ? { id: document.getElementById('grant').value.trim() }
        : action === 'redeem' ? { code: document.getElementById('code').value.trim() } : {};
      const r = await fetch(action === 'redeem' ? '/redeem' : '/admin/' + action, {
        method: 'POST', headers, body: JSON.stringify(data), cache: 'no-store'
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || 'فشل الطلب');
      const copyTarget = result.sourceURL || result.code;
      if (copyTarget && navigator.clipboard) {
        await navigator.clipboard.writeText(copyTarget).catch(() => {});
      }
      out.textContent = (copyTarget ? '✅ تم النسخ للحافظة تلقائياً:\\n' + copyTarget + '\\n\\n' : '') + JSON.stringify(result, null, 2);
      if (action === 'redeem') document.getElementById('code').value = '';
    } catch (e) {
      out.textContent = e.message;
    } finally {
      document.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  });
  </script></html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  });
}
