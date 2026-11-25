import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { getSamtal } from '@/lib/samtal/samtal.functions';
import { Icon } from './icon';
import { useWorkspace } from './workspace-provider';

// estim Samtal: the navigation link, shown only in real mode when the flag SAMTAL is on. It asks the server once per
// company and renders nothing on any failure, so the shell behaves exactly as before when Samtal is off.
const known = new Map<string, boolean>();
export function SamtalNavLink() {
  const workspace = useWorkspace();
  const company = workspace.mode === 'real' ? workspace.data?.company?.id : undefined;
  const [enabled, setEnabled] = useState(() => !!company && known.get(company) === true);
  useEffect(() => {
    if (!company) { setEnabled(false); return; }
    if (known.has(company)) { setEnabled(known.get(company)!); return; }
    let live = true;
    getSamtal().then(r => { known.set(company, !!r.enabled); if (live) setEnabled(!!r.enabled); }).catch(() => undefined);
    return () => { live = false; };
  }, [company]);
  if (!enabled) return null;
  return <Button asChild variant="prototype" className="nav"><Link to="/samtal" activeProps={{ className: 'active' }} title="Samtal"><Icon name="phone" /><span>Samtal</span></Link></Button>;
}
