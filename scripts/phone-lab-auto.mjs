/* global fetch, setTimeout, Buffer */
// `npm run phone:lab -- --auto`: play the iPhone's part over HTTP (same requests as
// apps/ios PresenceController) and verify the instructor's timeline shows each result.
import { evidenceItems } from './phone-lab-lib.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xd9]);

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
      else if (outcome === 'SKIP') record(name, 'SKIP', 'endpoint not available on this build');
      else record(name, 'FAIL', String(outcome));
    } catch (error) {
      record(name, 'FAIL', error instanceof Error ? error.message : String(error));
    }
  };
  const post = (path, body) => phonePost(webPort, path, body);

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
  await step('heartbeat accepted', async () => {
    const challenge = await post('/exam/phone-presence/challenge', { credential });
    const beat = await post('/exam/phone-presence/heartbeat', {
      credential,
      challenge: challenge.data?.challenge,
      sequence: challenge.data?.sequence,
      active: true,
    });
    return (
      (beat.status === 200 && beat.data?.ok === true) || `HTTP ${challenge.status}/${beat.status}`
    );
  });
  const desk = (people, handsVisible) =>
    post('/exam/phone-presence/desk-camera', { credential, people, handsVisible, framingOk: true });
  await step('desk camera: one person, hands visible', async () => {
    const report = await desk(1, true);
    const status = await studentClient.call('GET', `/exam/attempts/${attemptId}/phone-presence`);
    const state = status.data?.deskCamera;
    return (
      (report.status === 200 && state?.on && state.people === 1 && state.handsVisible === true) ||
      `HTTP ${report.status}, state ${JSON.stringify(state)}`
    );
  });
  await sleep(2200); // the server rejects desk reports closer than 2 s
  await step('desk camera: extra person report', async () => {
    const report = await desk(2, true);
    return report.status === 200 || `HTTP ${report.status}`;
  });
  await sleep(2200);
  await step('desk camera: left frame report', async () => {
    const report = await desk(0, false);
    return report.status === 200 || `HTTP ${report.status}`;
  });

  let uploaded = false;
  await step('evidence upload with phone credential', async () => {
    const upload = await post(`/exam/attempts/${attemptId}/evidence`, {
      credential,
      source: 'desk_camera',
      trigger: 'extra_person',
      capturedAt: new Date().toISOString(),
      imageJpegBase64: JPEG.toString('base64'),
    });
    if (upload.status === 404) return 'SKIP';
    uploaded = upload.status === 201;
    return uploaded || `HTTP ${upload.status}`;
  });
  if (uploaded) {
    await step('evidence listed for instructor and JPEG downloads intact', async () => {
      const list = await instructorClient.call('GET', `/exam/attempts/${attemptId}/evidence`);
      const item = evidenceItems(list.data).find((e) => e.trigger === 'extra_person');
      if (!item) return 'not listed';
      const image = await instructorClient.call(
        'GET',
        `/exam/attempts/${attemptId}/evidence/${encodeURIComponent(item.id)}`,
        undefined,
        { binary: true },
      );
      return (image.status === 200 && image.data.equals(JPEG)) || `HTTP ${image.status}`;
    });
  }

  const expected = [
    ['attempt_started', 'timeline shows attempt start'],
    ['iphone_paired', 'timeline shows iPhone paired'],
    ['desk_extra_person', 'timeline shows desk-camera extra person'],
    ['desk_left_frame', 'timeline shows desk-camera left frame'],
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
