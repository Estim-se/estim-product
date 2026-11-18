import { QuoteTable } from './quote-table';
import { TopHeader } from './top-header';
import { Icon } from './icon';

export function OfferterPage() {
  return <><TopHeader title="Offerter" subtitle="Alla offerter på ett ställe. Klicka för att se hela konversationen." /><QuoteTable /><div className="flag ok mt16 quote-table-note"><Icon name="info" /><span>Offerten är en del av konversationen, inte en egen modul. Godkända offerter mejlas som PDF till ert affärssystem, till exempel Entré eller Fortnox.</span></div></>;
}