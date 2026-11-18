import { useEffect } from 'react';
import { useEstim } from './store-provider';
import { TopHeader } from './top-header';
import { MobileExplainer } from './mobile-explainer';
import { PhoneFrame } from './phone-frame';
import { LockScreen } from './lock-screen';
import { MobileInbox } from './mobile-inbox';
import { MobileThread } from './mobile-thread';
import { MobileDone } from './mobile-done';

export function MobilePage() {
  const { state, actions } = useEstim();
  // Direct route visits also start at the lock screen without changing desktop selection.
  useEffect(() => { actions.openMobile(); }, [actions]);
  const thread = state.threads.find(t => t.id === state.m.id);
  return <><TopHeader title="Appen i mobilen" subtitle="Byggd för dig som står på jobbet. Allt viktigt med en tumme." />
    <div className="stage fadein"><MobileExplainer screen={state.m.scr} /><PhoneFrame screenKey={`${state.m.scr}:${state.m.id ?? ''}`}>
      {state.m.scr === 'lock' ? <LockScreen /> : state.m.scr === 'list' ? <MobileInbox /> : thread ? state.m.scr === 'thread' ? <MobileThread thread={thread} /> : <MobileDone thread={thread} /> : <MobileInbox />}
    </PhoneFrame></div></>;
}