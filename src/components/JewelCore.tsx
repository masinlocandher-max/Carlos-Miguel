import { useEffect, useRef, useState } from 'react';
import { stateLabel } from '../lib/model';
import type { JewelState } from '../lib/model';
import type { CoreController } from '../visual/JewelRenderer';
export function JewelCore({
  state,
  audioAmplitude = 0,
}: {
  state: JewelState;
  audioAmplitude?: number;
}) {
  const host = useRef<HTMLDivElement>(null),
    controller = useRef<CoreController | null>(null);
  const stateRef = useRef(state),
    audioRef = useRef(audioAmplitude);
  const [error, setError] = useState(false);
  stateRef.current = state;
  audioRef.current = audioAmplitude;
  useEffect(() => {
    const abort = new AbortController();
    import('../visual/JewelRenderer')
      .then((module) => module.createJewelRenderer(host.current!, stateRef.current, abort.signal))
      .then((instance) => {
        if (abort.signal.aborted) {
          instance.dispose();
          return;
        }
        controller.current = instance;
        instance.setState(stateRef.current);
        instance.setAudioAmplitude(audioRef.current);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(true);
      });
    return () => {
      abort.abort();
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);
  useEffect(() => controller.current?.setState(state), [state]);
  useEffect(() => controller.current?.setAudioAmplitude(audioAmplitude), [audioAmplitude]);
  return (
    <div
      ref={host}
      className="jewel-stage"
      data-state={state}
      aria-label={`Jewel development core: ${stateLabel[state]}`}
    >
      {error && (
        <p className="asset-error" role="alert">
          Jewel’s live core could not initialize. Refresh to retry.
        </p>
      )}
    </div>
  );
}
