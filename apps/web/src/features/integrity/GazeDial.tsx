import { SECTORS, bearingLabel, type GazeSample } from './gazeEstimator.js';

/** Degrees of gaze that map to the outer ring of the dial. */
export const DIAL_MAX_DEGREES = 45;
const R = 90;
const K = R / DIAL_MAX_DEGREES;
const SECTOR_NAMES: Record<(typeof SECTORS)[number], string> = {
  N: 'up',
  NE: 'up and right',
  E: 'right',
  SE: 'down and right',
  S: 'down (desk or lap)',
  SW: 'down and left',
  W: 'left',
  NW: 'up and left',
};

/** Dial coordinates for a gaze angle; radius is clamped to the outer ring. */
export function dialPoint(yaw: number, pitch: number): { x: number; y: number } {
  let x = yaw * K;
  let y = -pitch * K;
  const r = Math.hypot(x, y);
  if (r > R) {
    x = (x / r) * R;
    y = (y / r) * R;
  }
  return { x, y };
}

function polar(bearing: number, radius: number): string {
  const a = (bearing * Math.PI) / 180;
  return `${(radius * Math.sin(a)).toFixed(2)},${(-radius * Math.cos(a)).toFixed(2)}`;
}

/** SVG path of a 45 degree wedge centred on a compass bearing. */
export function wedgePath(centre: number, radius = R): string {
  return `M0,0 L${polar(centre - 22.5, radius)} A${radius},${radius} 0 0 1 ${polar(centre + 22.5, radius)} Z`;
}

const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}°`;
const dir = (v: number, pos: string, neg: string) =>
  Math.abs(v) < 1 ? 'centre' : v > 0 ? pos : neg;

/**
 * Compass-style gaze dial. Centre = looking at the screen; N is up, S is down (desk or lap).
 * The shaded rectangle is the on-screen zone. Pure presentation: reusable for the instructor
 * live view by passing samples received from a student.
 */
export function GazeDial({
  sample,
  trail = [],
  sectorMs,
  caption,
}: {
  readonly sample: GazeSample | null;
  /** Recent samples, oldest first (about 5 s). Drawn as a fading trail. */
  readonly trail?: readonly GazeSample[];
  /** Off-screen dwell per sector (indexed like SECTORS) for sector shading. */
  readonly sectorMs?: readonly number[];
  readonly caption?: string;
}) {
  const maxMs = Math.max(1, ...(sectorMs ?? []));
  const zone = sample?.zone ?? { yaw: 22.5, pitch: 13.75 };
  const dot = sample ? dialPoint(sample.yaw, sample.pitch) : null;
  const latest = trail.length > 0 ? trail[trail.length - 1]!.t : 0;
  const summary = sample
    ? `Estimated gaze ${bearingLabel(sample)} from the screen centre, ${
        sample.onScreen
          ? 'on screen'
          : `${Math.round(sample.offScreenDeg)} degrees beyond the screen`
      }.`
    : 'No gaze estimate right now.';
  return (
    <figure className="gaze-dial" aria-label="Gaze dial" style={{ margin: 0 }}>
      <svg viewBox="-120 -120 240 240" role="img" aria-label={summary}>
        {SECTORS.map((name, i) => {
          const share = (sectorMs?.[i] ?? 0) / maxMs;
          return (
            <path
              key={name}
              d={wedgePath(i * 45)}
              fill={`hsla(215, 75%, 52%, ${(0.05 + 0.5 * share).toFixed(3)})`}
              stroke="#c3cee0"
              strokeWidth={0.5}
              data-sector={name}
            >
              <title>{`${name}: ${SECTOR_NAMES[name]}`}</title>
            </path>
          );
        })}
        {[15, 30, 45].map((d) => (
          <circle key={d} r={d * K} fill="none" stroke="#c3cee0" strokeDasharray="2 3" />
        ))}
        <rect
          data-testid="gaze-zone"
          x={-zone.yaw * K}
          y={-zone.pitch * K}
          width={zone.yaw * 2 * K}
          height={zone.pitch * 2 * K}
          fill="rgba(20, 184, 166, 0.18)"
          stroke="#0d9488"
          strokeWidth={1}
          rx={3}
        />
        {SECTORS.map((name, i) => {
          const [x, y] = polar(i * 45, R + 13).split(',');
          return (
            <text key={name} x={x} y={y} textAnchor="middle" dominantBaseline="middle">
              {name}
            </text>
          );
        })}
        {trail.slice(0, -1).map((s, i) => {
          const next = trail[i + 1]!;
          const a = dialPoint(s.yaw, s.pitch);
          const b = dialPoint(next.yaw, next.pitch);
          const age = Math.max(0, latest - next.t) / 5000;
          return (
            <line
              key={s.t}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="#2563eb"
              strokeWidth={2}
              strokeLinecap="round"
              opacity={Math.max(0.05, 0.7 * (1 - age))}
            />
          );
        })}
        {dot && (
          <>
            <line x1={0} y1={0} x2={dot.x} y2={dot.y} stroke="#1e3a8a" strokeWidth={1.5} />
            <circle
              data-testid="gaze-dot"
              cx={dot.x}
              cy={dot.y}
              r={5}
              fill={sample!.onScreen ? '#0d9488' : '#d97706'}
              stroke="#fff"
              strokeWidth={1.5}
            />
          </>
        )}
        <circle r={2} fill="#1e3a8a" />
      </svg>
      {caption && <figcaption className="muted">{caption}</figcaption>}
      <dl className="gaze-readouts">
        {sample ? (
          <>
            <dt>Gaze</dt>
            <dd>
              yaw {signed(sample.yaw)} ({dir(sample.yaw, 'right', 'left')}) · pitch{' '}
              {signed(sample.pitch)} ({dir(sample.pitch, 'up', 'down')})
            </dd>
            <dt>Off centre</dt>
            <dd>
              {Math.round(sample.magnitude)}° · bearing {bearingLabel(sample)}
            </dd>
            <dt>Beyond screen</dt>
            <dd>{sample.onScreen ? 'On screen' : `${Math.round(sample.offScreenDeg)}°`}</dd>
            <dt>Head</dt>
            <dd>
              yaw {signed(sample.headYaw)} · pitch {signed(sample.headPitch)} · roll{' '}
              {signed(sample.headRoll)}
            </dd>
            <dt>Eyes</dt>
            <dd>
              yaw {signed(sample.eyeYaw)} · pitch {signed(sample.eyePitch)}
              {sample.eyesValid ? '' : ' (held)'}
            </dd>
          </>
        ) : (
          <>
            <dt>Gaze</dt>
            <dd>Waiting for one clear face</dd>
          </>
        )}
      </dl>
    </figure>
  );
}
