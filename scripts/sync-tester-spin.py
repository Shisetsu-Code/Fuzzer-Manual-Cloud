"""Export confirmed counts using Tester Spin's own summary; source DB is read-only."""
import argparse
import datetime
import json
import pathlib
import sqlite3
import sys

parser = argparse.ArgumentParser()
parser.add_argument('source', type=pathlib.Path)
parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path('data/tester-spin-features.json'))
args = parser.parse_args()
sys.path.insert(0, str(args.source.resolve()))
from tester_spin.feature_summary import _feature_summary
from tester_spin.providers.registry import PROVIDERS

database = args.source.resolve() / 'data/tester-spin.sqlite3'
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
    rows = connection.execute("""SELECT provider,slug,payload_json FROM test_results
        WHERE id IN (SELECT MAX(id) FROM test_results GROUP BY provider,slug)""").fetchall()
    catalog = connection.execute('SELECT provider,slug,name,url,symbol FROM games').fetchall()
games = {}
for provider, slug, payload in rows:
    item = dict(zip(('purchases', 'antebets'), _feature_summary(json.loads(payload), counts_only=True)))
    games[provider+':'+slug] = item
    if provider == 'pragmatic': games[slug] = item
for target, source in {'sweet-bonanza': 'sweet-bonanza-slot', 'fruit-party': 'fruit-party-slot', 'the-dog-house': 'the-dog-house-slot'}.items():
    if source in games and target not in games:
        games[target] = {**games[source], 'catalogSlug': source}
records = []
for provider, slug, name, url, symbol in catalog:
    launch_url = None
    features = games.get(provider+':'+slug, {})
    if provider == 'playtech' and symbol:
        from urllib.parse import urlencode
        url = 'https://cachedownload.playtechone.com/ngmdesktop/casinoclient.html?' + urlencode({'game': symbol, 'preferedmode': 'offline', 'real': '0'})
    if provider == 'redtiger' and symbol:
        launch_url = url
        from tester_spin.providers.redtiger.demo_auth import demo_page_url
        url = demo_page_url(url, symbol)
    records.append(dict(provider=provider, slug=slug, name=name, url=url, **({'launchUrl': launch_url} if launch_url else {}), **features))
extras = pathlib.Path(__file__).resolve().parent.parent / 'providers-extra.json'
if extras.exists(): records.extend(json.loads(extras.read_text(encoding='utf-8')))
args.output.parent.mkdir(parents=True, exist_ok=True)
temporary = args.output.with_suffix('.tmp')
temporary.write_text(json.dumps({'source': 'Tester-Spin', 'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'games': games, 'catalog': records, 'providers': {key:value[2] for key,value in PROVIDERS.items()}}), encoding='utf-8')
temporary.replace(args.output)
print(json.dumps({'games': len(games), 'eligible': sum(any(isinstance(item.get(key), int) and item[key] > 0 for key in ('purchases', 'antebets')) for item in games.values())}))
