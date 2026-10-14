"""Deterministic, read-only import of the archived GFDL standard. Never configures traffic."""
import json,re,hashlib,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2]/'standards/drs/3.00.00'
pages=json.loads((root/'source-pages.json').read_text())
def write(name,obj): (root/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
vectors=[];current=None
for page in pages[16:25]:
 for line in page['text'].splitlines():
  if not line.startswith('|'):continue
  cols=[x.strip() for x in line.split('|')[1:-1]]
  if len(cols)!=3:continue
  if re.fullmatch(r'\d{6}',cols[0]):
   current={'source_vector_id':cols[0],'source_page':page['page'],'name_parts':[cols[1]],'props':[cols[2]],'lines':[line]};vectors.append(current)
  elif current and cols[0]=='' and cols[2]:current['name_parts'].append(cols[1]);current['props'].append(cols[2]);current['lines'].append(line)
levels=[{'level':i,'source_section':'3.3 / 3.5','source_pages':[4,8,9,10], 'max_volume':{'bps':[1e8,1e9,1e10,1e11,5e11,1e12,5e12][i-1],'pps':[25000,250000,2e6,25e6,125e6,250e6,1e9][i-1],'tps':[500,5000,50000,200000,1e6,5e6,25e6][i-1]},'max_outage_seconds':[21600,14400,3600,600,300,60,20][i-1],'max_extra_latency_seconds':[10,5,3,2,1.5,1,.5][i-1],'max_bots':[10,50,500,1000,5000,50000,1000000][i-1],'persistence_source':['1 hour','12 hours','24 hours','7 days','30 days','6 months','1 year'][i-1]} for i in range(1,8)]
types=[];entry=None;collecting=False
for page in pages[12:17]:
 for line in page['text'].splitlines():
  if line.startswith('4.2. Attack'): collecting=True;continue
  if line.startswith('4.3 Attack'):collecting=False
  if not collecting:continue
  m=re.match(r'^(\d{5,6}) (.+)$',line)
  if m:
   entry={'source_type_id':m[1],'source_section':'4.2','source_page':page['page'],'name':m[2],'description':[],'source_text':[line]};types.append(entry)
  elif entry:entry['description'].append(line);entry['source_text'].append(line)
for t in types:t['description']=' '.join(t['description']);t['source_text']='\n'.join(t['source_text'])
write('types.json',types)
for level in levels:level['source_text']={str(page):pages[page-1]['text'] for page in level['source_pages']}
ambiguities=[];out=[]
for row in vectors:
 sid=row['source_vector_id']; level=int(sid[0]); text=' '.join(row['props']);text=re.sub(r'\bmax\s+out\s*=','max_out=',text);text=re.sub(r'\bmax\s+latency\s*=','max_latency=',text)
 props={}
 for chunk in text.split(','):
  chunk=chunk.strip()
  if '=' in chunk:
   k,v=chunk.split('=',1);props[k.strip()]=v.strip()
  elif chunk:props[chunk]=True
 v={'internal_id':'drs-3.00.00-'+sid,'source_vector_id':sid,'source_section':'4.3','source_page':row['source_page'],'level':level,'family':{'1':'network-tcp','2':'network-udp','3':'network-other','4':'http','5':'low-and-slow','6':'non-http'}.get(sid[1],'unresolved'),'name':' '.join(x for x in row['name_parts'] if x),'required_properties':[k for k in props if k not in ['vol_bps','vol_pps','vol_cps','vol_tps','max_out','max_latency','max_bots','persistence']],'load_requirements':{k:val for k,val in props.items() if k.startswith('vol_')},'service_requirements':{k:props[k] for k in ['max_out','max_latency','max_bots','persistence'] if k in props},'source_text':'\n'.join(row['lines']),'interpretation_status':'line-preserved','ambiguity_ids':[]}
 def issue(key,source,conflict,why):
  aid=sid+'-'+key;v['ambiguity_ids'].append(aid);ambiguities.append({'id':aid,'vector_id':v['internal_id'],'source_page':row['source_page'],'source_value':source,'conflicting_value':conflict,'selected_interpretation':None,'rationale':why,'review_status':'unresolved','affects_verdict':True})
 if v['family']=='unresolved' or (('HTTP' in v['name'] or 'HTTPS' in v['name']) and sid[1]!='4'):issue('family',sid[1],'4 per section 4.1.1.1','Identifier family does not match its stated HTTP family; retain source string.')
 raw=props.get('max_out','');m=re.fullmatch(r'(\d+(?:\.\d+)?)(s|m|h)',raw)
 if m and float(m[1])*{'s':1,'m':60,'h':3600}[m[2]]!=levels[level-1]['max_outage_seconds']:issue('outage',raw,str(levels[level-1]['max_outage_seconds'])+' seconds','Vector line and section 3.5.1 conflict; neither is silently overwritten.')
 for key in ['max_out','max_latency','max_bots','persistence']:
  if key not in props:issue('missing-'+key,None,'Defined in level table','No implicit inheritance from level-wide values.')
 def scaled(raw):
  m=re.fullmatch(r'(\d+(?:\.\d+)?)([KMG]?)',raw or '')
  return float(m[1])*{'':1,'K':1e3,'M':1e6,'G':1e9}[m[2]] if m else None
 bot=scaled(props.get('max_bots'))
 if bot is not None and bot!=levels[level-1]['max_bots']:issue('bots',props['max_bots'],str(levels[level-1]['max_bots']),'Vector source diversity and section 3.5.3 conflict.')
 lat=re.fullmatch(r'(\d+(?:\.\d+)?)s',props.get('max_latency',''))
 if lat and float(lat[1])!=levels[level-1]['max_extra_latency_seconds']:issue('latency',props['max_latency'],str(levels[level-1]['max_extra_latency_seconds'])+' seconds','Vector latency and section 3.5.2 conflict.')
 persistence=props.get('persistence',''); expected=levels[level-1]['persistence_source']
 if persistence and re.sub(r'\s+','',persistence)!=re.sub(r'\s+','',expected):issue('persistence',persistence,expected,'Vector persistence and section 3.5.4 differ; preserve both values.')
 v['source_type_id']=sid[1:];matches=[t for t in types if t['source_type_id']==v['source_type_id']];v['source_type_definition']=matches[0] if len(matches)==1 else None
 if len(matches)!=1:issue('type-id',v['source_type_id'],[t['source_type_id'] for t in types if t['source_type_id'].endswith(sid[-3:])],'Type identifier does not map uniquely to section 4.2. No suffix-based automatic substitution.')
 if v['ambiguity_ids']:v['interpretation_status']='review-required' 
 out.append(v)
assert len(out)>80 and len({v['internal_id'] for v in out})==len(out)
for i in range(1,8): print('Level',i,len([v for v in out if v['level']==i]))
ambiguities += [
 {'id':'score-threshold-equality','source_value':'above / below / in between (section 5, page 26)','conflicting_value':'Equality is unspecified','selected_interpretation':'PASS iff ratio > threshold; FAIL iff ratio < 0.40; equality is MET','rationale':'Conservative reading of strict language, integer cross-products, no prior rounding. ShieldTester interpretation, not an official clarification.','review_status':'documented-interpretation','affects_verdict':True},
 {'id':'first-level-failure','source_value':'Use previous passed level (page 27)','conflicting_value':'No previous passed level at level 1','selected_interpretation':'Final DRS null, terminal FAIL, no zero invented','rationale':'No prior score exists; report absence explicitly.','review_status':'documented-interpretation','affects_verdict':True},
 {'id':'maximum-level-pass','source_value':'Proceed to next level after passing (page 27)','conflicting_value':'No level 8; highest score 7 (page 2)','selected_interpretation':'Return score of passed terminal level; max remains 7','rationale':'Terminate at maximum planned level without inventing an additional level.','review_status':'documented-interpretation','affects_verdict':True},
 {'id':'level-simultaneity','source_value':'Simultaneously mitigate vectors at a level (5.1 page 26)','conflicting_value':'Sequential scenario execution alone does not prove simultaneity','selected_interpretation':'Require evidence for the plan-defined combined exposure; otherwise partial','rationale':'A set of isolated successes cannot establish joint conditions.','review_status':'documented-interpretation','affects_verdict':True},
 {'id':'scope-denominator','source_value':'Total vectors in level (5.3 page 26)','conflicting_value':'Selected service subset may omit vectors','selected_interpretation':'Retain full level denominator; exclusions are diagnostic, no claimed full DRS with missing evidence','rationale':'No unsupported applicability exclusion reduces official denominator.','review_status':'documented-interpretation','affects_verdict':True}]
write('levels.json',levels);write('vectors.json',out);write('ambiguities.json',ambiguities)
write('scoring.json',{'standard_version':'3.00.00','engine_version':'shieldtester-drs/1','interpretation_profile':'strict-conservative/1','source_section':'5','source_pages':[26,27],'pass_percent_by_level':[75,75,75,85,85,85,85],'fail_percent':40,'score_formula':'level - 1 + passed / total','threshold_comparisons':{'pass':'>','fail':'<','equal':'MET'},'first_level_failure_score':None,'missing_evidence':'INCONCLUSIVE / NOT_EVALUATED; no official score','rounding':'display only','baseline_min_seconds':300,'baseline_origin':'ShieldTester choice, not DRS mandate','exclude_from_denominator':'No exclusion without a normative reviewed rule; current profile has none'})
subprocess.run(['npx','prettier','--write',*[str(root/n) for n in ['source-pages.json','types.json','levels.json','vectors.json','scoring.json','ambiguities.json']]],check=True,stdout=subprocess.DEVNULL)
files={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in ['source.pdf','LICENSE.txt','source-pages.json','types.json','levels.json','vectors.json','scoring.json','ambiguities.json']}
write('manifest.json',{'standard':'DDoS Resiliency Score','version':'3.00.00','publication_date':'2026-08-04','source_url':'https://www.ddosresiliencyscore.org/wp-content/uploads/2026/08/DDoS-Resiliency-Score-Standard-3.0.pdf','license':'GFDL-1.3','author':'Red Button Ltd.','importer':'ShieldTester','immutable':True,'vector_count':len(out),'files':files,'catalogue_sha256':hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'scope':'Read-only reference. No generator or attack implementation; original PDF preserved; not a certification.'})
print('Vectors',len(out),'ambiguities',len(ambiguities))

subprocess.run(["npx","prettier","--write",str(root/"manifest.json")],check=True,stdout=subprocess.DEVNULL)
