// RouteWatch Worker.
// 1. /stations  Live relay of DriveBC roadside weather stations near the route (browsers cannot read DriveBC directly).
// 2. Hourly job  Keeps a log for checking the app's grades against what really happened:
//      obs/<day>           what each pass's road station reported, hour by hour
//      fc/<day>            the raw hourly forecast for each pass as issued that morning (grades are recomputed from this later)
//      cam/<day>/<hh>/<id> highway cam snapshots every 2 hours from 6 am to 8 pm
// 3. /log/days, /log/day/<day>, /cam/...  Read the log back for reports.
const POINTS = [["Nelson", 49.4928, -117.2948], ["Castlegar", 49.2889, -117.6619], ["Paulson Summit", 49.2416, -118.053], ["Christina Lake", 49.1007, -118.2226], ["Eholt Summit", 49.1452, -118.5346], ["Rock Creek", 49.0573, -118.9995], ["Anarchist Summit", 49.0051, -119.3147], ["Osoyoos", 49.0323, -119.4682], ["Keremeos", 49.2054, -119.8414], ["Princeton", 49.4526, -120.5254], ["Sunday Summit", 49.2394, -120.5623], ["Allison Pass", 49.116, -120.867], ["Hope", 49.3616, -121.3636], ["Vancouver", 49.2609, -123.1139], ["McCulloch (Hwy 33)", 49.7577, -119.1261], ["Kelowna", 49.8625, -119.4906], ["Pennask Summit", 49.9093, -120.0242], ["Merritt", 50.1113, -120.7862], ["Coquihalla Summit", 49.5948, -121.0819]];
const PASSES = [{"name": "Paulson Summit", "lat": 49.2416, "lon": -118.053, "elev": 1535, "cams": [174]}, {"name": "Eholt Summit", "lat": 49.1452, "lon": -118.5346, "elev": 1028, "cams": [247]}, {"name": "Anarchist Summit", "lat": 49.0051, "lon": -119.3147, "elev": 1233, "cams": [64]}, {"name": "Sunday Summit", "lat": 49.2394, "lon": -120.5623, "elev": 1284, "cams": [1155, 246]}, {"name": "Allison Pass", "lat": 49.116, "lon": -120.867, "elev": 1342, "cams": [1112, 65]}, {"name": "McCulloch (Hwy 33)", "lat": 49.7577, "lon": -119.1261, "elev": 1265, "cams": [249, 1130]}, {"name": "Pennask Summit", "lat": 49.9093, "lon": -120.0242, "elev": 1728, "cams": [251, 1156]}, {"name": "Coquihalla Summit", "lat": 49.5948, "lon": -121.0819, "elev": 1244, "cams": [686, 685]}];
const MAX_KM = 10;
const TZ = 'America/Vancouver';
const SRC = 'https://www.drivebc.ca/api/weather/current/';
const UA = { 'User-Agent': 'routewatch-prototype' };
const CORS = { 'Access-Control-Allow-Origin': '*' };
const FC_VARS = 'temperature_2m,precipitation,snowfall,weather_code,wind_gusts_10m,visibility,is_day';
const CAM_TTL = 120 * 86400;

function km(lat1, lon1, lat2, lon2) {
  const dx = (lon1 - lon2) * 111.2 * Math.cos(lat1 * Math.PI / 180), dy = (lat1 - lat2) * 111.2;
  return Math.hypot(dx, dy);
}
function json(obj, status, cache) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': cache || 'no-store' } });
}
function localNow() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: TZ });
  return { day: s.slice(0, 10), hh: s.slice(11, 13), hour: +s.slice(11, 13) };
}
async function nearestStations() {
  const res = await fetch(SRC, { headers: UA });
  if (!res.ok) throw new Error('DriveBC returned ' + res.status);
  const all = await res.json();
  const stations = {};
  for (const [name, lat, lon] of POINTS) {
    let best = null;
    for (const s of all) {
      const c = s.location && s.location.coordinates;
      if (!c) continue;
      const d = km(lat, lon, c[1], c[0]);
      if (d <= MAX_KM && (!best || d < best.d)) best = { d, s };
    }
    if (!best) continue;
    const s = best.s;
    stations[name] = {
      station: s.weather_station_name, distKm: Math.round(best.d * 10) / 10, elev: s.elevation,
      air: s.air_temperature, road: s.road_temperature, pavement: s.pavement_status, grip: s.pavement_grip,
      roadCondition: s.road_condition, snow: s.snow, snowStd: s.snow_stdobs, depth: s.snow_depth,
      precip: s.precipitation, wind: s.average_wind, gust: s.maximum_wind, vis: s.visibility,
      weather: s.present_weather ? s.present_weather.label : null,
      forecast: (s.forecast_group || []).slice(0, 4).map(f => ({ period: f.Period, text: f.Text })),
    };
  }
  return stations;
}

async function saveForecast(env, day, hour, done) {
  try { // the forecast as issued today, saved once a day
    if (!(await env.LOG.get('fc/' + day))) {
      const q = 'latitude=' + PASSES.map(p => p.lat).join(',') + '&longitude=' + PASSES.map(p => p.lon).join(',') +
        '&elevation=' + PASSES.map(p => p.elev).join(',') + '&hourly=' + FC_VARS + '&forecast_days=7&timezone=' + encodeURIComponent(TZ);
      const res = await fetch('https://api.open-meteo.com/v1/forecast?' + q);
      if (!res.ok) throw new Error('Open-Meteo returned ' + res.status);
      let j = await res.json();
      if (!Array.isArray(j)) j = [j];
      const passes = {};
      PASSES.forEach((p, i) => { passes[p.name] = j[i].hourly; });
      await env.LOG.put('fc/' + day, JSON.stringify({ issuedAt: new Date().toISOString(), issuedLocalHour: hour, passes }));
      done.fc = true;
    }
  } catch (e) { done.errors.push('fc: ' + e.message); }
}

async function runLog(env) {
  const { day, hh, hour } = localNow();
  const done = { day, hh, obs: false, fc: false, cams: 0, errors: [] };
  await saveForecast(env, day, hour, done); // retried on every call until today's copy is saved
  const marker = 'ran/' + day + '/' + hh;
  if (await env.LOG.get(marker)) return { ...done, skipped: true };
  await env.LOG.put(marker, '1', { expirationTtl: 3 * 86400 });

  try { // what the road stations report right now
    const st = await nearestStations();
    const key = 'obs/' + day;
    const cur = JSON.parse((await env.LOG.get(key)) || '{}');
    cur[hh] = { _at: new Date().toISOString() };
    for (const p of PASSES) {
      const s = st[p.name];
      if (s) cur[hh][p.name] = { station: s.station, distKm: s.distKm, air: s.air, road: s.road, pavement: s.pavement, snow: s.snow, snowStd: s.snowStd, depth: s.depth, precip: s.precip, weather: s.weather, vis: s.vis };
    }
    await env.LOG.put(key, JSON.stringify(cur));
    done.obs = true;
  } catch (e) { done.errors.push('obs: ' + e.message); }

  if (hour >= 6 && hour <= 20 && hour % 2 === 0) { // cam snapshots
    for (const p of PASSES) for (const id of p.cams) {
      try {
        const res = await fetch('https://www.drivebc.ca/images/' + id + '.jpg', { headers: UA });
        if (!res.ok) throw new Error('cam ' + id + ' returned ' + res.status);
        await env.LOG.put('cam/' + day + '/' + hh + '/' + id + '.jpg', await res.arrayBuffer(), { expirationTtl: CAM_TTL, metadata: { pass: p.name } });
        done.cams++;
      } catch (e) { done.errors.push(e.message); }
    }
  }
  return done;
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runLog(env).then(r => console.log(JSON.stringify(r)))); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/' || path === '/stations') {
      const cache = caches.default, key = new Request('https://routewatch.internal/stations');
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const stations = await nearestStations();
        // Attach the last two days of hourly readings so the app can say when the pavement status changed.
        const today = localNow().day;
        const yest = new Date(Date.now() - 86400000).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 10);
        for (const d of [yest, today]) {
          const obs = JSON.parse((await env.LOG.get('obs/' + d)) || '{}');
          for (const hh of Object.keys(obs).sort()) {
            const at = obs[hh]._at;
            if (!at) continue;
            for (const name of Object.keys(obs[hh])) {
              if (name === '_at' || !stations[name]) continue;
              const o = obs[hh][name];
              (stations[name].history = stations[name].history || []).push({ t: at, pavement: o.pavement, road: o.road, depth: o.depth, snowStd: o.snowStd });
            }
          }
        }
        const out = json({ updated: new Date().toISOString(), stations }, 200, 'public, max-age=300');
        ctx.waitUntil(cache.put(key, out.clone()));
        return out;
      } catch (e) { return json({ error: e.message }, 502); }
    }
    if (path === '/run') return json(await runLog(env)); // safe to call: it does nothing if this hour already ran
    if (path === '/log/days') {
      const l = await env.LOG.list({ prefix: 'obs/' });
      return json({ days: l.keys.map(k => k.name.slice(4)) });
    }
    let m = path.match(/^\/log\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (m) {
      const [obs, fc, cams] = await Promise.all([env.LOG.get('obs/' + m[1]), env.LOG.get('fc/' + m[1]), env.LOG.list({ prefix: 'cam/' + m[1] + '/' })]);
      return json({ day: m[1], passes: PASSES, obs: obs ? JSON.parse(obs) : null, fc: fc ? JSON.parse(fc) : null, cams: cams.keys.map(k => ({ key: k.name, pass: k.metadata && k.metadata.pass })) });
    }
    m = path.match(/^\/(cam\/\d{4}-\d{2}-\d{2}\/\d{2}\/\d+\.jpg)$/);
    if (m) {
      const img = await env.LOG.get(m[1], 'arrayBuffer');
      if (!img) return new Response('not found', { status: 404, headers: CORS });
      return new Response(img, { headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
    }
    return new Response('not found', { status: 404, headers: CORS });
  },
};
