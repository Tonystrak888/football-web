#!/usr/bin/env node
'use strict';
/*
 * Football Hub backend (ไม่ต้องลง npm package อะไรเพิ่ม — ใช้ Node 18+ อย่างเดียว)
 *  - worker ดึงข้อมูลสดจาก API-Football ตลอด 24/7
 *  - ตรวจจับเหตุการณ์ใหม่ (ประตู/ใบแดง/เริ่ม/พักครึ่ง/จบ) แล้วส่ง Telegram / webhook
 *  - เปิด API ให้หน้าเว็บ: /api/feed  /api/leagues  /api/match/:id  /api/health
 *  - เสิร์ฟ index.html ให้ด้วย (same-origin ไม่ต้องตั้ง CORS)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- config
(function loadDotEnv() {
  try {
    const f = path.join(__dirname, '.env');
    if (!fs.existsSync(f)) return;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* ignore */ }
})();
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

const CFG = {
  port: +env('PORT', 3000),
  host: env('HOST', '0.0.0.0'),
  key: env('API_FOOTBALL_KEY', ''),
  mock: env('MOCK', '') === '1',
  liveSec: Math.max(10, +env('LIVE_POLL_SEC', 30)),       // ถี่แค่ไหนตอนมีแมตช์เตะอยู่
  idleSec: Math.max(60, +env('IDLE_POLL_SEC', 300)),      // ตอนไม่มีอะไรเตะ
  fixturesMin: Math.max(2, +env('FIXTURES_REFRESH_MIN', 10)),
  leaguesMin: Math.max(10, +env('LEAGUES_REFRESH_MIN', 60)),
  tzOffsetHours: +env('TZ_OFFSET_HOURS', 7),               // เวลาไทย
  dayStartHour: +env('DAY_START_HOUR', 6),                 // "วันฟุตบอล" เริ่มตี 6 ไปถึงตี 6 วันถัดไป
  tgToken: env('TELEGRAM_BOT_TOKEN', ''),
  tgChats: list(env('TELEGRAM_CHAT_ID', '')),
  webhook: env('WEBHOOK_URL', ''),
  notifyMode: env('NOTIFY_MODE', 'leagues'),               // leagues | teams | all
  notifyTeams: list(env('NOTIFY_TEAMS', '')).map((s) => s.toLowerCase()),
  notifyEvents: new Set(list(env('NOTIFY_EVENTS', 'goal,red,pen,var,start,halftime,ft'))),
  adminToken: env('ADMIN_TOKEN', ''),
  trustProxy: env('TRUST_PROXY', '') === '1',
  dataDir: env('DATA_DIR', path.join(__dirname, 'data')),
  detailMaxPerMin: +env('DETAIL_MAX_PER_MIN', 20),
  rateLimitPerMin: +env('RATE_LIMIT_PER_MIN', 240),
  predictions: env('PREDICTIONS', '1') !== '0',           // ดึง % โอกาสชนะของนัดถัดไป (ประหยัดโควตา: ดึงครั้งเดียวต่อนัด)
};

if (!CFG.mock && !CFG.key) {
  console.error('\n[!] ยังไม่ได้ตั้ง API_FOOTBALL_KEY (ดู .env.example)\n    อยากลองระบบก่อนด้วยข้อมูลจำลองให้รัน:  MOCK=1 node server.js\n');
  process.exit(1);
}
fs.mkdirSync(CFG.dataDir, { recursive: true });

// ลีกที่ติดตามเป็นพิเศษ (id ตรงกับ L[] ในหน้าเว็บ) — ดึงตารางคะแนน/ผลล่าสุด/โปรแกรมถัดไป
const LEAGUES = [
  { id: 'epl', api: 39 }, { id: 'liga', api: 140 }, { id: 'seriea', api: 135 },
  { id: 'bundes', api: 78 }, { id: 'ligue1', api: 61 }, { id: 'ucl', api: 2 },
  { id: 'thai', api: 296 }, { id: 'jl', api: 98 }, { id: 'mls', api: 253 },
];
const leagueByApi = new Map(LEAGUES.map((l) => [l.api, l]));

// ชื่อทีมจาก API -> ชื่อสั้นที่หน้าเว็บใช้อยู่ (ทีมโปรดที่บันทึกไว้จะได้ไม่หลุด) เพิ่มเองได้ใน aliases.json
const ALIASES = Object.assign({
  'Manchester City': 'Man City', 'Manchester United': 'Man United', 'Nottingham Forest': 'Nottm Forest',
  'Tottenham Hotspur': 'Tottenham', 'Newcastle United': 'Newcastle', 'Brighton & Hove Albion': 'Brighton',
  'Wolverhampton Wanderers': 'Wolves', 'Leeds United': 'Leeds', 'West Ham United': 'West Ham',
  'Ipswich Town': 'Ipswich', 'Hull City': 'Hull', 'Coventry City': 'Coventry', 'Sunderland AFC': 'Sunderland',
  'Atletico Madrid': 'Atletico Madrid', 'Athletic Club': 'Athletic Bilbao', 'Celta Vigo': 'Celta Vigo',
  'Paris Saint Germain': 'PSG', 'Paris Saint-Germain': 'PSG', 'Olympique Marseille': 'Marseille',
  'Olympique Lyonnais': 'Lyon', 'AS Monaco': 'Monaco', 'Stade Brestois 29': 'Brest', 'Stade Rennais': 'Rennes',
  'Bayern München': 'Bayern', 'Bayern Munich': 'Bayern', 'Borussia Dortmund': 'Dortmund',
  'Bayer Leverkusen': 'Leverkusen', 'Eintracht Frankfurt': 'Frankfurt', 'Borussia Mönchengladbach': 'Gladbach',
  'Borussia Monchengladbach': 'Gladbach', 'FSV Mainz 05': 'Mainz', '1. FC Köln': 'Cologne', 'FC Koln': 'Cologne',
  'FC Augsburg': 'Augsburg', 'SC Freiburg': 'Freiburg', 'VfB Stuttgart': 'Stuttgart', 'Hamburger SV': 'Hamburg',
  'TSG Hoffenheim': 'Hoffenheim', '1. FC Union Berlin': 'Union Berlin', 'FC St. Pauli': 'St. Pauli',
  'AS Roma': 'Roma', 'AC Milan': 'AC Milan', 'Inter': 'Inter', 'SSC Napoli': 'Napoli',
  'Buriram United': 'Buriram', 'BG Pathum United': 'BG Pathum', 'Chiangrai United': 'Chiangrai',
  'Bangkok United': 'Bangkok United', 'Port FC': 'Port', 'Prachuap FC': 'Prachuap',
  'Urawa Red Diamonds': 'Urawa Reds', 'Nashville SC': 'Nashville', 'Los Angeles FC': 'LAFC',
  'Los Angeles Galaxy': 'LA Galaxy', 'Vancouver Whitecaps': 'Vancouver', 'St. Louis City': 'St. Louis',
  'New England Revolution': 'New England', 'Chicago Fire': 'Chicago', 'San Jose Earthquakes': 'San Jose',
  'Houston Dynamo': 'Houston', 'Philadelphia Union': 'Philadelphia', 'Seattle Sounders': 'Seattle',
  'Colorado Rapids': 'Colorado',
}, (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'aliases.json'), 'utf8')); } catch (e) { return {}; }
})());
const team = (n) => (n ? (ALIASES[n] || n) : '?');

// ---------------------------------------------------------------- utils
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flagEmoji(url, country) {
  if (!url) return country === 'World' ? '🌍' : '🏳️';
  const m = String(url).match(/\/([a-z]{2}(?:-[a-z]{2,3})?)\.(?:svg|png)/i);
  if (!m) return '🌍';
  const c = m[1].toLowerCase();
  if (c.includes('-')) return '🏴';
  return String.fromCodePoint(...c.toUpperCase().split('').map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

// "วันฟุตบอล" ของเวลาไทย: [เริ่ม 06:00 วันนี้, +24 ชม.)
function footballDay(now = Date.now()) {
  const off = CFG.tzOffsetHours * 3600e3;
  const local = new Date(now + off);
  let startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), CFG.dayStartHour);
  if (local.getTime() < startLocal) startLocal -= 86400e3;
  const from = startLocal - off;
  return { from, to: from + 86400e3 };
}
const ymd = (ms) => new Date(ms + CFG.tzOffsetHours * 3600e3).toISOString().slice(0, 10);

// ---------------------------------------------------------------- API-Football client
const API_BASE = 'https://v3.football.api-sports.io';
const quota = { remaining: null, limit: null, calls: 0, errors: 0, lastError: null };

async function api(endpoint, params = {}) {
  if (CFG.mock) return mock.handle(endpoint, params);
  const url = new URL(API_BASE + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'x-apisports-key': CFG.key }, signal: ctl.signal });
    quota.calls++;
    const rem = r.headers.get('x-ratelimit-requests-remaining');
    const lim = r.headers.get('x-ratelimit-requests-limit');
    if (rem != null) quota.remaining = +rem;
    if (lim != null) quota.limit = +lim;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const e = j.errors;
    if (e && (Array.isArray(e) ? e.length : Object.keys(e).length)) throw new Error('API: ' + JSON.stringify(e));
    return j.response || [];
  } catch (err) {
    quota.errors++;
    quota.lastError = String(err.message || err);
    throw err;
  } finally {
    clearTimeout(to);
  }
}
const quotaLow = () => quota.remaining != null && quota.remaining < 40;

// ---------------------------------------------------------------- normalise
const STATUS = {
  TBD: 'UP', NS: 'UP', '1H': 'LIVE', HT: 'LIVE', '2H': 'LIVE', ET: 'LIVE', BT: 'LIVE', P: 'LIVE', LIVE: 'LIVE',
  INT: 'LIVE', SUSP: 'LIVE', FT: 'FT', AET: 'FT', PEN: 'FT', AWD: 'FT', WO: 'FT', PST: 'PPD', CANC: 'CANC', ABD: 'ABD',
};

function normFixture(f) {
  const fx = f.fixture || {}, lg = f.league || {}, tm = f.teams || {}, gl = f.goals || {};
  const stt = fx.status || {};
  const phase = stt.short || 'NS';
  const tracked = leagueByApi.get(lg.id);
  return {
    id: fx.id,
    apiLeague: lg.id,
    lid: tracked ? tracked.id : null,
    league: lg.name || '',
    country: lg.country || '',
    flag: flagEmoji(lg.flag, lg.country),
    round: lg.round || null,
    home: team(tm.home && tm.home.name),
    away: team(tm.away && tm.away.name),
    homeId: tm.home && tm.home.id,
    k: (fx.timestamp || 0) * 1000,
    status: STATUS[phase] || 'UP',
    phase,
    min: stt.elapsed != null ? stt.elapsed : null,
    extra: stt.extra != null ? stt.extra : null,
    x: gl.home != null ? gl.home : null,
    y: gl.away != null ? gl.away : null,
  };
}

// แปลง events ของ API เป็นรูปแบบที่หน้าเว็บใช้ (g og pg pm y r yr s v) + คำนวณสกอร์ ณ ตอนทำประตู
function normEvents(list, homeId, finalX, finalY) {
  const evs = [];
  for (const e of list || []) {
    const side = e.team && e.team.id === homeId ? 'h' : 'a';
    const ty = String(e.type || '').toLowerCase();
    const d = String(e.detail || '').toLowerCase();
    const o = { min: (e.time && e.time.elapsed) || 0, a: (e.time && e.time.extra) || null, side, detail: e.detail || '' };
    let t = null;
    const player = (e.player && e.player.name) || null;
    const assist = (e.assist && e.assist.name) || null;
    if (ty === 'goal') {
      t = d.includes('missed') ? 'pm' : d.includes('own') ? 'og' : d.includes('penalty') ? 'pg' : 'g';
      o.p = player; if (t !== 'pm') o.as = assist;
    } else if (ty === 'card') {
      t = d.includes('second') || d.includes('yellow red') ? 'yr' : d.includes('red') ? 'r' : 'y';
      o.p = player; if (e.comments) o.n = e.comments;
    } else if (ty === 'subst') {
      t = 's'; o.o = player; o.i = assist;   // player = ออก, assist = เข้า
    } else if (ty === 'var') {
      t = 'v'; o.n = e.detail || ''; o.p = player;
    }
    if (!t) continue;
    o.type = t;
    evs.push(o);
  }
  evs.sort((a, b) => (a.min + (a.a || 0) / 100) - (b.min + (b.a || 0) / 100));
  // ใส่สกอร์ ณ เวลานั้นให้ประตู — ลองทั้งสองแบบของ own goal แล้วเลือกแบบที่ตรงกับสกอร์จริง
  const run = (ogToBenefit) => {
    let h = 0, a = 0; const sc = [];
    evs.forEach((e) => {
      if (e.type === 'g' || e.type === 'pg') { e.side === 'h' ? h++ : a++; sc.push([e, h, a]); }
      else if (e.type === 'og') {
        const toHome = ogToBenefit ? e.side === 'h' : e.side === 'a';
        toHome ? h++ : a++; sc.push([e, h, a]);
      }
    });
    return { h, a, sc };
  };
  const A = run(true), B = run(false);
  let pick = A;
  if (finalX != null && finalY != null) {
    if (A.h === finalX && A.a === finalY) pick = A;
    else if (B.h === finalX && B.a === finalY) pick = B;
    else pick = null;    // นับไม่ลงตัว (เช่น VAR ตัดประตู) -> ไม่แสดงสกอร์ในไทม์ไลน์ ดีกว่าแสดงผิด
  }
  if (pick) pick.sc.forEach(([e, h, a]) => { e.sx = h; e.sy = a; });
  return evs;
}

function mapStats(arr, homeId) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const val = (stats, name) => {
    const s = (stats || []).find((x) => x.type === name);
    if (!s || s.value == null) return 0;
    const n = parseInt(String(s.value).replace('%', ''), 10);
    return Number.isFinite(n) ? n : 0;
  };
  const row = (stats) => [
    val(stats, 'Ball Possession'), val(stats, 'Total Shots'), val(stats, 'Shots on Goal'), val(stats, 'Corner Kicks'),
    val(stats, 'Fouls'), val(stats, 'Offsides'), val(stats, 'Yellow Cards'), val(stats, 'Red Cards'), null,
  ];
  const h = arr.find((x) => x.team && x.team.id === homeId) || arr[0];
  const a = arr.find((x) => x !== h);
  if (!h || !a) return null;
  return { h: row(h.statistics), a: row(a.statistics) };
}

function mapLineups(arr, homeId) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const conv = (t) => {
    const p = (x, sub) => [((x.player && x.player.name) || '?') + (sub ? ' (สำรอง)' : ''), String((x.player && x.player.pos) || '').slice(0, 1).toUpperCase()];
    return (t.startXI || []).map((x) => p(x, false)).concat((t.substitutes || []).map((x) => p(x, true)));
  };
  const h = arr.find((x) => x.team && x.team.id === homeId) || arr[0];
  const a = arr.find((x) => x !== h);
  if (!h || !a) return null;
  return { h: conv(h), a: conv(a) };
}

// ---------------------------------------------------------------- state
const STATE_FILE = path.join(CFG.dataDir, 'state.json');
const S = {
  all: new Map(),            // id -> normalised match (+events)
  leagues: {},               // lid -> {season, standings[], matches[]}
  seasons: new Map(),        // api league id -> season year
  seen: new Map(),           // event key -> ts   (กันแจ้งซ้ำ)
  updated: { live: 0, fixtures: 0, leagues: 0 },
  dirty: false,
  window: footballDay(),
};
try {
  const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  for (const [k, v] of Object.entries(j.seen || {})) S.seen.set(k, v);
  log('โหลด state เดิม', S.seen.size, 'events');
} catch (e) { /* first run */ }

function saveState() {
  if (!S.dirty) return;
  const cutoff = Date.now() - 3 * 86400e3;
  for (const [k, t] of S.seen) if (t < cutoff) S.seen.delete(k);
  try {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify({ seen: Object.fromEntries(S.seen) }));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    S.dirty = false;
  } catch (e) { log('save state ไม่สำเร็จ:', e.message); }
}
setInterval(saveState, 30000).unref();

// ---------------------------------------------------------------- notifications
const queue = [];
let sending = false;

function notify(text) {
  if (!CFG.tgToken && !CFG.webhook) { log('[notify:ไม่ได้ตั้งช่องทาง]', text.replace(/\n/g, ' | ')); return; }
  queue.push(text);
  if (!sending) drain();
}
async function drain() {
  sending = true;
  while (queue.length) {
    const text = queue.shift();
    try {
      if (CFG.tgToken) {
        for (const chat of CFG.tgChats) {
          const r = await fetch(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
          });
          if (r.status === 429) {
            const j = await r.json().catch(() => ({}));
            const wait = ((j.parameters && j.parameters.retry_after) || 5) * 1000;
            queue.unshift(text); await sleep(wait); break;
          }
          if (!r.ok) log('telegram error', r.status, await r.text().catch(() => ''));
          await sleep(1100);
        }
      }
      if (CFG.webhook) {
        await fetch(CFG.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) })
          .catch((e) => log('webhook error', e.message));
      }
    } catch (e) { log('notify error', e.message); await sleep(3000); }
  }
  sending = false;
}

function inScope(m) {
  if (CFG.notifyMode === 'all') return true;
  const byTeam = CFG.notifyTeams.length && CFG.notifyTeams.some((t) => (m.home + ' ' + m.away).toLowerCase().includes(t));
  if (CFG.notifyMode === 'teams') return !!byTeam;
  return !!m.lid || !!byTeam;
}
const on = (cat) => CFG.notifyEvents.has(cat);
const head = (m) => `${m.flag} ${m.league}`;
const sc = (m, x, y) => `${m.home} ${x != null ? x : (m.x != null ? m.x : 0)} - ${y != null ? y : (m.y != null ? m.y : 0)} ${m.away}`;
const mn = (e) => (e.a ? `${e.min}+${e.a}'` : `${e.min}'`);
const teamOf = (m, e) => (e.side === 'h' ? m.home : m.away);

function notifyEvent(m, e) {
  if (!inScope(m)) return;
  if ((e.type === 'g' || e.type === 'pg' || e.type === 'og') && on('goal')) {
    const lab = e.type === 'og' ? '⚽ ทำเข้าประตูตัวเอง' : e.type === 'pg' ? '⚽ ประตู (จุดโทษ)' : '⚽ ประตู!';
    notify(`${lab}\n${sc(m, e.sx, e.sy)}\n${mn(e)} ${e.p || ''} (${teamOf(m, e)})${e.as ? ' · แอสซิสต์ ' + e.as : ''}\n${head(m)}`);
  } else if ((e.type === 'r' || e.type === 'yr') && on('red')) {
    notify(`🟥 ${e.type === 'yr' ? 'ใบเหลืองใบที่ 2 (ไล่ออก)' : 'ใบแดง'}\n${sc(m)}\n${mn(e)} ${e.p || ''} (${teamOf(m, e)})\n${head(m)}`);
  } else if (e.type === 'pm' && on('pen')) {
    notify(`❌ พลาดจุดโทษ\n${sc(m)}\n${mn(e)} ${e.p || ''} (${teamOf(m, e)})\n${head(m)}`);
  } else if (e.type === 'v' && on('var') && /cancel|disallow|no goal|overturn/i.test(e.detail)) {
    notify(`📺 VAR: ${e.detail}\n${sc(m)}\n${mn(e)} ${e.p || ''} (${teamOf(m, e)})\n${head(m)}`);
  }
}

// ---------------------------------------------------------------- ingest
function evKey(id, e) { return `${id}|${e.type}|${e.side}|${e.min}|${e.a || 0}|${e.p || e.o || ''}|${e.detail}`; }

function ingest(m) {
  const prev = S.all.get(m.id);
  const known = !!(prev && prev.eventsKnown);
  // เปลี่ยนสถานะ
  if (prev && inScope(m)) {
    if (prev.status === 'UP' && m.status === 'LIVE' && m.phase === '1H' && on('start')) {
      notify(`▶️ เริ่มเตะ\n${m.home} vs ${m.away}\n${head(m)}`);
    } else if (prev.phase !== 'HT' && m.phase === 'HT' && on('halftime')) {
      notify(`⏸ พักครึ่ง\n${sc(m)}\n${head(m)}`);
    } else if (prev.status === 'LIVE' && m.status === 'FT' && on('ft')) {
      notify(`🏁 จบเกม\n${sc(m)}\n${head(m)}`);
    }
  }
  // เหตุการณ์ใหม่ (ถ้าเพิ่งเห็นแมตช์ครั้งแรกขณะเตะไปแล้ว -> ถือว่าเป็นของเก่า ไม่แจ้งรัว)
  let eventsKnown = prev ? prev.eventsKnown : false;
  if (m.events) {
    const fresh = known || (m.min != null && m.min <= 3);
    for (const e of m.events) {
      const key = evKey(m.id, e);
      if (!S.seen.has(key)) {
        S.seen.set(key, Date.now()); S.dirty = true;
        if (fresh) notifyEvent(m, e);
      }
    }
    eventsKnown = true;
  }
  const merged = Object.assign({}, prev || {}, m);
  if (!m.events) merged.events = (prev && prev.events) || [];
  merged.eventsKnown = eventsKnown;
  S.all.set(m.id, merged);
  return merged;
}

function ingestRaw(f) {
  const m = normFixture(f);
  if (Array.isArray(f.events)) m.events = normEvents(f.events, m.homeId, m.x, m.y);
  return ingest(m);
}

// ---------------------------------------------------------------- pollers
async function pollLive() {
  const raw = await api('/fixtures', { live: 'all' });
  const liveIds = new Set();
  for (const f of raw) { const m = ingestRaw(f); liveIds.add(m.id); }
  S.updated.live = Date.now();
  // แมตช์ที่เคย LIVE แต่หายจาก live=all = น่าจะจบแล้ว -> ถามสถานะล่าสุดทันที (ไม่รอรอบรีเฟรชโปรแกรม)
  const gone = [];
  for (const m of S.all.values()) {
    if (m.status === 'LIVE' && !liveIds.has(m.id) && Date.now() - (m.resolvedAt || 0) > 60000) { m.resolvedAt = Date.now(); gone.push(m.id); }
  }
  for (let i = 0; i < gone.length; i += 20) {
    const part = gone.slice(i, i + 20);
    try {
      const r2 = await api('/fixtures', { ids: part.join('-') });
      for (const f of r2) ingestRaw(f);
    } catch (e) { log('resolve error', e.message); }
  }
  return raw.length;
}

async function loopLive() {
  for (;;) {
    let delay = CFG.idleSec * 1000;
    try {
      const n = await pollLive();
      const now = Date.now();
      const busy = [...S.all.values()].some((m) => m.status === 'LIVE' || (m.status === 'UP' && m.k - now < 120000 && m.k - now > -3 * 3600e3));
      delay = busy ? CFG.liveSec * 1000 : CFG.idleSec * 1000;
      if (quotaLow()) delay = Math.max(delay, 120000);
      if (n) log(`live: ${n} แมตช์ · โควตาเหลือ ${quota.remaining ?? '?'}`);
    } catch (e) {
      log('live poll error:', e.message);
      delay = Math.min(120000, CFG.liveSec * 2000);
    }
    await sleep(delay);
  }
}

async function refreshFixtures() {
  S.window = footballDay();
  const dates = [...new Set([ymd(S.window.from), ymd(S.window.to - 1)])];
  let n = 0;
  for (const d of dates) {
    const raw = await api('/fixtures', { date: d, timezone: 'Asia/Bangkok' });
    for (const f of raw) {
      const m = normFixture(f);
      const prev = S.all.get(m.id);
      // อย่าให้ข้อมูลโปรแกรม (ที่อาจเก่ากว่า live) ไปทับสถานะที่ live poll เพิ่งอัปเดต
      if (prev && prev.status === 'LIVE' && Date.now() - S.updated.live < 120000) continue;
      ingest(m); n++;
    }
  }
  S.updated.fixtures = Date.now();
  log(`โปรแกรม ${dates.join(', ')}: ${n} นัด`);
}
async function loopFixtures() {
  for (;;) {
    await sleep(CFG.fixturesMin * 60000);     // รอบแรกทำตอน boot ไปแล้ว
    try { if (!quotaLow()) await refreshFixtures(); } catch (e) { log('fixtures error:', e.message); }
  }
}

async function seasonOf(apiId) {
  const cached = S.seasons.get(apiId);
  if (cached && Date.now() - cached.t < 86400e3) return cached.y;
  const r = await api('/leagues', { id: apiId, current: 'true' });
  const seasons = (r[0] && r[0].seasons) || [];
  const cur = seasons.find((s) => s.current) || seasons[seasons.length - 1];
  if (!cur) throw new Error('หา season ปัจจุบันของลีก ' + apiId + ' ไม่เจอ');
  S.seasons.set(apiId, { y: cur.year, t: Date.now() });
  return cur.year;
}

const PRED = new Map();        // fixture id -> {t, p:[home,draw,away]}
async function ensurePred(id) {
  if (!CFG.predictions) return;
  const c = PRED.get(id);
  if (c && Date.now() - c.t < 12 * 3600e3) return;
  try {
    const r = await api('/predictions', { fixture: id });
    const pc = r[0] && r[0].predictions && r[0].predictions.percent;
    const p = pc ? [pc.home, pc.draw, pc.away].map((v) => parseFloat(String(v))) : null;
    PRED.set(id, { t: Date.now(), p: p && p.every(Number.isFinite) ? p : null });
  } catch (e) {
    PRED.set(id, { t: Date.now() - 11 * 3600e3, p: null });   // ลองใหม่อีกครั้งในอีก ~1 ชม.
  }
  const s = S.all.get(id), v = PRED.get(id);
  if (s && v && v.p) s.p = v.p;
}

async function refreshLeague(lg) {
  const season = await seasonOf(lg.api);
  const [stRaw, fxRaw] = await Promise.all([
    api('/standings', { league: lg.api, season }),
    api('/fixtures', { league: lg.api, season }),
  ]);
  // ตารางคะแนน (รวมทุกกลุ่ม/คอนเฟอเรนซ์ แล้วเรียงตามแต้ม)
  const groups = (stRaw[0] && stRaw[0].league && stRaw[0].league.standings) || [];
  const rows = [];
  const seen = new Set();
  for (const g of groups) for (const r of g) {
    const name = team(r.team && r.team.name);
    if (seen.has(name)) continue; seen.add(name);
    const a = r.all || {};
    rows.push({ team: name, p: a.played || 0, w: a.win || 0, d: a.draw || 0, l: a.lose || 0, pts: r.points || 0, gd: r.goalsDiff || 0 });
  }
  if (groups.length > 1) rows.sort((a, b) => b.pts - a.pts || b.gd - a.gd);
  // ผลล่าสุด 15 นัด + โปรแกรมถัดไป 15 นัด
  const all = fxRaw.map(normFixture);
  const done = all.filter((m) => m.status === 'FT').sort((a, b) => b.k - a.k).slice(0, 15);
  const next = all.filter((m) => m.status !== 'FT').sort((a, b) => a.k - b.k).slice(0, 15);
  const matches = done.concat(next).map((m) => {
    const prev = S.all.get(m.id);
    if (prev && prev.status === 'LIVE' && Date.now() - S.updated.live < 120000) return prev;  // ใช้ของ live ที่สดกว่า
    return ingest(m);
  });
  for (const m of next.slice(0, 6)) {
    if (quotaLow()) break;
    if (m.status === 'UP') { await ensurePred(m.id); await sleep(250); }
  }
  S.leagues[lg.id] = { season, standings: rows, matches: matches.map((m) => m.id), updatedAt: Date.now() };
  log(`ลีก ${lg.id} season ${season}: ตาราง ${rows.length} ทีม · ${matches.length} นัด`);
}
async function loopLeagues() {
  for (;;) {
    for (const lg of LEAGUES) {
      try { if (!quotaLow()) await refreshLeague(lg); } catch (e) { log(`league ${lg.id} error:`, e.message); }
      await sleep(1500);
    }
    S.updated.leagues = Date.now();
    await sleep(CFG.leaguesMin * 60000);
  }
}

// ---------------------------------------------------------------- match detail (events + stats + lineups)
const DETAIL = new Map();         // id -> {t, v}
const inflight = new Map();
const detailHits = [];

function pub(m) {
  return { id: m.id, lid: m.lid, league: m.league, flag: m.flag, round: m.round, home: m.home, away: m.away, k: m.k, status: m.status, phase: m.phase, min: m.min, extra: m.extra, x: m.x, y: m.y, p: m.p || null };
}

async function getDetail(id) {
  const m0 = S.all.get(id);
  if (!m0) return null;
  const ttl = m0.status === 'LIVE' ? 20e3 : m0.status === 'FT' ? 600e3 : 300e3;
  const c = DETAIL.get(id);
  if (c && Date.now() - c.t < ttl) return c.v;
  const now = Date.now();
  while (detailHits.length && now - detailHits[0] > 60000) detailHits.shift();
  if (c && (detailHits.length >= CFG.detailMaxPerMin || quotaLow())) return c.v;   // กันงบ API หมด
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    detailHits.push(Date.now());
    const raw = await api('/fixtures', { id });
    const f = raw[0];
    if (!f) return c ? c.v : null;
    const m = ingestRaw(f);
    const v = Object.assign(pub(m), {
      events: (m.events || []).map((e) => ({ min: e.min, a: e.a, type: e.type, side: e.side, p: e.p, as: e.as, i: e.i, o: e.o, n: e.n, sx: e.sx, sy: e.sy })),
      stats: mapStats(f.statistics, m.homeId),
      lineups: mapLineups(f.lineups, m.homeId),
    });
    DETAIL.set(id, { t: Date.now(), v });
    return v;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

// ---------------------------------------------------------------- HTTP
const buckets = new Map();
function limited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.t > 60000) { b = { t: now, n: 0 }; buckets.set(ip, b); }
  return ++b.n > CFG.rateLimitPerMin;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 120000) buckets.delete(k); }, 60000).unref();

function send(req, res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = Object.assign({ 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, extra);
  const ae = String(req.headers['accept-encoding'] || '');
  if (buf.length > 1024 && /\bgzip\b/.test(ae)) {
    h['content-encoding'] = 'gzip'; h.vary = 'Accept-Encoding';
    res.writeHead(code, h); res.end(zlib.gzipSync(buf));
  } else { res.writeHead(code, h); res.end(buf); }
}

function feedJson() {
  const now = Date.now();
  const w = footballDay(now);
  const matches = [];
  for (const m of S.all.values()) {
    if ((m.k >= w.from && m.k < w.to) || m.status === 'LIVE') matches.push(pub(m));
  }
  matches.sort((a, b) => a.k - b.k);
  return { ok: true, now, window: w, updated: S.updated.live || S.updated.fixtures, matches };
}
function leaguesJson() {
  const out = {};
  for (const [lid, v] of Object.entries(S.leagues)) {
    out[lid] = { season: v.season, standings: v.standings, matches: v.matches.map((id) => S.all.get(id)).filter(Boolean).map(pub), updatedAt: v.updatedAt };
  }
  return { ok: true, now: Date.now(), leagues: out };
}

const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer(async (req, res) => {
  try {
    const ip = (CFG.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p.startsWith('/api/')) {
      if (limited(ip)) return send(req, res, 429, { ok: false, error: 'too many requests' });
      if (p === '/api/feed') return send(req, res, 200, feedJson());
      if (p === '/api/leagues') return send(req, res, 200, leaguesJson());
      if (p === '/api/health') {
        return send(req, res, 200, {
          ok: true, mock: CFG.mock, uptime: Math.round(process.uptime()), matches: S.all.size,
          updated: S.updated, quota, notify: { telegram: !!CFG.tgToken, webhook: !!CFG.webhook, mode: CFG.notifyMode, events: [...CFG.notifyEvents] },
        });
      }
      let m;
      if ((m = p.match(/^\/api\/match\/(\d+)$/))) {
        const d = await getDetail(+m[1]);
        return d ? send(req, res, 200, d) : send(req, res, 404, { ok: false, error: 'not found' });
      }
      if (p === '/api/notify/test' && req.method === 'POST') {
        if (!CFG.adminToken || u.searchParams.get('token') !== CFG.adminToken) return send(req, res, 403, { ok: false, error: 'forbidden' });
        notify('✅ ทดสอบแจ้งเตือนจาก Football Hub');
        return send(req, res, 200, { ok: true });
      }
      return send(req, res, 404, { ok: false, error: 'not found' });
    }
    if (p === '/' || p === '/index.html') {
      return send(req, res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8', { 'cache-control': 'no-cache' });
    }
    send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
  } catch (e) {
    log('http error', e.message);
    try { send(req, res, 500, { ok: false, error: 'server error' }); } catch (_) { /* ignore */ }
  }
});

// ---------------------------------------------------------------- mock provider (ทดสอบโดยไม่ใช้ API key: MOCK=1)
const mock = (() => {
  const t0 = Date.now();
  const mk = (id, lgId, lgName, country, flag, round, h, a, k, goals, cards) => ({ id, lgId, lgName, country, flag, round, h, a, k, goals, cards });
  // goals: [minute, 'h'|'a', player, assist, type]  cards: [minute, side, player, detail]
  const FX = [
    mk(1001, 39, 'Premier League', 'England', 'https://media.api-sports.io/flags/gb-eng.svg', 'Regular Season - 7', 'Arsenal', 'Chelsea', t0 - 20e3,
      [[12, 'h', 'B. Saka', 'M. Odegaard'], [33, 'a', 'C. Palmer', null], [55, 'h', 'K. Havertz', null, 'Penalty'], [80, 'h', 'G. Martinelli', 'B. White']], [[62, 'a', 'M. Caicedo', 'Red Card']]),
    mk(1002, 140, 'La Liga', 'Spain', 'https://media.api-sports.io/flags/es.svg', 'Regular Season - 8', 'Real Madrid', 'Villarreal', t0 + 25e3, [[20, 'h', 'Vinicius Jr', null]], []),
    mk(1003, 296, 'Thai League 1', 'Thailand', 'https://media.api-sports.io/flags/th.svg', 'Regular Season - 7', 'Buriram United', 'Rayong', t0 - 40e3, [[8, 'h', 'Supachok', null]], []),
    mk(1004, 244, 'Veikkausliiga', 'Finland', 'https://media.api-sports.io/flags/fi.svg', 'Regular Season - 22', 'HJK', 'Inter Turku', t0 + 3600e3, [], []),
    mk(1005, 78, 'Bundesliga', 'Germany', 'https://media.api-sports.io/flags/de.svg', 'Regular Season - 6', 'Bayern München', 'Borussia Dortmund', t0 - 3 * 3600e3, [[10, 'h', 'H. Kane', null], [70, 'a', 'S. Guirassy', null]], []),
  ];
  const minuteOf = (f) => Math.floor((Date.now() - f.k) / 1000);        // 1 วินาทีจริง = 1 นาทีในเกม
  function state(f) {
    const m = minuteOf(f);
    if (m < 0) return { short: 'NS', elapsed: null };
    if (m <= 45) return { short: '1H', elapsed: Math.max(1, m) };
    if (m <= 60) return { short: 'HT', elapsed: 45 };
    if (m <= 105) return { short: '2H', elapsed: m - 15 };
    return { short: 'FT', elapsed: 90 };
  }
  function fixture(f) {
    const s = state(f);
    const el = s.short === 'FT' ? 999 : (s.elapsed || 0);
    const gs = f.goals.filter((g) => g[0] <= el);
    const ev = [];
    gs.forEach((g) => ev.push({ time: { elapsed: g[0], extra: null }, team: { id: g[1] === 'h' ? f.id * 10 + 1 : f.id * 10 + 2, name: g[1] === 'h' ? f.h : f.a }, player: { id: 1, name: g[2] }, assist: { id: 2, name: g[3] || null }, type: 'Goal', detail: g[4] ? 'Penalty' : 'Normal Goal' }));
    f.cards.filter((c) => c[0] <= el).forEach((c) => ev.push({ time: { elapsed: c[0], extra: null }, team: { id: c[1] === 'h' ? f.id * 10 + 1 : f.id * 10 + 2, name: c[1] === 'h' ? f.h : f.a }, player: { id: 3, name: c[2] }, assist: { id: null, name: null }, type: 'Card', detail: c[3], comments: null }));
    const started = s.short !== 'NS';
    return {
      fixture: { id: f.id, timestamp: Math.floor(f.k / 1000), status: { short: s.short, elapsed: s.elapsed, extra: null } },
      league: { id: f.lgId, name: f.lgName, country: f.country, flag: f.flag, round: f.round },
      teams: { home: { id: f.id * 10 + 1, name: f.h }, away: { id: f.id * 10 + 2, name: f.a } },
      goals: { home: started ? gs.filter((g) => g[1] === 'h').length : null, away: started ? gs.filter((g) => g[1] === 'a').length : null },
      events: ev,
      statistics: started ? [
        { team: { id: f.id * 10 + 1 }, statistics: [{ type: 'Ball Possession', value: '58%' }, { type: 'Total Shots', value: 11 }, { type: 'Shots on Goal', value: 5 }, { type: 'Corner Kicks', value: 6 }, { type: 'Fouls', value: 9 }, { type: 'Offsides', value: 2 }, { type: 'Yellow Cards', value: null }, { type: 'Red Cards', value: null }] },
        { team: { id: f.id * 10 + 2 }, statistics: [{ type: 'Ball Possession', value: '42%' }, { type: 'Total Shots', value: 6 }, { type: 'Shots on Goal', value: 2 }, { type: 'Corner Kicks', value: 3 }, { type: 'Fouls', value: 12 }, { type: 'Offsides', value: 1 }, { type: 'Yellow Cards', value: 2 }, { type: 'Red Cards', value: 1 }] },
      ] : [],
      lineups: [
        { team: { id: f.id * 10 + 1 }, startXI: [{ player: { name: 'Home GK', pos: 'G' } }, { player: { name: 'Home DF', pos: 'D' } }, { player: { name: 'Home MF', pos: 'M' } }, { player: { name: 'Home FW', pos: 'F' } }], substitutes: [{ player: { name: 'Home Sub', pos: 'M' } }] },
        { team: { id: f.id * 10 + 2 }, startXI: [{ player: { name: 'Away GK', pos: 'G' } }, { player: { name: 'Away FW', pos: 'F' } }], substitutes: [] },
      ],
    };
  }
  return {
    handle(endpoint, q) {
      if (endpoint === '/fixtures') {
        if (q.live === 'all') return FX.map(fixture).filter((x) => ['1H', 'HT', '2H'].includes(x.fixture.status.short));
        if (q.id) return FX.filter((f) => f.id === +q.id).map(fixture);
        if (q.ids) return FX.filter((f) => String(q.ids).split('-').map(Number).includes(f.id)).map(fixture);
        if (q.date) return FX.map(fixture).filter((x) => ymd(x.fixture.timestamp * 1000) === q.date);
        if (q.league) return FX.filter((f) => f.lgId === +q.league).map(fixture);
        return [];
      }
      if (endpoint === '/predictions') return [{ predictions: { percent: { home: '55%', draw: '25%', away: '20%' } } }];
      if (endpoint === '/leagues') return [{ league: { id: +q.id }, seasons: [{ year: 2026, current: true }] }];
      if (endpoint === '/standings') {
        const f = FX.filter((x) => x.lgId === +q.league);
        if (!f.length) return [];
        const teams = [f[0].h, f[0].a];
        return [{ league: { id: +q.league, standings: [teams.map((n, i) => ({ rank: i + 1, team: { name: n }, points: 20 - i * 3, goalsDiff: 8 - i * 4, all: { played: 7, win: 6 - i, draw: 2, lose: i } }))] } }];
      }
      return [];
    },
  };
})();

// ---------------------------------------------------------------- boot
server.listen(CFG.port, CFG.host, () => {
  log(`Football Hub รันที่ http://localhost:${CFG.port}  ${CFG.mock ? '(โหมดข้อมูลจำลอง MOCK)' : ''}`);
  log(`แจ้งเตือน: telegram=${!!CFG.tgToken} webhook=${!!CFG.webhook} mode=${CFG.notifyMode} events=${[...CFG.notifyEvents].join(',')}`);
});
(async () => {
  try { await refreshFixtures(); } catch (e) { log('fixtures (รอบแรก) error:', e.message); }
  loopLive(); loopFixtures().catch(() => {}); loopLeagues().catch(() => {});
})();
process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT', () => { saveState(); process.exit(0); });
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.message ? e.message : e));
