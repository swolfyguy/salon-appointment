/* Faded Lines booking app. Configuration lives in config.js. */
(function () {
  'use strict';
  const C = window.SALON_CONFIG;
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
  let bookings = store.get(KEY_B, []);
  const saveBookings = () => store.set(KEY_B, bookings);

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
  const price = (s, b) => Math.round((b.base * s.mult) / 5) * 5;
  const first = (b) => b.name.split(' ')[0];

  /* ---------- availability ----------
     Demo availability is deterministic per barber per day, plus whatever this
     device has already booked. Replace busyBlocks() with a call to your booking
     backend when you have one. */
  const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  function busyBlocks(b, k) {
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
  const S = { barber: null, svc: [], date: TODAY, time: null, editing: null, last: null };
  let scr = 'home';
  const PROG = { home: 0, bookings: 0, barber: 25, services: 50, time: 75, details: 92, done: 100 };
  const total = () => (S.barber ? S.svc.reduce((t, s) => t + price(s, S.barber), 0) : 0);
  const mins = () => S.svc.reduce((t, s) => t + s.mins, 0);

  const upcoming = (b) => b.status === 'confirmed' && (b.date > TODAY || (b.date === TODAY && b.time + b.mins / 60 > nowH()));
  const sortByWhen = (a, b) => a.date === b.date ? a.time - b.time : a.date < b.date ? -1 : 1;
  const nextBooking = () => bookings.filter(upcoming).sort(sortByWhen)[0] || null;
  const lastBooking = () => bookings.filter((b) => b.status !== 'cancelled').sort((a, b) => b.createdAt - a.createdAt)[0] || null;

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
    cards += `<a class="row" href="${mapsUrl()}" target="_blank" rel="noopener"><div class="av">📍</div>
      <div class="rowmain"><b>${esc(C.address.split(',')[0])}, ${esc(C.suburb)}</b><span>Tap for directions</span></div></a>`;
    if (bookings.length) cards += `<button class="txt" type="button" data-go="bookings">My bookings</button>`;
    $('home-cards').innerHTML = cards;

    $('gallery').innerHTML = (C.images.gallery || []).map((p) => `<figure>${imgTag(p, 400, 300)}</figure>`).join('');
    $('home-foot').innerHTML = footer();
  }
  const footer = () => `<b>${esc(C.address)}</b>${esc(C.hoursText)}<br><a href="tel:${esc(C.phone)}">${esc(C.phoneDisplay)}</a>`;
  const mapsUrl = () => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(C.name + ', ' + C.address)}`;

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
        <div class="price">$${price(s, S.barber)}</div></button>`).join('');
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
      const d = fromKey(k), shut = !hoursFor(d) || !slotsFor(S.barber, k, mins() / 60).length;
      return `<button class="chip ${S.date === k ? 'sel' : ''}" type="button" role="tab" aria-selected="${S.date === k}" ${shut ? 'disabled' : ''} data-date="${k}">
        <small>${k === TODAY ? 'Today' : d.toLocaleDateString(C.locale, { weekday: 'short' })}</small><b>${d.getDate()}</b></button>`;
    }).join('');
    const list = slotsFor(S.barber, S.date, mins() / 60);
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
      ${b.services.map((id) => { const s = svcById(id); return s ? `<div class="rc"><span>${esc(s.name)}</span><b>$${price(s, who)}</b></div>` : ''; }).join('')}
      <div class="rc"><span>Total · ${b.mins} min</span><b>$${b.total}</b></div>
      ${b.ref ? `<div class="rc ref"><span>Reference</span><b>${esc(b.ref)}</b></div>` : ''}`;
  }
  const draft = () => ({
    barberId: S.barber.any ? assign(S.date, S.time, mins() / 60).id : S.barber.id,
    requestedAny: !!S.barber.any, services: S.svc.map((s) => s.id), date: S.date, time: S.time, mins: mins(),
    total: S.barber.any ? null : total(),
  });
  function priced(b) { const who = barberById(b.barberId); b.total = b.services.reduce((t, id) => t + price(svcById(id), who), 0); return b; }

  function live() {
    const el = $('live');
    if (!S.barber || scr === 'home' || scr === 'bookings' || scr === 'done') { el.innerHTML = ''; return; }
    el.innerHTML = `<h3>Your booking so far</h3>
      <div class="rc"><span>Barber</span><b>${esc(S.barber.name)}</b></div>
      ${S.svc.map((s) => `<div class="rc"><span>${esc(s.name)}</span><b>$${price(s, S.barber)}</b></div>`).join('')}
      ${S.time ? `<div class="rc"><span>When</span><b>${esc(shortDate(S.date))}, ${fmt(S.time)}</b></div>` : ''}
      ${S.svc.length ? `<div class="rc"><span>Total · ${mins()} min</span><b>$${total()}</b></div>` : ''}`;
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
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', a = new Uint8Array(5);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.random() * 256));
    return C.refPrefix + '-' + Array.from(a, (n) => chars[n % chars.length]).join('');
  };
  async function send(b) {
    if (!C.bookingEndpoint) return true;
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(C.bookingEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), signal: ctl.signal });
      return r.ok;
    } catch (e) { return false; } finally { clearTimeout(tm); }
  }
  async function confirmBooking() {
    if (!validate()) return;
    if (!freeAt(barberById(draft().barberId), S.date, S.time, mins() / 60)) { toast('That time was just taken. Pick another.'); go('time'); return; }
    const btn = document.querySelector('#cta .cta'); btn.disabled = true; btn.classList.add('busy'); btn.textContent = 'Confirming…';
    const customer = { name: $('nm').value.trim(), phone: $('ph').value.trim(), email: $('em').value.trim() };
    store.set(KEY_C, customer);
    const b = priced({ ...draft(), ref: newRef(), status: 'confirmed', createdAt: Date.now(), notes: $('nt').value.trim(), ...customer, shop: C.name });
    const sent = await send({ event: 'booking.created', ...b });
    bookings.push(b); saveBookings();
    S.last = b; S.editing = null;
    if (!sent) toast(`Saved on this device, but we couldn't reach the shop. Please call ${C.phoneDisplay} to confirm.`, 6000);
    go('done');
  }
  async function commitReschedule() {
    const b = bookings.find((x) => x.ref === S.editing); if (!b) return;
    const d = draft(); b.date = d.date; b.time = d.time; b.barberId = d.barberId; priced(b); b.updatedAt = Date.now();
    saveBookings(); S.last = b; S.editing = null; S.last.moved = true;
    const sent = await send({ event: 'booking.rescheduled', ...b });
    if (!sent) toast(`Moved on this device, but we couldn't reach the shop. Please call ${C.phoneDisplay} to confirm.`, 6000);
    go('done');
  }

  /* ---------- done ---------- */
  function drawDone() {
    const b = S.last; if (!b) { go('home'); return; }
    const who = barberById(b.barberId);
    $('h-done').textContent = b.moved ? 'Moved' : "Chair's yours";
    $('doneline').textContent = `${longDate(b.date)} at ${fmt(b.time)} with ${who.name}. ` + (b.email ? `We've noted ${b.email} for your confirmation.` : '');
    $('done-body').innerHTML = `<div class="card">${lines(b)}</div>
      <button class="row" type="button" id="ics"><div class="av">📅</div><div class="rowmain"><b>Add to calendar</b><span>Apple, Outlook and others · reminder the night before</span></div></button>
      <a class="row" href="${gcalUrl(b)}" target="_blank" rel="noopener"><div class="av">G</div><div class="rowmain"><b>Add to Google Calendar</b><span>Opens in a new tab</span></div></a>
      <a class="row" href="${mapsUrl()}" target="_blank" rel="noopener"><div class="av">📍</div><div class="rowmain"><b>Get directions</b><span>${esc(C.address)}</span></div></a>
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
    const up = bookings.filter(upcoming).sort(sortByWhen), rest = bookings.filter((b) => !upcoming(b)).sort(sortByWhen).reverse();
    const card = (b, past) => {
      const who = barberById(b.barberId);
      return `<div class="card bk ${past ? 'past' : ''}"><div class="when">${esc(shortDate(b.date))}, ${fmt(b.time)}${b.status === 'cancelled' ? '<span class="tag off">Cancelled</span>' : past ? '<span class="tag">Past</span>' : ''}</div>
        <div class="meta">${esc(b.services.map((id) => (svcById(id) || {}).name).filter(Boolean).join(' + '))} with ${esc(who ? who.name : '')} · $${b.total} · ${b.mins} min<br>Ref ${esc(b.ref)}</div>
        ${past ? '' : `<div class="bk-actions"><button class="btn2" type="button" data-move="${esc(b.ref)}">Reschedule</button><button class="btn2 danger" type="button" data-cancel="${esc(b.ref)}">Cancel</button></div>`}</div>`;
    };
    $('bookings').innerHTML = (up.length ? up.map((b) => card(b, false)).join('') : `<p class="empty">No upcoming bookings on this device.</p>`)
      + (rest.length ? `<p class="lbl">Earlier</p>` + rest.map((b) => card(b, true)).join('') : '')
      + `<p class="note">Free cancellation up to ${C.cancelHours} hours before. Inside that window, call the shop on <a href="tel:${esc(C.phone)}">${esc(C.phoneDisplay)}</a>.</p>`;
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
    b.status = 'cancelled'; b.cancelledAt = Date.now(); saveBookings();
    const sent = await send({ event: 'booking.cancelled', ...b });
    toast(sent ? 'Booking cancelled.' : `Cancelled on this device. Please also call ${C.phoneDisplay}.`, sent ? 3000 : 6000);
    drawBookings();
  }

  /* ---------- bottom bar ---------- */
  function bar() {
    const b = $('cta');
    const sum = (t) => `<div class="sum"><span>${t}</span><b>$${total()} · ${mins()} min</b></div>`;
    if (scr === 'home') b.innerHTML = `<button class="cta" type="button" data-go="barber">Book an appointment</button>`;
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
    if (scr === 'details') { $('receipt').innerHTML = lines(priced({ ...draft() })); $('pay-note').textContent = C.paymentNote; }
    if (scr === 'done') drawDone();
    if (scr === 'bookings') drawBookings();
    bar(); live();
  }
  function reset() { S.barber = null; S.svc = []; S.date = TODAY; S.time = null; S.editing = null; go('home'); }

  /* ---------- events (delegated) ---------- */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-go],[data-barber],[data-svc],[data-date],[data-time],[data-move],[data-cancel],#usual,#move,#finish,#ics');
    if (!el) return;
    const d = el.dataset;
    if (d.go) { if (d.go === 'home') reset(); else go(d.go); }
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
  draw();
})();
