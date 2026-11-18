import type { MobileScreen } from '@/lib/estim-store';
import { Icon } from './icon';

// The explanation follows the phone's current step, as in the prototype.
export function MobileExplainer({ screen }: { screen: MobileScreen }) {
  const index = { lock: 0, list: 1, thread: 2, done: 3 }[screen];
  return <div className="side-explain"><div className="eyebrow">Mellan två jobb</div><h2 className="mt8">Läs AI:ns svar. <span className="serif">Tryck en gång.</span></h2>
    <p className="small muted mt12">Det här är kärnan för en VD som själv står på jobbet. Ingen behöver sitta vid datorn för att kunden ska få svar samma timme.</p>
    <ol>{['Notis när ett AI-svar är klart', 'Hela tråden och AI:ns förslag', 'Godkänn, ändra text eller ring', 'Skickat i kundens kanal'].map((text, i) => <li key={text} className={i === index ? 'on' : ''}>{text}</li>)}</ol>
    <div className="flag ok mt16"><Icon name="spark" /><span>Samma inkorg som på datorn. Det du godkänner här syns direkt där.</span></div></div>;
}