import { initialThreads, simulatedRequest, type InboxFilter, type Thread } from '@/data/inbox';
import { DRAFTS, formal, type DraftVariant } from './drafts';
import type { Quote } from './quote';
import { settings } from '@/data/prototype-pages';

export interface Draft { text: string; v: DraftVariant; ch: string; att: string[]; edited: boolean }
export function initial() {
  const threads = initialThreads();
  const drafts: Record<string, Draft> = {};
  threads.forEach(t => { const generator = DRAFTS[t.id]; if (generator) drafts[t.id] = { text: generator(t), v: 'std', ch: t.ch === 'form' ? 'email' : t.ch, att: t.att.slice(), edited: false }; });
  return { view: 'desk', page: 'inkorg', sel: 'lind', filter: 'alla' as InboxFilter, threads, drafts,
    settings: settings.map(s => s.on), drawer: null as string | null, modal: null as { type: string; id: string; preview?: boolean } | null,
    toast: '', hl: null as string | null, guide: { on: false, step: 0 },
    m: { scr: 'lock', id: null as string | null, editing: false }, cust: { step: 'view' }, stats: { ai: 14, sek: 47 } };
}
export type EstimState = ReturnType<typeof initial>;
const now = () => new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
const ev = (t: Thread, text: string) => t.events.push([now(), text]);
const channelNames: Record<string, string> = { email: 'E-post', sms: 'SMS', wa: 'WhatsApp' };

// Store-owned timers survive route/component changes. Reset cancels old demo events.
export function createEstimStore() {
  let state = initial();
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let customerVisit = 0;
  const update = (fn: (s: EstimState) => void) => { state = structuredClone(state); fn(state); listeners.forEach(l => l()); };
  const after = (ms: number, fn: (s: EstimState) => void) => {
    const timer = setTimeout(() => { timers.delete(timer); update(fn); }, ms); timers.add(timer);
  };
  const toast = (text: string) => {
    clearTimeout(toastTimer); update(s => { s.toast = text; });
    toastTimer = setTimeout(() => update(s => { s.toast = ''; }), 3200);
  };
  const follow = (id: string, ms: number, fn: (s: EstimState, t: Thread) => void) => after(ms, s => { const t = s.threads.find(t => t.id === id); if (t) fn(s, t); });
  const notify = (s: EstimState, text: string) => { if (!s.modal && s.view === 'desk') toast(text); };
  const win = (s: EstimState, t: Thread, week: string) => {
    t.status = 'vunnen'; t.week = week; ev(t, 'Godkänd med BankID');
    t.msgs.push({ from: 'ai', ch: t.ch, time: now(), text: `Tack ${t.name.split(' ')[0]}! Vi har fått ditt godkännande. Vår elektriker hör av sig för att boka tid ${week}. /Volt Vision`, auto: true });
    ev(t, 'AI skrev överlämning till elektrikern'); notify(s, `${t.name.split(' ')[0]} godkände med BankID`);
  };
  const actions = {
    update, toast,
    toggleSetting(index: number) { update(s => { if (index >= 0 && index < s.settings.length) s.settings[index] = !s.settings[index]; }); },
    reset() { timers.forEach(clearTimeout); timers.clear(); clearTimeout(toastTimer); state = initial(); toast('Demon är återställd'); },
    select(id: string) { update(s => { const t = s.threads.find(t => t.id === id); if (!t) return; t.read = true; s.sel = id; s.page = 'inkorg'; s.view = 'desk'; s.hl = null; }); },
    toggleAuto(id: string) { let auto = false; update(s => { const t = s.threads.find(t => t.id === id); if (t) { t.autopilot = !t.autopilot; auto = t.autopilot; } }); toast(auto ? 'AI svarar själv i den här tråden. Priser kräver fortfarande ditt OK.' : 'AI skriver utkast, du skickar'); },
    setDraft(id: string, v: DraftVariant) { update(s => { const t = s.threads.find(t => t.id === id), d = s.drafts[id]; if (!t || !d) return; const generator = DRAFTS[id === 'karl' && t.stage2 ? 'karl2' : id]; if (!generator) return; const base = generator(t, v === 'formell' ? 'std' : v); Object.assign(d, { text: v === 'formell' ? formal(base) : base, v, edited: false }); }); },
    regen(id: string) { const d = state.drafts[id]; if (d && !d.edited) actions.setDraft(id, d.v); },
    editDraft(id: string, text: string) { update(s => { const d = s.drafts[id]; if (d) { d.text = text; d.edited = true; } }); },
    addAtt(id: string, value: string) { update(s => { const d = s.drafts[id]; if (d && value && !d.att.includes(value)) d.att.push(value); }); },
    delAtt(id: string, index: number) { update(s => { s.drafts[id]?.att.splice(index, 1); }); },
    setCh(id: string, ch: string) { update(s => { const t = s.threads.find(t => t.id === id), d = s.drafts[id]; if (t && d && (ch === 'email' ? t.email !== '—' : t.phone !== '—')) d.ch = ch; }); },
    openDrawer(id: string) { update(s => { s.drawer = id; }); },
    closeDrawer() { const id = state.drawer; update(s => { s.drawer = null; }); if (id) actions.regen(id); },
    upd(index: number, key: 't' | 'q' | 'p', value: string) {
      const id = state.drawer; if (!id) return;
      update(s => { const line = s.threads.find(t => t.id === id)?.q?.lines[index]; if (!line) return;
        if (key === 't') line.t = value; else line[key] = parseFloat(value.replace(/\s/g, '').replace(',', '.')) || 0;
      }); actions.regen(id);
    },
    togRot(index: number) { const id = state.drawer; if (!id) return; update(s => { const l = s.threads.find(t => t.id === id)?.q?.lines[index]; if (l) l.rot = !l.rot; }); actions.regen(id); },
    delL(index: number) { const id = state.drawer; if (!id) return; update(s => { s.threads.find(t => t.id === id)?.q?.lines.splice(index, 1); }); actions.regen(id); },
    addL(opt = false) { const id = state.drawer; if (!id) return; update(s => { s.threads.find(t => t.id === id)?.q?.lines.push({ t: opt ? 'Nytt tillval' : 'Ny rad', typ: 'arbete', q: 1, u: 'h', p: 650, rot: true, ...(opt ? { opt: true } : {}) }); }); actions.regen(id); },
    setOwners(owners: number) { const id = state.drawer; if (!id) return; update(s => { const q = s.threads.find(t => t.id === id)?.q; if (q) q.owners = owners; }); actions.regen(id); },
    setPriceForm(prisform: Quote['prisform']) { const id = state.drawer; if (!id) return; update(s => { const q = s.threads.find(t => t.id === id)?.q; if (q) q.prisform = prisform; }); actions.regen(id); },
    openCustomer(id: string, preview?: boolean) { customerVisit++; update(s => { s.cust = { step: 'view' }; s.modal = { type: 'cust', id, ...(preview === undefined ? {} : { preview }) }; }); },
    closeCustomer() { customerVisit++; update(s => { s.modal = null; }); },
    toggleAddOn(id: string) { update(s => { const q = s.threads.find(t => t.id === id)?.q; if (q) q.addOn = !q.addOn; }); actions.regen(id); },
    approveCustomer() {
      const modal = state.modal; if (!modal || state.cust.step !== 'view') return;
      if (modal.preview) { toast('Förhandsvisning. Skicka svaret först.'); return; }
      update(s => { s.cust.step = 'bankid'; });
      // Mock signing only; a visit counter isolates timers from closed/reopened views.
      const visit = customerVisit;
      after(1600, s => { if (customerVisit === visit && s.modal?.id === modal.id && s.cust.step === 'bankid') s.cust.step = 'info'; });
    },
    submitCustomer() { update(s => { if (!s.modal || s.modal.preview || s.cust.step !== 'info') return; const t = s.threads.find(t => t.id === s.modal?.id); if (!t) return; s.cust.step = 'klar'; win(s, t, 'v. 50'); }); },
    sendBrief(id: string) { update(s => { const t = s.threads.find(t => t.id === id); if (t) { t.briefSent = true; ev(t, 'Överlämning skickad till elektrikern (SMS) och order@voltvision.se'); } }); toast('Skickat till elektrikern och order@voltvision.se'); },
    send(id: string, { silent = false } = {}) {
      if (!state.drafts[id]) return;
      let sentToast = '';
      update(s => {
        const t = s.threads.find(t => t.id === id), d = s.drafts[id]; if (!t || !d) return;
        t.msgs.push({ from: 'vv', ch: d.ch, time: now(), text: d.text, att: d.att.slice(), quote: d.att.some(a => a.startsWith('Offert')) });
        t.read = true; t.lastSent = now(); if (!t.chs.includes(d.ch)) t.chs.push(d.ch);
        ev(t, `Svar skickat via ${channelNames[d.ch]}`); s.stats.ai++; delete s.drafts[id];
        sentToast = `Skickat till ${t.name.split(' ')[0]} via ${channelNames[d.ch]}`;
        t.status = ['lind', 'jonas'].includes(id) || (id === 'karl' && t.stage2) ? 'skickad' : 'ai';
      });
      if (!silent) toast(sentToast);
      if (id === 'lind') follow(id, 2400, (s, t) => { t.opened = true; ev(t, 'Sara öppnade offerten'); notify(s, 'Sara öppnade den uppdaterade offerten'); });
      if (id === 'wallin') follow(id, 3200, (_s, t) => {
        t.msgs.push({ from: 'kund', ch: 'email', time: now(), text: 'Hej! Torsdag 07.30 passar bra. Huset är från 1929 och uttagen är inte jordade. Induktion och ugn där ritningen visar. Spotlights i sovrummet!\n/Erik' }); ev(t, 'Erik svarade');
        follow(id, 1400, (s, t) => { t.msgs.push({ from: 'ai', ch: 'email', time: now(), text: 'Tack Erik! Då ses vi torsdag 26/11 kl 07.30 på Vikingagatan 8. Vi skickar en påminnelse kvällen innan. /Volt Vision', auto: true }, { from: 'sys', time: now(), text: 'AI bokade platsbesök tor 26/11 07:30 i er kalender' }); ev(t, 'Platsbesök bokat tor 26/11 07:30'); t.status = 'bokat'; t.facts = [['trygg', 'Platsbesök bokat tor 26/11 07:30'], ['info', 'Huset från 1929, ojordat. Räkna med jordning i hela lägenheten.'], ['info', 'Induktion + ugn, spotlights i sovrummet']]; notify(s, 'AI bokade platsbesöket själv'); });
      });
      if (id === 'jonas') follow(id, 3000, (s, t) => { t.msgs.push({ from: 'sys', time: now(), text: 'Jonas godkände med BankID och fyllde i uppgifter för ROT' }); win(s, t, 'v. 48'); });
      if (id === 'karl') {
        const t = state.threads.find(t => t.id === id);
        if (!t?.stage2) follow(id, 3000, (s, t) => { t.msgs.push({ from: 'kund', ch: 'sms', time: now(), text: 'Tack! Vi kör på det. Kan ni börja v. 49?' }); Object.assign(t, { status: 'svar', stage2: true, read: false, autopilot: false, facts: [['trygg', 'Karl vill köra v. 49'], ['spark', 'Bokningar lämnar AI:n alltid till dig']], why: 'Karl vill köra. Bokningar går alltid via dig, så AI:n har pausat autopiloten. Svaret bekräftar veckan och ber honom godkänna med BankID.', asks: [['Kan ni börja v. 49?', 1]] }); s.drafts['karl'] = { text: DRAFTS.karl2(t), v: 'std', ch: 'sms', att: ['Offert #1049'], edited: false }; ev(t, 'Karl svarade via SMS'); notify(s, 'Karl svarade. Nytt AI-utkast väntar.'); });
        else follow(id, 2800, (s, t) => { t.msgs.push({ from: 'sys', time: now(), text: 'Karl godkände med BankID' }); win(s, t, 'v. 49'); });
      }
    },
    simNew() {
      if (state.threads.some(t => t.id === 'sofia')) { actions.select('sofia'); return; }
      update(s => { s.threads.unshift(simulatedRequest()); s.sel = 'sofia'; s.page = 'inkorg'; s.view = 'desk'; });
      follow('sofia', 1800, (_s, t) => { t.msgs.push({ from: 'ai', ch: 'sms', time: now(), text: DRAFTS.sofia(t), auto: true }); t.status = 'ai'; ev(t, 'AI ställde följdfrågor automatiskt'); });
      after(1800, s => { s.stats.ai++; toast('AI svarade Sofia på 38 sekunder'); });
    },
  };
  return { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, actions };
}