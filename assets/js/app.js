/* Faded Lines booking app. Configuration lives in config.js.
   Runs in two modes:
     API mode  (config.api = true and /api reachable): availability and bookings
               come from the Worker + D1, shared across every device.
     Demo mode (config.api = false, or the API is unreachable): availability is
               simulated and bookings live in this browser only. */
(function () {
  'use strict';
  const C = globalThis.SALON_CONFIG;
  if (!C) { document.body.textContent = 'Missing assets/js/config.js'; return; }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');

  /* ---------- images ---------- */
  function src(p, w, h, faces) {
    if (!p) return '';
    if (p.src) return p.src;
    return `https://images.unsplash.com/photo-${p.id}?auto=format&fit=crop&w=${w}&h=${h}&q=70${faces ? '&crop=faces' : ''}`;
  }
  const imgTag = (p, w, h, cls, faces) => p ? `<img class="${cls || ''}" src="${src(p, w, h, faces)}" alt="${esc(p.alt || '')}" loading="lazy" decoding="async" onerror="this.classList.add('broken')">` : '';

  /* ---------- storage ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: keep going in memory */ } },
  };
  const KEY_B = 'salon.bookings', KEY_C = 'salon.customer';
  let bookings = store.get(KEY_B, []);   // this device's bookings (the full record in demo mode, a cached copy in API mode)
  const saveBookings = () => store.set(KEY_B, bookings);

  /* ---------- API ---------- */
  const API = C.api !== false;
  let online = false;      // true once the API has answered
  let BUSY = {};           // date -> barberId -> [[start, end, ref|null]]
  let FEATURES = { media: false, ai: false, aiDemo: false };   // what the deployment can do, from the API
  async function api(path, opts) {
    const o = { method: 'GET', ...opts };
    if (o.body !== undefined) { o.body = JSON.stringify(o.body); o.headers = { 'content-type': 'application/json' }; }
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(path, { ...o, signal: ctl.signal });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.status = r.status; throw e; }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error('The shop is taking too long to answer. Try again.'), { status: 0 });
      if (!e.status) e.status = 0;
      throw e;
    } finally { clearTimeout(tm); }
  }
  async function loadAvailability() {
    if (!API) return;
    try {
      const r = await api(`/api/availability?from=${TODAY}&to=${DAYS[DAYS.length - 1]}`);
      BUSY = r.busy || {}; FEATURES = { ...FEATURES, ...(r.features || {}) }; online = true;
    } catch (e) {
      if (online) toast('Lost contact with the shop. Times may be out of date.');
      online = false;
    }
    draw();
  }

  /* ---------- dates & hours ---------- */
  const dkey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmt = (h) => { const H = Math.floor(h), m = Math.round((h - H) * 60); return `${(H % 12) || 12}:${pad(m)}${H < 12 ? 'am' : 'pm'}`; };
  const fmtHour = (h) => { const H = Math.floor(h), m = Math.round((h - H) * 60); return `${(H % 12) || 12}${m ? ':' + pad(m) : ''}${H < 12 ? 'am' : 'pm'}`; };
  const nowH = () => { const n = new Date(); return n.getHours() + n.getMinutes() / 60; };
  const hoursFor = (d) => C.hours[d.getDay()] || null;
  const longDate = (k) => fromKey(k).toLocaleDateString(C.locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const shortDate = (k) => fromKey(k).toLocaleDateString(C.locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const DAYS = (() => { const o = [], t = new Date(); for (let i = 0; i < C.daysAhead; i++) { const d = new Date(t); d.setDate(t.getDate() + i); o.push(dkey(d)); } return o; })();
  const TODAY = DAYS[0];
  const dayLabel = (k) => k === TODAY ? 'Today' : k === DAYS[1] ? 'Tomorrow' : fromKey(k).toLocaleDateString(C.locale, { weekday: 'short' });

  /* ---------- staff & pricing ---------- */
  const staff = () => C.barbers.filter((b) => !b.any);
  const barberById = (id) => C.barbers.find((b) => b.id === id);
  const svcById = (id) => C.services.find((s) => s.id === id);
  const worksOn = (b, k) => !(b.daysOff || []).includes(fromKey(k).getDay());
  const priceWith = (s, b) => Math.round((b.base * s.mult) / 5) * 5;
  const price = (s, b) => b.any ? Math.min(...staff().map((x) => priceWith(s, x))) : priceWith(s, b);   // "Any barber" quotes the lowest rate
  const money = (n, b) => (b && b.any ? 'from ' : '') + '$' + n;
  const first = (b) => b.name.split(' ')[0];

  /* ---------- availability ----------
     API mode: BUSY comes from the server. Demo mode: deterministic busy blocks
     per barber per day plus whatever this device has booked. */
  const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  function busyBlocks(b, k) {
    if (online) return ((BUSY[k] || {})[b.id] || []).filter((x) => !S.editing || x[2] !== S.editing).map((x) => [x[0], x[1]]);
    const h = hoursFor(fromKey(k)); if (!h) return [];
    const r = rng(hash(b.id + k)), n = 2 + Math.floor(r() * 3), out = [];
    for (let i = 0; i < n; i++) {
      const start = h[0] + Math.floor(r() * (h[1] - h[0] - 1) * 4) / 4;
      out.push([start, Math.min(start + 0.5 + Math.floor(r() * 4) * 0.25, h[1])]);
    }
    bookings.forEach((x) => {
      if (x.status === 'confirmed' && x.barberId === b.id && x.date === k && x.ref !== S.editing) out.push([x.time, x.time + x.mins / 60]);
    });
    return out;
  }
  const freeAt = (b, k, t, need) => worksOn(b, k) && !busyBlocks(b, k).some(([a, z]) => t < z && t + need > a);
  const busyNow = (b) => { const t = nowH(); return !worksOn(b, TODAY) || busyBlocks(b, TODAY).some(([a, z]) => t >= a && t < z); };
  function slotsFor(b, k, need) {
    const h = hoursFor(fromKey(k)); if (!h || !need) return [];
    const earliest = k === TODAY ? nowH() + C.leadMinutes / 60 : -1;
    const out = [];
    for (let t = h[0]; t + need <= h[1] + 1e-9; t += C.slotMinutes / 60) {
      if (t < earliest) continue;
      if (b.any ? staff().some((x) => freeAt(x, k, t, need)) : freeAt(b, k, t, need)) out.push(t);
    }
    return out;
  }
  const assign = (k, t, need) => staff().find((x) => freeAt(x, k, t, need)) || staff()[0];
  function nextFree(b) {
    for (const k of DAYS) { const s = slotsFor(b, k, 0.75); if (s.length) return `${dayLabel(k)} ${fmt(s[0])}`; }
    return 'Fully booked';
  }
  function openStatus() {
    const d = new Date(), h = hoursFor(d), t = nowH();
    if (h && t >= h[0] && t < h[1]) return { open: true, text: `Open now · closes ${fmtHour(h[1])}` };
    if (h && t < h[0]) return { open: false, text: `Opens ${fmtHour(h[0])} today` };
    for (let i = 1; i < 8; i++) {
      const n = new Date(d); n.setDate(d.getDate() + i); const nh = hoursFor(n);
      if (nh) return { open: false, text: `Closed · opens ${i === 1 ? 'tomorrow' : n.toLocaleDateString(C.locale, { weekday: 'long' })} ${fmtHour(nh[0])}` };
    }
    return { open: false, text: 'Closed' };
  }
  const waitEstimate = () => { const busy = staff().filter(busyNow).length; return busy >= staff().length ? 45 : 5 + busy * 15; };

  /* ---------- state ---------- */
  const S = { barber: null, svc: [], date: TODAY, time: null, editing: null, last: null, look: null };
  let scr = 'home';
  let LOOK = null;         // last AI advice shown on the look screen
  const PROG = { home: 0, bookings: 0, look: 10, barber: 25, services: 50, time: 75, details: 92, done: 100 };
  const AI = !!(C.ai && C.ai.enabled);
  const total = () => (S.barber ? S.svc.reduce((t, s) => t + price(s, S.barber), 0) : 0);
  const mins = () => S.svc.reduce((t, s) => t + s.mins, 0);

  const upcoming = (b) => b.status === 'confirmed' && (b.date > TODAY || (b.date === TODAY && b.time + b.mins / 60 > nowH()));
  const sortByWhen = (a, b) => a.date === b.date ? a.time - b.time : a.date < b.date ? -1 : 1;
  const nextBooking = () => bookings.filter(upcoming).sort(sortByWhen)[0] || null;
  const lastBooking = () => bookings.filter((b) => b.status !== 'cancelled').sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  function remember(b) { const i = bookings.findIndex((x) => x.ref === b.ref); i >= 0 ? (bookings[i] = b) : bookings.push(b); saveBookings(); }

  /* ---------- navigation ---------- */
  function go(name) {
    scr = name;
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('on'));
    $('s-' + name).classList.add('on');
    $('fill').style.width = PROG[name] + '%';
    window.scrollTo({ top: 0, behavior: 'instant' });
    draw();
    const h = $('h-' + name); if (h) h.focus({ preventScroll: true });
  }
  let toastTimer;
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms || 3200);
  }
  function busyButton(on, label) {
    const btn = document.querySelector('#cta .cta'); if (!btn) return;
    btn.disabled = on; btn.classList.toggle('busy', on); if (label) btn.textContent = label;
  }

  /* ---------- home ---------- */
  function drawHome() {
    const st = openStatus();
    const pill = `<span class="dot"></span>${esc(st.text)}`;
    ['pill-m', 'pill-d'].forEach((id) => { const el = $(id); el.innerHTML = pill; el.classList.toggle('shut', !st.open); });
    $('strip').innerHTML = st.open
      ? `<div class="tile"><b><span class="pulse"></span>~${waitEstimate()} min</b><span>Estimated walk-in wait</span></div>
         <div class="tile"><b>${esc(staff().filter((b) => !busyNow(b)).length)} of ${staff().length}</b><span>Barbers free right now</span></div>`
      : `<div class="tile"><b>${esc(st.text.replace('Closed · ', ''))}</b><span>Book ahead below</span></div>
         <div class="tile"><b>${C.daysAhead} days</b><span>Bookable ahead</span></div>`;

    const nb = nextBooking(), lb = lastBooking();
    let cards = '';
    if (nb) {
      const b = barberById(nb.barberId);
      cards += `<div class="card upnext"><p class="eyebrow">Your next visit</p>
        <div class="rc"><span>When</span><b>${esc(shortDate(nb.date))}, ${fmt(nb.time)}</b></div>
        <div class="rc"><span>With</span><b>${esc(b ? b.name : '')}</b></div>
        <div class="rc"><span>${esc(nb.services.map((id) => (svcById(id) || {}).name).filter(Boolean).join(', '))}</span><b>$${nb.total}</b></div>
        <div class="bk-actions"><button class="btn2" type="button" data-go="bookings">Manage</button></div></div>`;
    }
    if (lb) {
      const b = barberById(lb.requestedAny ? 'any' : lb.barberId);
      const names = lb.services.map((id) => (svcById(id) || {}).name).filter(Boolean).join(' + ');
      if (b && names) cards += `<button class="row" type="button" id="usual"><div class="av">↻</div>
        <div class="rowmain"><b>Book my usual</b><span>${esc(names)} with ${esc(first(b))} · ${lb.mins} min</span></div></button>`;
    }
    if (AI && (!online || FEATURES.ai)) cards += `<button class="row" type="button" data-go="look"><div class="av ai">✦</div>
      <div class="rowmain"><b>Not sure what to get?</b><span>Add a photo, get looks that suit you and the right barber</span></div></button>`;
    cards += `<a class="row" href="${mapsUrl()}" target="_blank" rel="noopener"><div class="av">📍</div>
      <div class="rowmain"><b>${esc(C.address.split(',')[0])}, ${esc(C.suburb)}</b><span>Tap for directions</span></div></a>`;
    cards += waRow('Got a question?');
    if (bookings.length) cards += `<button class="txt" type="button" data-go="bookings">My bookings</button>`;
    $('home-cards').innerHTML = cards;

    $('gallery').innerHTML = (C.images.gallery || []).map((p) => `<figure>${imgTag(p, 400, 300)}</figure>`).join('');
    const pairs = C.images.beforeAfter || [];
    $('ba-wrap').hidden = !pairs.length;
    $('ba').innerHTML = pairs.map((p, i) => `<figure>
      <div class="cmp">
        ${imgTag(p.before, 600, 450, 'before')}${imgTag(p.after, 600, 450, 'after')}
        <span class="tagl b">Before</span><span class="tagl a">After</span>
        <div class="line"></div><div class="knob">‹›</div>
        <input type="range" min="0" max="100" value="50" aria-label="Compare before and after${p.caption ? ': ' + esc(p.caption) : ''}">
      </div>
      ${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}</figure>`).join('');
    $('home-foot').innerHTML = footer();
    $('rail-foot').innerHTML = footer();
  }
  const modeNote = () => API && !online ? `<br><span class="muted">Demo mode: live availability unavailable, bookings stay on this device.</span>` : '';
  const footer = () => `<b>${esc(C.address)}</b>${esc(C.hoursText)}<br><a href="tel:${esc(C.phone)}">${esc(C.phoneDisplay)}</a>${waUrl() ? ` · <a href="${waUrl()}" target="_blank" rel="noopener">WhatsApp</a>` : ''}${modeNote()}`;
  const mapsUrl = () => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(C.name + ', ' + C.address)}`;
  /* WhatsApp click-to-chat. Works on phones with the app and on desktop via WhatsApp Web. */
  const waUrl = (msg) => { const n = String(C.whatsapp || '').replace(/\D/g, ''); return n ? `https://wa.me/${n}?text=${encodeURIComponent(msg || C.whatsappMessage || '')}` : ''; };
  const WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 1.8a8.2 8.2 0 1 1-4.2 15.3l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 0 1 12 3.8zm-3.2 4.4c-.2 0-.5 0-.7.3-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.2 5 4.4 2.5 1 3 .8 3.5.7.5 0 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3l-2-1c-.3-.1-.5-.1-.7.2l-.9 1.1c-.2.2-.3.2-.6.1a6.7 6.7 0 0 1-3.4-3c-.3-.4 0-.5.1-.7l.5-.6.3-.5c.1-.2 0-.4 0-.5l-.9-2.2c-.2-.5-.4-.5-.6-.5h-.6z"/></svg>';
  const waRow = (title, msg) => waUrl() ? `<a class="row" href="${waUrl(msg)}" target="_blank" rel="noopener"><div class="av wa">${WA_ICON}</div>
      <div class="rowmain"><b>${esc(title)}</b><span>Chat with us on WhatsApp</span></div></a>` : '';

  /* ---------- photos & video ----------
     Uploader state is keyed by purpose: "before" (the booking being made),
     "before:REF" / "after:REF" (an existing booking). Each key holds the
     uploaded media {id, url, contentType}. */
  const UP = {};
  const up = (key) => UP[key] || (UP[key] = { items: [], busy: false });
  const isVideo = (m) => (m.contentType || '').startsWith('video/');
  const thumb = (m, rm) => `<div class="th">${isVideo(m)
    ? `<video src="${esc(m.url)}#t=0.5" muted playsinline preload="metadata"></video><span class="play">▶</span>`
    : `<img src="${esc(m.url)}" alt="" loading="lazy">`}${rm ? `<button type="button" class="rm" data-rm="${esc(rm)}" aria-label="Remove">×</button>` : ''}</div>`;
  function drawUploader(key) {
    document.querySelectorAll(`[data-uploader="${key}"]`).forEach((el) => {
      if (!online) { el.innerHTML = `<p class="note">Photo upload needs the live booking service, which is unavailable right now.</p>`; return; }
      const u = up(key), attached = key.includes(':') && FEATURES.media;
      el.innerHTML = `<div class="thumbs">${u.items.map((m, i) => thumb(m, attached ? '' : `${key}:${i}`)).join('')}
        <label class="th add ${u.busy ? 'busy' : ''}"><input type="file" accept="image/*,video/*" multiple hidden data-files="${esc(key)}" ${u.busy ? 'disabled' : ''}>
          <span>${u.busy ? '<span class="spin"></span>' + (FEATURES.media ? 'Uploading' : 'Adding') : '+ Photo or video'}</span></label></div>
        ${FEATURES.media ? '' : '<p class="note muted" style="margin-top:6px">Preview only in this demo: photos stay on your device.</p>'}`;
    });
  }
  /* Storage off: keep the file in the browser and show it, nothing is sent. */
  const localItem = (blob, fromVideo) => ({ id: null, local: true, fromVideo: !!fromVideo, url: URL.createObjectURL(blob), contentType: blob.type });
  async function shrinkImage(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { throw new Error("That image format isn't supported here. Try a JPG or PNG."); }
    const max = 1024, s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); if (bmp.close) bmp.close();
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  }
  async function videoFrames(file, n) {
    const url = URL.createObjectURL(file), v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("Couldn't read that video. Try an MP4 or MOV.")); });
    const c = document.createElement('canvas'), s = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    const out = [], dur = Number.isFinite(v.duration) ? v.duration : 4;
    for (let i = 0; i < n; i++) {
      v.currentTime = Math.max(0, Math.min(dur * (i / n) + 0.15, dur - 0.05));
      await new Promise((r) => { v.onseeked = r; });
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      out.push(await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)));
    }
    URL.revokeObjectURL(url);
    return out.filter(Boolean);
  }
  async function uploadBlob(blob, kind) {
    const r = await fetch(`/api/uploads?kind=${kind}`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Upload failed');
    return d;
  }
  async function addFiles(key, files) {
    const u = up(key), [kind, ref] = key.split(':');
    u.busy = true; drawUploader(key);
    try {
      for (const f of files) {
        const added = [], send = FEATURES.media ? (b) => uploadBlob(b, kind) : (b, v) => localItem(b, v);
        if (f.type.startsWith('video/')) {
          if (f.size > C.media.maxVideoMB * 1048576) throw new Error(`Videos must be under ${C.media.maxVideoMB} MB`);
          for (const b of await videoFrames(f, 4)) added.push({ ...(await send(b, true)), fromVideo: true });
          added.push(await send(f));
        } else if (f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)) {
          added.push(await send(await shrinkImage(f)));
        } else throw new Error('Choose a photo or a video.');
        u.items.push(...added);
        if (ref && FEATURES.media) {   // existing booking: attach straight away
          const r = await api(`/api/bookings/${encodeURIComponent(ref)}/media`, { method: 'POST', body: { kind, ids: added.map((m) => m.id) } });
          remember(r.booking);
        }
      }
    } catch (e) { toast(e.message, 5000); }
    u.busy = false; drawUploader(key);
  }
  const attachedMedia = (b) => (b.beforeMedia || []).length || (b.afterMedia || []).length
    ? `<div class="media-row">${[['beforeMedia', 'Before'], ['afterMedia', 'After']].map(([k, label]) => (b[k] || []).length
        ? `<div><small>${label}</small><div class="thumbs sm">${b[k].map((m) => thumb(m)).join('')}</div></div>` : '').join('')}</div>` : '';

  /* ---------- AI look advisor ---------- */
  function drawLook() {
    drawUploader('before');
    $('look-privacy').textContent = C.media.note;
    if (LOOK) drawAdvice(); else if (!online) $('look-result').innerHTML = `<p class="empty">The advisor needs the live booking service, which is unavailable right now.</p>`;
  }
  async function getAdvice() {
    let description = $('look-desc').value.trim();
    const items = up('before').items.filter((m) => !isVideo(m)), photos = items.map((m) => m.id).filter(Boolean).slice(0, C.ai.maxPhotos);
    if (items.length && !photos.length && description.length < 10) description = 'Suggest what suits my hair.';   // demo storage: photos never leave the device
    if (!photos.length && description.length < 10) { toast('Add a photo of your hair, or describe the look you want.'); return; }
    busyButton(true, 'Looking at your hair…');
    $('look-result').innerHTML = `<p class="empty"><span class="spin"></span>Working out what suits you. This takes about half a minute.</p>`;
    try {
      const r = await api('/api/advice', { method: 'POST', body: { photoIds: photos, description } });
      LOOK = { ...r.advice, description: $('look-desc').value.trim(), demo: !!r.demo }; drawAdvice();
    } catch (e) { $('look-result').innerHTML = ''; toast(e.message, 6000); }
    busyButton(false, 'Get suggestions');
  }
  function drawAdvice() {
    const a = LOOK;
    $('look-result').innerHTML = `${a.demo ? `<p class="note muted">Sample suggestions for demonstration. Live analysis of your photos switches on when the shop connects its AI key.</p>` : ''}
      <div class="card"><p class="eyebrow">What we see</p><p class="advice">${esc(a.analysis)}</p></div>
      <p class="lbl">Looks that would suit you</p>
      ${a.suggestions.map((s, i) => {
        const svcs = s.serviceIds.map(svcById).filter(Boolean), bs = s.barberIds.map(barberById).filter((b) => b && !b.any);
        const m = svcs.reduce((t, x) => t + x.mins, 0);
        return `<div class="card sug"><b>${esc(s.name)}</b><p>${esc(s.description)}</p><p class="why">${esc(s.why)}</p>
          ${s.maintenance ? `<p>${esc(s.maintenance)}</p>` : ''}
          ${svcs.length ? `<div class="rc" style="margin-top:8px"><span>${esc(svcs.map((x) => x.name).join(' + '))}</span><b>${m} min</b></div>` : ''}
          ${bs.length && svcs.length ? bs.map((b) => `<button class="row" type="button" data-book="${i}:${esc(b.id)}">
            <div class="av">${esc(b.initials)}${b.photo ? imgTag(b.photo, 120, 120, '', true) : ''}</div>
            <div class="rowmain"><b>Book with ${esc(b.name)}</b><span>${esc(b.note)}</span></div>
            <div class="price">$${svcs.reduce((t, x) => t + price(x, b), 0)}</div></button>`).join('')
          : `<p class="note">Ask for this in the chair, or <button class="txt" type="button" data-go="barber" style="display:inline;width:auto;padding:0">pick a barber</button>.</p>`}
        </div>`; }).join('')}
      ${a.tellBarber ? `<div class="card"><p class="eyebrow">Tell your barber</p><p class="advice">“${esc(a.tellBarber)}”</p></div>` : ''}
      <p class="note">Suggestions come from an AI looking at your photos and your description. Your barber has the final say in the chair.</p>`;
  }
  function bookSuggestion(i, barberId) {
    const s = LOOK.suggestions[i]; if (!s) return;
    S.barber = barberById(barberId); S.svc = s.serviceIds.map(svcById).filter(Boolean); S.time = null; S.editing = null;
    S.look = { description: LOOK.description, advice: `${s.name}. ${s.description}` };
    go('time');
  }

  /* ---------- step 1: barber ---------- */
  function drawBarbers() {
    $('barbers').innerHTML = C.barbers.map((b) => {
      const off = (b.daysOff || []).map((d) => new Date(2024, 0, 7 + d).toLocaleDateString(C.locale, { weekday: 'long' }) + 's');
      const nf = nextFree(b);
      return `<button class="row ${S.barber && S.barber.id === b.id ? 'sel' : ''}" type="button" data-barber="${b.id}">
        <div class="av lg">${esc(b.initials)}${b.photo ? imgTag(b.photo, 160, 160, '', true) : ''}</div>
        <div class="rowmain"><b>${esc(b.name)}${off.length ? `<span class="tag">Off ${esc(off.join(', '))}</span>` : ''}</b>
          <span>${esc(b.note)} · <span class="${nf.startsWith('Today') ? 'free' : ''}">next ${esc(nf)}</span></span></div>
        <div class="price">$${b.base}+</div></button>`;
    }).join('');
  }
  function pickBarber(id) { S.barber = barberById(id); S.svc = []; S.time = null; drawBarbers(); bar(); live(); }

  /* ---------- step 2: services ---------- */
  function drawServices() {
    $('h-services').textContent = S.barber.any ? 'Choose services' : 'Services with ' + first(S.barber);
    $('services').innerHTML = C.services.map((s) => `
      <button class="row" type="button" aria-pressed="${S.svc.includes(s)}" data-svc="${s.id}">
        <div class="tick"></div>
        <div class="thumb">${imgTag(s.photo, 160, 160)}</div>
        <div class="rowmain"><b>${esc(s.name)}</b><span>${esc(s.desc)} · ${s.mins} min</span></div>
        <div class="price">${money(price(s, S.barber), S.barber)}</div></button>`).join('');
  }
  function pickService(id) {
    const s = svcById(id);
    S.svc.includes(s) ? S.svc.splice(S.svc.indexOf(s), 1) : S.svc.push(s);
    S.time = null; drawServices(); bar(); live();
  }

  /* ---------- step 3: time ---------- */
  function drawTime() {
    const editing = !!S.editing;
    $('time-step').textContent = editing ? 'Rescheduling' : 'Step 3 of 4';
    $('h-time').textContent = editing ? 'Pick a new time' : 'Pick a time';
    $('time-back').dataset.go = editing ? 'bookings' : 'services';
    const old = document.querySelector('.editing'); if (old) old.remove();
    if (editing) {
      const b = bookings.find((x) => x.ref === S.editing);
      $('dates').insertAdjacentHTML('beforebegin', `<div class="editing">Moving booking ${esc(b.ref)}, currently ${esc(shortDate(b.date))} at ${fmt(b.time)}.</div>`);
    }
    const need = mins() / 60;
    if (!slotsFor(S.barber, S.date, need).length) { const k = DAYS.find((x) => slotsFor(S.barber, x, need).length); if (k) { S.date = k; S.time = null; } }
    const shown = DAYS.slice(0, window.innerWidth >= 900 ? 8 : DAYS.length);
    $('dates').innerHTML = shown.map((k) => {
      const d = fromKey(k), shut = !hoursFor(d) || !slotsFor(S.barber, k, need).length;
      return `<button class="chip ${S.date === k ? 'sel' : ''}" type="button" role="tab" aria-selected="${S.date === k}" ${shut ? 'disabled' : ''} data-date="${k}">
        <small>${k === TODAY ? 'Today' : d.toLocaleDateString(C.locale, { weekday: 'short' })}</small><b>${d.getDate()}</b></button>`;
    }).join('');
    const list = slotsFor(S.barber, S.date, need);
    $('times').innerHTML = list.length
      ? ['Morning', 'Afternoon', 'Evening'].map((part) => {
          const g = list.filter((t) => part === 'Morning' ? t < 12 : part === 'Afternoon' ? t >= 12 && t < 17 : t >= 17);
          return g.length ? `<p class="lbl">${part}</p><div class="slots">${g.map((t) => `<button class="slot ${S.time === t ? 'sel' : ''}" type="button" data-time="${t}" aria-pressed="${S.time === t}">${fmt(t)}</button>`).join('')}</div>` : '';
        }).join('')
      : `<p class="empty">${hoursFor(fromKey(S.date)) ? `${esc(first(S.barber))} has nothing free that fits ${mins()} minutes on this day.` : 'The shop is closed on this day.'}<br>Try another date.</p>`;
  }
  function pickDate(k) { S.date = k; S.time = null; drawTime(); bar(); live(); }
  function pickTime(t) { S.time = t; drawTime(); bar(); live(); }

  /* ---------- receipts ---------- */
  function lines(b) {
    const who = barberById(b.barberId);
    return `<div class="rc"><span>When</span><b>${esc(longDate(b.date))}, ${fmt(b.time)}</b></div>
      <div class="rc"><span>Barber</span><b>${esc(who ? who.name : '')}</b></div>
      ${b.services.map((id) => { const s = svcById(id); return s ? `<div class="rc"><span>${esc(s.name)}</span><b>${money(price(s, who), who)}</b></div>` : ''; }).join('')}
      <div class="rc"><span>Total · ${b.mins} min</span><b>${money(b.total, who)}</b></div>
      ${b.ref ? `<div class="rc ref"><span>Reference</span><b>${esc(b.ref)}</b></div>` : ''}`;
  }
  /* What we intend to book. In API mode the server assigns "Any barber" and prices it. */
  const draft = () => ({
    barberId: S.barber.any && !online ? assign(S.date, S.time, mins() / 60).id : S.barber.id,
    requestedAny: !!S.barber.any, services: S.svc.map((s) => s.id), date: S.date, time: S.time, mins: mins(), total: total(),
    beforeMedia: up('before').items.map((m) => m.id).filter(Boolean),
    lookRequest: S.look ? S.look.description : '', aiAdvice: S.look ? S.look.advice : '',
  });
  function priced(b) { const who = barberById(b.barberId); b.total = b.services.reduce((t, id) => t + price(svcById(id), who), 0); return b; }

  function live() {
    const el = $('live');
    if (!S.barber || scr === 'home' || scr === 'bookings' || scr === 'done') { el.innerHTML = ''; return; }
    el.innerHTML = `<h3>Your booking so far</h3>
      <div class="rc"><span>Barber</span><b>${esc(S.barber.name)}</b></div>
      ${S.svc.map((s) => `<div class="rc"><span>${esc(s.name)}</span><b>${money(price(s, S.barber), S.barber)}</b></div>`).join('')}
      ${S.time ? `<div class="rc"><span>When</span><b>${esc(shortDate(S.date))}, ${fmt(S.time)}</b></div>` : ''}
      ${S.svc.length ? `<div class="rc"><span>Total · ${mins()} min</span><b>${money(total(), S.barber)}</b></div>` : ''}`;
  }

  /* ---------- step 4: details & confirm ---------- */
  const FIELDS = [
    ['nm', (x) => x.trim().length > 1],
    ['ph', (x) => /^(\+?61|0)4\d{8}$/.test(x.replace(/[\s-]/g, ''))],
    ['em', (x) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x.trim())],
  ];
  function validate() {
    let ok = true;
    FIELDS.forEach(([id, test]) => {
      const el = $(id), good = test(el.value);
      el.setAttribute('aria-invalid', String(!good));
      $('e-' + id).classList.toggle('on', !good);
      if (!good && ok) { el.focus(); ok = false; }
    });
    return ok;
  }
  const newRef = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', a = new Uint8Array(6);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.random() * 256));
    return C.refPrefix + '-' + Array.from(a, (n) => chars[n % chars.length]).join('');
  };
  /* Demo-mode webhook. In API mode the Worker notifies instead. */
  async function send(b) {
    if (online || !C.bookingEndpoint) return true;
    try { const r = await fetch(C.bookingEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return r.ok; }
    catch (e) { return false; }
  }
  function apiFailed(e) {
    toast(e.message, 5000);
    if (e.status === 409) { loadAvailability(); go('time'); }
  }
  async function confirmBooking() {
    if (!validate()) return;
    const customer = { name: $('nm').value.trim(), phone: $('ph').value.trim(), email: $('em').value.trim() };
    const notes = $('nt').value.trim();
    store.set(KEY_C, customer);
    busyButton(true, 'Confirming…');
    let b;
    if (online) {
      try { b = (await api('/api/bookings', { method: 'POST', body: { ...draft(), ...customer, notes } })).booking; }
      catch (e) { busyButton(false, 'Confirm booking'); apiFailed(e); return; }
      loadAvailability();
    } else {
      const d = draft();
      if (!freeAt(barberById(d.barberId), S.date, S.time, mins() / 60)) { busyButton(false, 'Confirm booking'); toast('That time was just taken. Pick another.'); go('time'); return; }
      b = priced({ ...d, beforeMedia: [], afterMedia: [], ref: newRef(), status: 'confirmed', createdAt: Date.now(), notes, ...customer });
      if (!(await send({ event: 'booking.created', shop: C.name, ...b }))) toast(`Saved on this device, but we couldn't reach the shop. Please call ${C.phoneDisplay} to confirm.`, 6000);
    }
    remember(b); S.last = b; S.editing = null;
    go('done');
  }
  async function commitReschedule() {
    const b = bookings.find((x) => x.ref === S.editing); if (!b) return;
    busyButton(true, 'Moving…');
    if (online) {
      let nb;
      try { nb = (await api(`/api/bookings/${encodeURIComponent(b.ref)}`, { method: 'PATCH', body: { date: S.date, time: S.time } })).booking; }
      catch (e) { busyButton(false, 'Confirm new time'); apiFailed(e); return; }
      Object.assign(b, nb); loadAvailability();
    } else {
      const d = draft(); b.date = d.date; b.time = d.time; b.barberId = d.barberId; priced(b); b.updatedAt = Date.now();
      if (!(await send({ event: 'booking.rescheduled', shop: C.name, ...b }))) toast(`Moved on this device, but we couldn't reach the shop. Please call ${C.phoneDisplay} to confirm.`, 6000);
    }
    saveBookings(); S.last = b; S.editing = null; b.moved = true;
    go('done');
  }

  /* ---------- done ---------- */
  function drawDone() {
    const b = S.last; if (!b) { go('home'); return; }
    const who = barberById(b.barberId);
    $('h-done').textContent = b.moved ? 'Moved' : "Chair's yours";
    $('doneline').textContent = `${longDate(b.date)} at ${fmt(b.time)} with ${who.name}. ` + (b.email ? `We've noted ${b.email} for your confirmation.` : '');
    $('done-body').innerHTML = `<div class="card">${lines(b)}${attachedMedia(b)}${b.aiAdvice ? `<p class="note">Your barber will see the look you chose: ${esc(b.aiAdvice.split('. ')[0])}.</p>` : ''}</div>
      <button class="row" type="button" id="ics"><div class="av">📅</div><div class="rowmain"><b>Add to calendar</b><span>Apple, Outlook and others · reminder the night before</span></div></button>
      <a class="row" href="${gcalUrl(b)}" target="_blank" rel="noopener"><div class="av">G</div><div class="rowmain"><b>Add to Google Calendar</b><span>Opens in a new tab</span></div></a>
      <a class="row" href="${mapsUrl()}" target="_blank" rel="noopener"><div class="av">📍</div><div class="rowmain"><b>Get directions</b><span>${esc(C.address)}</span></div></a>
      ${waRow('Running late or need to ask something?', `Hi ${C.name}, about my booking ${b.ref} on ${shortDate(b.date)} at ${fmt(b.time)}: `)}
      <button class="txt" type="button" data-go="bookings">Reschedule or cancel</button>`;
    delete b.moved;
  }
  const stamp = (k, h) => { const H = Math.floor(h), m = Math.round((h - H) * 60); return k.replace(/-/g, '') + 'T' + pad(H) + pad(m) + '00'; };
  const summary = (b) => `${b.services.map((id) => svcById(id).name).join(' + ')} with ${barberById(b.barberId).name} at ${C.name}`;
  function gcalUrl(b) {
    const p = new URLSearchParams({ action: 'TEMPLATE', text: summary(b), dates: `${stamp(b.date, b.time)}/${stamp(b.date, b.time + b.mins / 60)}`, location: C.address, details: `Booking ${b.ref}. ${C.paymentNote}`, ctz: C.timezone });
    return 'https://calendar.google.com/calendar/render?' + p.toString();
  }
  function downloadIcs(b) {
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${C.name}//Booking//EN`, 'BEGIN:VEVENT',
      `UID:${b.ref}@${location.hostname || 'salon'}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`,
      `DTSTART:${stamp(b.date, b.time)}`, `DTEND:${stamp(b.date, b.time + b.mins / 60)}`,
      `SUMMARY:${summary(b)}`, `LOCATION:${C.address}`, `DESCRIPTION:Booking ${b.ref}. ${C.paymentNote}`,
      'BEGIN:VALARM', 'TRIGGER:-PT18H', 'ACTION:DISPLAY', `DESCRIPTION:${C.name} tomorrow at ${fmt(b.time)}`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${C.refPrefix}-${b.date}.ics` });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------- my bookings ---------- */
  function drawBookings() {
    const upList = bookings.filter(upcoming).sort(sortByWhen), rest = bookings.filter((b) => !upcoming(b)).sort(sortByWhen).reverse();
    const started = (b) => b.date < TODAY || (b.date === TODAY && b.time <= nowH());
    const card = (b, past) => {
      const who = barberById(b.barberId), live = b.status === 'confirmed';
      const key = `${started(b) ? 'after' : 'before'}:${b.ref}`;
      if (live && online) { const u = up(key); if (!u.items.some((m) => m.local)) u.items = b[started(b) ? 'afterMedia' : 'beforeMedia'] || []; }
      return `<div class="card bk ${past ? 'past' : ''}"><div class="when">${esc(shortDate(b.date))}, ${fmt(b.time)}${b.status === 'cancelled' ? '<span class="tag off">Cancelled</span>' : past ? '<span class="tag">Past</span>' : ''}</div>
        <div class="meta">${esc(b.services.map((id) => (svcById(id) || {}).name).filter(Boolean).join(' + '))} with ${esc(who ? who.name : '')} · $${b.total} · ${b.mins} min<br>Ref ${esc(b.ref)}</div>
        ${live && started(b) && (b.beforeMedia || []).length ? `<div class="media-row"><div><small>Before</small><div class="thumbs sm">${b.beforeMedia.map((m) => thumb(m)).join('')}</div></div></div>` : ''}
        ${live && online ? `<p class="lbl" style="margin-top:12px">${started(b) ? 'Your after photos' : 'Your hair now'} <span class="hint">${started(b) ? 'show off the result' : 'helps the barber plan'}</span></p><div data-uploader="${key}"></div>` : attachedMedia(b)}
        ${past ? '' : `<div class="bk-actions"><button class="btn2" type="button" data-move="${esc(b.ref)}">Reschedule</button><button class="btn2 danger" type="button" data-cancel="${esc(b.ref)}">Cancel</button></div>`}</div>`;
    };
    $('bookings').innerHTML = (upList.length ? upList.map((b) => card(b, false)).join('') : `<p class="empty">No upcoming bookings on this device.</p>`)
      + (rest.length ? `<p class="lbl">Earlier</p>` + rest.map((b) => card(b, true)).join('') : '')
      + `<p class="note">Free cancellation up to ${C.cancelHours} hours before. Inside that window, call the shop on <a href="tel:${esc(C.phone)}">${esc(C.phoneDisplay)}</a>.</p>`;
    bookings.forEach((b) => { if (b.status === 'confirmed') drawUploader(`${started(b) ? 'after' : 'before'}:${b.ref}`); });
  }
  /* API mode: refresh this device's upcoming bookings from the server, in case the shop changed them. */
  async function syncBookings() {
    if (!online) return;
    const up = bookings.filter(upcoming); if (!up.length) return;
    let changed = false;
    await Promise.all(up.map(async (b) => {
      try { const r = await api(`/api/bookings/${encodeURIComponent(b.ref)}`); if (JSON.stringify(r.booking) !== JSON.stringify(b)) { Object.assign(b, r.booking); changed = true; } }
      catch (e) { if (e.status === 404) { b.status = 'cancelled'; changed = true; } }
    }));
    if (changed) { saveBookings(); if (scr === 'bookings') drawBookings(); if (scr === 'home') drawHome(); }
  }
  function startReschedule(ref) {
    const b = bookings.find((x) => x.ref === ref); if (!b) return;
    S.editing = ref; S.barber = barberById(b.requestedAny ? 'any' : b.barberId); S.svc = b.services.map(svcById).filter(Boolean);
    S.date = b.date >= TODAY ? b.date : TODAY; S.time = null; go('time');
  }
  async function cancelBooking(ref) {
    const b = bookings.find((x) => x.ref === ref); if (!b) return;
    const hoursAway = (fromKey(b.date).getTime() + b.time * 3600000 - Date.now()) / 3600000;
    const msg = hoursAway < C.cancelHours ? `This is inside the ${C.cancelHours}-hour window. Cancel anyway?` : `Cancel your ${shortDate(b.date)} ${fmt(b.time)} booking?`;
    if (!window.confirm(msg)) return;
    if (online) {
      try { Object.assign(b, (await api(`/api/bookings/${encodeURIComponent(b.ref)}`, { method: 'DELETE' })).booking); }
      catch (e) { toast(e.message, 5000); return; }
      saveBookings(); toast('Booking cancelled.'); loadAvailability();
    } else {
      b.status = 'cancelled'; b.cancelledAt = Date.now(); saveBookings();
      const sent = await send({ event: 'booking.cancelled', shop: C.name, ...b });
      toast(sent ? 'Booking cancelled.' : `Cancelled on this device. Please also call ${C.phoneDisplay}.`, sent ? 3000 : 6000);
    }
    drawBookings();
  }

  /* ---------- bottom bar ---------- */
  function bar() {
    const b = $('cta');
    const sum = (t) => `<div class="sum"><span>${t}</span><b>${money(total(), S.barber)} · ${mins()} min</b></div>`;
    if (scr === 'home') b.innerHTML = `<button class="cta" type="button" data-go="barber">Book an appointment</button>`;
    else if (scr === 'look') b.innerHTML = `<button class="cta" type="button" id="advise" ${online ? '' : 'disabled'}>${online ? 'Get suggestions' : 'Advisor unavailable'}</button>`;
    else if (scr === 'barber') b.innerHTML = `<button class="cta" type="button" ${S.barber ? '' : 'disabled'} data-go="services">${S.barber ? 'Continue with ' + esc(first(S.barber)) : 'Pick a barber'}</button>`;
    else if (scr === 'services') b.innerHTML = (S.svc.length ? sum(S.svc.length + ' selected') : '') + `<button class="cta" type="button" ${S.svc.length ? '' : 'disabled'} data-go="time">${S.svc.length ? 'Pick a time' : 'Choose a service'}</button>`;
    else if (scr === 'time') b.innerHTML = sum(S.time ? fmt(S.time) : 'No time picked') + (S.editing
      ? `<button class="cta" type="button" ${S.time ? '' : 'disabled'} id="move">${S.time ? 'Confirm new time' : 'Pick a time'}</button>`
      : `<button class="cta" type="button" ${S.time ? '' : 'disabled'} data-go="details">${S.time ? 'Continue' : 'Pick a time'}</button>`);
    else if (scr === 'details') b.innerHTML = sum('Due at the shop') + `<button class="cta" type="submit" form="form">Confirm booking</button>`;
    else if (scr === 'done') b.innerHTML = `<button class="cta" type="button" id="finish">Done</button>`;
    else b.innerHTML = `<button class="cta" type="button" data-go="barber">Book another</button>`;
  }

  function draw() {
    if (scr === 'home') drawHome();
    if (scr === 'barber') drawBarbers();
    if (scr === 'services') drawServices();
    if (scr === 'time') drawTime();
    if (scr === 'look') drawLook();
    if (scr === 'details') { $('receipt').innerHTML = lines({ ...draft() }); $('pay-note').textContent = C.paymentNote; $('details-photos').hidden = !online; drawUploader('before'); }
    if (scr === 'done') drawDone();
    if (scr === 'bookings') { drawBookings(); syncBookings(); }
    bar(); live();
  }
  function reset() { S.barber = null; S.svc = []; S.date = TODAY; S.time = null; S.editing = null; S.look = null; LOOK = null; up('before').items = []; if ($('look-desc')) $('look-desc').value = ''; go('home'); }

  /* ---------- events (delegated) ---------- */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-go],[data-barber],[data-svc],[data-date],[data-time],[data-move],[data-cancel],[data-rm],[data-book],#usual,#move,#finish,#ics,#advise');
    if (!el) return;
    const d = el.dataset;
    if (d.go) { if (d.go === 'home') reset(); else go(d.go); }
    else if (d.rm) { const i = d.rm.lastIndexOf(':'); up(d.rm.slice(0, i)).items.splice(Number(d.rm.slice(i + 1)), 1); drawUploader(d.rm.slice(0, i)); }
    else if (d.book) { const i = d.book.indexOf(':'); bookSuggestion(Number(d.book.slice(0, i)), d.book.slice(i + 1)); }
    else if (el.id === 'advise') getAdvice();
    else if (d.barber) pickBarber(d.barber);
    else if (d.svc) pickService(d.svc);
    else if (d.date) pickDate(d.date);
    else if (d.time) pickTime(Number(d.time));
    else if (d.move) startReschedule(d.move);
    else if (d.cancel) cancelBooking(d.cancel);
    else if (el.id === 'usual') { const lb = lastBooking(); S.barber = barberById(lb.requestedAny ? 'any' : lb.barberId); S.svc = lb.services.map(svcById).filter(Boolean); S.date = TODAY; S.time = null; S.editing = null; go('time'); }
    else if (el.id === 'move') commitReschedule();
    else if (el.id === 'finish') reset();
    else if (el.id === 'ics') downloadIcs(S.last);
  });
  document.addEventListener('input', (e) => {
    const r = e.target.closest('.cmp input[type=range]'); if (r) r.parentElement.style.setProperty('--x', r.value + '%');
  });
  document.addEventListener('change', (e) => {
    const f = e.target.closest('input[data-files]'); if (!f || !f.files.length) return;
    const files = [...f.files]; f.value = ''; addFiles(f.dataset.files, files);
  });
  $('form').addEventListener('submit', (e) => { e.preventDefault(); confirmBooking(); });
  ['nm', 'ph', 'em'].forEach((id) => $(id).addEventListener('input', () => { $(id).setAttribute('aria-invalid', 'false'); $('e-' + id).classList.remove('on'); }));
  $('ph').addEventListener('input', (e) => {
    let d = e.target.value.replace(/\D/g, ''); if (d.startsWith('61')) d = '0' + d.slice(2); d = d.slice(0, 10);
    e.target.value = d.replace(/(\d{4})(\d{0,3})(\d{0,3})/, (_, a, b, c) => [a, b, c].filter(Boolean).join(' '));
  });
  let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (scr === 'time') drawTime(); }, 150); });

  /* ---------- init ---------- */
  document.title = `${C.name} ${C.suburb} — Book a chair`;
  $('rail-name').textContent = `${C.name} ${C.suburb}`;
  $('rail-blurb').textContent = C.blurb;
  $('rail-foot').innerHTML = footer();
  $('h-home').textContent = C.tagline;
  $('hero-blurb').textContent = C.blurb;
  const hero = $('hero-img'); hero.src = src(C.images.hero, 900, 700); hero.alt = C.images.hero.alt || ''; hero.onerror = () => hero.classList.add('broken');
  const rail = $('rail-bg'); rail.src = src(C.images.rail, 1200, 1600); rail.onerror = () => rail.classList.add('broken');
  const cust = store.get(KEY_C, null); if (cust) { $('nm').value = cust.name || ''; $('ph').value = cust.phone || ''; $('em').value = cust.email || ''; }
  setInterval(() => { if (scr === 'home') drawHome(); }, 60000);
  setInterval(loadAvailability, 90000);
  draw();
  loadAvailability().then(syncBookings);
})();
