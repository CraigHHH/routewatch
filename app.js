/* RouteWatch prototype. All times are BC wall-clock strings like 2026-12-22T09:00. */
(function () {
  'use strict';
  var D = window.RW_DATA;
  var TZ = 'America/Vancouver';
  var VARS = ['temperature_2m', 'precipitation', 'snowfall', 'weather_code', 'wind_gusts_10m', 'visibility', 'is_day', 'precipitation_probability'];
  var HOURS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  var DAYS_SHOWN = 4;
  var LVL = { '-1': { cls: 'lx', word: 'No forecast yet' }, 0: { cls: 'l0', word: 'Good' }, 1: { cls: 'l1', word: 'Caution' }, 2: { cls: 'l2', word: 'Bad' } };

  function $(id) { return document.getElementById(id); }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---- time helpers (wall clock, no time zone math) ----
  function toMs(s) { return Date.parse(s.length === 13 ? s + ':00:00Z' : s + ':00Z'); }
  function fromMs(ms) { return new Date(ms).toISOString().slice(0, 16); }
  function nowStr() { return new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T').slice(0, 16); }
  function addDays(day, n) { return fromMs(toMs(day + 'T00:00') + n * 864e5).slice(0, 10); }
  function fmtTime(s) {
    var h = +s.slice(11, 13), m = s.slice(14, 16);
    return ((h + 11) % 12 + 1) + ':' + m + (h < 12 ? ' am' : ' pm');
  }
  function fmtDay(day) {
    var d = new Date(toMs(day + 'T12:00'));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] + ' ' +
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCDate();
  }
  function fmtStamp(ms) {
    if (!ms) return 'never';
    var s = new Date(ms).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T');
    return fmtDay(s.slice(0, 10)) + ', ' + fmtTime(s);
  }

  // ---- state ----
  var today = nowStr().slice(0, 10);
  var st = load('rw_state', {});
  st.dir = st.dir || 'W';
  st.route = st.route || 'A';
  st.pace = st.pace || 0.83;
  if (!st.day0 || st.day0 < today) st.day0 = today;
  if (!st.dep || st.dep.slice(0, 10) < st.day0 || st.dep.slice(0, 10) > addDays(st.day0, DAYS_SHOWN - 1)) st.dep = st.day0 + 'T09';
  st.speak = !!st.speak;
  st.tires = st.tires || 'studded';
  st.drive = st.drive || 'awd';
  st.exp = st.exp || 'new';
  var live = load('rw_live', null); // {updated, stations:{pointName:{...}}}
  var LIVE_URL = 'https://raw.githubusercontent.com/CraigHHH/routewatch/data/stations.json';

  // Thresholds move with tires and experience. Drivetrain only matters in deep new snow.
  function profile() {
    var tire = { studded: 1.15, winter: 1, ms: 0.6, summer: 0.6 }[st.tires];
    var exp = { 'new': 0.7, ok: 1, expert: 1.3 }[st.exp];
    var drv = { awd: 1.15, fwd: 1, rwd: 0.85 }[st.drive];
    var k = tire * exp;
    return { rateBad: 1.5 * k, deepBad: 6 * k * drv, deepCaution: 1.5 * k };
  }
  var fc = load('rw_fc', null);     // {fetchedAt, byName:{name:{time:[],...}}}
  var ev = load('rw_ev', null);     // {fetchedAt, events:[]}
  var camsAt = load('rw_cams_at', 0);
  var idxCache = {};

  // ---- plan ----
  function stopsFor(routeKey, dir, pace) {
    var r = D.routes[routeKey];
    var list = r.stops.map(function (s) { return { name: s.name, min: s.min, km: s.km }; });
    if (dir === 'E') {
      list = list.reverse().map(function (s) { return { name: s.name, min: r.totalMin - s.min, km: r.totalKm - s.km }; });
    }
    list.forEach(function (s) { s.min = Math.round(s.min * pace); });
    return list;
  }
  function hourIndex(name, hourStr) {
    var f = fc && fc.byName[name];
    if (!f) return -1;
    var c = idxCache[name];
    if (!c) { c = idxCache[name] = {}; f.time.forEach(function (t, i) { c[t] = i; }); }
    var i = c[hourStr];
    return i === undefined ? -1 : i;
  }
  function sumBack(arr, i, n) {
    var s = 0;
    for (var k = Math.max(0, i - n + 1); k <= i; k++) s += arr[k] || 0;
    return s;
  }
  // Grade one place at one arrival time.
  function evalPoint(name, arrive) {
    var hourStr = fromMs(Math.round(toMs(arrive) / 36e5) * 36e5);
    var i = hourIndex(name, hourStr);
    var f = fc && fc.byName[name];
    if (i < 0 || f.temperature_2m[i] === null || f.temperature_2m[i] === undefined) return { level: -1, why: [], hourStr: hourStr };
    var o = {
      hourStr: hourStr,
      temp: f.temperature_2m[i],
      snow: f.snowfall[i] || 0,
      precip: f.precipitation[i] || 0,
      snow6: sumBack(f.snowfall, i, 6),
      precip6: sumBack(f.precipitation, i, 6),
      code: f.weather_code[i],
      gust: f.wind_gusts_10m[i],
      vis: f.visibility ? f.visibility[i] : null,
      dark: f.is_day ? f.is_day[i] === 0 : false,
      pop: f.precipitation_probability ? f.precipitation_probability[i] : null,
      leadH: Math.round((toMs(hourStr) - toMs(nowStr())) / 36e5)
    };
    var level = 0, why = [];
    function flag(l, text) { if (l > level) level = l; why.push(text); }
    var freezingRain = [56, 57, 66, 67].indexOf(o.code) >= 0;
    var P = profile(), isPass = D.points[name].kind === 'pass', summer = st.tires === 'summer';
    var mon = +hourStr.slice(5, 7);
    if (summer && isPass && (mon >= 10 || mon <= 4)) flag(2, 'summer tires are not legal here from October to April');
    if (freezingRain) flag(2, 'freezing rain');
    if (o.snow >= P.rateBad) flag(2, 'heavy snow falling, ' + o.snow.toFixed(1) + ' cm in the hour');
    else if (o.snow >= 0.1) flag(summer ? 2 : 1, 'snow falling, ' + o.snow.toFixed(1) + ' cm in the hour');
    if (o.snow6 >= P.deepBad) flag(2, o.snow6.toFixed(0) + ' cm of new snow in the 6 hours before');
    else if (o.snow6 >= P.deepCaution && o.snow < 0.1) flag(1, o.snow6.toFixed(1) + ' cm of new snow in the 6 hours before');
    if (!freezingRain && o.precip6 - o.snow6 * 0.7 > 0.3 && o.temp <= 1 && o.temp >= -4) flag(summer ? 2 : 1, 'wet road near freezing, ice possible');
    if (isPass && o.dark && o.snow >= 0.1 && st.exp === 'new') flag(2, 'snow falling in the dark');
    else if (isPass && o.dark && level >= 1) why.push('you would cross in the dark');
    var ls = live && live.stations[name];
    if (ls && o.leadH <= 3 && o.leadH >= -1 && /snow|ice|slush|frost/i.test(ls.pavement || '')) flag(1, 'road station reports pavement is ' + String(ls.pavement).toLowerCase() + ' right now');
    if (o.vis !== null && o.vis !== undefined) {
      // Modeled visibility is noisy, so it can raise a Caution but never a Bad on its own.
      if (o.vis < 500) flag(1, 'fog or low cloud possible, modeled visibility under 500 m');
    } else if (o.code === 45 || o.code === 48) flag(1, 'fog');
    if (o.gust >= 70) flag(1, 'wind gusts ' + Math.round(o.gust) + ' km/h');
    o.level = level; o.why = why;
    return o;
  }
  function evalPlan(routeKey, dir, pace, dep) {
    var depStr = dep.length === 13 ? dep + ':00' : dep;
    var worst = 0, counts = { 1: 0, 2: 0 }, unknown = 0;
    var stops = stopsFor(routeKey, dir, pace).map(function (s) {
      var arrive = fromMs(toMs(depStr) + s.min * 6e4);
      var e = evalPoint(s.name, arrive);
      e.name = s.name; e.arrive = arrive; e.km = s.km; e.pt = D.points[s.name];
      if (e.level < 0) unknown++; else { if (e.level > worst) worst = e.level; if (e.level > 0) counts[e.level]++; }
      return e;
    });
    var level = unknown === stops.length ? -1 : worst;
    if (unknown > 0 && worst === 0) level = -1;
    return { stops: stops, level: level, counts: counts, unknown: unknown };
  }
  function confText(leadH) {
    if (leadH <= 48) return 'Forecast is ' + Math.max(0, leadH) + ' hours out. Detail at this range is usually decent.';
    if (leadH <= 120) return 'Forecast is ' + Math.round(leadH / 24) + ' days out. Timing of snow can still shift by hours.';
    return 'Forecast is ' + Math.round(leadH / 24) + ' days out. Treat it as a rough outlook only.';
  }

  // ---- rendering ----
  function renderStatus(msg) {
    var el = $('status');
    var off = !navigator.onLine;
    el.className = 'status' + (off ? ' offline' : '');
    el.textContent = msg || ((off ? 'Offline. Showing saved data. ' : '') + 'Forecast saved ' + fmtStamp(fc && fc.fetchedAt) + '.');
  }
  function renderControls() {
    var rs = $('route');
    rs.innerHTML = Object.keys(D.routes).map(function (k) {
      return '<option value="' + k + '">' + esc(D.routes[k].label) + '</option>';
    }).join('');
    rs.value = st.route; $('dir').value = st.dir; $('pace').value = String(st.pace);
    $('day0').value = st.day0; $('day0').min = today; $('day0').max = addDays(today, 15);
    $('speak').checked = st.speak;
  }
  function renderGrid() {
    var h = '<tr><th></th>' + HOURS.map(function (x) { return '<th>' + ((x + 11) % 12 + 1) + (x < 12 ? 'am' : 'pm') + '</th>'; }).join('') + '</tr>';
    for (var d = 0; d < DAYS_SHOWN; d++) {
      var day = addDays(st.day0, d);
      h += '<tr><th class="day">' + fmtDay(day) + '</th>';
      HOURS.forEach(function (hr) {
        var dep = day + 'T' + (hr < 10 ? '0' : '') + hr;
        var p = evalPlan(st.route, st.dir, st.pace, dep);
        var txt = p.level === -1 ? '?' : p.level === 0 ? 'OK' : (p.level === 2 ? 'B ' : 'C ') + p.counts[p.level];
        h += '<td><button class="cell ' + LVL[p.level].cls + (dep === st.dep ? ' sel' : '') + '" data-dep="' + dep + '" aria-label="' +
          fmtDay(day) + ' ' + hr + ':00, ' + LVL[p.level].word + '">' + txt + '</button></td>';
      });
      h += '</tr>';
    }
    $('grid').innerHTML = h;
  }
  function renderSummary(plan) {
    var r = D.routes[st.route];
    var last = plan.stops[plan.stops.length - 1];
    var other = st.route === 'A' ? 'B' : 'A';
    var op = evalPlan(other, st.dir, st.pace, st.dep);
    var driveMin = Math.round(r.totalMin * st.pace);
    function describe(p) {
      if (p.level === -1) return 'no forecast yet';
      if (p.level === 0) return 'nothing flagged';
      var parts = [];
      if (p.counts[2]) parts.push('bad at ' + p.counts[2]);
      if (p.counts[1]) parts.push('caution at ' + p.counts[1]);
      return parts.join(', ');
    }
    $('summary').innerHTML =
      '<span class="big">Leave ' + fmtDay(st.dep.slice(0, 10)) + ' at ' + fmtTime(st.dep + ':00') + '</span>' +
      '<span class="chip ' + LVL[plan.level].cls + '">' + LVL[plan.level].word + '</span>' +
      '<span>Arrive about ' + fmtTime(last.arrive) + ' (' + Math.floor(driveMin / 60) + ' h ' + (driveMin % 60) + ' min driving, ' + r.totalKm + ' km, no stops counted)</span>' +
      '<span class="status">Other route (' + esc(D.routes[other].label) + ') at the same time: ' + describe(op) + '.</span>';
  }
  function renderMap(plan) {
    var all = [];
    Object.keys(D.routes).forEach(function (k) { all = all.concat(D.routes[k].geom); });
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, kx = Math.cos(49.5 * Math.PI / 180);
    all.forEach(function (c) { minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]); minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]); });
    var W = 800, pad = 46, sc = (W - 2 * pad) / ((maxX - minX) * kx), H = Math.round((maxY - minY) * sc + 2 * pad);
    function X(lon) { return (pad + (lon - minX) * kx * sc).toFixed(1); }
    function Y(lat) { return (pad + (maxY - lat) * sc).toFixed(1); }
    function path(k) { return D.routes[k].geom.map(function (c, i) { return (i ? 'L' : 'M') + X(c[0]) + ' ' + Y(c[1]); }).join(''); }
    var other = st.route === 'A' ? 'B' : 'A';
    var colors = { '-1': 'var(--none)', 0: 'var(--good)', 1: 'var(--caution)', 2: 'var(--bad)' };
    var s = '<svg class="map" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Route map with passes">' +
      '<path d="' + path(other) + '" fill="none" stroke="var(--line)" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="' + path(st.route) + '" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>';
    var up = true;
    plan.stops.forEach(function (e) {
      var x = X(e.pt.lon), y = Y(e.pt.lat);
      if (e.pt.kind === 'pass') {
        s += '<g class="m" data-pass="' + esc(e.name) + '"><circle cx="' + x + '" cy="' + y + '" r="11" fill="' + colors[e.level] + '" stroke="var(--card)" stroke-width="3"/>' +
          '<text x="' + x + '" y="' + (+y + (up ? -17 : 28)) + '" text-anchor="middle">' + esc(e.name.replace(' (Hwy 33)', '')) + '</text></g>';
        up = !up;
      } else if (['Nelson', 'Vancouver', 'Hope', 'Osoyoos', 'Kelowna', 'Princeton', 'Merritt'].indexOf(e.name) >= 0) {
        s += '<circle cx="' + x + '" cy="' + y + '" r="4" fill="var(--ink)"/><text class="town" x="' + x + '" y="' + (+y + 18) + '" text-anchor="middle">' + esc(e.name) + '</text>';
      }
    });
    $('mapwrap').innerHTML = s + '</svg>';
  }
  function wxLine(e) {
    if (e.level === -1) return 'No forecast for this time yet.';
    var bits = [Math.round(e.temp) + '°C'];
    if (e.snow >= 0.1) bits.push('snow ' + e.snow.toFixed(1) + ' cm/h');
    else if (e.precip >= 0.1) bits.push((e.temp <= 1 ? 'light mixed precipitation ' : 'rain ') + e.precip.toFixed(1) + ' mm/h');
    else bits.push('dry');
    if (e.snow6 >= 0.1) bits.push(e.snow6.toFixed(1) + ' cm new snow in prior 6 h');
    if (e.gust !== null && e.gust !== undefined) bits.push('gusts ' + Math.round(e.gust) + ' km/h');
    if (e.vis !== null && e.vis !== undefined && e.vis < 10000) bits.push('visibility ' + (e.vis / 1000).toFixed(1) + ' km');
    if (e.dark) bits.push('dark');
    return bits.join(' · ');
  }
  function liveLine(name) {
    var s = live && live.stations[name];
    if (!s) return '';
    var bits = [];
    if (s.road !== null && s.road !== undefined) bits.push('road ' + esc(s.road) + '°C');
    if (s.pavement) bits.push('pavement ' + esc(String(s.pavement).toLowerCase()));
    if (s.depth) bits.push('snow on ground ' + esc(s.depth));
    if (s.snowStd) bits.push('new snow ' + esc(s.snowStd));
    if (s.weather) bits.push(esc(String(s.weather).toLowerCase()));
    var h = '<div class="live"><b>Road station now</b> (' + esc(s.station) + (s.distKm >= 2 ? ', ' + s.distKm + ' km away' : '') + ', saved ' + fmtStamp(Date.parse(live.updated)) + '): ' + bits.join(' · ') + '.';
    var hist = s.history || [];
    for (var i = hist.length - 2; i >= 0; i--) {
      if (hist[i].pavement !== s.pavement) {
        h += ' Pavement changed from ' + esc(String(hist[i].pavement).toLowerCase()) + ' to ' + esc(String(s.pavement).toLowerCase()) + ' around ' + fmtStamp(Date.parse(hist[i + 1].t)) + '.';
        break;
      }
    }
    if (s.forecast && s.forecast[0]) h += '<br><b>Station forecast, ' + esc(s.forecast[0].period) + ':</b> ' + esc(s.forecast[0].text);
    return h + '</div>';
  }
  function renderRules() {
    var P = profile();
    $('rules').textContent = 'With your settings, a pass is Bad at ' + P.rateBad.toFixed(1) + ' cm of snow per hour or more, or ' + P.deepBad.toFixed(1) +
      ' cm of new snow in the 6 hours before' + (st.exp === 'new' ? ', or any snow falling in the dark' : '') +
      '. Freezing rain is Bad for everyone. Any lighter snow, ' + P.deepCaution.toFixed(1) +
      ' cm or more in the 6 hours before, a wet road near freezing, gusts of 70 km/h, or modeled visibility under 500 m is Caution.';
  }
  function renderStops(plan) {
    $('stops').innerHTML = plan.stops.map(function (e) {
      var t = '<div class="t">' + fmtTime(e.arrive) + '<small>' + e.km + ' km</small></div>';
      if (e.pt.kind !== 'pass') {
        var tag = e.level > 0 ? ' <span class="chip ' + LVL[e.level].cls + '">' + LVL[e.level].word + '</span>' : '';
        var cam = e.pt.cams.length ? ' <a href="#" data-pass="' + esc(e.name) + '">cams</a>' : '';
        return '<div class="stop town">' + t + '<div><span class="name">' + esc(e.name) + '</span>' + tag + cam +
          '<div class="wx">' + wxLine(e) + (e.why.length ? '. ' + esc(e.why.join(', ')) : '') + '</div></div></div>';
      }
      return '<div class="stop">' + t + '<button class="pass" data-pass="' + esc(e.name) + '">' +
        '<div class="top"><span><span class="name">' + esc(e.name) + '</span> <span class="elev">' + e.pt.elev + ' m</span></span>' +
        '<span class="chip ' + LVL[e.level].cls + '">' + LVL[e.level].word + '</span></div>' +
        '<div class="facts">' + wxLine(e) + '</div>' +
        (e.why.length ? '<div class="why">Why: ' + esc(e.why.join(', ')) + '.</div>' : '') +
        (e.level !== -1 ? '<div class="conf">' + confText(e.leadH) + '</div>' : '') +
        liveLine(e.name) +
        '<div class="camlink">Tap for highway cams (' + e.pt.cams.length + ')</div></button></div>';
    }).join('');
  }
  function distKm(a, b) {
    var dx = (a[0] - b[0]) * 72.3, dy = (a[1] - b[1]) * 111.2;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function renderEvents() {
    var el = $('events');
    if (!ev) { el.innerHTML = '<p class="hint">Not loaded yet. Needs a connection once.</p>'; return; }
    var geom = D.routes[st.route].geom;
    var near = ev.events.filter(function (x) {
      return x.pts.some(function (p) { return geom.some(function (g) { return distKm(p, g) < 2.5; }); });
    });
    var rank = { MAJOR: 0, MODERATE: 1, MINOR: 2, UNKNOWN: 3 };
    near.sort(function (a, b) { return (rank[a.sev] === undefined ? 3 : rank[a.sev]) - (rank[b.sev] === undefined ? 3 : rank[b.sev]); });
    var main = near.filter(function (x) { return x.sev === 'MAJOR' || x.type !== 'CONSTRUCTION'; });
    var minor = near.length - main.length;
    var h = main.map(function (x) {
      return '<div class="ev"><div class="h">' + (x.sev === 'MAJOR' ? '<span class="chip l2">Major</span> ' : '') + esc(x.head.replace(/_/g, ' ')) + (x.road ? ' on ' + esc(x.road) : '') + '</div>' + esc(x.desc) + '</div>';
    }).join('');
    if (!main.length) h = '<p>No incidents, road-condition or weather events listed near this route.</p>';
    h += '<p class="hint">' + (minor ? minor + ' minor construction notices hidden. ' : '') + 'DriveBC events saved ' + fmtStamp(ev.fetchedAt) + '. These are current events and say nothing about your travel day.</p>';
    el.innerHTML = h;
  }
  function camUrl(id) { return 'https://www.drivebc.ca/images/' + id + '.jpg'; }
  function openCams(name) {
    var pt = D.points[name];
    if (!pt || !pt.cams.length) return;
    $('dlg-title').textContent = name + ' cams';
    var bust = Math.floor(Date.now() / 3e5);
    $('dlg-body').innerHTML =
      '<p class="hint" style="margin-top:0">' + (navigator.onLine ? 'Live images. They show the road now, not when you get there.' :
        'Offline. These are the images saved ' + fmtStamp(camsAt) + '.') + '</p>' +
      pt.cams.map(function (c) {
        return '<figure class="cam"><img alt="' + esc(c.label) + '" src="' + camUrl(c.id) + '?t=' + bust + '">' +
          '<figcaption>' + esc(c.label) + ' · <a target="_blank" rel="noopener" href="https://www.drivebc.ca/cameras/' + c.id + '">open on DriveBC</a></figcaption></figure>';
      }).join('');
    $('dlg').showModal();
  }
  function render() {
    save('rw_state', st);
    renderStatus();
    renderGrid();
    var plan = evalPlan(st.route, st.dir, st.pace, st.dep);
    renderSummary(plan); renderMap(plan); renderStops(plan); renderEvents(); renderRules();
  }
  function fetchLive() {
    return fetch(LIVE_URL, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('stations ' + r.status);
      return r.json();
    });
  }

  // ---- data ----
  function fetchForecast() {
    var names = Object.keys(D.points);
    var q = 'latitude=' + names.map(function (n) { return D.points[n].lat; }).join(',') +
      '&longitude=' + names.map(function (n) { return D.points[n].lon; }).join(',') +
      '&elevation=' + names.map(function (n) { return D.points[n].elev; }).join(',') +
      '&hourly=' + VARS.join(',') + '&forecast_days=16&timezone=' + encodeURIComponent(TZ);
    return fetch('https://api.open-meteo.com/v1/forecast?' + q).then(function (r) {
      if (!r.ok) throw new Error('forecast ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!Array.isArray(j)) j = [j];
      var byName = {};
      names.forEach(function (n, i) { byName[n] = j[i].hourly; });
      return { fetchedAt: Date.now(), byName: byName };
    });
  }
  function fetchEvents() {
    return fetch('https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&limit=500&bbox=-123.3,48.9,-117.2,50.25').then(function (r) {
      if (!r.ok) throw new Error('events ' + r.status);
      return r.json();
    }).then(function (j) {
      var events = (j.events || []).map(function (x) {
        var g = x.geography || {}, c = g.coordinates || [];
        var pts = g.type === 'Point' ? [c] : (g.type === 'LineString' ? [c[0], c[Math.floor(c.length / 2)], c[c.length - 1]] : []);
        return { head: x.headline || x.event_type || '', type: x.event_type, sev: x.severity, desc: (x.description || '').slice(0, 400),
          road: x.roads && x.roads[0] ? x.roads[0].name : '', pts: pts.filter(Boolean).map(function (p) { return [+(+p[0]).toFixed(4), +(+p[1]).toFixed(4)]; }) };
      });
      return { fetchedAt: Date.now(), events: events };
    });
  }
  // Pull every cam on both routes once so the service worker has a copy for offline.
  function saveCams() {
    var ids = [];
    Object.keys(D.points).forEach(function (n) { D.points[n].cams.forEach(function (c) { ids.push(c.id); }); });
    var bust = Math.floor(Date.now() / 3e5);
    return Promise.all(ids.map(function (id) {
      return fetch(camUrl(id) + '?t=' + bust, { mode: 'no-cors' }).catch(function () { return null; });
    })).then(function (res) {
      if (res.some(Boolean)) { camsAt = Date.now(); save('rw_cams_at', camsAt); }
    });
  }
  function levelsOf(plan) { var m = {}; plan.stops.forEach(function (e) { m[e.name] = e.level; }); return m; }
  var busy = false;
  function refresh(manual) {
    if (busy) return;
    if (!navigator.onLine) { renderStatus(); return; }
    busy = true;
    renderStatus('Updating');
    var before = fc ? levelsOf(evalPlan(st.route, st.dir, st.pace, st.dep)) : null;
    var prevAt = fc && fc.fetchedAt;
    fetchLive().then(function (x) { live = x; save('rw_live', live); }).catch(function (e) { console.warn(e); }).then(fetchForecast).then(function (nfc) {
      fc = nfc; idxCache = {}; save('rw_fc', fc);
      if (before) {
        var after = levelsOf(evalPlan(st.route, st.dir, st.pace, st.dep)), diffs = [];
        Object.keys(after).forEach(function (n) {
          if (before[n] !== after[n] && before[n] !== -1 && after[n] !== -1) diffs.push(n + ' went from ' + LVL[before[n]].word + ' to ' + LVL[after[n]].word);
        });
        if (diffs.length) announce(diffs, prevAt);
      }
    }).catch(function (e) { console.warn(e); })
      .then(function () { return fetchEvents().then(function (x) { ev = x; save('rw_ev', ev); }).catch(function (e) { console.warn(e); }); })
      .then(function () { busy = false; render(); return saveCams(); });
  }
  function announce(diffs, prevAt) {
    $('changes').innerHTML = '<div class="banner"><b>Forecast for your drive changed since ' + fmtStamp(prevAt) + '</b>' + diffs.map(esc).join('<br>') + '</div>';
    if (st.speak && 'speechSynthesis' in window) {
      var u = new SpeechSynthesisUtterance('Route Watch. The forecast for your drive changed. ' + diffs.join('. ') + '.');
      window.speechSynthesis.speak(u);
    }
  }

  // ---- events ----
  $('dir').onchange = function () { st.dir = this.value; render(); };
  $('route').onchange = function () { st.route = this.value; render(); };
  $('pace').onchange = function () { st.pace = +this.value; render(); };
  ['tires', 'drive', 'exp'].forEach(function (k) {
    $(k).value = st[k];
    $(k).onchange = function () { st[k] = this.value; render(); };
  });
  $('day0').onchange = function () {
    if (!this.value) return;
    st.day0 = this.value; st.dep = st.day0 + st.dep.slice(10); render();
  };
  $('speak').onchange = function () {
    st.speak = this.checked; save('rw_state', st);
    if (st.speak && 'speechSynthesis' in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance('Spoken changes are on.'));
  };
  $('refresh').onclick = function () { refresh(true); };
  $('grid').onclick = function (e) {
    var b = e.target.closest('[data-dep]');
    if (b) { st.dep = b.getAttribute('data-dep'); $('changes').innerHTML = ''; render(); }
  };
  document.addEventListener('click', function (e) {
    var p = e.target.closest('[data-pass]');
    if (p) { e.preventDefault(); openCams(p.getAttribute('data-pass')); }
  });
  $('dlg-close').onclick = function () { $('dlg').close(); };
  $('dlg').addEventListener('click', function (e) { if (e.target === this) this.close(); });
  window.addEventListener('online', function () { refresh(false); });
  window.addEventListener('offline', function () { renderStatus(); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && (!fc || Date.now() - fc.fetchedAt > 15 * 6e4)) refresh(false);
  });
  setInterval(function () { if (!document.hidden) refresh(false); }, 15 * 6e4);

  renderControls();
  render();
  if (!fc || !live || Date.now() - fc.fetchedAt > 10 * 6e4) refresh(false);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn(e); });
})();
