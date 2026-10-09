/** Compact "How to place your phone" card: a top-down SVG of desk, laptop, student and phone. */
export function PhonePlacementCard() {
  // Phone at (232, 66) aims at the student/keyboard around (110, 118); cone half-angle 28 degrees.
  const phone = { x: 232, y: 66 };
  const aim = Math.atan2(118 - phone.y, 110 - phone.x);
  const half = (28 * Math.PI) / 180;
  const reach = 150;
  const edge = (a: number) =>
    `${(phone.x + reach * Math.cos(a)).toFixed(1)} ${(phone.y + reach * Math.sin(a)).toFixed(1)}`;
  const cone = `M ${phone.x} ${phone.y} L ${edge(aim - half)} A ${reach} ${reach} 0 0 0 ${edge(aim + half)} Z`;
  const phoneAngle = (aim * 180) / Math.PI;
  return (
    <section
      aria-label="How to place your phone"
      style={{
        background: '#27272a',
        borderRadius: 12,
        padding: 14,
        margin: '16px 0',
        display: 'grid',
        gap: 8,
      }}
    >
      <h3 style={{ margin: 0 }}>How to place your phone</h3>
      <svg
        viewBox="0 0 260 170"
        role="img"
        aria-label="Top-down diagram. Your laptop is in front of you. The phone stands on your side about one metre away, turned sideways at a 45 degree angle toward you and your keyboard, and its camera view is shown as a cone."
        style={{ width: '100%', maxWidth: 360, justifySelf: 'center' }}
      >
        <rect
          x="4"
          y="4"
          width="252"
          height="162"
          rx="10"
          fill="#52381f"
          stroke="#8a6a44"
          strokeWidth="2"
        />
        <path d={cone} fill="#3b82f6" fillOpacity="0.28" />
        <rect x="70" y="52" width="80" height="6" rx="2" fill="#a1a1aa" />
        <rect x="70" y="60" width="80" height="26" rx="4" fill="#71717a" />
        <circle cx="110" cy="132" r="12" fill="#fb923c" />
        <rect x="92" y="148" width="36" height="12" rx="6" fill="#fb923c" fillOpacity="0.6" />
        <line
          x1="110"
          y1="132"
          x2={phone.x}
          y2={phone.y}
          stroke="#d4d4d8"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />
        <rect
          x={phone.x - 5}
          y={phone.y - 13}
          width="10"
          height="26"
          rx="3"
          fill="#3b82f6"
          transform={`rotate(${phoneAngle.toFixed(1)} ${phone.x} ${phone.y})`}
        />
        <g fill="#e4e4e7" fontSize="9" fontFamily="sans-serif">
          <text x="110" y="42" textAnchor="middle">
            Laptop
          </text>
          <text x="88" y="136" textAnchor="end">
            You
          </text>
          <text x="196" y="130">
            about 1 m
          </text>
          <text x="196" y="44" fill="#93c5fd">
            45°
          </text>
        </g>
      </svg>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        <li>Turn the phone sideways (landscape).</li>
        <li>
          Rear camera facing you and your keyboard, about 1 m (arm&apos;s length) to your side at a
          45° angle.
        </li>
        <li>Slightly above desk height: prop it on books or a stand.</li>
      </ol>
    </section>
  );
}
