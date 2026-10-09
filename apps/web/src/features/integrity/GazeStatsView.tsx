import { plural } from '@examguard/contracts';
import { SECTORS } from './gazeEstimator.js';
import { wedgePath } from './GazeDial.js';
import type { GazeStatsSnapshot } from './gazeStats.js';

const pct = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(0)}%`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const minutes = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** Mini polar histogram: wedge length per compass sector = off-screen dwell; centre = on screen. */
export function SectorHistogram({
  sectorMs,
  onScreenMs,
}: {
  readonly sectorMs: readonly number[];
  readonly onScreenMs: number;
}) {
  const max = Math.max(1, ...sectorMs);
  const total = Math.max(1, onScreenMs + sectorMs.reduce((a, b) => a + b, 0));
  return (
    <svg viewBox="-60 -60 120 120" role="img" aria-label="Time per gaze direction" width={120}>
      {SECTORS.map((name, i) => {
        const ms = sectorMs[i] ?? 0;
        return (
          <path
            key={name}
            d={wedgePath(i * 45, 12 + 40 * (ms / max))}
            fill={`hsla(215, 75%, 52%, ${(0.25 + 0.6 * (ms / max)).toFixed(2)})`}
            stroke="#fff"
            strokeWidth={0.5}
          >
            <title>{`${name}: ${secs(ms)} (${((ms / total) * 100).toFixed(0)}%)`}</title>
          </path>
        );
      })}
      <circle r={10} fill={`rgba(20,184,166,${(0.2 + 0.7 * (onScreenMs / total)).toFixed(2)})`} />
    </svg>
  );
}

/** Statistics for the camera panel (and the instructor live view). Neutral wording only. */
export function GazeStats({ stats }: { readonly stats: GazeStatsSnapshot }) {
  const bySector = SECTORS.flatMap((name, i) =>
    (stats.sectorMs[i] ?? 0) > 0 ? [`${name} ${secs(stats.sectorMs[i]!)}`] : [],
  );
  return (
    <div className="gaze-stats">
      <SectorHistogram sectorMs={stats.sectorMs} onScreenMs={stats.onScreenMs} />
      <dl className="gaze-stats-grid">
        <dt>Observed</dt>
        <dd>{minutes(stats.observedMs)}</dd>
        <dt>Time on screen</dt>
        <dd>{pct(stats.onScreenPct)}</dd>
        <dt>Looked away</dt>
        <dd>
          {stats.lookAwayCount}× · longest {secs(stats.longestLookAwayMs)} · average{' '}
          {secs(stats.averageLookAwayMs)}
        </dd>
        <dt>Off-screen by direction</dt>
        <dd>{bySector.length > 0 ? bySector.join(' · ') : 'none'}</dd>
        <dt>Blink rate</dt>
        <dd>
          {stats.blinkRatePerMin === null
            ? 'measuring…'
            : `${stats.blinkRatePerMin.toFixed(0)} / min`}{' '}
          <span className="muted">({stats.blinkCount} seen; fast blinks can be missed)</span>
        </dd>
        <dt>Face present</dt>
        <dd>{pct(stats.facePresentPct)}</dd>
        <dt>More than one face</dt>
        <dd>
          {plural(stats.multipleFaceEvents, 'event')} ({secs(stats.multipleFaceMs)})
        </dd>
        <dt>Tracking quality</dt>
        <dd>{stats.quality === null ? 'n/a' : `${Math.round(stats.quality * 100)}%`}</dd>
        <dt>Phone detector</dt>
        <dd>
          {!stats.phoneAvailable
            ? 'unavailable'
            : `${plural(stats.phoneCandidateFrames, 'candidate frame')} · ${stats.phoneConfirmations} confirmed · last ${
                stats.phoneLastScore === null ? 'n/a' : stats.phoneLastScore.toFixed(2)
              } · max ${stats.phoneMaxScore.toFixed(2)}`}
        </dd>
        <dt>Vision rate</dt>
        <dd>{stats.fps === null ? 'n/a' : `${stats.fps.toFixed(1)} frames/s`}</dd>
      </dl>
    </div>
  );
}
