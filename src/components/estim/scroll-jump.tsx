import type { CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';

// Floating round button centred over a scroll area (up: top edge, down: bottom edge);
// the parent must be position:relative. Threshold and scrolling live in '@/lib/inbox-layout'.
export function ScrollJump({ direction, label, onClick, style }: { direction: 'up' | 'down'; label: string; onClick: () => void; style?: CSSProperties | undefined }) {
  return <Button variant="prototype" className={`xbtn scroll-jump scroll-jump-${direction}`} aria-label={label} title={label} style={style} onClick={onClick}>
    <Icon name="back" />
  </Button>;
}
