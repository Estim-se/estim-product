import type { Thread } from '@/data/inbox';
export type Quote = NonNullable<Thread['q']>;

// Pure calculations preserve the prototype rounding and deduction rules.
export const kr = (n: number) => Math.round(n).toLocaleString('sv-SE').replace(/ /g,' ') + ' kr';
export const esc = (s: unknown) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export const paras = (s: string) => s.split('\n').map(x => `<p>${esc(x)||'&nbsp;'}</p>`).join('');
export function calc(q: Quote, withAdd?: boolean){
  const add = withAdd===undefined ? q.addOn : withAdd;
  const Ls=q.lines.filter(l=>!l.opt || add);
  let exkl=0,arb=0,mat=0,rotB=0;
  Ls.forEach(l=>{ const v=l.q*l.p; exkl+=v; if(l.typ==='arbete') arb+=v; else mat+=v; if(l.rot&&l.typ==='arbete') rotB+=v; });
  const inkl=exkl*1.25; const rot=Math.min(rotB*1.25*0.30, 50000*(q.owners||1));
  const inklR=Math.round(inkl), avR=Math.round(rot);
  return {L:Ls, exkl, moms:inkl-exkl, inkl:inklR, arb, mat, av:avR, betala:inklR-avR};
}
export function calcAdd(q: Quote){ const A=q.lines.filter(l=>l.opt); let ex=0,rb=0; A.forEach(l=>{ex+=l.q*l.p; if(l.rot&&l.typ==='arbete') rb+=l.q*l.p;}); const inkl=Math.round(ex*1.25), av=Math.round(rb*1.25*0.3); return {inkl, av, betala:inkl-av, name:A[0]?.t}; }

