import { useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { openSentDocument } from '@/lib/document-link.functions';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';

export function SentDocument({ document }: { document: { id: string; name: string } }) {
  const openDoc = useServerFn(openSentDocument);
  const [error, setError] = useState('');
  async function open() {
    setError('');
    const tab = window.open('', '_blank');
    if (!tab) { setError('Tillåt nya flikar för att öppna dokumentet.'); return; }
    tab.opener = null;
    try { const result = await openDoc({ data: { id: document.id } }); tab.location.href = result.url; }
    catch { tab.close(); setError('Filen kunde inte öppnas.'); }
  }
  return <><Button variant="prototype" className="sent-document" onClick={() => void open()}><span className="thumb"><Icon name="doc" /></span><span>{document.name}</span></Button>{error && <p role="alert">{error}</p>}</>;
}