import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { DOC_TYPES, documentFileError, documentPath, type DocType } from '@/lib/documents';
import { Icon } from './icon';
import { useWorkspace } from './workspace-provider';

type Doc = { id: string; name: string; doc_type: DocType; description: string; file_path: string; file_name: string; uploaded_at: string };
type Draft = { name: string; doc_type: DocType; description: string; file: File | null };
const empty: Draft = { name: '', doc_type: 'forsakring', description: '', file: null };
const docs = () => supabase.from('company_documents');
const bucket = () => supabase.storage.from('company-documents');

// Company document library (real mode only). Files live in a private bucket under
// <company_id>/; nothing here is used by the AI or sending yet.
export function DocumentLibrary() {
  const ws = useWorkspace();
  const cid = ws.data?.company?.id;
  const [list, setList] = useState<Doc[]>([]);
  const [draft, setDraft] = useState<Draft>(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await docs().select('*').order('uploaded_at', { ascending: false });
    if (!r.error) setList(r.data as Doc[]);
  }, []);
  useEffect(() => { if (cid) void load(); }, [cid, load]);

  const reset = () => { setDraft(empty); setEditing(null); if (fileRef.current) fileRef.current.value = ''; };

  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!cid) return;
    const current = list.find(d => d.id === editing);
    if (!draft.name.trim()) return setMsg('Ge dokumentet ett namn.');
    if (!current && !draft.file) return setMsg('Välj en fil.');
    if (draft.file) { const err = documentFileError(draft.file); if (err) return setMsg(err); }
    setBusy(true); setMsg('');
    try {
      let stored: Pick<Doc, 'file_path' | 'file_name' | 'uploaded_at'> | undefined = current;
      if (draft.file) {
        const path = documentPath(cid, draft.file.name, crypto.randomUUID());
        const up = await bucket().upload(path, draft.file, { contentType: draft.file.type });
        if (up.error) throw up.error;
        stored = { file_path: path, file_name: draft.file.name, uploaded_at: new Date().toISOString() };
      }
      // A new document always has a file (checked above); this only narrows the type.
      if (!stored) throw new Error('Dokumentet saknar fil.');
      const { file_path, file_name, uploaded_at } = stored;
      const row = { name: draft.name.trim(), doc_type: draft.doc_type, description: draft.description.trim(), file_path, file_name, uploaded_at };
      const r = current ? await docs().update(row).eq('id', current.id).select().single() : await docs().insert(row).select().single();
      if (r.error) { if (draft.file) await bucket().remove([file_path]); throw r.error; }
      // Replaced file: remove the old original after the row points to the new one.
      if (current && draft.file && current.file_path !== file_path) await bucket().remove([current.file_path]);
      reset(); await load(); setMsg(current ? 'Dokumentet är uppdaterat.' : 'Dokumentet är sparat.');
    } catch { setMsg('Dokumentet kunde inte sparas. Försök igen.'); }
    setBusy(false);
  }

  async function remove(d: Doc) {
    if (!confirm(`Ta bort "${d.name}"?`)) return;
    setBusy(true);
    const r = await docs().delete().eq('id', d.id);
    if (r.error) setMsg('Dokumentet kunde inte tas bort.'); else { await bucket().remove([d.file_path]); if (editing === d.id) reset(); await load(); setMsg('Dokumentet är borttaget.'); }
    setBusy(false);
  }

  async function open(d: Doc) {
    const w = window.open('', '_blank');
    const r = await bucket().createSignedUrl(d.file_path, 60);
    if (r.data?.signedUrl && w) w.location.href = r.data.signedUrl; else { w?.close(); setMsg('Filen kunde inte öppnas.'); }
  }

  const label = (t: DocType) => DOC_TYPES.find(x => x.id === t)?.label ?? t;
  return <div className="card">
    <h3>Dokument</h3>
    <div className="sub">Försäkringsbevis, F-skatt och certifikat. Bara ert företag ser filerna.</div>
    {list.length > 0 && <div className="col mt12 settings-docs">{list.map(d => <div key={d.id} className="row between settings-doc">
      <span className="col"><span className="row small"><Icon name="doc" /><button type="button" className="linkbtn" onClick={() => void open(d)}>{d.name}</button><span className="chip">{label(d.doc_type)}</span></span>
        {d.description && <span className="xs muted">När: {d.description}</span>}
        <span className="xs muted">{d.file_name} · Uppladdad {new Date(d.uploaded_at).toLocaleDateString('sv-SE')}</span></span>
      <span className="row"><button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => { setEditing(d.id); setDraft({ name: d.name, doc_type: d.doc_type, description: d.description, file: null }); }}>Ändra</button>
        <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void remove(d)}>Ta bort</button></span>
    </div>)}</div>}
    {list.length === 0 && <div className="xs muted mt12">Inga dokument uppladdade än.</div>}
    <form className="col mt16 doc-form" onSubmit={save}>
      <b className="small">{editing ? 'Ändra dokument' : 'Lägg till dokument'}</b>
      <label className="field"><span>Namn</span><input value={draft.name} maxLength={120} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="T.ex. Försäkringsbevis 2026" /></label>
      <label className="field"><span>Typ</span><select value={draft.doc_type} onChange={e => setDraft({ ...draft, doc_type: e.target.value as DocType })}>{DOC_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
      <label className="field"><span>När ska AI:n skicka detta?</span><input value={draft.description} maxLength={500} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="T.ex. när kunden frågar om försäkring" /></label>
      <label className="field"><span>{editing ? 'Byt fil (valfritt)' : 'Fil'} · PDF eller bild, max 10 MB</span><input ref={fileRef} type="file" accept="application/pdf,image/*" onChange={e => setDraft({ ...draft, file: e.target.files?.[0] ?? null })} /></label>
      <span className="row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>{busy ? 'Sparar…' : editing ? 'Spara ändringar' : 'Ladda upp'}</button>
        {editing && <button className="btn btn-ghost btn-sm" type="button" onClick={reset}>Avbryt</button>}
      </span>
      {msg && <span className="small" role="status">{msg}</span>}
    </form>
  </div>;
}
