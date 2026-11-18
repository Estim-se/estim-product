import { useEffect, useRef, type ReactNode } from 'react';

// Keep this scroll node mounted through store updates; only screen changes reset it.
export function PhoneFrame({ screenKey, children }: { screenKey: string; children: ReactNode }) {
  const screen = useRef<HTMLDivElement>(null);
  useEffect(() => { if (screen.current) screen.current.scrollTop = 0; }, [screenKey]);
  return <div className="phone"><div className="screen" ref={screen}>{children}</div></div>;
}