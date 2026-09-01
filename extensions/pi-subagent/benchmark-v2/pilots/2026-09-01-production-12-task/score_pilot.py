#!/usr/bin/env python3
"""Normalize and deterministically score the exploratory 12-task production-preset pilot."""
from __future__ import annotations
import hashlib, json, math, random, re, statistics
from collections import defaultdict
from pathlib import Path

ROOT=Path(__file__).resolve().parent
TASKS={t['id']:t for t in json.load(open(ROOT/'tasks.json'))['tasks']}
RUNS=json.load(open(ROOT/'schedule.json'))['runs']

# Each claim is a conjunction of case-insensitive regular expressions. The
# protocol is intentionally lexical and is not a substitute for a blinded judge.
RULES={
'lookup-presets':[
 [r'gpt-5\.6-luna',r'medium'],[r'gpt-5\.6-terra',r'medium'],[r'gpt-5\.6-sol',r'medium'],
 [r'\bread\b',r'\bgrep\b',r'\bfind\b',r'\bls\b'],[r'web_search',r'source_check',r'fetch_content',r'get_search_content'],
 [r'(8\s+(scope|root)|scope.{0,30}8)',r'(3\s+(started |subagent )?calls|at most 3)'],[r'legacy|older',r'balanced|deep|exhaustive',r'normalize|map'] ],
'lookup-child-cli':[
 [r'--mode',r'json',r'--print',r'--no-session'],[r'--no-extensions',r'--no-skills',r'--no-context-files'],[r'child-guard\.ts'],
 [r'PI_OFFLINE',r'1|offline'],[r'PI_SESSION_ID',r'PI_MODEL',r'PI_REASONING_LEVEL'],[r'detached',r'process group'],[r'fd\s*3|file descriptor 3',r'liveness'] ],
'lookup-output-bounds':[
 [r'12\s*(KiB|KB)|12\s*\*\s*1024|12288'],[r'4\s*(KiB|KB)|4\s*\*\s*1024|4096'],[r'UTF-?8'],
 [r'control.{0,30}(sanit|replace)|sanit.{0,30}control'],[r'(length|text\.length).{0,20}/\s*4'],[r'complete',r'partial'],[r'output truncated|truncation marker'] ],
'lookup-web-limits':[
 [r'0\.26\.0'],[r'(same|one).{0,30}(source|extension)',r'package\.json|manifest',r'pi-web-access'],[r'4\s+quer',r'10\s+result'],
 [r'5\s+(URL|fetch|target)'],[r'32\s+quer',r'50\s+(fetch|content|target)'],[r'exceed|cross',r'block|does not execute|final',r'partial|final'] ],
'analysis-usage':[
 [r'assistant',r'toolResult'],[r'addUsage|aggregat|sum',r'input|output|cache|cost'],[r'ChildRunError',r'usage'],
 [r'failedUsage',r'set|store'],[r'tool_result',r'usage'],[r'details',r'usage',r'success'],[r'failure|failed',r'usage'] ],
'analysis-liveness':[
 [r'fd\s*3|file descriptor 3'],[r'EOF|end',r'error'],[r'SIGKILL',r'process group'],[r'SIGTERM',r'SIGKILL'],
 [r'detached'],[r'session_shutdown',r'cleanup|runtime files'],[r'unref'] ],
'analysis-json-collector':[
 [r'message_end'],[r'discard',r'non.?message|other event|ordinary'],[r'2\s*(MiB|MB)|2\s*\*\s*1024\s*\*\s*1024|2097152'],
 [r'malformed JSON',r'protocol|fail|error'],[r'toolResult',r'assistant',r'usage'],[r'text',r'toolUse',r'error',r'aborted'],[r'without a final assistant answer|no final'] ],
'analysis-finalization':[
 [r'36',r'48'],[r'30',r'40'],[r'denied',r'attempt'],[r'soft',r'warning|notice',r'(remain|continue|available)'],
 [r'hard',r'block|disable',r'final'],[r'2\s*(minute|min)|2\s*\*\s*60\s*\*\s*1000',r'soft.{0,60}hard|hard.{0,60}soft'],[r'partial',r'soft deadline|hardLimitReached|hard limit'] ],
'review-gate-parallel':[
 [r'startedCalls',r'authorizedToolCallIds|authorized'],[r'parallel|concurrent',r'(exceed|more than|oversubscribe)',r'3'],
 [r'reserv|pending|in.?flight'],[r'commit',r'increment|started'],[r'startedCalls\s*\+|include.{0,30}authorized|set\.size'],[r'atomic|synchronous|before'] ],
'review-final-eligibility':[
 [r'mixed'],[r'toolUse|tool call',r'accept|eligible'],[r'premature|intermediate|stale',r'final'],
 [r'finalOutput'],[r'without a final assistant answer|no final',r'bypass|avoid|not trigger'],[r'text.?only|===\s*[`\"]text|lastAssistantMode',r'reject|exclude|toolUse'] ],
'review-liveness-error':[
 [r'error',r'ignore|no.?op|undefined'],[r'EOF|end',r'insufficient|not cover|only'],[r'child',r'orphan|continue|remain|leak'],
 [r'terminate',r'process group|SIGKILL'],[r'once\([`\"]error|error listener',r'terminate'] ],
'review-failed-usage':[
 [r'ChildRunError'],[r'failedUsage',r'delete'],[r'tool_result',r'get|map'],[r'lost|missing|under.?report|zero',r'usage|cost|token'],
 [r'failedUsage',r'set|store'],[r'throw|catch',r'usage'] ],
}

CITATION_RE=re.compile(r'^-\s+([^:\n]+):(\d+)(?:-(\d+))?\s+[—-]',re.M)
HEADERS=['Conclusion','Findings','Evidence','Uncertainties']

def sha(path:Path): return hashlib.sha256(path.read_bytes()).hexdigest()
def med(values): return statistics.median(values) if values else 0

def get_text(content):
 return '\n'.join(p.get('text','') for p in content or [] if p.get('type')=='text')

def parse_meta(path):
 out={}
 for line in path.read_text().splitlines():
  k,v=line.split('=',1); out[k]=v
 return out

def parse_run(run):
 raw=ROOT/'raw'/f"{run['run_id']}.jsonl"
 events=[json.loads(x) for x in raw.read_text().splitlines() if x.strip()]
 messages=[e['message'] for e in events if e.get('type')=='message_end' and isinstance(e.get('message'),dict)]
 assistants=[m for m in messages if m.get('role')=='assistant']
 final=''
 for m in assistants:
  text=get_text(m.get('content'))
  if text.strip() and m.get('stopReason') not in ('toolUse','error','aborted'): final=text
 toolcalls=[]
 for idx,m in enumerate(messages):
  if m.get('role')=='assistant':
   for c in m.get('content') or []:
    if c.get('type')=='toolCall': toolcalls.append((idx,c.get('name')))
 subresults=[(idx,m) for idx,m in enumerate(messages) if m.get('role')=='toolResult' and m.get('toolName')=='pi_subagent']
 child=subresults[0][1] if len(subresults)==1 else None
 child_usage=(child or {}).get('usage') or {}
 parent_usages=[m.get('usage') or {} for m in assistants]
 parent_prompt=[u.get('input',0)+u.get('cacheRead',0)+u.get('cacheWrite',0) for u in parent_usages]
 def usum(key): return sum(u.get(key,0) or 0 for u in parent_usages)
 parent_cost=sum(((u.get('cost') or {}).get('total',0) or 0) for u in parent_usages)
 child_cost=((child_usage.get('cost') or {}).get('total',0) or 0)
 tool_result_bytes=sum(len(get_text(m.get('content')).encode()) for m in messages if m.get('role')=='toolResult')
 sub_bytes=sum(len(get_text(m.get('content')).encode()) for _,m in subresults)
 post=False
 if subresults:
  child_idx=subresults[-1][0]
  post=any(idx>child_idx and name!='pi_subagent' for idx,name in toolcalls)
 meta=parse_meta(ROOT/'logs'/f"{run['run_id']}.meta")
 details=(child or {}).get('details') or {}
 return {
  **run,'profile':TASKS[run['task_id']]['profile'],'task_sha256':TASKS[run['task_id']]['task_sha256'],
  'process':{'exit_code':int(meta['exit_code']),'wall_ms':int(meta['wall_ms'])},'raw_sha256':sha(raw),
  'final_answer':final,'final_answer_bytes':len(final.encode()),'assistant_messages':len(assistants),
  'parent':{'prompt_cumulative':sum(parent_prompt),'prompt_peak':max(parent_prompt,default=0),'input':usum('input'),'cacheRead':usum('cacheRead'),'cacheWrite':usum('cacheWrite'),'output':usum('output'),'reasoning':usum('reasoning'),'totalTokens':usum('totalTokens'),'cost':parent_cost,'tool_calls':len(toolcalls),'tool_names':[x[1] for x in toolcalls],'tool_result_bytes':tool_result_bytes,'subagent_result_bytes':sub_bytes,'post_subagent_investigation':post},
  'child':None if child is None else {'model':details.get('model'),'thinking':details.get('thinking'),'preset':details.get('preset'),'status':details.get('status'),'durationMs':details.get('durationMs'),'toolCallsAttempted':details.get('toolCallsAttempted'),'toolCallsExecuted':details.get('toolCallsExecuted'),'deniedCalls':details.get('deniedCalls'),'contextTokens':details.get('contextTokens'),'totalTokens':child_usage.get('totalTokens',0),'input':child_usage.get('input',0),'cacheRead':child_usage.get('cacheRead',0),'output':child_usage.get('output',0),'reasoning':child_usage.get('reasoning',0),'cost':child_cost},
  'combined':{'totalTokens':usum('totalTokens')+child_usage.get('totalTokens',0),'cost':parent_cost+child_cost}
 }

def resolve_citation_path(snap:Path, text:str):
 p=snap/text.strip()
 if p.is_file(): return p
 hits=[p for p in snap.rglob('*') if p.is_file() and str(p.relative_to(snap)).endswith(text.strip())]
 return hits[0] if len(hits)==1 else None

def score(record):
 text=record['final_answer']; low=text.lower(); task=TASKS[record['task_id']]
 rules=RULES[record['task_id']]
 claim_hits=[all(re.search(p,low,re.I|re.S) for p in group) for group in rules]
 snap=ROOT/'snapshots'/record['task_id']
 citations=[]
 for m in CITATION_RE.finditer(text):
  path_text=m.group(1).strip(); start=int(m.group(2)); end=int(m.group(3) or start)
  path=resolve_citation_path(snap,path_text)
  valid=False; rel=None
  if path and 1<=start<=end<=len(path.read_text().splitlines()): valid=True; rel=str(path.relative_to(snap))
  citations.append({'path':path_text,'resolved':rel,'start':start,'end':end,'valid':valid})
 marker_groups=defaultdict(list)
 for e in task['evidence']: marker_groups[e['marker']].append(e)
 marker_hits=[]
 for marker,spans in marker_groups.items():
  hit=False
  for c in citations:
   if not c['valid']: continue
   for e in spans:
    if c['resolved']==e['path'] and c['start']<=e['end'] and c['end']>=e['start']: hit=True
  marker_hits.append(hit)
 positions=[text.find(h) for h in HEADERS]
 format_ok=all(x>=0 for x in positions) and positions==sorted(positions)
 claim_score=60*sum(claim_hits)/len(claim_hits)
 citation_validity=20*(sum(c['valid'] for c in citations)/len(citations) if citations else 0)
 evidence_recall=15*(sum(marker_hits)/len(marker_hits) if marker_hits else 0)
 format_score=5 if format_ok else 0
 return {'run_id':record['run_id'],'task_id':record['task_id'],'arm':record['arm'],'claim_hits':claim_hits,'claim_recall':sum(claim_hits)/len(claim_hits),'citations':citations,'citation_validity':sum(c['valid'] for c in citations)/len(citations) if citations else 0,'evidence_marker_hits':marker_hits,'evidence_recall':sum(marker_hits)/len(marker_hits) if marker_hits else 0,'format_ok':format_ok,'score':claim_score+citation_validity+evidence_recall+format_score}

def ci(values,alpha=.05):
 v=sorted(values); return [v[int((alpha/2)*len(v))],v[min(len(v)-1,int((1-alpha/2)*len(v)))]]

def main():
 records=[parse_run(r) for r in RUNS]
 errors=[]
 for r in records:
  if r['process']['exit_code']!=0 or not r['final_answer'].strip(): errors.append([r['run_id'],'process_or_answer'])
  count=r['parent']['tool_names'].count('pi_subagent')
  if (r['arm']=='A' and count!=0) or (r['arm']=='B' and count!=1): errors.append([r['run_id'],f'subagent_count={count}'])
  if r['arm']=='B' and (not r['child'] or r['child']['status'] not in ('complete','partial')): errors.append([r['run_id'],'child_missing_or_failed'])
  (ROOT/'normalized'/f"{r['run_id']}.json").write_text(json.dumps(r,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
 scores=[score(r) for r in records]
 (ROOT/'scores.jsonl').write_text(''.join(json.dumps(s,ensure_ascii=False,sort_keys=True)+'\n' for s in scores))
 score_by={s['run_id']:s for s in scores}
 grouped=defaultdict(list)
 for r in records: grouped[(r['task_id'],r['arm'])].append(r)
 task_rows=[]
 for tid in TASKS:
  row={'task_id':tid,'profile':TASKS[tid]['profile']}
  for arm in 'AB':
   rs=grouped[(tid,arm)]
   row[arm]={'parent_prompt_cumulative':med([x['parent']['prompt_cumulative'] for x in rs]),'parent_prompt_peak':med([x['parent']['prompt_peak'] for x in rs]),'combined_tokens':med([x['combined']['totalTokens'] for x in rs]),'cost':med([x['combined']['cost'] for x in rs]),'wall_ms':med([x['process']['wall_ms'] for x in rs]),'quality':med([score_by[x['run_id']]['score'] for x in rs]),'claim_recall':med([score_by[x['run_id']]['claim_recall'] for x in rs]),'evidence_recall':med([score_by[x['run_id']]['evidence_recall'] for x in rs])}
  row['parent_context_reduction']=1-row['B']['parent_prompt_cumulative']/row['A']['parent_prompt_cumulative'] if row['A']['parent_prompt_cumulative'] else None
  row['quality_difference']=row['B']['quality']-row['A']['quality']
  task_rows.append(row)
 rng=random.Random(int(json.load(open(ROOT/'schedule.json'))['seed_hex'],16)^0x53434f5245)
 profiles=defaultdict(list)
 for row in task_rows: profiles[row['profile']].append(row)
 boot_red=[]; boot_q=[]
 for _ in range(10000):
  sample=[]
  for rows in profiles.values(): sample += [rng.choice(rows) for _ in rows]
  boot_red.append(med([x['parent_context_reduction'] for x in sample]))
  boot_q.append(statistics.mean(x['quality_difference'] for x in sample))
 def total(field,arm): return sum((r[field] if field in r else 0) for r in records if r['arm']==arm)
 summary={
  'status':'exploratory_complete' if not errors else 'exploratory_complete_with_errors','runs':len(records),'errors':errors,
  'compliance':{'A_without_subagent':sum(r['arm']=='A' and 'pi_subagent' not in r['parent']['tool_names'] for r in records),'B_exactly_one_subagent':sum(r['arm']=='B' and r['parent']['tool_names'].count('pi_subagent')==1 for r in records),'B_post_subagent_investigation':sum(r['arm']=='B' and r['parent']['post_subagent_investigation'] for r in records)},
  'task_level':task_rows,
  'overall':{
   'median_task_parent_context_reduction':med([x['parent_context_reduction'] for x in task_rows]),'parent_context_reduction_bootstrap_95ci':ci(boot_red),
   'mean_task_quality_difference_B_minus_A':statistics.mean(x['quality_difference'] for x in task_rows),'quality_difference_bootstrap_95ci':ci(boot_q),
   'median_task_quality_A':med([x['A']['quality'] for x in task_rows]),'median_task_quality_B':med([x['B']['quality'] for x in task_rows]),
   'corpus_parent_prompt_cumulative_A':sum(r['parent']['prompt_cumulative'] for r in records if r['arm']=='A'),'corpus_parent_prompt_cumulative_B':sum(r['parent']['prompt_cumulative'] for r in records if r['arm']=='B'),
   'corpus_combined_tokens_A':sum(r['combined']['totalTokens'] for r in records if r['arm']=='A'),'corpus_combined_tokens_B':sum(r['combined']['totalTokens'] for r in records if r['arm']=='B'),
   'corpus_reported_cost_A':sum(r['combined']['cost'] for r in records if r['arm']=='A'),'corpus_reported_cost_B':sum(r['combined']['cost'] for r in records if r['arm']=='B'),
   'median_wall_ms_A':med([r['process']['wall_ms'] for r in records if r['arm']=='A']),'median_wall_ms_B':med([r['process']['wall_ms'] for r in records if r['arm']=='B']),
  },
  'scoring_limitations':['lexical claim rules','citation semantics approximated by frozen marker overlap','no unsupported-claim judge','scorer frozen after one orchestration preflight output was inspected']
 }
 (ROOT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
 print(json.dumps(summary['overall'],indent=2)); print('compliance',summary['compliance']); print('errors',errors)
if __name__=='__main__': main()
