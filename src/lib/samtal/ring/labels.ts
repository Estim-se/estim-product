// estim Samtal A3/A4 (Ring estim): Swedish labels. Browser-safe.
export const RING_NUMBER_DISPLAY = '08-525 146 19';
export const RING_GREETING = 'Hej och välkommen till estim! Berätta vad du vill komma ihåg och lägg på när du är klar.';
export const CALL_KIND: Record<string, string> = { telefonsamtal: 'Telefonsamtal', rostanteckning: 'Röstanteckning' };
export const RING_STATUS: Record<string, string> = { mottagen: 'Bearbetas', bearbetas: 'Bearbetas', klar: 'Klar', privat: 'Privat – raderas', fel: 'Fel' };
export const RING_DRAFT_KIND: Record<string, string> = { uppgift: 'Uppgift', paminnelse: 'Påminnelser', materialunderlag: 'Materialunderlag', offertutkast: 'Offertutkast', kundanteckning: 'Kundanteckning' };
export const RING_TEXT = {
  heading: 'Röstanteckningar',
  needsReview: 'Behöver granskas',
  customerMissing: 'Kund saknas',
  chooseCompany: 'Välj företag',
  chooseCompanyHelp: 'Du hör till flera företag. Välj vilket företag anteckningen gäller. Den syns inte för något företag innan du har valt.',
  contextHelp: 'Ska du ringa in en anteckning? Välj företag först, så hamnar den rätt (gäller i 30 minuter).',
  reminders: 'Påminnelser',
  materials: 'Materialunderlag',
  quote: 'Offertutkast',
  noSend: 'Inget skickas, beställs eller offereras automatiskt. Allt här är utkast som du godkänner.',
  empty: 'Inga röstanteckningar ännu.',
} as const;
export const RING_REJECTION: Record<string, string> = {
  unknown_identity: 'Okänd uppringare', identity_conflict: 'Motstridig identitet', unverified_account: 'Overifierat konto', company_context_required: 'Företag måste väljas före samtalet',
};
