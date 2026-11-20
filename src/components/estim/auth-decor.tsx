// Decorative, slowly drifting line illustrations for the login page (purely visual).
const stroke={fill:'none',stroke:'currentColor',strokeWidth:1.4,strokeLinecap:'round' as const,strokeLinejoin:'round' as const};
export function AuthDecor(){
  return <div className="auth-decor" aria-hidden="true">
    <svg className="deco d1" viewBox="0 0 80 80" {...stroke}><path d="M14 22c10-8 26-10 38-4l4 6-8 2-4-4-6 2L22 64a4 4 0 0 1-6-4l18-34-6-2c-4 0-10 2-14 4Z"/></svg>
    <svg className="deco d2" viewBox="0 0 80 80" {...stroke}><rect x="30" y="10" width="26" height="22" rx="3"/><path d="M38 16v10h6m6-10v10M43 32 24 70"/></svg>
    <svg className="deco d3" viewBox="0 0 100 60" {...stroke}><rect x="10" y="20" width="62" height="16" rx="2"/><path d="M18 36v6m10-6v6m10-6v6m10-6v6m10-6v6M72 28h10c6 0 8-4 8-10V8"/></svg>
    <svg className="deco d4" viewBox="0 0 80 80" {...stroke}><path d="M44 8 22 44h16l-4 28 24-38H42l2-26Z"/></svg>
    <svg className="deco d5" viewBox="0 0 80 80" {...stroke}><circle cx="40" cy="34" r="16"/><path d="M33 52h14m-12 6h10m-9-14 4-8 4 8"/></svg>
  </div>;
}
