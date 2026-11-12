// The ship, in 3D: a low-poly pirate ship rocking on the sea, with the crew
// walking between the places where their kind of work happens.
//
//   const ship = mountShip(container, { onSelect, placeOf, sayOf });
//   ship.update(state, selectedName);   // state.crew + state.threads, as the dispatcher sends them
//   ship.dispose();
//
// mountShip throws when WebGL is not available, so the page can keep its flat
// SVG ship. three.js is vendored (public/vendor): the phone may have no signal
// beyond the tailnet.
import * as THREE from './vendor/three.module.min.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const UP = new THREE.Vector3(0, 1, 0);

// ---------- the ship's measurements (ship space: bow +x, up +y, near side +z) ----------
const Q = 1.5;            // quarterdeck above the main deck
const F = 0.55;           // foredeck above the main deck
const SHIP_Y = 1.0;       // main deck above the mean sea
const MAIN = { x: -0.5, top: 9.5 };
const FORE = { x: 3.3, top: 6.9 };
const NEST_Y = 6.9;
const AZ = 0.49;          // the camera stands off the starboard bow
const EL = 0.16;
const FOV = 31;
const SCALE = 1.14;       // pirates are drawn a touch larger than life
const HIP = 0.42;
const WALK = 2.3;         // deck units per second
const CLIMB = 1.5;
const SAIL_YAW = 2.878;   // sails belly away from the camera, so the crew is never behind canvas
const FACE = { cam: 0.3, bow: Math.PI / 2, stern: -Math.PI / 2, away: Math.PI };

const hullW = (x) => (x <= 0 ? 2.3 - 0.75 * (x / 6.6) ** 2 : 2.3 * Math.max(0, 1 - (x / 6.75) ** 2.6) ** 0.9);
const sheer = (x) => 0.5 + 0.6 * smooth(2.6, 4.4, x);          // top of the bulwark
const keel = (x) => -1.9 + 1.2 * smooth(3.5, 6.7, x);
const rake = (x, y) => x + (0.3 * smooth(3, 6.7, x) - 0.12 * smooth(-4, -6.6, x)) * (y + 1);

// Where each kind of work happens: [x, y, z, facing] for each pirate that turns up.
const SLOTS = {
  helm: [[-5.5, Q, 0, FACE.bow], [-5.65, Q, 0.8, FACE.bow], [-5.65, Q, -0.8, FACE.bow]],
  charts: [[-3.85, Q, -0.45, 0.15], [-4.6, Q, 0.3, FACE.bow], [-3.85, Q, 1.1, FACE.away]],
  door: [[-2.3, 0, 0.05, FACE.stern], [-2.25, 0, -0.72, FACE.stern], [-2.2, 0, 0.82, FACE.stern], [-1.65, 0, -0.35, FACE.stern]],
  cannons: [[0.9, 0, 0.45, 0.1], [2.2, 0, 0.45, 0.1], [1.55, 0, -0.1, 0.1]],
  bench: [[1.7, 0, -1.4, 0.15], [0.8, 0, -0.75, FACE.bow], [2.6, 0, -0.75, FACE.stern]],
  nest: [[-0.86, NEST_Y, 0.32, 0.1], [-0.16, NEST_Y, 0.38, 0.45]],
  rigging: [[3.3, 2.4, 1.5, FACE.cam], [3.3, 3.6, 1.0, FACE.cam], [-0.5, 3.0, 1.58, FACE.cam]],
  squall: [[6.3, F, 0.05, 0.5], [4.75, F, 0.6, 0.5], [4.35, F, 0.05, 0.5]],
};
// Where each pirate rests: asleep off duty, awake and waiting when on duty with nothing to do.
const HOMES = [
  { p: [-0.98, 0, 0.02], face: FACE.stern, nap: 'napSit', lounge: 'stand' },      // back against the main mast
  { p: [-2.6, 0, 1.62], face: FACE.bow, nap: 'napSit', lounge: 'stand' },         // by the cabin window
  { p: [-5.6, Q, 1.3], face: FACE.bow, nap: 'napSit', lounge: 'stand' },         // quarterdeck, near rail
  { p: [5.6, F, -0.2], face: FACE.bow, nap: 'napLie', lounge: 'stand', loungeFace: 0.4 }, // flat out on the foredeck
  { p: [2.6, 0, -1.58], face: 0.25, nap: 'napPerch', lounge: 'perch' },           // on the barrel
  { p: [-6.1, Q, -1.0], face: 0.45, nap: 'napSit', lounge: 'stand' },             // quarterdeck, far rail
  { p: [3.72, 0, 0.9], face: FACE.stern, nap: 'napSit', lounge: 'stand' },       // against the foredeck step
];
const POT = { x: 0.1, z: -1.05 };
const GALLEY = { p: [POT.x, 0, -1.85], face: 0.2, nap: 'napSit', lounge: 'stir' }; // the cook's, behind the pot
const zoneOf = (y) => (y === 0 ? 'main' : y === Q ? 'quarter' : y === F ? 'fore' : null);
const MASTS = [[MAIN.x, 0, 0.5], [FORE.x, 0, 0.48]];   // things to walk around on the main deck

const PALETTES = {
  night: {
    skyTop: '#060f1a', skyMid: '#0e2233', horizon: '#1d3f5a', sea: '#17566f', hemiSky: '#7f9fc9', hemiGround: '#0d2231', hemi: 1.25,
    sun: '#b9cdf5', sunI: 1.5, sail: '#d9ceb2', cloud: '#1a3247', glass: '#f0cd84', glow: 1, lantern: 1, island: '#102a3c',
  },
  day: {
    skyTop: '#a9d0de', skyMid: '#cfe3ea', horizon: '#eef0de', sea: '#3f8a9c', hemiSky: '#ffffff', hemiGround: '#8fa7a3', hemi: 1.45,
    sun: '#fff1d6', sunI: 2.3, sail: '#f6eedb', cloud: '#ffffff', glass: '#5d7884', glow: 0, lantern: 0, island: '#9fb7a4',
  },
};

// ---------- small geometry builders ----------
// Many thin rods (ropes, rails, posts) as one mesh.
function tubes(segs, radius, sides = 4) {
  const pos = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
  const pt = (base, t, r) => [base.x + (u.x * Math.cos(t) + v.x * Math.sin(t)) * r, base.y + (u.y * Math.cos(t) + v.y * Math.sin(t)) * r, base.z + (u.z * Math.cos(t) + v.z * Math.sin(t)) * r];
  for (const [p, q, rr] of segs) {
    a.fromArray(p); b.fromArray(q); d.subVectors(b, a).normalize();
    u.set(0, 1, 0); if (Math.abs(d.y) > 0.9) u.set(1, 0, 0);
    u.cross(d).normalize(); v.crossVectors(d, u);
    const r = rr ?? radius;
    for (let i = 0; i < sides; i++) {
      const t0 = (i / sides) * TAU, t1 = ((i + 1) / sides) * TAU;
      const p00 = pt(a, t0, r), p01 = pt(a, t1, r), p10 = pt(b, t0, r), p11 = pt(b, t1, r);
      pos.push(...p00, ...p01, ...p11, ...p00, ...p11, ...p10);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function hullGeometry() {
  const pos = [], col = [];
  const C = { keel: new THREE.Color('#3a281c'), wood: new THREE.Color('#8a5d37'), brass: new THREE.Color('#d0a24a'), top: new THREE.Color('#5a3a22'), cabin: new THREE.Color('#946640') };
  const quad = (a, b, c, d, color) => { for (const p of [a, b, c, a, c, d]) { pos.push(p[0], p[1], p[2]); col.push(color.r, color.g, color.b); } };
  const N = 26, xs = [];
  for (let i = 0; i <= N; i++) xs.push(-6.6 + 13.3 * (1 - (1 - i / N) ** 1.5));
  const FR = [0, 0.12, 0.42, 0.74, 0.8, 1], WD = [0, 0.6, 0.93, 1, 1.03, 1], BAND = [C.keel, C.keel, C.wood, C.brass, C.top];
  const ring = (x) => { const g = sheer(x), k = keel(x), w = hullW(x); return FR.map((f, j) => { const y = lerp(k, g, f); return [rake(x, y), y, w * WD[j]]; }); };
  const flip = (p) => [p[0], p[1], -p[2]];
  let prev = ring(xs[0]);
  for (let j = 0; j < 5; j++) quad(prev[j], flip(prev[j]), flip(prev[j + 1]), prev[j + 1], BAND[j]);   // the transom
  for (let i = 1; i <= N; i++) {
    const cur = ring(xs[i]);
    for (let j = 0; j < 5; j++) {
      quad(prev[j], cur[j], cur[j + 1], prev[j + 1], BAND[j]);
      quad(flip(cur[j]), flip(prev[j]), flip(prev[j + 1]), flip(cur[j + 1]), BAND[j]);
    }
    prev = cur;
  }
  // The aftercastle: cabin walls that carry on up into the quarterdeck rail.
  const YS = [0.5, 1.4, 1.52, 2.0], AFT = [C.cabin, C.brass, C.top];
  const wall = (x) => YS.map((y) => [rake(x, y), y, hullW(x)]);
  let pw = wall(-6.6);
  for (let j = 0; j < 3; j++) quad(pw[j], flip(pw[j]), flip(pw[j + 1]), pw[j + 1], AFT[j]);
  for (const x of [-5.7, -4.8, -3.9, -3.0]) {
    const cw = wall(x);
    for (let j = 0; j < 3; j++) { quad(pw[j], cw[j], cw[j + 1], pw[j + 1], AFT[j]); quad(flip(cw[j]), flip(pw[j]), flip(pw[j + 1]), flip(cw[j + 1]), AFT[j]); }
    pw = cw;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function deckGeometry(x0, x1, y, n, inset = 0.05) {
  const pos = [], uv = [];
  const put = (x, z) => { pos.push(rake(x, y), y, z); uv.push(x * 0.5, z * 0.5); };
  for (let i = 0; i < n; i++) {
    const xa = lerp(x0, x1, i / n), xb = lerp(x0, x1, (i + 1) / n);
    const wa = Math.max(0.01, hullW(xa) - inset), wb = Math.max(0.01, hullW(xb) - inset);
    put(xa, wa); put(xb, wb); put(xb, -wb);
    put(xa, wa); put(xb, -wb); put(xa, -wa);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function sailGeometry(w, h, belly) {
  const g = new THREE.PlaneGeometry(w, h, 6, 4);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) / w + 0.5, v = p.getY(i) / h + 0.5;   // v = 1 along the yard
    p.setZ(i, belly * Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.1 + 0.8 * (1 - v))));
    if (v < 0.01) p.setY(i, p.getY(i) + 0.2 * Math.sin(Math.PI * u));   // the foot is cut in an arc
  }
  g.translate(0, -h / 2, 0);
  g.computeVertexNormals();
  return g;
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const plankTexture = () => {
  const t = canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#a17a4d'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? 'rgba(255,235,200,.07)' : 'rgba(60,30,10,.08)';
      g.fillRect(0, i * 16, w, 16);
      g.fillStyle = 'rgba(58,34,16,.7)'; g.fillRect(0, i * 16, w, 1.5);
      g.fillRect((i * 53) % w, i * 16, 1.5, 16);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};

const jollyRoger = () => canvasTexture(256, 144, (g, w, h) => {
  g.fillStyle = '#16130f'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#efe9da'; g.fillStyle = '#efe9da'; g.lineCap = 'round'; g.lineWidth = 13;
  g.beginPath(); g.moveTo(70, 36); g.lineTo(186, 116); g.moveTo(186, 36); g.lineTo(70, 116); g.stroke();
  g.beginPath(); g.arc(128, 62, 34, 0, TAU); g.fill();
  g.fillRect(108, 82, 40, 26);
  g.fillStyle = '#16130f';
  g.beginPath(); g.arc(115, 62, 9, 0, TAU); g.arc(141, 62, 9, 0, TAU); g.fill();
  g.beginPath(); g.moveTo(128, 72); g.lineTo(123, 82); g.lineTo(133, 82); g.fill();
  for (const x of [118, 128, 138]) g.fillRect(x - 1, 94, 2, 14);
});

const glowTexture = () => canvasTexture(64, 64, (g) => {
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,244,214,.9)'); r.addColorStop(0.25, 'rgba(255,240,200,.35)'); r.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
});

// ---------- how a pirate holds itself ----------
// Each fills in the joint angles for one moment; the figure eases towards them.
// Arms and legs swing forward with negative angles. L is the arm on the figure's -x side.
const POSE = { by: 0, bx: 0, bz: 0, tw: 0, hx: 0, hy: 0, alx: 0, alz: 0, arx: 0, arz: 0, llx: 0, lrx: 0 };
const POSE_KEYS = Object.keys(POSE);
const ACT = {
  walk(o, t, P) {
    const s = Math.sin(P.phase);
    o.llx = s * 0.8; o.lrx = -s * 0.8; o.alx = -s * 0.7; o.arx = s * 0.7;
    o.by = Math.abs(Math.cos(P.phase)) * 0.05; o.bx = 0.1; o.bz = s * 0.05;
  },
  climb(o, t, P) {
    const s = Math.sin(P.phase);
    o.alx = -2.5 + s * 0.45; o.arx = -2.5 - s * 0.45; o.llx = -0.5 - s * 0.4; o.lrx = -0.5 + s * 0.4;
    o.bx = 0.28; o.hx = -0.35;
  },
  stand(o, t, P) {   // hands on hips, looking about
    o.alx = 0.25; o.arx = 0.25; o.alz = -0.55; o.arz = 0.55;
    o.hy = Math.sin(t * 0.45 + P.seed * 3) * 0.6; o.by = Math.sin(t * 1.8 + P.seed) * 0.012; o.bz = Math.sin(t * 0.3 + P.seed) * 0.03;
  },
  perch(o, t, P) {   // on the barrel, kicking heels
    const s = Math.sin(t * 2.4 + P.seed);
    o.by = 0.2; o.llx = -1.3 + s * 0.25; o.lrx = -1.3 - s * 0.25; o.alx = 0.35; o.arx = 0.35; o.alz = -0.2; o.arz = 0.2;
    o.hy = Math.sin(t * 0.5 + P.seed) * 0.6; o.bx = -0.08;
  },
  stir(o, t) {       // the cook at the pot
    o.arx = -1.25 + Math.sin(t * 3) * 0.12; o.arz = -0.15 + Math.cos(t * 3) * 0.3; o.alz = -0.5; o.alx = 0.2;
    o.bx = 0.18; o.hx = 0.2; o.hy = Math.sin(t * 0.4) * 0.2;
  },
  napSit(o, t, P) {
    const b = Math.sin(t * 1.2 + P.seed) * 0.03;
    o.by = -0.335; o.llx = -1.85; o.lrx = -1.78; o.bx = 0.3 + b; o.hx = 0.7 + b * 2; o.hy = 0.15;
    o.alx = -0.9; o.arx = -0.85; o.alz = 0.15; o.arz = -0.15;
  },
  napPerch(o, t, P) {
    const b = Math.sin(t * 1.2 + P.seed) * 0.03;
    o.by = 0.2; o.llx = -1.2; o.lrx = -1.15; o.bx = 0.22 + b; o.hx = 0.5 + b * 2; o.alx = -0.6; o.arx = -0.6; o.alz = 0.2; o.arz = -0.2;
  },
  napLie(o, t, P) {  // on its back, hands behind its head, one knee up
    o.bx = -Math.PI / 2; o.by = -HIP + 0.17 + Math.sin(t * 1.2 + P.seed) * 0.008;
    o.alx = -2.9; o.arx = -2.9; o.alz = 0.5; o.arz = -0.5; o.lrx = -0.45;
  },
  helm(o, t) {
    const s = Math.sin(t * 1.2);
    o.alx = -1.35 - s * 0.35; o.arx = -1.35 + s * 0.35; o.alz = 0.15; o.arz = -0.15; o.bx = 0.08; o.bz = s * 0.04; o.hy = Math.sin(t * 0.3) * 0.25;
  },
  charts(o, t, P) {
    o.bx = 0.42; o.hx = 0.35; o.hy = Math.sin(t * 0.7 + P.seed) * 0.35;
    o.alx = -0.9; o.alz = 0.2; o.arx = -1.0 + Math.sin(t * 1.9) * 0.12; o.arz = -0.1 + Math.cos(t * 0.95) * 0.35;
  },
  bench(o, t, P) {   // the hammer goes up slowly and comes down fast
    const f = (t * 1.6 + P.seed) % 1;
    const up = f < 0.65 ? smooth(0, 0.65, f) : 1 - ((f - 0.65) / 0.35) ** 2;
    o.arx = -0.9 - up * 1.5; o.alx = -0.85; o.alz = 0.15; o.bx = 0.25 + (1 - up) * 0.08; o.by = -(1 - up) * 0.02; o.hx = 0.2;
  },
  cannons(o, t, P, fx) {
    const c = fx.cannon(P.slot);
    if (c == null) { o.alx = -2.7 + Math.sin(t * 6) * 0.3; o.arx = -2.7 - Math.sin(t * 6) * 0.3; o.by = Math.abs(Math.sin(t * 3)) * 0.06; return; }   // cheering the gunners on
    if (c < 0.5) { const s = Math.sin(t * 6); o.alx = -1.2 + s * 0.3; o.arx = -1.2 + s * 0.3; o.bx = 0.3 + s * 0.05; }                 // ramming home
    else if (c < 0.72) { o.arx = -1.35; o.alx = -0.2; o.bx = 0.36; o.by = -0.03; o.hx = 0.15; }                                          // touching her off
    else { o.alx = -2.65; o.arx = -2.65; o.alz = 0.5; o.arz = -0.5; o.bx = -0.2; o.by = c < 0.82 ? Math.sin(((c - 0.72) / 0.1) * Math.PI) * 0.16 : 0; }
  },
  nest(o, t, P) {    // spyglass up, sweeping the horizon
    o.arx = -2.0; o.arz = -0.35; o.alz = -0.5; o.alx = 0.1; o.tw = Math.sin(t * 0.45 + P.seed) * 0.9; o.hx = -0.12;
  },
  rigging(o, t, P) { // one hand for the ship, one to wave the hands on
    const s = Math.sin(t * 5 + P.seed);
    o.alx = -3.35; o.arx = -2.4 + s * 0.25; o.arz = 0.5 + s * 0.35; o.llx = -0.25; o.lrx = 0.2; o.bx = 0.12;
    o.hy = Math.sin(t * 0.9) * 0.4; o.by = Math.sin(t * 2.5) * 0.02;
  },
  door(o, t, P) {    // three knocks, then an ear to the door
    const f = (t / 2.6 + P.seed) % 1;
    if (f < 0.45) { o.arx = -1.75 + Math.sin((f / 0.45) * Math.PI * 6) * 0.32; o.bx = 0.12; }
    else { o.arx = -0.3; o.hy = 0.65; o.bx = 0.05; o.lrx = Math.max(0, Math.sin(t * 10)) * 0.2; }
    o.alz = -0.5; o.alx = 0.2;
  },
  squall(o, t) {
    o.alx = -2.6 + Math.sin(t * 9) * 0.5; o.arx = -2.6 + Math.cos(t * 8) * 0.5; o.alz = -0.3; o.arz = 0.3;
    o.bz = Math.sin(t * 13) * 0.07; o.by = Math.abs(Math.sin(t * 6.5)) * 0.06; o.hy = Math.sin(t * 7) * 0.3;
    o.llx = Math.sin(t * 13) * 0.25; o.lrx = -Math.sin(t * 13) * 0.25;
  },
};

const CSS = `
.s3d { position: relative; overflow: hidden; -webkit-tap-highlight-color: transparent; }
.s3d canvas { display: block; width: 100%; height: 100%; touch-action: manipulation; }
.s3d-over { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.s3d-over > * { position: absolute; left: 0; top: 0; white-space: nowrap; will-change: transform; user-select: none; -webkit-user-select: none; }
.s3d-over button.s3d-name { margin: 0; padding: 0 7px; border: 0; border-radius: 99px; font: 700 12px/16px var(--body, system-ui, sans-serif);
  letter-spacing: .02em; color: var(--ink, #2a1f14); background: color-mix(in srgb, var(--panel, #fbf4e2) 84%, transparent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .3); pointer-events: auto; cursor: pointer; transition: none; }
.s3d-over button.s3d-name.off { opacity: .66; font-weight: 500; }
.s3d-over button.s3d-name.sel { opacity: 1; color: var(--brass-ink, #1a1408); background: var(--brass-hi, #f0cd84); }
.s3d-bub { padding: 1px 8px 2px; border-radius: 9px; border: 1px solid var(--line, #d9c7a0); background: var(--panel, #fbf4e2); color: var(--ink, #2a1f14);
  font: 500 12px/16px var(--body, system-ui, sans-serif); box-shadow: 0 2px 6px rgba(0, 0, 0, .3); }
.s3d-bub::after { content: ''; position: absolute; left: calc(50% + var(--tail, 0px)); bottom: -5px; width: 8px; height: 8px; margin-left: -4px;
  background: inherit; border: solid; border-color: inherit; border-width: 0 1px 1px 0; transform: rotate(45deg); }
.s3d-bub { transition: opacity .25s; }
.s3d-bub.gone { opacity: 0; }
.s3d-small .s3d-over button.s3d-name { font-size: 11px; line-height: 14px; padding: 0 5px; }
.s3d-small .s3d-bub { font-size: 11px; line-height: 14px; padding: 1px 6px; }
.s3d-bub.air { border-color: var(--brass-hi, #f0cd84); }
.s3d-bub.alert { border-color: var(--live, #a8322a); font-weight: 700; }
.s3d-z { font: italic 700 14px var(--body, system-ui, sans-serif); color: var(--ink, #2a1f14); text-shadow: 0 0 3px var(--bg, #efe4c9), 0 0 3px var(--bg, #efe4c9); }
.s3d-z i { display: inline-block; animation: s3d-z 2.8s ease-in-out infinite; }
@keyframes s3d-z { 0% { opacity: 0; transform: translate(0, 4px) scale(.8); } 40% { opacity: 1; } 100% { opacity: 0; transform: translate(8px, -12px) scale(1.15); } }
@media (prefers-reduced-motion: reduce) { .s3d-z i { animation: none; } }
`;

export function mountShip(container, opts = {}) {
  const onSelect = opts.onSelect ?? (() => {});
  const placeOf = opts.placeOf ?? (() => null);
  const sayOf = opts.sayOf ?? (() => '');

  const canvas = document.createElement('canvas');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); }
  catch (e) { throw new Error('WebGL is not available: ' + (e?.message ?? e)); }
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  if (!document.getElementById('s3d-css')) {
    const st = document.createElement('style');
    st.id = 's3d-css'; st.textContent = CSS;
    document.head.append(st);
  }
  container.classList.add('s3d');
  const over = document.createElement('div');
  over.className = 's3d-over';
  container.append(canvas, over);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1.6, 1, 220);
  const target = new THREE.Vector3(1.35, 4.7, 0);
  let camDist = 26;

  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };
  const lam = (color, extra) => keep(new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra }));
  const mk = (geo, mat, parent, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const box = (w, h, d) => keep(new THREE.BoxGeometry(w, h, d));
  const cyl = (rt, rb, h, n = 7, open = false) => keep(new THREE.CylinderGeometry(rt, rb, h, n, 1, open));
  const beam = (a, b, r0, r1, mat, parent, sides = 6) => {
    const va = new THREE.Vector3(...a), d = new THREE.Vector3(...b).sub(va);
    const m = mk(cyl(r1, r0, d.length(), sides), mat, parent);
    m.position.copy(va).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(UP, d.normalize());
    return m;
  };

  // ---------- light, sky, sea ----------
  const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(-7, 16, 12);
  sun.target.position.set(0.5, 3, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 9, bottom: -8, near: 2, far: 46 });
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
  scene.add(hemi, sun, sun.target);
  scene.fog = new THREE.Fog(0x000000, 30, 90);

  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 4; skyCanvas.height = 256;
  const skyTex = keep(new THREE.CanvasTexture(skyCanvas));
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;

  // The sky and the sea turn with the camera, so the horizon always lies square across the view.
  const view = new THREE.Group();
  view.position.set(target.x, 0, 0);
  scene.add(view);

  const SEA = { nx: 46, nz: 28, hw: 46, z0: -27, z1: 15 };
  const seaGeo = keep(new THREE.PlaneGeometry(1, 1, SEA.nx, SEA.nz));
  seaGeo.rotateX(-Math.PI / 2);
  {
    const p = seaGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) * 2, v = p.getZ(i) + 0.5;
      p.setXYZ(i, Math.sign(u) * Math.abs(u) ** 1.5 * SEA.hw, 0, lerp(SEA.z0, SEA.z1, v));
    }
  }
  const seaMat = keep(new THREE.MeshPhongMaterial({ color: '#17566f', flatShading: true, shininess: 50, specular: '#223344' }));
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.receiveShadow = true;
  view.add(sea);
  const wave = (x, z, t) => 0.17 * Math.sin(0.5 * x + 0.95 * t) + 0.12 * Math.sin(0.33 * z + 0.21 * x + 0.7 * t + 1.3) + 0.07 * Math.sin(1.05 * x - 0.8 * z + 1.6 * t) + 0.05 * Math.sin(1.9 * x + 1.3 * z + 2.2 * t);
  function swell(t) {
    const p = seaGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      p.setY(i, wave(x, z, t) * smooth(SEA.z0, SEA.z0 + 12, z));
    }
    p.needsUpdate = true;
  }

  // A speck of an island on the horizon.
  const islandMat = lam('#9fb7a4');
  {
    const isle = new THREE.Group();
    isle.position.set(-17, 0, SEA.z0 + 1.2);
    const mound = mk(keep(new THREE.SphereGeometry(3.4, 7, 4, 0, TAU, 0, Math.PI / 2)), islandMat, isle);
    mound.scale.y = 0.3;
    beam([0.4, 0.8, 0], [1.1, 3.4, 0], 0.16, 0.1, islandMat, isle, 5);
    for (let i = 0; i < 5; i++) {
      const leaf = mk(keep(new THREE.ConeGeometry(0.34, 1.9, 3)), islandMat, isle, 1.1, 3.4, 0);
      leaf.rotation.set(0, (i / 5) * TAU, 1.9);
      leaf.translateY(0.85);
    }
    isle.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
    view.add(isle);
  }

  const sky = new THREE.Group();
  sky.position.set(0, 0, -72);
  view.add(sky);
  const starGeo = keep(new THREE.BufferGeometry());
  {
    const pts = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 150; i++) pts.push((rnd() - 0.5) * 120, 2.5 + rnd() ** 0.8 * 30, rnd() * 4);
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }
  const starMat = keep(new THREE.PointsMaterial({ color: '#f3e6c4', size: 1.8, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9 }));
  const stars = new THREE.Points(starGeo, starMat);
  const moon = new THREE.Mesh(keep(new THREE.IcosahedronGeometry(2.4, 2)), keep(new THREE.MeshBasicMaterial({ color: '#f5ecd0', fog: false })));
  moon.position.set(21, 16.5, 0);
  const glowTex = keep(glowTexture());
  const halo = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glowTex, color: '#cfe0ff', transparent: true, opacity: 0.55, depthWrite: false, fog: false, blending: THREE.AdditiveBlending })));
  halo.scale.setScalar(17);
  halo.position.copy(moon.position);
  sky.add(stars, halo, moon);
  const cloudMat = keep(new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true, fog: false }));
  const clouds = [];
  {
    const blob = keep(new THREE.IcosahedronGeometry(1, 1));
    const spots = [[-34, 15, 1.5], [-9, 23, 1.1], [14, 12, 1.25], [35, 18, 1.6], [-52, 22, 1.2]];
    for (const [x, y, s] of spots) {
      const c = new THREE.Group();
      for (const [dx, dy, r] of [[0, 0, 2.2], [2.3, -0.2, 1.6], [-2.4, -0.3, 1.7], [0.9, 0.9, 1.5], [4.2, -0.5, 1.0]]) {
        const m = new THREE.Mesh(blob, cloudMat);
        m.position.set(dx, dy, 0); m.scale.set(r, r * 0.62, r * 0.6);
        c.add(m);
      }
      c.position.set(x, y, 0); c.scale.setScalar(s);
      sky.add(c); clouds.push(c);
    }
  }

  // Gulls wheel about the mastheads by day.
  const gullMat = keep(new THREE.MeshBasicMaterial({ color: '#fbfaf5', side: THREE.DoubleSide }));
  const gulls = [];
  {
    const wing = keep(new THREE.BufferGeometry());
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.1, 0.62, 0.05, 0, 0, 0, 0.14], 3));
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group();
      const l = new THREE.Mesh(wing, gullMat), r = new THREE.Mesh(wing, gullMat);
      r.scale.x = -1;
      g.add(l, r);
      scene.add(g);
      gulls.push({ g, l, r, a: i * 2.1, rad: 5.5 + i * 1.6, y: 10.4 + i * 0.5, sp: 0.5 - i * 0.07 });
    }
  }

  // ---------- the ship ----------
  const ship = new THREE.Group();
  scene.add(ship);
  const M = {
    hull: keep(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide })),
    deck: keep(new THREE.MeshLambertMaterial({ map: keep(plankTexture()), flatShading: true })),
    wood: lam('#7b5231'), dark: lam('#472d1b'), pale: lam('#b08a58'), mast: lam('#6a4628'), rope: lam('#9a7a52'),
    iron: lam('#2b2b30'), brass: lam('#c9a24b'), sail: lam('#f4ecd6', { side: THREE.DoubleSide }), chart: lam('#f1e6c8'), red: lam('#b23a2c'),
    glass: lam('#5d7884', { emissive: '#f0cd84', emissiveIntensity: 0 }),
    fire: lam('#ffb347', { emissive: '#ff8a2a', emissiveIntensity: 1 }),
    stew: lam('#7d8b4a'),
  };
  mk(keep(hullGeometry()), M.hull, ship);
  mk(keep(deckGeometry(-3.05, 4.0, 0, 10)), M.deck, ship).castShadow = false;
  mk(keep(deckGeometry(-6.6, -3.0, Q, 5)), M.deck, ship);
  mk(keep(deckGeometry(3.95, 6.7, F, 9)), M.deck, ship);
  // Cap rails along the bulwarks and round the quarterdeck.
  {
    const segs = [];
    const line = (f, x0, x1, n) => { for (let i = 0; i < n; i++) { const a = f(lerp(x0, x1, i / n)), b = f(lerp(x0, x1, (i + 1) / n)); segs.push([a, b], [[a[0], a[1], -a[2]], [b[0], b[1], -b[2]]]); } };
    line((x) => [rake(x, sheer(x)), sheer(x), hullW(x)], -3.0, 6.7, 22);
    line((x) => [rake(x, 2), 2, hullW(x)], -6.6, -3.0, 6);
    const sx = rake(-6.6, 2);
    segs.push([[sx, 2, -hullW(-6.6)], [sx, 2, hullW(-6.6)]]);
    // The balustrade across the front of the quarterdeck, with a gap at the stairs.
    segs.push([[-3, 1.98, -1.02], [-3, 1.98, 2.2]]);
    for (let z = -1.0; z < 2.2; z += 0.4) segs.push([[-3, Q, z], [-3, 1.98, z], 0.04]);
    segs.push([[-3, Q, -2.2], [-3, 1.98, -2.2], 0.04]);
    mk(keep(tubes(segs, 0.065, 4)), M.dark, ship);
  }
  // Cabin front: the captain's door, a lit window, a lantern.
  {
    const w = hullW(-3);
    mk(box(0.12, Q, w * 2), M.wood, ship, -3.04, Q / 2, 0);
    mk(box(0.06, 1.26, 0.94), M.brass, ship, -2.97, 0.63, 0.05);
    mk(box(0.06, 1.16, 0.8), M.dark, ship, -2.94, 0.6, 0.05);
    mk(keep(new THREE.SphereGeometry(0.05, 6, 4)), M.brass, ship, -2.89, 0.6, 0.33);
    mk(cyl(0.15, 0.15, 0.05, 8), M.glass, ship, -2.9, 0.98, 0.05).rotation.z = Math.PI / 2;
    mk(box(0.06, 0.56, 0.66), M.dark, ship, -2.97, 0.86, 1.3);
    mk(box(0.06, 0.44, 0.54), M.glass, ship, -2.95, 0.86, 1.3);
    mk(box(0.07, 0.44, 0.05), M.dark, ship, -2.94, 0.86, 1.3);
    for (let i = 0; i < 5; i++) mk(box(0.3, 0.3 * (i + 1), 0.86), i % 2 ? M.wood : M.pale, ship, -1.65 - 0.3 * i, 0.15 * (i + 1), -1.5);
    // Windows along the aftercastle and across the stern.
    for (const x of [-4.1, -5.3]) for (const s of [1, -1]) { const m = mk(box(0.5, 0.4, 0.05), M.glass, ship, rake(x, 1), 0.98, s * (hullW(x) + 0.005)); m.rotation.y = s * 0.11; }
    for (const z of [-0.8, 0, 0.8]) mk(box(0.05, 0.42, 0.52), M.glass, ship, rake(-6.6, 1) - 0.01, 1.0, z);
  }
  // Foredeck step.
  mk(box(0.1, F, hullW(4) * 2 - 0.1), M.wood, ship, 4.0, F / 2, 0);
  mk(box(0.42, 0.28, 0.9), M.pale, ship, 3.76, 0.14, -0.9);
  // Masts, yards, bowsprit.
  beam([MAIN.x, -0.4, 0], [MAIN.x, MAIN.top, 0], 0.22, 0.1, M.mast, ship, 8);
  beam([FORE.x, -0.4, 0], [FORE.x, FORE.top, 0], 0.19, 0.09, M.mast, ship, 8);
  beam([6.0, 1.3, 0], [9.2, 2.35, 0], 0.15, 0.07, M.mast, ship, 6);
  const sails = [];
  const setSail = (mast, yardY, w, h, belly) => {
    const g = new THREE.Group();
    g.position.set(mast.x, yardY, 0); g.rotation.y = SAIL_YAW;
    beam([-w / 2 - 0.3, 0, 0.2], [w / 2 + 0.3, 0, 0.2], 0.075, 0.075, M.mast, g, 5);
    const s = mk(keep(sailGeometry(w, h, belly)), M.sail, g, 0, -0.06, 0.24);
    s.receiveShadow = false;
    ship.add(g); sails.push(s);
  };
  setSail(MAIN, 4.95, 5.4, 2.3, 0.5);
  setSail(MAIN, 6.5, 4.0, 1.3, 0.36);
  setSail(FORE, 4.5, 4.2, 1.9, 0.42);
  setSail(FORE, 5.9, 3.1, 1.15, 0.3);
  {
    // The jib, set high enough to stand under.
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute([9.0, 2.4, 0, 3.45, 6.5, 0, 5.4, 3.9, -0.5, 9.0, 2.4, 0, 5.4, 3.9, -0.5, 4.7, 3.05, -0.05, 3.45, 6.5, 0, 4.7, 3.05, -0.05, 5.4, 3.9, -0.5], 3));
    g.computeVertexNormals();
    const jib = mk(g, M.sail, ship);
    jib.receiveShadow = false;
    sails.push(jib);
  }
  // Crow's nest.
  mk(cyl(0.78, 0.7, 0.08, 10), M.dark, ship, MAIN.x, NEST_Y - 0.04, 0);
  mk(cyl(0.84, 0.72, 0.56, 10, true), keep(new THREE.MeshLambertMaterial({ color: '#7b5231', flatShading: true, side: THREE.DoubleSide })), ship, MAIN.x, NEST_Y + 0.26, 0);
  mk(keep(new THREE.TorusGeometry(0.84, 0.045, 4, 10)), M.dark, ship, MAIN.x, NEST_Y + 0.54, 0).rotation.x = Math.PI / 2;
  // Standing rigging: shrouds with ratlines (the rope ladders), and stays.
  {
    const segs = [];
    const shrouds = (mx, railY, railZ, topY, spread) => {
      for (const s of [1, -1]) {
        const a0 = [mx - spread, railY, s * railZ], a1 = [mx + spread, railY, s * railZ], top = [mx, topY, s * 0.12];
        segs.push([a0, top], [a1, top]);
        for (let y = railY + 0.55; y < topY - 0.5; y += 0.55) {
          const t = (y - railY) / (topY - railY);
          segs.push([[lerp(a0[0], top[0], t), y, lerp(a0[2], top[2], t)], [lerp(a1[0], top[0], t), y, lerp(a1[2], top[2], t)], 0.018]);
        }
      }
    };
    shrouds(MAIN.x, 0.5, 2.3, 6.3, 0.6);
    shrouds(FORE.x, 0.7, 2.0, 5.2, 0.5);
    segs.push([[9.0, 2.4, 0], [FORE.x, 6.6, 0]], [[FORE.x, 6.8, 0], [MAIN.x, 8.6, 0]], [[MAIN.x, 8.8, 0], [rake(-6.6, 2), 2.0, 0]], [[9.1, 2.35, 0], [FORE.x, 4.9, 0]]);
    const m = mk(keep(tubes(segs, 0.028, 3)), M.rope, ship);
    m.castShadow = false;
  }
  // The Jolly Roger.
  const flagGeo = keep(new THREE.PlaneGeometry(1.5, 0.86, 8, 3));
  flagGeo.translate(0.75, 0, 0);
  const flagBase = flagGeo.attributes.position.array.slice();
  const flag = mk(flagGeo, keep(new THREE.MeshLambertMaterial({ map: keep(jollyRoger()), side: THREE.DoubleSide })), ship, MAIN.x + 0.05, MAIN.top - 0.5, 0);
  flag.rotation.y = 0.243;
  function flap(t) {
    const p = flagGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = flagBase[i * 3], k = x / 1.5;
      p.setZ(i, Math.sin(x * 4.2 - t * 7) * 0.1 * k);
      p.setY(i, flagBase[i * 3 + 1] + Math.sin(x * 3 - t * 5) * 0.04 * k - 0.08 * k * k);
    }
    p.needsUpdate = true;
  }
  // The helm.
  const wheel = new THREE.Group();
  {
    mk(box(0.14, 0.82, 0.14), M.dark, ship, -4.95, Q + 0.41, 0);
    const g = new THREE.Group();
    g.position.set(-4.86, Q + 0.86, 0); g.rotation.y = Math.PI / 2;
    mk(keep(new THREE.TorusGeometry(0.4, 0.05, 5, 12)), M.wood, wheel);
    mk(cyl(0.09, 0.09, 0.1, 8), M.brass, wheel).rotation.x = Math.PI / 2;
    for (let i = 0; i < 4; i++) mk(box(0.05, 1.08, 0.05), M.wood, wheel).rotation.z = (i / 4) * Math.PI;
    g.add(wheel); ship.add(g);
  }
  // The chart table, with a chart, an X and a candle.
  {
    const t = new THREE.Group();
    t.position.set(-3.85, Q, 0.3);
    mk(box(1.05, 0.08, 0.72), M.wood, t, 0, 0.64, 0);
    for (const [x, z] of [[-0.45, -0.28], [0.45, -0.28], [-0.45, 0.28], [0.45, 0.28]]) mk(box(0.08, 0.6, 0.08), M.dark, t, x, 0.3, z);
    mk(box(0.74, 0.02, 0.5), M.chart, t, -0.05, 0.69, 0).rotation.y = 0.12;
    const x1 = mk(box(0.16, 0.025, 0.035), M.red, t, 0.12, 0.705, 0.05); x1.rotation.y = 0.8;
    const x2 = mk(box(0.16, 0.025, 0.035), M.red, t, 0.12, 0.705, 0.05); x2.rotation.y = -0.8;
    mk(cyl(0.035, 0.035, 0.16, 5), M.chart, t, 0.4, 0.76, -0.22);
    mk(keep(new THREE.SphereGeometry(0.04, 5, 4)), M.fire, t, 0.4, 0.87, -0.22).castShadow = false;
    ship.add(t);
  }
  // The carpenter's bench.
  {
    const b = new THREE.Group();
    b.position.set(1.7, 0, -0.75);
    mk(box(1.15, 0.1, 0.52), M.pale, b, 0, 0.62, 0);
    for (const [x, z] of [[-0.48, -0.18], [0.48, -0.18], [-0.48, 0.18], [0.48, 0.18]]) mk(box(0.09, 0.58, 0.09), M.dark, b, x, 0.29, z);
    mk(box(0.95, 0.06, 0.07), M.dark, b, 0, 0.2, 0.18);
    mk(box(0.8, 0.05, 0.2), M.chart, b, -0.05, 0.7, -0.02).rotation.y = 0.1;
    mk(box(0.22, 0.16, 0.18), M.red, b, 0.42, 0.75, 0.12);
    ship.add(b);
  }
  // Cannons on the near side, run out over the rail.
  const cannons = [];
  for (const x of [0.9, 2.2]) {
    const g = new THREE.Group();
    g.position.set(x, 0, 1.5);
    mk(box(0.5, 0.34, 0.74), M.wood, g, 0, 0.3, 0);
    for (const [wx, wz] of [[-0.29, -0.24], [0.29, -0.24], [-0.29, 0.24], [0.29, 0.24]]) mk(cyl(0.14, 0.14, 0.07, 8), M.dark, g, wx, 0.14, wz).rotation.z = Math.PI / 2;
    const barrel = mk(cyl(0.12, 0.18, 1.1, 8), M.iron, g, 0, 0.66, 0.32);
    barrel.rotation.x = Math.PI / 2 - 0.06;
    mk(cyl(0.15, 0.15, 0.08, 8), M.iron, g, 0, 0.7, 0.86).rotation.x = Math.PI / 2 - 0.06;
    const flash = mk(keep(new THREE.IcosahedronGeometry(0.3, 0)), M.fire, g, 0, 0.72, 1.05);
    flash.castShadow = false; flash.visible = false;
    ship.add(g);
    cannons.push({ g, flash, c: 0, kick: 0, manned: false, muzzle: new THREE.Vector3(x, 0.72, 2.5) });
  }
  {
    const ball = keep(new THREE.SphereGeometry(0.11, 6, 5));
    for (const [x, y, z] of [[1.45, 0.11, 1.8], [1.67, 0.11, 1.8], [1.56, 0.11, 1.62], [1.56, 0.28, 1.74]]) mk(ball, M.iron, ship, x, y, z);
  }
  // Barrels, and the galley pot with its fire.
  const barrelGeo = cyl(0.3, 0.3, 0.62, 8), hoopGeo = cyl(0.31, 0.31, 0.05, 8);
  for (const [x, y, z] of [[2.6, 0, -1.78], [-6.25, Q, 0.1]]) {
    mk(barrelGeo, M.wood, ship, x, y + 0.31, z);
    mk(hoopGeo, M.iron, ship, x, y + 0.14, z);
    mk(hoopGeo, M.iron, ship, x, y + 0.48, z);
  }
  const steam = [];
  {
    const px = POT.x, pz = POT.z;
    mk(box(0.5, 0.1, 0.5), M.iron, ship, px, 0.05, pz);
    mk(box(0.3, 0.1, 0.3), M.fire, ship, px, 0.14, pz).castShadow = false;
    mk(cyl(0.32, 0.24, 0.36, 8), M.iron, ship, px, 0.38, pz);
    mk(cyl(0.28, 0.28, 0.02, 8), M.stew, ship, px, 0.56, pz);
    const puff = keep(new THREE.IcosahedronGeometry(1, 0));
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(puff, keep(new THREE.MeshLambertMaterial({ color: '#f1efe8', flatShading: true, transparent: true, opacity: 0.5, depthWrite: false })));
      m.position.set(px, 0.7, pz);
      ship.add(m); steam.push(m);
    }
  }
  // Stern lantern, and the lights that only burn at night.
  const lanternMat = lam('#ffd27a', { emissive: '#ffb347', emissiveIntensity: 1 });
  const lamps = [];
  {
    const sx = rake(-6.6, 2);
    beam([sx, 2, 0], [sx - 0.1, 3.0, 0], 0.05, 0.04, M.dark, ship, 5);
    mk(box(0.26, 0.32, 0.26), lanternMat, ship, sx - 0.1, 3.14, 0).castShadow = false;
    mk(box(0.34, 0.06, 0.34), M.dark, ship, sx - 0.1, 3.33, 0);
    mk(box(0.16, 0.2, 0.16), lanternMat, ship, -2.86, 1.3, 0.72).castShadow = false;
    for (const [x, y, z, i] of [[sx + 0.5, 3.1, 0.2, 14], [-2.5, 1.35, 0.75, 7], [FORE.x + 0.4, 1.6, 0.6, 5]]) {
      const l = new THREE.PointLight('#ffb866', i, 9, 1.6);
      l.position.set(x, y, z); l.userData.i = i;
      ship.add(l); lamps.push(l);
    }
  }

  // Cannon smoke.
  const puffs = [];
  {
    const g = keep(new THREE.IcosahedronGeometry(1, 0));
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(g, keep(new THREE.MeshLambertMaterial({ color: '#e9e5db', flatShading: true, transparent: true, opacity: 0, depthWrite: false })));
      m.visible = false;
      ship.add(m);
      puffs.push({ m, v: new THREE.Vector3(), life: 0, max: 1, size: 0.3 });
    }
  }
  let puffAt = 0;
  function fire(c) {
    c.kick = 1; c.flashT = 0.09;
    for (let i = 0; i < 6; i++) {
      const p = puffs[puffAt++ % puffs.length];
      p.m.position.copy(c.muzzle).add(new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.2, i * 0.12));
      p.v.set((Math.random() - 0.5) * 0.7, 0.35 + Math.random() * 0.5, 0.9 + Math.random() * 1.4);
      p.max = p.life = 1.0 + Math.random() * 0.8; p.size = 0.13 + Math.random() * 0.15;
      p.m.visible = true;
    }
  }

  // ---------- where the crew can go ----------
  const nodes = new Map();
  const addNode = (id, p, zone = zoneOf(p[1]), extra = {}) => { nodes.set(id, { id, p: new THREE.Vector3(p[0], p[1], p[2]), zone, links: [], ...extra }); };
  const link = (a, b, mode) => { nodes.get(a).links.push({ to: b, mode }); nodes.get(b).links.push({ to: a, mode }); };
  for (const [place, list] of Object.entries(SLOTS)) list.forEach((s, i) => addNode(`${place}:${i}`, s, zoneOf(s[1]), { face: s[3] }));
  HOMES.forEach((h, i) => addNode(`home:${i}`, h.p, undefined, { face: h.face }));
  addNode('home:galley', GALLEY.p, undefined, { face: GALLEY.face });
  addNode('stairs0', [-1.25, 0, -1.5]); addNode('stairs1', [-3.3, Q, -1.5]); link('stairs0', 'stairs1', 'walk');
  addNode('step0', [3.35, 0, -0.9]); addNode('step1', [4.4, F, -0.9]); link('step0', 'step1', 'walk');
  // Up the main shrouds to the crow's nest.
  addNode('mainBase', [MAIN.x, 0, 1.6]); addNode('mainLow', [MAIN.x, 0.9, 2.3], null); addNode('mainTop', [MAIN.x, 6.0, 0.48], null);
  link('mainBase', 'mainLow', 'climb'); link('mainLow', 'rigging:2', 'climb'); link('rigging:2', 'mainTop', 'climb');
  link('mainTop', 'nest:0', 'climb'); link('mainTop', 'nest:1', 'climb');
  // Up the fore shrouds.
  addNode('foreBase', [FORE.x, 0, 1.35]); addNode('foreLow', [FORE.x, 1.0, 2.02], null);
  link('foreBase', 'foreLow', 'climb'); link('foreLow', 'rigging:0', 'climb'); link('rigging:0', 'rigging:1', 'climb');

  function findPath(start, goalId) {
    const START = '@';
    const get = (id) => (id === START ? start : nodes.get(id));
    const startId = start.id ?? START;
    const dist = new Map([[startId, 0]]), prev = new Map(), done = new Set();
    for (;;) {
      let cur = null, best = Infinity;
      for (const [id, d] of dist) if (!done.has(id) && d < best) { best = d; cur = id; }
      if (cur == null) return null;
      if (cur === goalId) break;
      done.add(cur);
      const n = get(cur);
      const visit = (to, mode, edge) => {
        const d = best + n.p.distanceTo(nodes.get(to).p) + 0.01;
        if (d < (dist.get(to) ?? Infinity)) { dist.set(to, d); prev.set(to, { from: cur, mode, edge }); }
      };
      for (const l of n.links) visit(l.to, l.mode, n.edge ?? [cur, l.to]);
      if (n.zone) for (const m of nodes.values()) if (m.zone === n.zone && m.id !== cur) visit(m.id, 'walk', null);
    }
    const out = [];
    for (let id = goalId; id !== startId;) {
      const step = prev.get(id), n = nodes.get(id), from = get(step.from);
      out.unshift({ p: n.p, zone: n.zone, mode: step.mode, edge: step.edge, id });
      if (!step.edge && n.zone === 'main') {   // walk round the masts, not through them
        for (const [mx, mz, r] of MASTS) {
          const ax = from.p.x, az = from.p.z, dx = n.p.x - ax, dz = n.p.z - az, len2 = dx * dx + dz * dz;
          if (len2 < 0.01) continue;
          const t = ((mx - ax) * dx + (mz - az) * dz) / len2;
          if (t <= 0.02 || t >= 0.98) continue;
          let ox = ax + dx * t - mx, oz = az + dz * t - mz;
          const d = Math.hypot(ox, oz);
          if (d >= r) continue;
          if (d < 0.001) { ox = 0; oz = 1; } else { ox /= d; oz /= d; }
          out.unshift({ p: new THREE.Vector3(mx + ox * (r + 0.12), 0, mz + oz * (r + 0.12)), zone: 'main', mode: 'walk', edge: null, id: null });
        }
      }
      id = step.from;
    }
    return out;
  }

  // ---------- the crew ----------
  const G = {
    torso: cyl(0.2, 0.27, 0.5, 7), belt: cyl(0.275, 0.275, 0.07, 7), buckle: box(0.09, 0.08, 0.03),
    head: keep(new THREE.IcosahedronGeometry(0.27, 1)), eye: keep(new THREE.SphereGeometry(0.036, 6, 4)), nose: keep(new THREE.SphereGeometry(0.045, 5, 4)),
    arm: box(0.115, 0.36, 0.115), hand: keep(new THREE.SphereGeometry(0.078, 6, 4)), leg: box(0.15, 0.4, 0.17), boot: box(0.17, 0.11, 0.25),
    cap: keep(new THREE.SphereGeometry(0.288, 8, 4, 0, TAU, 0, 1.3)), knot: keep(new THREE.SphereGeometry(0.06, 5, 4)), tail: box(0.05, 0.17, 0.03),
    brim: cyl(0.5, 0.38, 0.1, 3), crown: cyl(0.2, 0.26, 0.2, 6), patch: box(0.12, 0.1, 0.03), strap: keep(new THREE.TorusGeometry(0.275, 0.016, 4, 12)),
    feather: keep(new THREE.ConeGeometry(0.075, 0.55, 4)), beard: keep(new THREE.ConeGeometry(0.2, 0.36, 6)), band: cyl(0.293, 0.293, 0.08, 8), visor: box(0.3, 0.035, 0.16),
    toque: cyl(0.25, 0.23, 0.26, 8), puff: keep(new THREE.IcosahedronGeometry(0.29, 1)),
    handle: box(0.045, 0.045, 0.34), mallet: box(0.1, 0.2, 0.1), glass: cyl(0.045, 0.065, 0.42, 6), glassBand: cyl(0.07, 0.07, 0.05, 6),
    ring: keep(new THREE.TorusGeometry(0.42, 0.035, 4, 16)),
    cloud: keep(new THREE.IcosahedronGeometry(1, 0)), rain: box(0.02, 0.14, 0.02), bolt: box(0.05, 0.3, 0.05),
  };
  const ringMat = keep(new THREE.MeshBasicMaterial({ color: '#f0cd84' }));
  const cloudDark = lam('#4a5563'), rainMat = keep(new THREE.MeshBasicMaterial({ color: '#b7d3e8' })), boltMat = keep(new THREE.MeshBasicMaterial({ color: '#ffe680' }));

  function makePirate(m, index) {
    const mats = [];
    const pm = (hex) => { const mt = new THREE.MeshLambertMaterial({ color: hex, flatShading: true }); mats.push({ m: mt, base: new THREE.Color(hex) }); return mt; };
    const coat = pm(m.color || '#c9a24b');
    const sleeve = pm('#' + new THREE.Color(m.color || '#c9a24b').multiplyScalar(0.8).getHexString());
    const skin = pm('#e9c49a'), ink = pm('#2a1f14'), trews = pm('#4f3f37'), boot = pm('#231911'), brass = pm('#c9a24b'), iron = pm('#8b8f96'), wood = pm('#8a5f38');
    const root = new THREE.Group(), body = new THREE.Group(), head = new THREE.Group();
    root.scale.setScalar(SCALE);
    body.position.y = HIP;
    root.add(body);
    mk(G.torso, coat, body, 0, 0.25, 0);
    mk(G.belt, ink, body, 0, 0.06, 0);
    mk(G.buckle, brass, body, 0, 0.06, 0.27);
    head.position.y = 0.5;
    body.add(head);
    mk(G.head, skin, head, 0, 0.24, 0);
    const eyes = [mk(G.eye, ink, head, -0.1, 0.27, 0.24), mk(G.eye, ink, head, 0.1, 0.27, 0.24)];
    mk(G.nose, skin, head, 0, 0.2, 0.27);
    const limb = (x, y, geo, mat, len, tip, tipMat, tz = 0) => {
      const g = new THREE.Group();
      g.position.set(x, y, 0);
      mk(geo, mat, g, 0, -len / 2, 0);
      mk(tip, tipMat, g, 0, -len - 0.02, tz);
      body.add(g);
      return g;
    };
    const armL = limb(-0.275, 0.44, G.arm, sleeve, 0.36, G.hand, skin), armR = limb(0.275, 0.44, G.arm, sleeve, 0.36, G.hand, skin);
    const legL = limb(-0.115, 0, G.leg, trews, 0.36, G.boot, boot, 0.04), legR = limb(0.115, 0, G.leg, trews, 0.36, G.boot, boot, 0.04);
    // What they carry: every hand can hold a hammer or a spyglass when the work calls for it.
    const hammer = new THREE.Group();
    hammer.position.y = -0.4;
    mk(G.handle, wood, hammer, 0, 0, 0.14);
    mk(G.mallet, iron, hammer, 0, 0, 0.31);
    const spyglass = new THREE.Group();
    mk(G.glass, brass, spyglass, 0, -0.6, 0);
    mk(G.glassBand, ink, spyglass, 0, -0.8, 0);
    armR.add(hammer, spyglass);
    // What they wear.
    const bandana = (hex) => {
      const c = pm(hex);
      mk(G.cap, c, head, 0, 0.245, 0).rotation.x = -0.22;
      mk(G.knot, c, head, 0.27, 0.3, -0.08);
      mk(G.tail, c, head, 0.33, 0.22, -0.1).rotation.z = 0.5;
      mk(G.tail, c, head, 0.3, 0.19, -0.16).rotation.z = 0.2;
      return c;
    };
    const tricorn = () => { mk(G.brim, ink, head, 0, 0.45, 0); mk(G.crown, ink, head, 0, 0.55, 0); mk(G.buckle, brass, head, 0, 0.52, 0.245); };
    switch (m.look) {
      case 'skull': bandana('#f2efe6'); mk(G.eye, ink, head, 0, 0.44, 0.215).scale.setScalar(1.5); break;
      case 'bandana': bandana('#c8392b'); break;
      case 'spyglass': bandana('#2f5f8a'); break;
      case 'eyepatch': {
        tricorn();
        mk(G.patch, ink, head, 0.1, 0.27, 0.245);
        const s = mk(G.strap, ink, head, 0, 0.27, 0);
        s.rotation.set(Math.PI / 2, 0.35, 0);
        eyes[1].visible = false;
        break;
      }
      case 'feather': {
        tricorn();
        const f = mk(G.feather, pm('#b49ad8'), head, 0.2, 0.78, -0.06);
        f.scale.z = 0.35; f.rotation.z = -0.45;
        break;
      }
      case 'beard': {
        const white = pm('#f1f1ee'), blue = pm('#3c5a7a');
        const b = mk(G.beard, white, head, 0, 0.07, 0.15);
        b.rotation.x = Math.PI; b.scale.z = 0.7;
        mk(G.cap, blue, head, 0, 0.25, 0);
        mk(G.band, blue, head, 0, 0.36, 0);
        mk(G.knot, white, head, 0, 0.56, 0);
        break;
      }
      case 'hammer': { const green = pm('#6b8f4e'); mk(G.cap, green, head, 0, 0.25, 0); mk(G.visor, green, head, 0, 0.37, 0.27); break; }
      case 'chef': { const white = pm('#fafafa'); mk(G.toque, white, head, 0, 0.56, 0); mk(G.puff, white, head, 0, 0.76, 0).scale.y = 0.72; break; }
      default: bandana('#2a1f14');
    }
    const ring = new THREE.Mesh(G.ring, ringMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.03; ring.visible = false;
    root.add(ring);
    ship.add(root);

    const nameEl = document.createElement('button');
    nameEl.type = 'button'; nameEl.className = 's3d-name'; nameEl.textContent = m.name;
    nameEl.addEventListener('click', () => onSelect(m.name));
    const bubEl = document.createElement('div');
    bubEl.className = 's3d-bub'; bubEl.hidden = true;
    const zEl = document.createElement('span');
    zEl.className = 's3d-z'; zEl.innerHTML = '<i>z z</i>'; zEl.setAttribute('aria-hidden', 'true');
    over.append(nameEl, bubEl, zEl);

    return {
      name: m.name, look: m.look, index, seed: (index * 0.618 + 0.3) % 1, root, body, head, armL, armR, legL, legR, eyes, hammer, spyglass, ring, mats,
      nameEl, bubEl, zEl, nameW: 0, nameH: 16, bubW: 0, bubH: 20, say: '', bubOff: 0, nameOff: 0, alert: false, bubWant: true, bubSince: 0, box: null, nameBox: null,
      pos: new THREE.Vector3(), at: null, goal: null, path: null, i: 0, mode: 'walk', phase: 0,
      action: 'stand', face: 0, heading: 0, slot: 0, off: false, dim: 0, hop: 0, squall: false, cloud: null,
      pose: { ...POSE }, want: { ...POSE }, feet: { x: 0, y: 0 }, top: { x: 0, y: 0 }, depth: 0,
    };
  }

  function makeCloud(P) {
    const g = new THREE.Group();
    g.position.y = 2.25;
    for (const [x, y, z, r] of [[0, 0, 0, 0.42], [0.4, -0.04, 0.05, 0.3], [-0.4, -0.05, -0.03, 0.32], [0.1, 0.16, -0.1, 0.3]]) {
      const c = new THREE.Mesh(G.cloud, cloudDark);
      c.position.set(x, y, z); c.scale.set(r, r * 0.7, r * 0.8);
      g.add(c);
    }
    const rain = [];
    for (let i = 0; i < 9; i++) {
      const r = new THREE.Mesh(G.rain, rainMat);
      r.userData = { x: ((i * 0.37) % 1 - 0.5) * 1.1, z: ((i * 0.61) % 1 - 0.5) * 0.5, o: (i * 0.23) % 1 };
      g.add(r); rain.push(r);
    }
    const bolt = new THREE.Group();
    for (const [x, y, rz] of [[0.05, -0.38, 0.5], [-0.03, -0.6, -0.55], [0.06, -0.82, 0.5]]) { const b = new THREE.Mesh(G.bolt, boltMat); b.position.set(x, y, 0.2); b.rotation.z = rz; bolt.add(b); }
    g.add(bolt);
    P.root.add(g);
    return { g, rain, bolt };
  }

  const crew = new Map();   // name -> pirate
  let selected = null;
  let snapNext = true;      // put everyone straight where they belong (first frame, or after a long pause)

  function send(P, goalId, action, face) {
    P.action = action; P.face = face;
    if (P.goal === goalId) return;
    P.goal = goalId;
    if (P.at == null && !P.path) { P.pos.copy(nodes.get(goalId).p); P.at = goalId; P.heading = face; return; }
    let start;
    if (!P.path) start = nodes.get(P.at);
    else {
      const next = P.path[P.i];
      start = next.edge
        ? { p: P.pos.clone(), zone: null, edge: next.edge, links: next.edge.map((to) => ({ to, mode: next.mode })) }
        : { p: P.pos.clone(), zone: next.zone, links: [] };
    }
    if (start.id === goalId) { P.path = null; return; }
    const path = findPath(start, goalId);
    if (!path?.length) { P.pos.copy(nodes.get(goalId).p); P.at = goalId; P.path = null; return; }
    P.path = path; P.i = 0; P.mode = path[0].mode; P.at = null;
  }

  function update(state, sel) {
    selected = sel ?? null;
    const list = state?.crew ?? [];
    const byName = new Map((state?.threads ?? []).map((t) => [t.callsign, t]));
    for (const [name, P] of crew) {
      if (list.some((m) => m.name === name)) continue;
      ship.remove(P.root); P.nameEl.remove(); P.bubEl.remove(); P.zEl.remove();
      P.mats.forEach((x) => x.m.dispose());
      crew.delete(name);
    }
    const count = {};
    let nextHome = 0;
    for (const m of list) {
      let P = crew.get(m.name);
      if (!P) {
        P = makePirate(m, crew.size);
        P.home = m.look === 'chef' && ![...crew.values()].some((o) => o.home === 'home:galley') ? 'home:galley' : `home:${nextHome % HOMES.length}`;
        crew.set(m.name, P);
      }
      if (P.home !== 'home:galley') nextHome += 1;
      const t = byName.get(m.name);
      const place = placeOf(t);
      const spec = P.home === 'home:galley' ? GALLEY : HOMES[Number(P.home.slice(5))];
      P.off = !t;
      P.squall = place === 'squall';
      if (place && SLOTS[place]) {
        const n = (count[place] = (count[place] ?? 0) + 1) - 1;
        P.slot = n;
        const id = `${place}:${n % SLOTS[place].length}`;
        send(P, id, place, nodes.get(id).face);
      } else if (t) send(P, P.home, spec.lounge, spec.loungeFace ?? spec.face);
      else send(P, P.home, spec.nap, spec.face);
      const say = sayOf(t, place) || '';
      if (say !== P.say) { P.say = say; P.bubEl.textContent = say; P.bubEl.hidden = !say; P.bubW = 0; }
      P.alert = Boolean(t?.asking || t?.squall || t?.waiting);
      P.bubEl.classList.toggle('alert', Boolean(t?.asking || t?.squall));
      P.bubEl.classList.toggle('air', Boolean(t?.onAir));
      P.nameEl.classList.toggle('off', !t);
      if (selected === m.name && !P.nameEl.classList.contains('sel')) P.hop = 1;
      P.nameEl.classList.toggle('sel', selected === m.name);
      P.nameEl.setAttribute('aria-label', `${m.name}: ${say || (t ? 'on duty' : 'off duty, napping')}`);
      P.zEl.hidden = Boolean(t);
      P.ring.visible = selected === m.name;
    }
    invalidate();
  }

  // ---------- one moment ----------
  let T = 0;
  const fx = { cannon: (slot) => (slot < cannons.length ? cannons[slot].c : null) };
  const tmp = new THREE.Vector3();
  const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

  function stepPirate(P, dt, snap) {
    if (snap && P.goal) { P.pos.copy(nodes.get(P.goal).p); P.at = P.goal; P.path = null; }
    let heading = P.face;
    if (P.path) {
      let left = (P.mode === 'climb' ? CLIMB : WALK) * dt;
      while (P.path && left > 0) {
        const wp = P.path[P.i];
        const d = P.pos.distanceTo(wp.p);
        if (d <= left) {
          P.pos.copy(wp.p); left -= d; P.phase += d * (P.mode === 'climb' ? 5 : 6.6);
          P.i += 1;
          if (P.i >= P.path.length) { P.path = null; P.at = P.goal; } else P.mode = P.path[P.i].mode;
        } else {
          P.pos.lerp(wp.p, left / d); P.phase += left * (P.mode === 'climb' ? 5 : 6.6); left = 0;
        }
      }
      if (P.path) {
        const wp = P.path[P.i];
        heading = P.mode === 'climb' ? Math.PI : (Math.hypot(wp.p.x - P.pos.x, wp.p.z - P.pos.z) > 0.02 ? Math.atan2(wp.p.x - P.pos.x, wp.p.z - P.pos.z) : P.heading);
      }
    }
    const act = P.path ? P.mode : P.action;
    const o = P.want;
    for (const k of POSE_KEYS) o[k] = 0;
    o.alz = -0.1; o.arz = 0.1;
    (ACT[act] ?? ACT.stand)(o, T, P, fx);
    if (P.hop > 0) { o.by += Math.sin(P.hop * Math.PI) * 0.22; P.hop = Math.max(0, P.hop - dt * 2.4); }
    const k = snap ? 1 : 1 - Math.exp(-(act === 'walk' || act === 'climb' ? 30 : 14) * dt);
    for (const key of POSE_KEYS) P.pose[key] += (o[key] - P.pose[key]) * k;
    P.heading = snap ? heading : P.heading + angDiff(heading, P.heading) * (1 - Math.exp(-10 * dt));
    const q = P.pose;
    P.root.position.copy(P.pos);
    P.root.rotation.y = P.heading;
    P.body.position.y = HIP + q.by;
    P.body.rotation.set(q.bx, q.tw, q.bz);
    P.head.rotation.set(q.hx, q.hy, 0);
    P.armL.rotation.set(q.alx, 0, q.alz); P.armR.rotation.set(q.arx, 0, q.arz);
    P.legL.rotation.x = q.llx; P.legR.rotation.x = q.lrx;
    const asleep = !P.path && act.startsWith('nap');
    const blink = asleep ? 0.12 : ((T * 0.31 + P.seed) % 1 > 0.97 ? 0.12 : 1);
    for (const e of P.eyes) e.scale.y = blink;
    P.hammer.visible = P.look === 'hammer' || (!P.path && act === 'bench');
    P.spyglass.visible = !P.hammer.visible && (P.look === 'spyglass' || (!P.path && act === 'nest'));
    const dim = P.off ? 1 : 0;
    if (Math.abs(dim - P.dim) > 0.002 || snap) {
      P.dim = snap ? dim : P.dim + (dim - P.dim) * (1 - Math.exp(-3 * dt));
      for (const x of P.mats) { const g = (x.base.r + x.base.g + x.base.b) / 3; x.m.color.setRGB(lerp(x.base.r, g, 0.45 * P.dim), lerp(x.base.g, g, 0.45 * P.dim), lerp(x.base.b, g, 0.45 * P.dim)).multiplyScalar(1 - 0.36 * P.dim); }
    }
    if (P.ring.visible) P.ring.scale.setScalar(1 + Math.sin(T * 4) * 0.06);
    if (P.squall && !P.cloud) P.cloud = makeCloud(P);
    if (P.cloud) {
      P.cloud.g.visible = P.squall;
      if (P.squall) {
        P.cloud.g.rotation.y = -P.heading;
        P.cloud.g.position.y = 2.25 + Math.sin(T * 2) * 0.04;
        for (const r of P.cloud.rain) { const f = (T * 1.7 + r.userData.o) % 1; r.position.set(r.userData.x, -0.25 - f * 0.9, r.userData.z); }
        P.cloud.bolt.visible = (T * 0.9 + P.seed) % 1 > 0.9 && Math.sin(T * 60) > -0.3;
      }
    }
  }

  function tick(dt, snap) {
    T += dt;
    swell(T);
    flap(T);
    const az = AZ + Math.sin(T * 0.11) * 0.045;
    view.rotation.y = az;
    const ce = Math.cos(EL);
    camera.position.set(target.x + Math.sin(az) * ce * camDist, target.y + Math.sin(EL) * camDist, target.z + Math.cos(az) * ce * camDist);
    camera.lookAt(target);
    ship.position.y = SHIP_Y + Math.sin(T * 0.8) * 0.1;
    ship.rotation.z = Math.sin(T * 0.62 + 1) * 0.022;
    ship.rotation.x = Math.sin(T * 0.5) * 0.03;
    sails.forEach((s, i) => { s.scale.z = 1 + Math.sin(T * 0.9 + i * 1.3) * 0.12; });
    for (const c of clouds) { c.position.x += dt * 0.35; if (c.position.x > 62) c.position.x = -62; }
    starMat.opacity = 0.78 + Math.sin(T * 1.3) * 0.12;
    for (const g of gulls) {
      if (!g.g.visible) continue;
      g.a += dt * g.sp;
      g.g.position.set(1.5 + Math.cos(g.a) * g.rad, g.y + Math.sin(g.a * 2) * 0.4, -3 + Math.sin(g.a) * g.rad * 0.7);
      g.g.rotation.y = -g.a;
      const f = Math.sin(T * 7 + g.rad) * 0.55;
      g.l.rotation.z = f; g.r.rotation.z = -f;
    }
    // Cannons fire in turn while someone mans them.
    for (const c of cannons) c.manned = false;
    let helmed = false;
    for (const P of crew.values()) {
      if (P.path) continue;
      if (P.action === 'cannons' && cannons[P.slot]) cannons[P.slot].manned = true;
      if (P.action === 'helm') helmed = true;
    }
    cannons.forEach((c, i) => {
      if (c.manned && dt > 0) {
        const before = c.c;
        c.c = (c.c + dt / (4.2 + i * 0.6)) % 1;
        if (before < 0.72 && c.c >= 0.72) fire(c);
      } else if (!c.manned) c.c = 0.3;
      c.kick = Math.max(0, c.kick - dt * 2.2);
      c.g.position.z = 1.5 - c.kick * c.kick * 0.32;
      c.flashT = Math.max(0, (c.flashT ?? 0) - dt);
      c.flash.visible = c.flashT > 0;
    });
    for (const p of puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const f = 1 - p.life / p.max;
      p.m.position.addScaledVector(p.v, dt);
      p.v.multiplyScalar(1 - dt * 1.4);
      p.m.scale.setScalar(p.size * (1 + f * 2.2));
      p.m.material.opacity = 0.7 * (1 - f) ** 1.5;
      if (p.life <= 0) p.m.visible = false;
    }
    steam.forEach((m, i) => {
      const f = (T * 0.33 + i / 3) % 1;
      m.position.set(POT.x + Math.sin(f * 5 + i) * 0.07, 0.62 + f * 0.95, POT.z);
      m.scale.setScalar(0.07 + f * 0.16);
      m.material.opacity = 0.5 * (1 - f);
    });
    wheel.rotation.z = helmed ? Math.sin(T * 1.2) * 0.75 : wheel.rotation.z * (1 - Math.min(1, dt * 2));
    for (const P of crew.values()) stepPirate(P, dt, snap);
  }

  // ---------- names and speech, laid over the picture ----------
  const size = { w: 0, h: 0 };
  let small = false;   // a phone-width picture: smaller labels, fewer bubbles
  function project(P) {
    P.root.getWorldPosition(tmp);
    tmp.project(camera);
    P.depth = tmp.z;
    P.feet.x = (tmp.x * 0.5 + 0.5) * size.w; P.feet.y = (-tmp.y * 0.5 + 0.5) * size.h;
    tmp.set(0, 0.62, 0);
    P.head.localToWorld(tmp);
    tmp.project(camera);
    P.top.x = (tmp.x * 0.5 + 0.5) * size.w; P.top.y = (-tmp.y * 0.5 + 0.5) * size.h;
  }
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  function layLabels(snap) {
    const all = [...crew.values()], now = performance.now();
    for (const P of all) {
      project(P);
      if (!P.nameW) { P.nameW = P.nameEl.offsetWidth; P.nameH = P.nameEl.offsetHeight; }
      if (P.say && !P.bubW) { P.bubW = P.bubEl.offsetWidth; P.bubH = P.bubEl.offsetHeight; }
      P.box = { x: Math.min(P.feet.x, P.top.x) - 11, y: P.top.y, w: 22 + Math.abs(P.feet.x - P.top.x), h: Math.max(8, P.feet.y - P.top.y) };
    }
    // Names sit under the feet; one that would cover another drops a line.
    const names = [];
    for (const P of all.sort((a, b) => a.feet.y - b.feet.y)) {
      const r = { x: clamp(P.feet.x - P.nameW / 2, 2, size.w - P.nameW - 2), y: Math.min(Math.max(P.feet.y, P.top.y + 14) + 4, size.h - P.nameH - 2), w: P.nameW, h: P.nameH };
      let off = 0;
      for (let n = 0; n < 3 && names.some((o) => hits({ ...r, y: r.y + off }, o)); n++) off += P.nameH + 1;
      P.nameOff = snap ? off : P.nameOff + (off - P.nameOff) * 0.2;
      r.y += off;
      names.push(r);
      P.nameBox = r;
      P.nameEl.style.transform = `translate(${r.x.toFixed(1)}px, ${(r.y - off + P.nameOff).toFixed(1)}px)`;
      if (!P.zEl.hidden) P.zEl.style.transform = `translate(${(P.top.x + 6).toFixed(1)}px, ${(P.top.y - 14).toFixed(1)}px)`;
    }
    // Speech goes over the head, lifted clear of the others. On a crowded deck the
    // least urgent bubbles give way rather than bury the crew; a tap still tells all.
    const placed = [], levels = small ? 2 : 3;
    const rank = (P) => (P.alert ? 0 : P.name === selected ? 1 : 2);
    for (const P of all.filter((p) => p.say).sort((a, b) => rank(a) - rank(b) || b.top.y - a.top.y)) {
      const x = clamp(P.top.x - P.bubW / 2, 3, size.w - P.bubW - 3);
      const y0 = Math.max(2, P.top.y - P.bubH - 7), step = P.bubH + 3;
      const at = (y) => ({ x, y, w: P.bubW, h: P.bubH });
      const clear = (r) => !placed.some((o) => hits(r, o));
      // Not over another figure or its name, and never straight above the head of someone standing
      // higher up the picture, where it would seem to be theirs.
      const free = (r) => clear(r) && !all.some((o) => o !== P && (hits(r, o.box) || hits(r, o.nameBox) || (o.top.y < P.top.y && r.y < o.top.y && Math.abs(o.top.x - P.top.x) < 18)));
      let off = -1;
      for (let n = 0; n <= levels && off < 0 && y0 - n * step >= 2; n++) if (free(at(y0 - n * step))) off = n * step;
      if (off < 0 && rank(P) < 2) { off = 0; for (let n = 0; n <= 4 && y0 - n * step >= 2; n++) if (clear(at(y0 - n * step))) { off = n * step; break; } }
      const show = off >= 0;
      if (show !== P.bubWant) { P.bubWant = show; P.bubSince = now; }
      if (snap || now - P.bubSince > 300) P.bubEl.classList.toggle('gone', !P.bubWant);
      if (!show) continue;
      P.bubOff = snap ? off : P.bubOff + (off - P.bubOff) * 0.2;
      placed.push(at(y0 - off));
      P.bubEl.style.transform = `translate(${x.toFixed(1)}px, ${(y0 - P.bubOff).toFixed(1)}px)`;
      P.bubEl.style.setProperty('--tail', `${clamp(P.top.x - (x + P.bubW / 2), -P.bubW / 2 + 9, P.bubW / 2 - 9).toFixed(1)}px`);
      P.bubEl.style.zIndex = rank(P) < 2 ? 2 : 1;
    }
  }

  function pick(ev) {
    const box = canvas.getBoundingClientRect();
    const x = ev.clientX - box.left, y = ev.clientY - box.top;
    let best = null, bestD = Infinity;
    for (const P of crew.values()) {
      const cx = (P.feet.x + P.top.x) / 2, cy = (P.feet.y + P.top.y) / 2;
      const reach = Math.max(26, Math.hypot(P.feet.x - P.top.x, P.feet.y - P.top.y) * 0.9);
      const d = Math.hypot(x - cx, y - cy);
      if (d < reach && d < bestD) { best = P; bestD = d; }
    }
    return best;
  }
  canvas.addEventListener('click', (ev) => { const P = pick(ev); if (P) onSelect(P.name); });
  canvas.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse') canvas.style.cursor = pick(ev) ? 'pointer' : ''; });

  // ---------- night and day ----------
  const media = { dark: matchMedia('(prefers-color-scheme: dark)'), still: matchMedia('(prefers-reduced-motion: reduce)') };
  const isDark = () => { const t = document.documentElement.dataset.theme; return t === 'dark' || (t !== 'light' && media.dark.matches); };
  function applyTheme() {
    const dark = isDark(), p = dark ? PALETTES.night : PALETTES.day;
    const g = skyCanvas.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, p.skyTop); grad.addColorStop(0.3, p.skyMid); grad.addColorStop(0.6, p.horizon); grad.addColorStop(1, p.horizon);
    g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
    skyTex.needsUpdate = true;
    scene.fog.color.set(p.horizon);
    hemi.color.set(p.hemiSky); hemi.groundColor.set(p.hemiGround); hemi.intensity = p.hemi;
    sun.color.set(p.sun); sun.intensity = p.sunI;
    seaMat.color.set(p.sea); M.sail.color.set(p.sail); cloudMat.color.set(p.cloud); islandMat.color.set(p.island);
    M.glass.color.set(p.glass); M.glass.emissiveIntensity = p.glow;
    lanternMat.emissiveIntensity = dark ? 1 : 0.15;
    for (const l of lamps) l.intensity = l.userData.i * p.lantern;
    stars.visible = moon.visible = halo.visible = dark;
    for (const gl of gulls) gl.g.visible = !dark;
    container.style.background = p.horizon;
  }

  // ---------- running, pausing, drawing ----------
  let raf = 0, last = 0, onScreen = true, lost = false, disposed = false, pausedAt = 0;
  const still = () => media.still.matches;
  function draw(dt, snap) {
    if (!size.w || !size.h || lost) return;
    tick(dt, snap);
    renderer.render(scene, camera);
    layLabels(snap);
  }
  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    draw(dt, snapNext);
    snapNext = false;
  }
  function sync() {
    const want = !disposed && onScreen && !document.hidden && !still() && !lost;
    if (want && !raf) {
      if (pausedAt && performance.now() - pausedAt > 2500) snapNext = true;   // nobody watched them walk; they are there by now
      last = performance.now();
      raf = requestAnimationFrame(loop);
    } else if (!want && raf) { cancelAnimationFrame(raf); raf = 0; pausedAt = performance.now(); }
    if (!raf && !disposed && still()) draw(0, true);
  }
  // With motion reduced nothing runs: each change is drawn once, with everyone already in place.
  function invalidate() { if (!raf && !disposed && still() && onScreen) draw(0, true); }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    size.w = w; size.h = h;
    small = w < 520;
    container.classList.toggle('s3d-small', small);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camDist = Math.max(11.9, 16.2 / camera.aspect) / (2 * Math.tan((FOV * Math.PI) / 360));
    camera.updateProjectionMatrix();
    scene.fog.near = camDist + 10; scene.fog.far = camDist + 75;
    for (const P of crew.values()) { P.nameW = 0; P.bubW = 0; }
    if (!raf) draw(0, true);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; sync(); }) : null;
  io?.observe(container);
  const mo = new MutationObserver(() => { applyTheme(); invalidate(); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const onTheme = () => { applyTheme(); invalidate(); };
  const onVisible = () => sync();
  const onLost = (e) => { e.preventDefault(); lost = true; sync(); };
  const onRestored = () => { lost = false; sync(); };
  media.dark.addEventListener('change', onTheme);
  media.still.addEventListener('change', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  applyTheme();
  resize();
  sync();

  return {
    update,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf); raf = 0;
      ro.disconnect(); io?.disconnect(); mo.disconnect();
      media.dark.removeEventListener('change', onTheme);
      media.still.removeEventListener('change', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      for (const P of crew.values()) P.mats.forEach((x) => x.m.dispose());
      disposables.forEach((d) => d.dispose?.());
      renderer.dispose();
      canvas.remove(); over.remove();
      container.classList.remove('s3d');
    },
  };
}
