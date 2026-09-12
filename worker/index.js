/* Cloudflare Worker: booking API backed by D1, media in R2, AI advice via Claude.
   Static files are served by the assets binding; this code only runs for /api/*.

   Routes
     GET    /api/availability?from=YYYY-MM-DD&to=YYYY-MM-DD   busy blocks per day per barber
     POST   /api/bookings                                     create
     GET    /api/bookings/:ref                                read one
     PATCH  /api/bookings/:ref   {date,time}                  reschedule
     DELETE /api/bookings/:ref                                cancel
     POST   /api/bookings/:ref/media  {kind,ids}              attach before/after photos or video
     POST   /api/uploads?kind=before|after   (raw body)       store a photo or video in R2
     GET    /api/media/:id                                    serve a stored photo or video
     POST   /api/advice   {photoIds,description}              AI look suggestions
     GET    /api/admin/bookings?date=YYYY-MM-DD               owner: day list   (Bearer ADMIN_TOKEN)
     POST   /api/admin/blocks    {barberId,date,start,end,reason}   owner: add time off
     DELETE /api/admin/blocks/:id                             owner: remove time off
*/
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import '../assets/js/config.js';
const C = globalThis.SALON_CONFIG;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
    }
  },
};

/* ---------- routing ---------- */
async function route(req, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, ''), m = req.method;
  let x;
  if (m === 'GET' && p === '/api/availability') return availability(env, url);
  if (m === 'POST' && p === '/api/bookings') return create(env, ctx, await body(req));
  if ((x = p.match(/^\/api\/bookings\/([A-Z0-9-]{4,16})$/))) {
    if (m === 'GET') return json({ booking: await getBooking(env, x[1]) });
    if (m === 'PATCH') return reschedule(env, ctx, x[1], await body(req));
    if (m === 'DELETE') return cancel(env, ctx, x[1]);
  }
  if (m === 'POST' && (x = p.match(/^\/api\/bookings\/([A-Z0-9-]{4,16})\/media$/))) return attachMedia(env, x[1], await body(req));
  if (m === 'POST' && p === '/api/uploads') return upload(req, env, url);
  if (m === 'GET' && (x = p.match(/^\/api\/media\/([A-Za-z0-9]{20})$/))) return serveMedia(req, env, x[1]);
  if (m === 'POST' && p === '/api/advice') return advice(req, env, ctx, await body(req));
  if (p.startsWith('/api/admin/')) {
    requireAdmin(req, env);
    if (m === 'GET' && p === '/api/admin/bookings') return adminDay(env, url);
    if (m === 'POST' && p === '/api/admin/blocks') return addBlock(env, await body(req));
    if (m === 'DELETE' && (x = p.match(/^\/api\/admin\/blocks\/(\d+)$/))) {
      await env.DB.prepare('DELETE FROM blocks WHERE id = ?').bind(Number(x[1])).run();
      return json({ ok: true });
    }
  }
  fail(404, 'Not found');
}
async function body(req) {
  try { return await req.json(); } catch (e) { fail(400, 'Expected a JSON body'); }
}
function requireAdmin(req, env) {
  if (!env.ADMIN_TOKEN) fail(503, 'ADMIN_TOKEN secret is not set');
  const h = req.headers.get('authorization') || '';
  if (h !== `Bearer ${env.ADMIN_TOKEN}`) fail(401, 'Unauthorised');
}

/* ---------- shop time helpers ---------- */
const pad = (n) => String(n).padStart(2, '0');
const fmt = (h) => { const H = Math.floor(h), m = Math.round((h - H) * 60); return `${(H % 12) || 12}:${pad(m)}${H < 12 ? 'am' : 'pm'}`; };
const isDate = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && !Number.isNaN(Date.parse(k + 'T00:00:00Z'));
const weekday = (k) => new Date(k + 'T00:00:00Z').getUTCDay();
const hoursFor = (k) => C.hours[weekday(k)] || null;
const addDays = (k, n) => new Date(Date.parse(k + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
function shopNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: C.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) + Number(g('minute')) / 60 };
}
const randomId = (n) => { const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', a = crypto.getRandomValues(new Uint8Array(n)); return Array.from(a, (x) => chars[x % chars.length]).join(''); };

/* ---------- catalogue ---------- */
const staff = () => C.barbers.filter((b) => !b.any);
const barberById = (id) => C.barbers.find((b) => b.id === id);
const svcById = (id) => C.services.find((s) => s.id === id);
const worksOn = (b, k) => !(b.daysOff || []).includes(weekday(k));
const price = (s, b) => Math.round((b.base * s.mult) / 5) * 5;
const totalFor = (ids, b) => ids.reduce((t, id) => t + price(svcById(id), b), 0);
const minsFor = (ids) => ids.reduce((t, id) => t + svcById(id).mins, 0);

/* ---------- availability ---------- */
async function busyMap(env, from, to) {
  const [bk, bl] = await Promise.all([
    env.DB.prepare("SELECT ref, barber_id, date, time, mins FROM bookings WHERE status = 'confirmed' AND date BETWEEN ? AND ?").bind(from, to).all(),
    env.DB.prepare('SELECT barber_id, date, start, end FROM blocks WHERE date BETWEEN ? AND ?').bind(from, to).all(),
  ]);
  const map = {};
  const put = (k, id, s, e, ref) => { ((map[k] = map[k] || {})[id] = map[k][id] || []).push([s, e, ref]); };
  bk.results.forEach((r) => put(r.date, r.barber_id, r.time, r.time + r.mins / 60, r.ref));
  bl.results.forEach((r) => put(r.date, r.barber_id, r.start, r.end, null));
  return map;
}
async function availability(env, url) {
  const now = shopNow();
  const from = url.searchParams.get('from') || now.date, to = url.searchParams.get('to') || addDays(now.date, C.daysAhead - 1);
  if (!isDate(from) || !isDate(to) || to < from || addDays(from, 60) < to) fail(400, 'Bad date range');
  return json({ from, to, today: now.date, now: now.hour, busy: await busyMap(env, from, to), features: features(env) });
}
/* What this deployment can actually do. The page adapts to it. */
const features = (env) => ({
  media: !!env.MEDIA,
  ai: !!(C.ai && C.ai.enabled) && (!!env.ANTHROPIC_API_KEY || !!(C.ai && C.ai.demo)),
  aiDemo: !!(C.ai && C.ai.enabled && C.ai.demo) && !env.ANTHROPIC_API_KEY,
});

/* Overlap test for a candidate slot. Runs inside INSERT/UPDATE statements so two
   customers racing for the same slot can never both succeed. */
const NO_CLASH = `NOT EXISTS (SELECT 1 FROM bookings b WHERE b.status = 'confirmed' AND b.barber_id = ?1 AND b.date = ?2 AND b.ref <> ?5 AND b.time < ?4 AND (b.time + b.mins / 60.0) > ?3)
  AND NOT EXISTS (SELECT 1 FROM blocks k WHERE k.barber_id = ?1 AND k.date = ?2 AND k.start < ?4 AND k.end > ?3)`;

/* ---------- validation ---------- */
function validateSlot(date, time, mins, editingRef) {
  if (!isDate(date)) fail(400, 'Bad date');
  const now = shopNow();
  if (date < now.date || date > addDays(now.date, C.daysAhead - 1)) fail(400, `Bookings open ${C.daysAhead} days ahead`);
  const h = hoursFor(date); if (!h) fail(400, 'The shop is closed that day');
  if (typeof time !== 'number' || !Number.isFinite(time)) fail(400, 'Bad time');
  const step = C.slotMinutes / 60;
  if (Math.abs((time - h[0]) / step - Math.round((time - h[0]) / step)) > 1e-6) fail(400, 'Time is not on the booking grid');
  if (time < h[0] || time + mins / 60 > h[1] + 1e-9) fail(400, 'That time is outside opening hours');
  if (date === now.date && time < now.hour + C.leadMinutes / 60) fail(409, 'That time has already passed. Pick a later one.');
}
function validateCustomer(b) {
  const name = String(b.name || '').trim(), phone = String(b.phone || '').trim(), email = String(b.email || '').trim(), notes = String(b.notes || '').trim();
  if (name.length < 2 || name.length > 60) fail(400, 'Enter your first name');
  if (!/^(\+?61|0)4\d{8}$/.test(phone.replace(/[\s-]/g, ''))) fail(400, 'Enter a valid Australian mobile');
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email) || email.length > 120) fail(400, 'Enter a valid email');
  if (notes.length > 240) fail(400, 'Notes are too long');
  return { name, phone, email, notes };
}
function validateServices(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > C.services.length) fail(400, 'Choose at least one service');
  const u = [...new Set(ids.map(String))];
  if (u.some((id) => !svcById(id))) fail(400, 'Unknown service');
  return u;
}
const newRef = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', a = crypto.getRandomValues(new Uint8Array(6));
  return C.refPrefix + '-' + Array.from(a, (n) => chars[n % chars.length]).join('');
};

/* ---------- media ---------- */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const MEDIA_ID = /^[A-Za-z0-9]{20}$/;
const mediaOut = (list) => (list || []).map((m) => ({ id: m.id, contentType: m.contentType, url: `/api/media/${m.id}` }));
async function upload(req, env, url) {
  if (!env.MEDIA) fail(503, 'Photo storage is not set up yet');
  const kind = url.searchParams.get('kind') === 'after' ? 'after' : 'before';
  const ct = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const isImg = IMAGE_TYPES.includes(ct), isVid = VIDEO_TYPES.includes(ct);
  if (!isImg && !isVid) fail(415, 'Upload a JPG, PNG or WebP photo, or an MP4, MOV or WebM video');
  const max = (isImg ? C.media.maxImageMB : C.media.maxVideoMB) * 1048576;
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > max) fail(413, `${isImg ? 'Photos' : 'Videos'} must be under ${isImg ? C.media.maxImageMB : C.media.maxVideoMB} MB`);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) fail(413, `${isImg ? 'Photos' : 'Videos'} must be under ${isImg ? C.media.maxImageMB : C.media.maxVideoMB} MB`);
  if (buf.byteLength < 100) fail(400, 'That file looks empty');
  const id = randomId(20);
  await env.MEDIA.put(`media/${id}`, buf, { httpMetadata: { contentType: ct }, customMetadata: { kind } });
  await env.DB.prepare('INSERT INTO media (id, kind, content_type, size, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, kind, ct, buf.byteLength, Date.now()).run();
  return json({ id, url: `/api/media/${id}`, contentType: ct, kind }, 201);
}
async function serveMedia(req, env, id) {
  if (!env.MEDIA) fail(404, 'Not found');
  const range = req.headers.get('range');
  const obj = await env.MEDIA.get(`media/${id}`, range ? { range: req.headers } : undefined);
  if (!obj) fail(404, 'Not found');
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', 'private, max-age=86400');
  h.set('x-content-type-options', 'nosniff');
  h.set('content-security-policy', "default-src 'none'");
  let status = 200;
  if (range && obj.range && 'offset' in obj.range) {
    const end = obj.range.offset + (obj.range.length ?? obj.size - obj.range.offset) - 1;
    h.set('content-range', `bytes ${obj.range.offset}-${end}/${obj.size}`);
    h.set('content-length', String(end - obj.range.offset + 1));
    status = 206;
  }
  return new Response(obj.body, { status, headers: h });
}
async function knownMedia(env, ids) {
  const u = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && MEDIA_ID.test(x)))].slice(0, 12);
  if (!u.length) return [];
  const r = await env.DB.prepare(`SELECT id, content_type FROM media WHERE id IN (${u.map(() => '?').join(',')})`).bind(...u).all();
  return u.map((id) => r.results.find((m) => m.id === id)).filter(Boolean).map((m) => ({ id: m.id, contentType: m.content_type }));
}
async function attachMedia(env, ref, b) {
  const cur = await getBooking(env, ref);
  if (cur.status !== 'confirmed') fail(409, 'That booking was cancelled');
  const kind = b.kind === 'after' ? 'after' : 'before';
  const add = await knownMedia(env, b.ids);
  if (!add.length) fail(400, 'Nothing to attach');
  const col = kind === 'after' ? 'after_media' : 'before_media';
  const have = cur[kind === 'after' ? 'afterMedia' : 'beforeMedia'].map((m) => ({ id: m.id, contentType: m.contentType }));
  const merged = [...have, ...add.filter((m) => !have.some((h) => h.id === m.id))].slice(0, 12);
  await env.DB.prepare(`UPDATE bookings SET ${col} = ?, updated_at = ? WHERE ref = ?`).bind(JSON.stringify(merged), Date.now(), ref).run();
  return json({ booking: await getBooking(env, ref) });
}

/* ---------- AI look advisor ---------- */
const AdviceSchema = z.object({
  analysis: z.string().describe('Two or three sentences on what the photos show: hair type, texture, density, growth pattern, current shape, and what tends to suit that. If the photos do not show hair clearly, say so and rely on the description.'),
  suggestions: z.array(z.object({
    name: z.string().describe('Short name for the look, e.g. "Mid skin fade with textured crop"'),
    description: z.string().describe('How it is cut, in barbering terms the customer can repeat: guard numbers, fade height, length on top, how the beard is shaped.'),
    why: z.string().describe('Why it suits this person and what they asked for'),
    serviceIds: z.array(z.string()).describe('Service ids from the menu needed for this look'),
    barberIds: z.array(z.string()).describe('Barber ids whose skills fit this look, best first'),
    maintenance: z.string().describe('How often to come back and what styling it needs'),
  })).describe('Two or three looks, best match first'),
  tellBarber: z.string().describe('One sentence the customer can say to the barber to get the first suggestion'),
});
function advisorSystem() {
  const menu = C.services.map((s) => `- ${s.id}: ${s.name} (${s.desc}, ${s.mins} min)`).join('\n');
  const team = staff().map((b) => `- ${b.id}: ${b.name}. Skills: ${(b.skills || [b.note]).join(', ')}`).join('\n');
  return `You are the look advisor for ${C.name}, a barbershop in ${C.suburb}. A customer shares photos of their hair as it is now and, optionally, describes the look they want. Recommend two or three haircut or beard looks that suit their hair type, texture, density, growth pattern and head shape, and that match what they asked for. Be specific and practical, using barbering vocabulary the customer can repeat in the chair. If something they asked for will not work with their hair, say so kindly and suggest the nearest look that will.

Only recommend services from this menu, by id:
${menu}

Only recommend barbers from this team, by id, choosing the ones whose skills fit each look:
${team}

Never comment on attractiveness, age, ethnicity, weight or health. Do not identify the person. If the photos do not show hair clearly, say so in the analysis and work from the description.`;
}
const b64 = (buf) => { const bytes = new Uint8Array(buf); let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return btoa(s); };
/* Sample answer used when no API key is configured and config.ai.demo is on,
   so the flow can be shown to a client. Picks barbers from the config and
   reacts to a few keywords so it feels responsive. */
function demoAdvice(description) {
  const d = description.toLowerCase();
  const fadeGuy = staff().find((b) => (b.skills || []).join(' ').includes('fade')) || staff()[0];
  const scissorGuy = staff().find((b) => (b.skills || []).join(' ').includes('scissor')) || staff()[1] || staff()[0];
  const beardGuy = staff().find((b) => (b.skills || []).join(' ').includes('beard')) || staff()[0];
  const wantsBeard = /beard|shave|stubble/.test(d), wantsLong = /long|length|grow|push back|flow/.test(d), wantsShort = /short|buzz|tight|crop/.test(d);
  const fade = svcById('fade') ? 'fade' : C.services[0].id, cut = svcById('cut') ? 'cut' : C.services[0].id, beard = svcById('beard') ? 'beard' : null;
  const suggestions = [
    { name: wantsShort ? 'High skin fade with a short textured crop' : 'Mid skin fade with textured crop',
      description: `Skin on the sides blended up to a ${wantsShort ? '1.5' : '2'} around the parietal ridge, ${wantsShort ? '2 to 3 cm' : '5 to 6 cm'} on top point-cut for texture and pushed forward.`,
      why: 'Your density on top carries texture well, and a clean fade keeps the sides tight between visits.',
      serviceIds: [fade, ...(wantsBeard && beard ? [beard] : [])], barberIds: [fadeGuy.id], maintenance: 'Every 3 to 4 weeks. A pea of matte clay, worked in dry.' },
    { name: wantsLong ? 'Scissor taper with length on top' : 'Classic taper with a side part',
      description: `Scissor over comb on the sides for a softer taper, ${wantsLong ? 'length kept on top so it can be pushed back' : 'a clean side part with a little height at the front'}.`,
      why: wantsLong ? 'Keeps the length you asked for while tidying the shape around the ears and neck.' : 'A softer outline that suits a straight growth pattern and grows out gracefully.',
      serviceIds: [cut, ...(wantsBeard && beard ? [beard] : [])], barberIds: [scissorGuy.id, fadeGuy.id], maintenance: 'Every 5 to 6 weeks. Light pomade or nothing at all.' },
  ];
  if (wantsBeard && beard) suggestions.push({ name: 'Beard shape-up with a faded cheek line', description: 'Cheeks and neckline cleaned with a razor, sides of the beard faded into the haircut, length kept through the chin.', why: 'Ties the beard into whichever cut you pick and keeps it looking deliberate.', serviceIds: [beard], barberIds: [beardGuy.id], maintenance: 'Every 2 to 3 weeks for the lines.' });
  return {
    analysis: 'Sample analysis: medium-density straight hair with a slight wave at the fringe and a crown whorl that pushes hair forward. Shapes with tighter sides and weight kept on top tend to sit best.',
    suggestions,
    tellBarber: `${suggestions[0].name}, ${suggestions[0].description.split(',')[0].toLowerCase()}.`,
  };
}
async function advice(req, env, ctx, b) {
  if (!C.ai || !C.ai.enabled) fail(404, 'Not found');
  if (!env.ANTHROPIC_API_KEY) {
    if (!C.ai.demo) fail(503, 'The look advisor is not set up yet');
    await new Promise((r) => setTimeout(r, 1800));
    return json({ advice: demoAdvice(String(b.description || '')), demo: true, photos: [] });
  }
  const ip = req.headers.get('cf-connecting-ip') || 'unknown', now = Date.now();
  const [perIp, total] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE ip = ? AND created_at > ?').bind(ip, now - 3600000).first('n'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE created_at > ?').bind(now - 86400000).first('n'),
  ]);
  if (perIp >= C.ai.perHour) fail(429, "You've used the advisor a lot in the last hour. Try again a bit later.");
  if (total >= C.ai.perDay) fail(429, 'The advisor is busy today. Try again tomorrow, or ask us in the chair.');

  const description = String(b.description || '').trim().slice(0, 500);
  const media = await knownMedia(env, b.photoIds);
  const images = [];
  for (const m of media.filter((x) => IMAGE_TYPES.includes(x.contentType)).slice(0, C.ai.maxPhotos)) {
    const obj = await env.MEDIA.get(`media/${m.id}`);
    if (obj) images.push({ type: 'image', source: { type: 'base64', media_type: m.contentType, data: b64(await obj.arrayBuffer()) } });
  }
  if (!images.length && description.length < 10) fail(400, 'Add a photo of your hair or describe the look you want');

  await env.DB.prepare('INSERT INTO ai_calls (ip, created_at) VALUES (?, ?)').bind(ip, now).run();
  ctx.waitUntil(env.DB.prepare('DELETE FROM ai_calls WHERE created_at < ?').bind(now - 86400000).run());

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
  let res;
  try {
    res = await client.messages.parse({
      model: env.AI_MODEL || 'claude-opus-5',
      max_tokens: 4000,
      system: advisorSystem(),
      output_config: { effort: 'medium', format: zodOutputFormat(AdviceSchema) },
      messages: [{
        role: 'user',
        content: [
          ...images,
          { type: 'text', text: images.length
            ? `Here ${images.length === 1 ? 'is a photo' : 'are photos'} of my hair now.${description ? ` What I want: ${description}` : ' Suggest what would suit me.'}`
            : `I have no photo. What I want: ${description}` },
        ],
      }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) fail(503, 'The advisor is busy right now. Try again in a minute.');
    if (e instanceof Anthropic.AuthenticationError) fail(503, 'The look advisor is misconfigured');
    if (e instanceof Anthropic.APIError) { console.error('advisor', e.status, e.message); fail(502, 'The advisor did not answer. Try again.'); }
    throw e;
  }
  if (res.stop_reason === 'refusal') fail(422, "We couldn't work with those photos. Try clearer shots of just your hair, or describe what you want.");
  const out = res.parsed_output;
  if (!out || !out.suggestions.length) fail(502, 'The advisor gave an unusable answer. Try again.');
  out.suggestions = out.suggestions.slice(0, 3).map((s) => ({
    ...s,
    serviceIds: [...new Set(s.serviceIds.filter(svcById))],
    barberIds: [...new Set(s.barberIds.filter((id) => { const x = barberById(id); return x && !x.any; }))],
  }));
  return json({ advice: out, photos: media.map((m) => m.id) });
}

/* ---------- bookings ---------- */
const parseList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
const shape = (r) => r && ({
  ref: r.ref, barberId: r.barber_id, requestedAny: !!r.requested_any, services: JSON.parse(r.services),
  date: r.date, time: r.time, mins: r.mins, total: r.total, name: r.name, phone: r.phone, email: r.email, notes: r.notes || '',
  beforeMedia: mediaOut(parseList(r.before_media)), afterMedia: mediaOut(parseList(r.after_media)),
  lookRequest: r.look_request || '', aiAdvice: r.ai_advice || '',
  status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, cancelledAt: r.cancelled_at,
});
async function getBooking(env, ref) {
  const r = await env.DB.prepare('SELECT * FROM bookings WHERE ref = ?').bind(ref).first();
  if (!r) fail(404, 'No booking with that reference');
  return shape(r);
}
async function create(env, ctx, b) {
  const services = validateServices(b.services), mins = minsFor(services);
  const requested = barberById(String(b.barberId || '')); if (!requested) fail(400, 'Unknown barber');
  const date = b.date, time = Number(b.time);
  validateSlot(date, time, mins);
  const cust = validateCustomer(b);
  const before = await knownMedia(env, b.beforeMedia);
  const lookRequest = String(b.lookRequest || '').trim().slice(0, 500), aiAdvice = String(b.aiAdvice || '').trim().slice(0, 600);
  const candidates = (requested.any ? staff() : [requested]).filter((x) => worksOn(x, date));
  if (!candidates.length) fail(409, `${requested.name} doesn't work on that day`);
  const ref = newRef(), created = Date.now();
  for (const who of candidates) {
    const r = await env.DB.prepare(`INSERT INTO bookings (ref, barber_id, requested_any, services, date, time, mins, total, name, phone, email, notes, status, created_at, before_media, look_request, ai_advice)
      SELECT ?5, ?1, ?6, ?7, ?2, ?3, ?8, ?9, ?10, ?11, ?12, ?13, 'confirmed', ?14, ?15, ?16, ?17 WHERE ${NO_CLASH}`)
      .bind(who.id, date, time, time + mins / 60, ref, requested.any ? 1 : 0, JSON.stringify(services), mins, totalFor(services, who), cust.name, cust.phone, cust.email, cust.notes, created,
        JSON.stringify(before), lookRequest, aiAdvice).run();
    if (r.meta.changes === 1) {
      const booking = await getBooking(env, ref);
      notify(env, ctx, 'booking.created', booking);
      return json({ booking }, 201);
    }
  }
  fail(409, 'That time was just taken. Pick another.');
}
async function reschedule(env, ctx, ref, b) {
  const cur = await getBooking(env, ref);
  if (cur.status !== 'confirmed') fail(409, 'That booking was cancelled');
  const date = b.date, time = Number(b.time);
  validateSlot(date, time, cur.mins, ref);
  const requested = barberById(cur.requestedAny ? 'any' : cur.barberId);
  const candidates = (requested.any ? staff() : [requested]).filter((x) => worksOn(x, date));
  if (!candidates.length) fail(409, `${requested.name} doesn't work on that day`);
  for (const who of candidates) {
    const r = await env.DB.prepare(`UPDATE bookings SET date = ?2, time = ?3, barber_id = ?1, total = ?6, updated_at = ?7 WHERE ref = ?5 AND status = 'confirmed' AND ${NO_CLASH}`)
      .bind(who.id, date, time, time + cur.mins / 60, ref, totalFor(cur.services, who), Date.now()).run();
    if (r.meta.changes === 1) {
      const booking = await getBooking(env, ref);
      notify(env, ctx, 'booking.rescheduled', booking);
      return json({ booking });
    }
  }
  fail(409, 'That time was just taken. Pick another.');
}
async function cancel(env, ctx, ref) {
  const cur = await getBooking(env, ref);
  if (cur.status === 'confirmed') {
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE ref = ?").bind(Date.now(), ref).run();
    notify(env, ctx, 'booking.cancelled', await getBooking(env, ref));
  }
  return json({ booking: await getBooking(env, ref) });
}

/* ---------- owner ---------- */
async function adminDay(env, url) {
  const date = url.searchParams.get('date') || shopNow().date;
  if (!isDate(date)) fail(400, 'Bad date');
  const [bk, bl] = await Promise.all([
    env.DB.prepare('SELECT * FROM bookings WHERE date = ? ORDER BY time, barber_id').bind(date).all(),
    env.DB.prepare('SELECT * FROM blocks WHERE date = ? ORDER BY start').bind(date).all(),
  ]);
  return json({ date, bookings: bk.results.map(shape), blocks: bl.results.map((r) => ({ id: r.id, barberId: r.barber_id, date: r.date, start: r.start, end: r.end, reason: r.reason || '' })) });
}
async function addBlock(env, b) {
  const who = barberById(String(b.barberId || '')); if (!who || who.any) fail(400, 'Pick a barber');
  const start = Number(b.start), end = Number(b.end);
  if (!isDate(b.date)) fail(400, 'Bad date');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0 || end > 24) fail(400, 'Bad time range');
  const r = await env.DB.prepare('INSERT INTO blocks (barber_id, date, start, end, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(who.id, b.date, start, end, String(b.reason || '').slice(0, 80), Date.now()).run();
  return json({ id: r.meta.last_row_id }, 201);
}

/* ---------- notifications ---------- */
function notify(env, ctx, event, booking) {
  if (!env.NOTIFY_WEBHOOK) return;
  const who = barberById(booking.barberId);
  const text = `${event.replace('booking.', '')}: ${booking.name} · ${booking.services.map((id) => svcById(id).name).join(' + ')} with ${who ? who.name : booking.barberId} · ${booking.date} ${fmt(booking.time)} · ${booking.phone} · ${booking.ref}`
    + (booking.aiAdvice ? ` · wants: ${booking.aiAdvice}` : '') + (booking.beforeMedia.length ? ` · ${booking.beforeMedia.length} photo(s)` : '');
  ctx.waitUntil(fetch(env.NOTIFY_WEBHOOK, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event, text, shop: C.name, ...booking }),
  }).catch((e) => console.error('webhook failed', e)));
}
