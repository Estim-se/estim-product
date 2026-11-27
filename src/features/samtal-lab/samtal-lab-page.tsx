// Samtal Test Lab: temporary internal demo. Everything runs in the browser on synthetic data; no calls leave the page.
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { calc, kr } from '@/lib/quote';
import { analyse, matchAssignment, rotSentence, type Analysis, type CallType, type Evidence } from './analyze';
import { catalog, customers, employees, examples, type LabCustomer } from './data';

const TYPES: [CallType, string][] = [['in', 'Inkommande samtal'], ['ut', 'Utgående samtal'], ['ring', 'Ring estim']];
const selectCls = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';

function EvidenceList({ items }: { items: Evidence[] }) {
  return <ul className="mt-2 space-y-1 text-sm text-muted-foreground">{items.map((e, i) => <li key={i}>{e.ok ? '✓' : '!'} {e.label}</li>)}</ul>;
}

export function SamtalLabPage() {
  const [employee, setEmployee] = useState(employees[0]!.id);
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<CallType>('in');
  const [text, setText] = useState('');
  const [result, setResult] = useState<Analysis | null>(null);
  const [chosen, setChosen] = useState<LabCustomer | null>(null);

  const reset = () => { setPhone(''); setType('in'); setText(''); setResult(null); setChosen(null); setEmployee(employees[0]!.id); };
  const run = () => { setChosen(null); setResult(analyse({ text, phone, type }, { customers, catalog })); };

  const customer = result && !result.privat ? (result.customer.kind === 'befintlig' ? result.customer.customer : chosen) : null;
  const assignment = result && !result.privat ? (result.assignment ?? (chosen ? matchAssignment(text, chosen) : null)) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Samtal Test Lab</h1>
        <Badge variant="destructive">Simulerad AI – regelbaserad analys, ingen riktig AI används</Badge>
      </div>
      <p className="text-sm text-muted-foreground">Intern demo med påhittade kunder. Inget sparas, skickas eller hämtas från servern.</p>

      <Card><CardContent className="space-y-3 pt-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <div><Label htmlFor="lab-emp">Anställd</Label><select id="lab-emp" className={selectCls} value={employee} onChange={e => setEmployee(e.target.value)}>{employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
          <div><Label htmlFor="lab-phone">Kundens/motpartens telefonnummer</Label><Input id="lab-phone" value={phone} onChange={e => setPhone(e.target.value)} placeholder="070-123 45 67" /></div>
          <div><Label htmlFor="lab-type">Typ</Label><select id="lab-type" className={selectCls} value={type} onChange={e => setType(e.target.value as CallType)}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        </div>
        <div><Label htmlFor="lab-text">Transkribering</Label><Textarea id="lab-text" rows={9} value={text} onChange={e => setText(e.target.value)} placeholder="Skriv eller klistra in ett samtal…" /></div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={run} disabled={!text.trim()}>Analysera samtal</Button>
          <Button variant="outline" onClick={reset}>Återställ</Button>
        </div>
        <div className="flex flex-wrap gap-2 text-sm"><span className="self-center text-muted-foreground">Exempel:</span>
          {examples.map(x => <Button key={x.label} size="sm" variant="secondary" onClick={() => { setText(x.text); setPhone(x.phone); setType(x.type); setEmployee(x.employee); setResult(null); setChosen(null); }}>{x.label}</Button>)}
        </div>
      </CardContent></Card>

      {result?.privat && <Card><CardHeader><CardTitle>Inget affärsunderlag</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">Samtalet ser privat ut. Ingen kund, inget uppdrag, ingen offert och inga uppgifter skapas.</CardContent></Card>}

      {result && !result.privat && <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>Kund</CardTitle></CardHeader><CardContent>
          {result.customer.kind === 'befintlig' && <p><strong>{result.customer.customer.name}</strong>, {result.customer.customer.address}, {result.customer.customer.place} <Badge variant="secondary">Befintlig kund</Badge></p>}
          {result.customer.kind === 'ny' && <p><strong>{result.customer.name ?? 'Okänt namn'}</strong>{result.customer.address ? `, ${result.customer.address}` : ''} <Badge variant="secondary">Ny kund föreslås</Badge></p>}
          {result.customer.kind === 'oklar' && <div className="space-y-2"><Badge variant="destructive">Kräver bekräftelse</Badge><p className="text-sm">Välj rätt kund:</p>
            <div className="flex flex-wrap gap-2">{result.customer.candidates.map(c => <Button key={c.id} size="sm" variant={chosen?.id === c.id ? 'default' : 'outline'} onClick={() => setChosen(c)}>{c.name}, {c.address}</Button>)}</div></div>}
          <EvidenceList items={result.customer.evidence} />
        </CardContent></Card>

        <Card><CardHeader><CardTitle>Uppdrag</CardTitle></CardHeader><CardContent>
          {!assignment && <p className="text-sm text-muted-foreground">Bekräfta kunden först.</p>}
          {assignment?.kind === 'befintligt' && <p><strong>{assignment.assignment.title}</strong> ({assignment.assignment.status}) <Badge variant="secondary">{assignment.addOn ? 'Tilläggsarbete' : 'Befintligt uppdrag'}</Badge></p>}
          {assignment?.kind === 'nytt' && <p><strong>{assignment.title}</strong> <Badge variant="secondary">Nytt uppdrag föreslås</Badge></p>}
          {customer && customer.assignments.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Kundens uppdrag: {customer.assignments.map(a => a.title).join(', ')}</p>}
          {assignment && <EvidenceList items={assignment.evidence} />}
        </CardContent></Card>

        <Card className="md:col-span-2"><CardHeader><CardTitle>Offertutkast (ej skickat)</CardTitle></CardHeader><CardContent>
          {!result.quote ? <p className="text-sm text-muted-foreground">Inga prissatta arbeten hittades i samtalet.</p> : (() => { const t = calc(result.quote.quote); return <>
            <table className="w-full text-sm"><thead><tr className="text-left text-muted-foreground"><th>Rad</th><th>Antal</th><th className="text-right">À-pris</th><th className="text-right">Summa</th></tr></thead>
              <tbody>{result.quote.quote.lines.map((l, i) => <tr key={i} className="border-t"><td>{l.t}</td><td>{l.q} {l.u}</td><td className="text-right">{kr(l.p)}</td><td className="text-right">{kr(l.q * l.p)}</td></tr>)}</tbody></table>
            <div className="mt-3 space-y-1 text-sm"><p>Inkl. moms: {kr(t.inkl)} · ROT-avdrag: −{kr(t.av)}</p><p className="font-medium">{rotSentence(result.quote.quote)}</p>
              {result.quote.missing.length > 0 && <p className="text-muted-foreground">Mängd saknas för: {result.quote.missing.join(', ')}</p>}</div>
          </>; })()}
        </CardContent></Card>

        <Card className="md:col-span-2"><CardHeader><CardTitle>Uppgifter och påminnelser</CardTitle></CardHeader><CardContent>
          {result.tasks.length === 0 ? <p className="text-sm text-muted-foreground">Inga uppgifter hittades.</p> :
            <ul className="space-y-1 text-sm">{result.tasks.map((t, i) => <li key={i}>• {t.text} {t.due && <Badge variant="outline">{t.due}</Badge>} <span className="text-muted-foreground">– {employees.find(e => e.id === employee)?.name}</span></li>)}</ul>}
        </CardContent></Card>
      </div>}
    </div>
  );
}
