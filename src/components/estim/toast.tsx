import { Icon } from './icon';
import { useEstim } from './store-provider';

export function Toast() {
  const { state } = useEstim();
  return state.toast ? <div className="toast" role="status"><Icon name="check" />{state.toast}</div> : null;
}