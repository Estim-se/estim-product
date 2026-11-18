import { Button } from '@/components/ui/button';
import { settings } from '@/data/prototype-pages';
import { useEstim } from './store-provider';

export function SettingToggle({ index }: { index: number }) {
  const { state, actions } = useEstim(), setting = settings[index];
  if (!setting) return null;
  return <div className="kop"><div className="grow"><b>{setting.label}</b><span>{setting.sub}</span></div><Button variant="prototype" role="switch" aria-label={setting.label} aria-checked={state.settings[index]} className={`toggle ${state.settings[index] ? 'on' : ''}`} onClick={() => actions.toggleSetting(index)} /></div>;
}