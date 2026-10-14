from pathlib import Path
import json,re,sys
ids=sys.argv[1:]
if not ids or len(ids)>2 or any(not re.fullmatch('[a-f0-9-]{36}',x) for x in ids):raise RuntimeError('Two identified recipe campaigns maximum')
path=Path('/var/log/nginx/shieldtest-fleet.jsonl')
if path.stat().st_size>8*1024*1024:raise RuntimeError('Collector log budget exceeded')
records=[]
for line in path.read_text().splitlines():
    record=json.loads(line)
    if record['trace'].split(':')[0] not in ids:continue
    records.append({'trace':record['trace'],'source':record['source'],'status':int(record['status']),'epochSec':float(record['epochSec'])})
    if len(records)>900:raise RuntimeError('Recipe receipt budget exceeded')
if not records:raise RuntimeError('No matching receiver traces')
print(json.dumps(records,separators=(',',':')))
