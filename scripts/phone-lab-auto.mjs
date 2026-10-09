/* global fetch, setTimeout */
// `npm run phone:lab -- --auto`: play the iPhone's part over HTTP (same requests as
// apps/ios PresenceController): claim, a few heartbeats, a simulated loss (heartbeats stop past
// the lease), then a reconnect that also reports the app was backgrounded. Verifies the
// instructor's timeline shows paired, lost, reconnected and phone_left_app.

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Server lease is 8 s; wait a little longer so the loss is unambiguous. */
const LOSS_WAIT_MS = 9500;

/** Same shape as the iPhone app: JSON, no cookies, no Origin, straight through the web proxy. */
async function phonePost(webPort, path, body) {
  const response = await fetch(`http://127.0.0.1:${webPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

/** Returns true when any check failed. `say` and `tag` are the script's print helpers. */
export async function runAuto({
  studentClient,
  instructorClient,
  attemptId,
  pairingCode,
  webPort,
  say,
  tag,
}) {
  const results = [];
  const record = (name, status, detail = '') => {
    results.push(status);
    const word = status === 'PASS' ? 'green' : status === 'SKIP' ? 'yellow' : 'red';
    say(`${tag(`[${status}]`, word)} ${name}${detail ? ` (${detail})` : ''}`);
  };
  const step = async (name, fn) => {
    try {
      const outcome = await fn();
      if (outcome === true) record(name, 'PASS');
      else record(name, 'FAIL', String(outcome));
    } catch (error) {
      record(name, 'FAIL', error instanceof Error ? error.message : String(error));
    }
  };
  const post = (path, body) => phonePost(webPort, path, body);
  const presence = async () =>
    (await studentClient.call('GET', `/exam/attempts/${attemptId}/phone-presence`)).data;

  say(tag('\n--auto: simulating the iPhone', 'cyan'));
  let credential = '';
  await step('claim pairing code', async () => {
    const claim = await post('/exam/phone-presence/claim', { code: pairingCode });
    credential = claim.data?.credential ?? '';
    return (
      (claim.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(credential)) || `HTTP ${claim.status}`
    );
  });
  if (!credential) {
    say(tag('\nauto check: FAILED', 'red'));
    return true;
  }
  const heartbeat = async (extra = {}) => {
    const challenge = await post('/exam/phone-presence/challenge', { credential });
    const beat = await post('/exam/phone-presence/heartbeat', {
      credential,
      challenge: challenge.data?.challenge,
      sequence: challenge.data?.sequence,
      active: true,
      ...extra,
    });
    return (
      (beat.status === 200 && beat.data?.ok === true) || `HTTP ${challenge.status}/${beat.status}`
    );
  };
  await step('heartbeats accepted (3 x 2 s)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const ok = await heartbeat();
      if (ok !== true) return ok;
      if (i < 2) await sleep(2000);
    }
    return true;
  });
  await step('laptop sees the phone as present', async () => {
    const state = await presence();
    return (state?.required === true && state.active === true) || JSON.stringify(state);
  });
  await step('retired desk-camera route answers 410 Gone', async () => {
    const gone = await post('/exam/phone-presence/desk-camera', { credential, people: 1 });
    return gone.status === 410 || `HTTP ${gone.status}`;
  });

  say(tag(`Simulating a lost phone: no heartbeats for ${LOSS_WAIT_MS / 1000} s…`, 'dim'));
  await sleep(LOSS_WAIT_MS);
  await step('laptop sees the phone as lost', async () => {
    const state = await presence();
    return (state?.required === true && state.active === false) || JSON.stringify(state);
  });
  await step('phone reconnects (reporting it left the app)', () => heartbeat({ leftApp: true }));
  await step('laptop sees the phone again', async () => {
    const state = await presence();
    return state?.active === true || JSON.stringify(state);
  });

  const expected = [
    ['attempt_started', 'timeline shows attempt start'],
    ['iphone_paired', 'timeline shows iPhone paired'],
    ['iphone_lost', 'timeline shows iPhone lost'],
    ['iphone_reconnected', 'timeline shows iPhone reconnected'],
    ['phone_left_app', 'timeline shows phone left the app'],
  ];
  let kinds = new Set();
  for (let i = 0; i < 6; i += 1) {
    const tl = await instructorClient.call('GET', `/exam/attempts/${attemptId}/timeline`);
    kinds = new Set((tl.data?.entries ?? []).map((e) => e.kind));
    if (expected.every(([kind]) => kinds.has(kind))) break;
    await sleep(1000);
  }
  for (const [kind, name] of expected) record(name, kinds.has(kind) ? 'PASS' : 'FAIL', kind);
  const failed = results.includes('FAIL');
  say(tag(failed ? '\nauto check: FAILED' : '\nauto check: all passed', failed ? 'red' : 'green'));
  return failed;
}
