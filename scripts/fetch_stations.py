"""Copy DriveBC roadside weather station readings for the RouteWatch passes into one small JSON file.
Run by a scheduled GitHub Action because browsers are not allowed to read the DriveBC feed directly."""
import json, math, sys, urllib.request, datetime, os

OUT = sys.argv[1]
MAX_KM = 10
KEEP_HOURS = 48
here = os.path.dirname(os.path.abspath(__file__))
points = json.loads(open(os.path.join(here, '..', 'data.js')).read().split('=', 1)[1].rstrip().rstrip(';'))['points']
req = urllib.request.Request('https://www.drivebc.ca/api/weather/current/', headers={'User-Agent': 'routewatch-prototype'})
stations = json.load(urllib.request.urlopen(req, timeout=60))

def km(lat1, lon1, lat2, lon2):
    dx = (lon1 - lon2) * 111.2 * math.cos(math.radians(lat1)); dy = (lat1 - lat2) * 111.2
    return math.hypot(dx, dy)

try:
    old = json.load(open(OUT))['stations']
except Exception:
    old = {}
now = datetime.datetime.now(datetime.timezone.utc)
stamp = now.strftime('%Y-%m-%dT%H:%M:%SZ')
cutoff = (now - datetime.timedelta(hours=KEEP_HOURS)).strftime('%Y-%m-%dT%H:%M:%SZ')
out = {}
for name, p in points.items():
    best = None
    for s in stations:
        c = (s.get('location') or {}).get('coordinates')
        if not c: continue
        d = km(p['lat'], p['lon'], c[1], c[0])
        if d <= MAX_KM and (best is None or d < best[0]): best = (d, s)
    if not best: continue
    d, s = best
    pw = s.get('present_weather') or {}
    rec = dict(station=s.get('weather_station_name'), distKm=round(d, 1), elev=s.get('elevation'),
               air=s.get('air_temperature'), road=s.get('road_temperature'), pavement=s.get('pavement_status'),
               grip=s.get('pavement_grip'), roadCondition=s.get('road_condition'),
               snow=s.get('snow'), snowStd=s.get('snow_stdobs'), depth=s.get('snow_depth'),
               precip=s.get('precipitation'), wind=s.get('average_wind'), gust=s.get('maximum_wind'),
               vis=s.get('visibility'), weather=pw.get('label'),
               forecast=[dict(period=f.get('Period'), text=f.get('Text')) for f in (s.get('forecast_group') or [])[:4]])
    hist = [h for h in (old.get(name) or {}).get('history', []) if h['t'] >= cutoff]
    hist.append(dict(t=stamp, road=rec['road'], pavement=rec['pavement'], depth=rec['depth'], snowStd=rec['snowStd']))
    rec['history'] = hist
    out[name] = rec
json.dump(dict(updated=stamp, stations=out), open(OUT, 'w'), separators=(',', ':'))
print(stamp, len(out), 'stations:', ', '.join('%s<-%s(%.1fkm)' % (k, v['station'], v['distKm']) for k, v in out.items()))
