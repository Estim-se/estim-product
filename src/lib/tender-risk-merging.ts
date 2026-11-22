import type { TenderInsights } from './tender-insights';
type Risk = TenderInsights['risks'][number];
type Source = Risk['source'];
export const insightSources = (value: {source: Source;sources?:Source[]|undefined}) => [value.source,...value.sources??[]].filter((s,i,all)=>all.findIndex(t=>JSON.stringify(t)===JSON.stringify(s))===i);
const words=(s:string)=>new Set(s.toLocaleLowerCase('sv').normalize('NFD').replace(/\p{Diacritic}/gu,'').match(/[a-z]{4,}/g)??[]);
function topic(r:Risk){
 const s=`${r.title} ${r.description}`.toLowerCase();
 if(/(?:sakna|underlag|handling|ritning)/.test(s)&&/(?:befintlig)/.test(s)&&/(?:el-|elinstallation|elinstallationer|teleinstallation)/.test(s))return 'existing-electrical-documents';
 if(/vs.?ritning|vvs.?ritning/i.test(s)&&/stämmer|felakt|fel i|avvik|disponering/i.test(s))return 'incorrect-vs-drawing';
 if(/jordgubbsprinsen|flyttfirma/.test(s))return 'prescribed-moving-contractor';
 return null;
}
export function sameRiskIssue(a:Risk,b:Risk){
 const ta=topic(a),tb=topic(b);if(ta&&tb)return ta===tb;
 const aw=words(a.title),bw=words(b.title),shared=[...aw].filter(w=>bw.has(w)).length;
 const sameSource=insightSources(a).some(s=>insightSources(b).some(t=>s.document_id===t.document_id&&s.page===t.page&&s.evidence===t.evidence));
 return a.title.toLowerCase()===b.title.toLowerCase() || sameSource&&shared>=2 || shared>=3&&shared/Math.max(aw.size,bw.size)>=0.6;
}
export function mergeTenderRisks(risks:Risk[],groups:number[][]=[]):Risk[]{
 const parent=risks.map((_,i)=>i);const root=(i:number):number=>parent[i]===i?i:root(parent[i]??i);
 function join(a:number,b:number){parent[root(b)]=root(a);}
 for(let i=0;i<risks.length;i++)for(let j=i+1;j<risks.length;j++){const a=risks[i],b=risks[j];if(a&&b&&sameRiskIssue(a,b))join(i,j);}
 for(const group of groups){const first=group[0];if(first===undefined)continue;for(const i of group)if(risks[first]&&risks[i])join(first,i);}
 const result=new Map<number,Risk>();const severity={Hög:0,Medel:1,Låg:2};
 risks.forEach((r,i)=>{const k=root(i),old=result.get(k);if(!old){result.set(k,{...r,sources:insightSources(r)});return;}
  const descriptions=[old.description,r.description].filter((v,index,all)=>all.indexOf(v)===index);
  result.set(k,{...old,description:descriptions.join('\n').slice(0,2000),sources:insightSources({...old,sources:[...insightSources(old),...insightSources(r)]}),severity:severity[r.severity]<severity[old.severity]?r.severity:old.severity,suggestion:old.suggestion==='Fråga beställaren'||r.suggestion==='Fråga beställaren'?'Fråga beställaren':old.suggestion,consequence:old.consequence===r.consequence?old.consequence:'Tid och pengar'});
 });return [...result.values()].sort((a,b)=>severity[a.severity]-severity[b.severity]);
}
export const needsRiskQuestion=(r:Risk)=>r.suggestion==='Fråga beställaren'||/motstrid|motsäg|motsäg|konflikt|olika uppgifter/i.test(`${r.title} ${r.description}`);
// Ordinary positive indexation cannot become an adverse condition through risk merging.
export function reconcileTenderIndexRisks(risks:Risk[],keyData:TenderInsights['key_data']):Risk[]{
 const compensation=keyData.find(k=>k.field==='Ersättningsform');
 if(!compensation?.source||compensation.source.flag||!/(?:indexreglering sker|med indexreglering).*EM.?index/i.test(compensation.value))return risks;
 const changes=keyData.find(k=>k.field==='ÄTA-regler');
 return risks.flatMap(r=>{
  if(!/indexreglering|EM.?index/i.test(r.title))return [r];
  if(/ÄTA/i.test(`${r.title} ${r.description}`)&&changes?.source&&!changes.source.flag){
   return [{...r,title:'ÄTA-ersättning och påslag',description:changes.value,source:changes.source,sources:insightSources({...r,sources:[...insightSources(r),changes.source]})}];
  }
  return [];
 });
}
export function ensureRiskQuestions(questions:TenderInsights['questions'],risks:Risk[]):TenderInsights['questions']{
 const result=questions.map(q=>({...q,sources:insightSources(q)}));
 risks.forEach((r,i)=>{if(!needsRiskQuestion(r))return;
  const covered=result.find(q=>q.risk_indices?.includes(i));
  if(covered){covered.sources=insightSources({...covered,sources:[...covered.sources,...insightSources(r)]});return;}
  result.push({question:`Kan ni förtydliga vad som gäller för "${r.title}"? ${r.description} Vilken uppgift eller omfattning ska ligga till grund för anbudet?`,source:r.source,sources:insightSources(r),risk_indices:[i]});
 });return result;
}

export function retainTenderQuestions(current:TenderInsights['questions'],previous:TenderInsights['questions']):TenderInsights['questions']{
 const result=[...current];
 for(const old of previous){
  const ow=words(old.question);const same=result.find(q=>{const qw=words(q.question),shared=[...ow].filter(w=>qw.has(w)).length;return old.question.trim()===q.question.trim()||shared>=3&&shared/Math.max(ow.size,qw.size)>=0.6;});
  if(same)same.sources=insightSources({...same,sources:[...insightSources(same),...insightSources(old)]});
  else {const {risk_indices:_indices,...clean}=old;result.push(clean);}
 }return result;
}
export function ensureTenderDateQuestion(questions:TenderInsights['questions'],keyData:TenderInsights['key_data']):TenderInsights['questions']{
 const start=keyData.find(k=>k.field==='Start'),deadline=keyData.find(k=>k.field==='Anbudstid');
 function date(s:string){const iso=s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);if(iso?.[0])return Date.parse(iso[0]);const m=s.toLowerCase().match(/\b(\d{1,2})\s+(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\s+(\d{4})/);if(!m?.[1]||!m[2]||!m[3])return null;const month=['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'].indexOf(m[2]);return Date.UTC(Number(m[3]),month,Number(m[1]));}
 if(!start?.source||!deadline?.source)return questions;const a=date(start.value),b=date(deadline.value);if(a===null||b===null||!(a<b))return questions;
 if(questions.some(q=>/start/i.test(q.question)&&/anbud/i.test(q.question)))return questions;
 return [...questions,{question:`Vilket byggstartdatum gäller? Underlaget anger start "${start.value}", före anbudstid "${deadline.value}". Bekräfta rätt startdatum och om tidsplanen ska revideras.`,source:start.source,sources:[start.source,deadline.source]}];
}