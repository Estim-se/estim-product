import { initial, type EstimState, type Draft, type DesktopPath } from './estim-store';
import type { WorkspaceData } from './real.functions';
import type { RealMutation } from './real.schemas';
import type { Thread } from '@/data/inbox';
import type { Quote } from './quote';
import { auditTimeline } from './real-presentation';
import { waWindowOpen } from './channel-rules';
import { whatsappAutoReply } from './whatsapp-auto';

// AI steps are injected so the store stays testable without network access.
export interface RealAi { interpret(id:string):Promise<unknown>; write(id:string,v:Draft['v'],ch:'email'|'sms'|'wa'):Promise<unknown> }

const time = (value:string) => new Date(value).toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'});
const strings = (value:unknown):string[] => Array.isArray(value) ? value.filter((v):v is string=>typeof v==='string') : [];
const rows = (value:unknown):string[][] => Array.isArray(value) ? value.filter(Array.isArray).map(row=>row.map(String)) : [];
const asks = (value:unknown):(string|number)[][] => Array.isArray(value) ? value.filter(Array.isArray).map(row=>[String(row[0]??''),row[1]?1:0]) : [];
export function emptyRealState(): EstimState { const s=initial(); return {...s, threads:[],drafts:{},sel:'',stats:{ai:0,sek:0},settings:[true,true,false,true,true,true,true]}; }
export function workspaceState(data:WorkspaceData, previous:EstimState):EstimState {
  const drafts:Record<string,Draft>={};
  data.drafts.forEach(d=>{drafts[d.thread_id]={text:d.text,v:d.variant==='kort'||d.variant==='formell'?d.variant:'std',ch:d.channel,att:strings(d.attachments),edited:d.edited,warn:strings(d.warnings),review:d.needs_review&&strings(d.warnings).length>0};});
  const threads:Thread[]=data.threads.map(t=>{
    const c=data.customers.find(c=>c.id===t.customer_id);
    const q=data.quotes.find(q=>q.thread_id===t.id);
    const outgoing=data.messages.filter(m=>m.thread_id===t.id&&(m.from==='vv'||m.from==='ai')).at(-1);
    const msgs=data.messages.filter(m=>m.thread_id===t.id&&(m.delivery_status==='sent'||data.documentDeliveries?.some(d=>d.message_id===m.id))).map(m=>({from:m.from,auto:m.from==='ai',ch:m.channel??t.channel,time:time(m.sent_at),text:m.delivery_status==='sent'?m.text:'Dokument skickat',att:strings(m.attachments),documents:data.documentDeliveries?.filter(d=>d.message_id===m.id).map(d=>({id:d.id,name:d.name}))??[],quote:strings(m.attachments).some(a=>a.startsWith('Offert'))}));
    return {deliveryError:outgoing?.channel==='wa'&&outgoing.delivery_status==='not_sent'?outgoing.delivery_error??'WhatsApp-svaret kunde inte skickas. Försök igen.':undefined,waSent:outgoing?.channel==='wa'&&outgoing.delivery_status==='sent'&&Boolean(outgoing.provider_message_id),id:t.id,name:c?.name??'',ini:(c?.name??'').split(' ').map(n=>n[0]).slice(0,2).join(''),ch:t.channel,chs:[...new Set([t.channel,...msgs.map(m=>m.ch)])],time:time(t.last_message_at),place:c?.place??t.place??'',addr:c?.address??'—',phone:c?.phone||'—',email:c?.email||'—',job:t.job,status:t.status==='analys'&&Date.now()-new Date(t.updated_at).getTime()>90000?'svar':t.status,read:t.read,autopilot:t.channel==='wa'?whatsappAutoReply(data.company?.whatsapp_auto_reply??false,t.whatsapp_auto_override):t.autopilot,waWin:waWindowOpen(t.last_customer_wa_at),msgs,asks:asks(t.asks),facts:rows(t.facts),why:t.why,att:[],events:data.audit.filter(a=>{const after=a.after;return after && typeof after==='object' && !Array.isArray(after) && after['thread_id']===t.id;}).reverse().map(a=>[time(a.created_at),auditTimeline(a)]),q:q?{nr:q.nr,owners:q.owners,addOn:q.add_on,prisform:q.prisform,lines:Array.isArray(q.lines)?q.lines as unknown as Quote['lines']:[]}:null};
  });
  return {...previous,threads,drafts,settings:Array.isArray(data.company?.settings)?data.company.settings.map(Boolean):previous.settings,sel:threads.some(t=>t.id===previous.sel)?previous.sel:threads[0]?.id??'',stats:{ai:data.messages.filter(m=>m.from==='ai').length,sek:0}};
}

// Real actions never invoke the demo store: no scripts, fake replies, or simulated approvals.
export function createRealStore() {
  let state=emptyRealState(); const listeners=new Set<()=>void>();
  let data:WorkspaceData | null=null;
  let mutate:((input:RealMutation)=>Promise<unknown>)|undefined;
  let reload:(()=>Promise<void>)|undefined;
  let queue=Promise.resolve(); let toastTimer:ReturnType<typeof setTimeout>|undefined;
  let writeError=false;
  let ai:RealAi|undefined;
  let delivery: ((id:string)=>Promise<{sent:boolean;error:string|null}>)|undefined;
  const AI_TIMEOUT_MS=60000;
  const withTimeout=<T,>(p:Promise<T>)=>new Promise<T>((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout')),AI_TIMEOUT_MS);p.then(v=>{clearTimeout(t);res(v);},e=>{clearTimeout(t);rej(e);});});
  // Any AI failure or timeout returns the thread to "svar" so the user can write by hand.
  const aiFailed=async(id:string)=>{
    update(s=>{const t=s.threads.find(t=>t.id===id);if(t&&t.status==='analys')t.status='svar';});
    toast('AI kunde inte svara just nu');
    try{await persist({kind:'thread',id,status:'svar'});}catch{}
    try{await reload?.();}catch{}
  };
  // Runs one AI reply for a thread; failures keep the thread usable for manual writing.
  const aiReply=async(id:string,v:Draft['v'])=>{
    const d=state.drafts[id];if(!ai||!d)return;
    const ch=d.ch==='sms'||d.ch==='wa'?d.ch:'email';
    update(s=>{const x=s.drafts[id];if(x)x.busy=true;});
    try{await queue;await withTimeout(ai.write(id,v,ch));await reload?.();}
    catch{await aiFailed(id);}
    finally{update(s=>{const x=s.drafts[id];if(x)x.busy=false;});}
  };
  let epoch=0;
  const dirtyQuotes=new Set<string>();
  const update=(fn:(s:EstimState)=>void)=>{state=structuredClone(state);fn(state);listeners.forEach(l=>l());};
  const toast=(text:string)=>{clearTimeout(toastTimer);update(s=>{s.toast=text;});toastTimer=setTimeout(()=>update(s=>{s.toast='';}),3200);};
  const persist=(input:RealMutation,refresh=false)=>{
    const write=mutate,read=reload;
    const own=epoch;
    const task=queue.then(async()=>{if(own!==epoch)return;if(!write)throw new Error('Ingen anslutning.');await write(input);if(own===epoch&&refresh&&read)await read();});
    queue=task.then(()=>{writeError=false;}).catch(()=>{writeError=true;toast('Ändringen kunde inte sparas. Försök igen.');});return task;
  };
  const draftSave=(id:string)=>{const draft=state.drafts[id];if(draft)void persist({kind:'draft',id,draft:{...draft,ch:draft.ch==='sms'?'sms':draft.ch==='wa'?'wa':'email'}}).catch(()=>{});};
  // Quote fields are visit-local until the explicit drawer save succeeds.
  const changeQuote=(fn:(q:Quote)=>void)=>{const id=state.drawer;if(!id)return;dirtyQuotes.add(id);update(s=>{const q=s.threads.find(t=>t.id===id)?.q;if(q)fn(q);});};
  // New request flow: analys -> interpret -> code-built quote -> reply draft -> svar. Never sends.
  async function actions_runRequest(id:string){
    if(!ai)return;
    update(s=>{const t=s.threads.find(t=>t.id===id);if(t)t.status='analys';});
    try{await withTimeout(ai.interpret(id));const channel=state.drafts[id]?.ch;await withTimeout(ai.write(id,'std',channel==='sms'||channel==='wa'?channel:'email'));}
    catch{await aiFailed(id);return;}
    try{await reload?.();}catch{}
  }
  const actions={
    update,toast,
    reset(){toast('Återställning finns bara i demoläge.');},
    select(id:string){update(s=>{s.sel=id;s.view='desk';s.page='inkorg';const t=s.threads.find(t=>t.id===id);if(t)t.read=true;});void persist({kind:'thread',id,read:true}).catch(()=>{});},
    toggleSetting(index:number){update(s=>{s.settings[index]=!s.settings[index];});const c=data?.company;if(c)void persist({kind:'company',company:{name:c.name,signature:c.signature,hourly_rate_ex_vat:c.hourly_rate_ex_vat,travel_fee:c.travel_fee,settings:state.settings,reply_to_email:c.reply_to_email??''}},true).catch(()=>{});},
    toggleAuto(id:string){const t=state.threads.find(t=>t.id===id);if(!t||t.ch!=='wa')return;const autopilot=!t.autopilot;void persist({kind:'thread',id,autopilot}).then(()=>{update(s=>{const thread=s.threads.find(t=>t.id===id);if(thread)thread.autopilot=autopilot;});toast(autopilot?'AI skickar svar automatiskt i den här WhatsApp-tråden.':'AI skriver utkast, du skickar');}).catch(()=>{});},
    setDraft(id:string,variant:Draft['v']){if(state.drafts[id]?.busy)return;void aiReply(id,variant);},
    regen(id:string){const d=state.drafts[id];if(d&&!d.busy)void aiReply(id,d.v);},
    editDraft(id:string,text:string){update(s=>{const d=s.drafts[id];if(d){d.text=text;d.edited=true;}});draftSave(id);},
    addAtt(id:string,value:string){update(s=>{const d=s.drafts[id];if(d&&!d.att.includes(value))d.att.push(value);});draftSave(id);},
    delAtt(id:string,index:number){update(s=>{s.drafts[id]?.att.splice(index,1);});draftSave(id);},
    setCh(id:string,ch:string){if(ch!=='email'&&ch!=='sms'&&ch!=='wa')return;update(s=>{const d=s.drafts[id];if(d)d.ch=ch;});draftSave(id);},
    openDrawer(id:string){update(s=>{s.drawer=id;});},closeDrawer(){const id=state.drawer;if(id)dirtyQuotes.delete(id);update(s=>{s.drawer=null;if(data){const persisted=workspaceState(data,s);s.threads=persisted.threads;}});},
    upd(index:number,key:'t'|'q'|'p',value:string){changeQuote(q=>{const l=q.lines[index];if(!l)return;if(key==='t')l.t=value;else l[key]=Math.max(0,parseFloat(value.replace(/\s/g,'').replace(',','.'))||0);});},
    togRot(index:number){changeQuote(q=>{const l=q.lines[index];if(l)l.rot=!l.rot;});},
    delL(index:number){changeQuote(q=>{q.lines.splice(index,1);});},
    addL(opt=false){changeQuote(q=>{q.lines.push({t:opt?'Nytt tillval':'Ny rad',typ:'arbete',q:1,u:'h',p:data?.company?.hourly_rate_ex_vat??0,rot:true,...(opt?{opt:true}:{})});});},
    setOwners(owners:number){changeQuote(q=>{q.owners=owners;});},setPriceForm(prisform:string){changeQuote(q=>{q.prisform=prisform;});},
    openCustomer(_id:string,_preview?:boolean){toast('Kundens godkännande ansluts i ett senare steg.');},closeCustomer(){},toggleAddOn(id:string){dirtyQuotes.add(id);update(s=>{const q=s.threads.find(t=>t.id===id)?.q;if(q)q.addOn=!q.addOn;});},approveCustomer(){},submitCustomer(){},sendBrief(_id:string){toast('Överlämning är inte ansluten ännu.');},
    send(id:string,_options?:{silent?:boolean}){const d=state.drafts[id];if(!d?.text.trim()){toast('Skriv ett svar först.');return;}if(d.busy)return;update(s=>{const draft=s.drafts[id];if(draft)draft.busy=true;});void (async()=>{try{await queue;if(!delivery)throw new Error('Ingen anslutning.');const result=await delivery(id);await reload?.();if(result.sent){toast(d.ch==='wa'?'Svar skickat via WhatsApp.':'Svaret är sparat som skickat.');if(state.m.scr==='thread'&&state.m.id===id)actions.mobileGo('done',id);}else{const error=result.error??'WhatsApp-svaret kunde inte skickas. Försök igen.';update(s=>{const t=s.threads.find(t=>t.id===id);if(t)t.deliveryError=error;});toast(error);}}catch(error){const message=error instanceof Error?error.message:'Svaret kunde inte skickas.';if(d.ch==='wa')update(s=>{const t=s.threads.find(t=>t.id===id);if(t)t.deliveryError=message;});toast(message);}finally{update(s=>{const draft=s.drafts[id];if(draft)draft.busy=false;});}})();},
    simNew(){toast('Använd Ny förfrågan.');},
    openMobile(path?:string){update(s=>{if(path==='/'||path==='/offerter'||path==='/kanaler'||path==='/installningar')s.desktopPath=path as DesktopPath;s.view='mob';s.m={scr:'lock',id:null,editing:false};});},
    mobileGo(scr:EstimState['m']['scr'],id?:string){update(s=>{s.m={scr,id:id||s.m.id,editing:false};});},mobileEdit(){update(s=>{s.m.editing=!s.m.editing;});},
    mobileApprove(id:string){actions.send(id);},mobilePrice(id:string){actions.select(id);actions.openDrawer(id);},
  };
  return {getSnapshot:()=>state,subscribe:(l:()=>void)=>{listeners.add(l);return()=>{listeners.delete(l);};},actions,
    connectAi(next:RealAi){ai=next;},
    connectDelivery(next:(id:string)=>Promise<{sent:boolean;error:string|null}>){delivery=next;},
    // "Försök igen": rerun only the missing steps (a saved quote means interpretation already ran).
    retryAi(id:string){const t=state.threads.find(t=>t.id===id);if(!t)return;if(t.q){const d=state.drafts[id];if(d&&!d.busy)void aiReply(id,d.v);}else void actions_runRequest(id);},
    // New request flow: analys -> interpret -> code-built quote -> reply draft -> svar. Never sends.
    runRequest:actions_runRequest,
    connect(write:(input:RealMutation)=>Promise<unknown>,read:()=>Promise<void>){mutate=write;reload=read;},
    hydrate(next:WorkspaceData){data=next;const previous=state;state=workspaceState(next,state);let failed=false;for(const t of state.threads){if(dirtyQuotes.has(t.id))t.q=previous.threads.find(p=>p.id===t.id)?.q??t.q;if(previous.threads.find(p=>p.id===t.id)?.status==='analys'&&t.status==='svar'&&!state.drafts[t.id]?.text&&state.drafts[t.id]?.warn?.includes('AI kunde inte svara just nu'))failed=true;}listeners.forEach(l=>l());if(failed)toast('AI kunde inte svara just nu');},
    clear(){epoch++;clearTimeout(toastTimer);dirtyQuotes.clear();data=null;mutate=undefined;reload=undefined;queue=Promise.resolve();writeError=false;state=emptyRealState();listeners.forEach(l=>l());},
    async flush(){await queue;if(writeError)throw new Error('Kunde inte spara.');},
    async saveQuote(){const id=state.drawer;if(!id||!dirtyQuotes.has(id))return;const q=state.threads.find(t=>t.id===id)?.q;if(!q)return;const quote={...q,owners:q.owners===2?2 as const:1 as const,prisform:q.prisform==='fast'?'fast' as const:'ungefar' as const,lines:q.lines.map(l=>({...l,typ:l.typ==='arbete'?'arbete' as const:l.typ==='material'?'material' as const:'resa' as const}))};await persist({kind:'quote',id,quote});dirtyQuotes.delete(id);try{await reload?.();}catch(error){dirtyQuotes.add(id);throw error;}
      // Regenerate the reply with the saved numbers unless the user edited the text by hand.
      const d=state.drafts[id];if(ai&&d&&!d.edited)void aiReply(id,d.v);},
    async createQuote(id:string){await queue;dirtyQuotes.add(id);const nr=String(Math.max(1000,...(data?.quotes.map(q=>Number(q.nr))??[]))+1);update(s=>{const t=s.threads.find(t=>t.id===id);if(t)t.q={nr,owners:1,addOn:false,prisform:'ungefar',lines:[]};});actions.openDrawer(id);},
    addMoment(id:string){const moment=data?.moments.find(m=>m.id===id);if(!moment)return;changeQuote(q=>{q.lines.push({t:moment.name,typ:'arbete',q:moment.hours_per_unit,u:'h',p:data?.company?.hourly_rate_ex_vat??0,rot:moment.rot_eligible});if(moment.material_per_unit_ex_vat)q.lines.push({t:moment.name+' · material',typ:'material',q:1,u:moment.unit,p:moment.material_per_unit_ex_vat,rot:false});});},
  };
}