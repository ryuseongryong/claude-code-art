// 01 — Whispering Currents / 속삭이는 해류
//
// 2옥타브 Perlin 노이즈를 각도로 읽은 벡터장 위를 입자가 흐른다.
//
// PHASE 1: 일부러 추상이 없다. 캔버스 리사이즈, DPR 스케일, requestAnimationFrame 루프,
// dt/t 시계, 포인터 좌표를 모두 이 파일 안에서 직접 처리한다. Phase 2 에서 작품 02 를
// 이 스캐폴딩째로 베껴 쓴 뒤, 무엇이 중복인지 눈으로 확인하고 engine.js 로 추출한다.
// 그때까지 이 중복은 버그가 아니라 의도다.

// ============================================================================
// 상수
// ============================================================================

const TAU = Math.PI * 2;

// --- 시계 ---
// 두 개의 시계가 필요하다.
//   dt   = 물리용. 1/20초로 캡한다 — 탭을 나갔다 돌아왔을 때 적분기가 터지지 않게.
//   real = UI 성 타이밍용. 캡이 더 느슨하다(0.25초).
// 왜 둘인가: 프레임이 116ms 걸리는 기계에서 dt 는 0.05 만 나아가고 벽시계는 0.117 이 흐른다.
// 물리에는 그게 맞지만(느려질 뿐 안정적), "길게 누르면 1.4초에 걸쳐 충전" 은 관람객에게 한
// 약속이라 실경과로 재야 한다. 그렇지 않으면 느린 기계에서 3.3초가 걸린다(실측).
const DT_CAP = 1 / 20;
const REAL_CAP = 0.25;

// --- 백킹스토어 ---
// DPR 상한 2 만으로는 부족하다. 3840x2160 @dpr2 는 7680x4320 = 33.2M px = 126.6 MiB 이고,
// 모든 작품이 매 프레임 하는 전면 fillRect 하나가 10.79ms — 16.6ms 예산의 65% 를
// 입자 한 개 그리기 전에 쓴다(실측 0.33 ns/px, 완전 선형).
// 아래 식은 1920x1080@2, 2560x1440@2, 3840x2160@2·@3 을 모두 2309x1299 = 2,999,391 px
// = 11.4 MiB ~ 0.97ms 로 수렴시킨다.
const PX_CAP = 3_000_000;
const MAX_DIM = 4096;           // 여러 모바일 GPU 가 이 위의 캔버스를 거부한다

// --- 입자 ---
// 화면 면적에 비례해 6000~34000 으로 묶는다. 1920x1080 -> round(2073600/61) = 33,993.
const AREA_PER_PARTICLE = 61;
const N_MIN = 6000;
const N_MAX = 34000;

const SPEED = 62;               // CSS px/s, 버킷별 배수가 곱해진다.
                                // 프레임당 세그먼트 길이 = SPEED * 배수 * dt. 이게 곧 잉크량이다.
const LIFE_MIN = 2.2;           // s — 수명이 끝나면 재배치. 없으면 모든 입자가
const LIFE_MAX = 7.0;           //     수렴선으로 모여 화면이 몇 줄로 굳는다

// --- 벡터장 ---
const F1 = 0.0028;              // 1옥타브 주파수 (CSS px^-1) — 큰 해류, 주기 약 360 CSS px
const F2 = 0.0079;              // 2옥타브 — 잔결
const OCT2_AMP = 0.5;
const WIND_TURNS = 2;           // 노이즈 [-1,1] -> 각도 몇 바퀴
const DRIFT1 = 7.5;             // 옥타브별 시간 표류 (CSS px/s) — 장 자체가 천천히 흐른다
const DRIFT2 = -13.0;

// --- 잔상 ---
// 캔버스를 지우지 않고 매 프레임 이 색으로 덮어 잔상을 만든다.
// 감쇠 0.934^n: 50% 10.15프레임(167ms), 10% 31프레임(517ms), 완전 소멸 75프레임(833ms).
const COVER = 'rgba(5,5,7,0.066)';
const COVER_ALPHA = 0.066;

// 가산 합성의 클립 임계는 채널당 프레임당 (255-5) * 0.066 = 16.5.
// alpha 0.30 이면 한 번 맞을 때 76 을 침전시켜 임계의 4.6배 — Perlin 수렴선(매 프레임
// 지나가는 픽셀)이 4프레임 만에 #ffffff 로 클립되어 색 정보가 전부 날아간다.
// 그래서 알파는 버킷별로 정하고(아래 BUCKETS), 어느 버킷도 최대 채널 침전이 ~10 을
// 넘지 않게 맞췄다 — 임계 16.5 에 1.6배 겹침 여유가 남는다.
// 어두운 색일수록 알파 여유가 많다는 것이 요점이다: #0d2438 은 alpha 0.10 에서도
// 파랑 침전이 56*0.10 = 5.6 뿐이고, #8ed4ff 는 alpha 0.04 에 이미 255*0.04 = 10.2 다.

// --- 색 버킷 ---
// 입자별 strokeStyle 은 104.90ms, 색 6버킷(6회 stroke) 은 48.55ms, 단일 path 는 46.99ms.
// 즉 버킷 6개의 대가는 3% 뿐이라 색 다양성은 사실상 무료다. 대신 입자별 색은 2.2배 비싸다.
// 버킷을 입자 인덱스로 나누면 각 버킷이 연속 구간이 되어 정렬도 세그먼트 버퍼도 필요 없다.
// 버킷마다 속도를 달리해 깊이가 다른 물살처럼 층이 진다.
//
// 색은 R 을 낮게 잡는다. 가산 합성에서는 채널 하나가 클립될 때까지 R:G:B 비율이 유지되므로,
// 수렴선처럼 여러 번 겹치는 픽셀에서 파랑을 지키려면 비율이 극단적이어야 한다.
// 26:91:143 은 포화 시 (46,162,255) 로 강한 시안블루가 되는 반면
// 124:198:255 는 G 까지 포화해 희끗한 흰색이 된다.
//
// 굵기는 전부 1.0 이하다. 실측: 34,000 세그먼트에서 폭 0.8 과 1.0 은 24.1 / 24.5ms 로
// 사실상 같은데(빠른 경로), 최대 1.35 가 섞이면 44.90ms 로 1.83배 뛴다. 1px 초과는
// 세그먼트마다 제대로 된 사각형 지오메트리를 만들어야 한다. 그래서 "어두운 층을 안개처럼"
// 은 굵기가 아니라 알파로 만든다 — 그건 공짜다.
const BUCKETS = [
  { color: '#0d2438', speed: 0.60, width: 1.00, alpha: 0.100 },   // 어두운 안개층
  { color: '#123a5e', speed: 0.74, width: 0.96, alpha: 0.085 },
  { color: '#1a5b8f', speed: 0.88, width: 0.92, alpha: 0.070 },
  { color: '#2685c4', speed: 1.04, width: 0.86, alpha: 0.055 },
  { color: '#4aacea', speed: 1.22, width: 0.80, alpha: 0.045 },
  { color: '#8ed4ff', speed: 1.44, width: 0.72, alpha: 0.040 },   // 빠르고 밝은 가는 실
];
const NB = BUCKETS.length;

// --- 마우스 바람 ---
const WIND_R = 150;             // CSS px
const WIND_GAIN = 0.55;         // 포인터 속도(CSS px/s) 에 곱해진다

// --- 길게 누르는 소용돌이 ---
const VORTEX_CHARGE = 1.4;      // s — 충전에 걸리는 시간
const VORTEX_R0 = 90;           // CSS px, charge 0
const VORTEX_R1 = 0.42;         // * min(w,h), charge 1
const VORTEX_S0 = 1.4;          // 강도, charge 0
const VORTEX_S1 = 5.2;          // 강도, charge 1
const VORTEX_BURST = 1.35;      // 놓는 순간의 방출 펄스
const VORTEX_UNWIND = 2.6;      // s — 놓은 뒤 서서히 풀리는 시간
const VORTEX_INFLOW = 0.22;     // 접선력 대비 구심력 비율 — 0 이면 순수 회전

// ============================================================================
// 난수 — xorshift32. Math.random 대신 쓰는 이유는 재현성(시드 로그로 장면 복원)이다.
// ============================================================================

let rngState = 0x9e3779b9;
function rnd() {
  let s = rngState;
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  rngState = s >>> 0;
  return rngState / 4294967296;
}

// ============================================================================
// 2D improved Perlin noise (Perlin 2002 의 6t^5-15t^4+10t^3 fade)
// 실측 2옥타브 79.0 ns/eval. 34000 입자 x 2옥타브 = 68,000 eval = 5.37ms/frame.
// 예산의 34% 지만 진짜 병목은 이게 아니라 드로우 콜이다(위 BUCKETS 주석 참고).
// ============================================================================

const PERM = new Uint8Array(512);
(function seedNoise() {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {                 // Fisher-Yates
    const j = (rnd() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function grad2(h, x, y) {
  switch (h & 7) {
    case 0: return  x + y;
    case 1: return  x - y;
    case 2: return -x + y;
    case 3: return -x - y;
    case 4: return  x;
    case 5: return -x;
    case 6: return  y;
    default: return -y;
  }
}

function perlin2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const X = xi & 255, Y = yi & 255;
  const u = fade(xf), v = fade(yf);
  const A = PERM[X] + Y, B = PERM[X + 1] + Y;
  const n00 = grad2(PERM[A],     xf,     yf);
  const n10 = grad2(PERM[B],     xf - 1, yf);
  const n01 = grad2(PERM[A + 1], xf,     yf - 1);
  const n11 = grad2(PERM[B + 1], xf - 1, yf - 1);
  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return a + v * (b - a);
}

// ============================================================================
// 상태
// ============================================================================

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

let w = 0, h = 0;               // CSS px — 작품이 쓰는 논리 좌표계
let scale = 1;                  // 백킹스토어 배율
let n = 0;                      // 입자 수
let bStart = new Int32Array(NB + 1);   // 버킷별 연속 구간 경계

let px, py;                     // 현재 위치 (CSS px)
let qx, qy;                     // 직전 위치 — 세그먼트의 시작점
let life;                       // 남은 수명 (s)

let raf = 0;
let lastMs = 0;
let t = 0;                      // 누적 시간 (s), dt 캡이 적용된 것

// --- 포인터 ---
// 이벤트는 원시 상태만 기록하고 프레임 경계에서 한 번 스냅샷한다.
// 한 프레임에 pointermove 가 여러 번 오면 속도가 왜곡되기 때문이다.
const raw = { x: -1e5, y: -1e5, down: false, active: false, pid: -1 };
const ptr = { x: -1e5, y: -1e5, vx: 0, vy: 0, active: false, down: false };
let lastPx = -1e5, lastPy = -1e5;

// --- 소용돌이 ---
const vortex = { on: false, releasing: false, x: 0, y: 0, charge: 0, out: 0 };

// ============================================================================
// 캔버스 리사이즈 + DPR
// ============================================================================

function resize() {
  const rect = canvas.getBoundingClientRect();
  const cw = Math.max(1, Math.round(rect.width));
  const ch = Math.max(1, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;

  scale = Math.min(dpr, 2, Math.sqrt(PX_CAP / (cw * ch)));
  let bw = Math.round(cw * scale), bh = Math.round(ch * scale);
  if (bw > MAX_DIM || bh > MAX_DIM) {
    const k = MAX_DIM / Math.max(bw, bh);
    scale *= k; bw = Math.round(bw * k); bh = Math.round(bh * k);
  }

  const first = (w === 0);
  canvas.width = bw;
  canvas.height = bh;
  // 이후 모든 좌표는 CSS px. 이 한 줄이 "반경 150px" 를 DPR 과 무관하게
  // 물리적으로 같은 크기로 만든다.
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  w = cw; h = ch;

  if (first) spawnAll();
  else refit();

  // 리사이즈는 백킹스토어를 재할당해 캔버스를 투명하게 비운다 -> 다시 검정으로 칠한다.
  paintBlack();
}

function paintBlack() {
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#050507';
  ctx.fillRect(0, 0, w, h);
}

// ============================================================================
// 입자
// ============================================================================

function countFor(cw, ch) {
  return Math.min(N_MAX, Math.max(N_MIN, Math.round((cw * ch) / AREA_PER_PARTICLE)));
}

function allocate(count) {
  n = count;
  px = new Float32Array(n); py = new Float32Array(n);
  qx = new Float32Array(n); qy = new Float32Array(n);
  life = new Float32Array(n);
  // 버킷을 인덱스로 균등 분할 -> 각 버킷이 연속 구간이라 draw 루프가 범위 순회면 된다.
  for (let b = 0; b <= NB; b++) bStart[b] = Math.round((b * n) / NB);
}

function place(i) {
  const x = rnd() * w, y = rnd() * h;
  px[i] = x; py[i] = y;
  qx[i] = x; qy[i] = y;          // 같은 점에서 시작 -> 첫 프레임에 긴 줄이 그려지지 않는다
  life[i] = LIFE_MIN + rnd() * (LIFE_MAX - LIFE_MIN);
}

function spawnAll() {
  allocate(countFor(w, h));
  for (let i = 0; i < n; i++) place(i);
}

// 리사이즈: 입자 수를 새 면적에 맞추고 기존 입자는 비율로 옮긴다.
// 전부 재배치하면 화면이 한 번 리셋된 것처럼 튄다.
function refit() {
  const want = countFor(w, h);
  if (want === n) {
    for (let i = 0; i < n; i++) {
      if (px[i] < 0 || px[i] > w || py[i] < 0 || py[i] > h) place(i);
    }
    return;
  }
  const oldN = n, oPx = px, oPy = py, oLife = life;
  allocate(want);
  for (let i = 0; i < n; i++) {
    if (i < oldN) {
      const x = Math.min(w, Math.max(0, oPx[i])), y = Math.min(h, Math.max(0, oPy[i]));
      px[i] = x; py[i] = y; qx[i] = x; qy[i] = y; life[i] = oLife[i];
    } else place(i);
  }
}

// ============================================================================
// 포인터
// ============================================================================

canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  raw.x = e.clientX - r.left;
  raw.y = e.clientY - r.top;
  raw.down = true; raw.active = true; raw.pid = e.pointerId;
  canvas.setPointerCapture(e.pointerId);   // 드래그가 캔버스를 벗어나도 유지
  vortex.on = true; vortex.releasing = false;
  vortex.x = raw.x; vortex.y = raw.y; vortex.charge = 0; vortex.out = 1;
});

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  raw.x = e.clientX - r.left;
  raw.y = e.clientY - r.top;
  raw.active = true;
});

canvas.addEventListener('pointerup', () => {
  raw.down = false;
  if (vortex.on) { vortex.on = false; vortex.releasing = true; vortex.out = VORTEX_BURST; }
});

canvas.addEventListener('pointercancel', () => {
  raw.down = false; raw.active = false;
  if (vortex.on) { vortex.on = false; vortex.releasing = true; vortex.out = VORTEX_BURST; }
});

canvas.addEventListener('pointerleave', () => { raw.active = false; });
canvas.addEventListener('pointerenter', () => { raw.active = true; });

function snapshotPointer(dt) {
  ptr.x = raw.x; ptr.y = raw.y;
  ptr.active = raw.active; ptr.down = raw.down;

  // vx/vy 는 CSS px per SECOND. 프레임당으로 두면 60Hz 와 120Hz 에서 바람 세기가 달라진다.
  if (lastPx > -9e4 && dt > 0) {
    const rx = (ptr.x - lastPx) / dt;
    const ry = (ptr.y - lastPy) / dt;
    ptr.vx += (rx - ptr.vx) * 0.25;          // 저역통과 — 이벤트 단위 지터 제거
    ptr.vy += (ry - ptr.vy) * 0.25;
  }
  lastPx = ptr.x; lastPy = ptr.y;

  // 감쇠가 없으면 커서가 멈춘 뒤 마지막 속도가 영구히 남아 바람이 영원히 분다.
  // 0.001^dt 는 약 70ms 반감.
  const decay = Math.pow(0.001, dt);
  ptr.vx *= decay; ptr.vy *= decay;
}

// ============================================================================
// 프레임
// ============================================================================

function frame(nowMs) {
  const elapsed = (nowMs - lastMs) / 1000;
  const dt = Math.min(DT_CAP, elapsed);
  const real = Math.min(REAL_CAP, elapsed);
  lastMs = nowMs;
  t += dt;

  snapshotPointer(dt);
  step(dt, real);
  draw();

  raf = requestAnimationFrame(frame);
}

function step(dt, real) {
  // --- 소용돌이 충전/방출 --- real 로 잰다(위 DT_CAP 주석 참고)
  if (vortex.on) {
    vortex.charge = Math.min(1, vortex.charge + real / VORTEX_CHARGE);
    vortex.out = 1;
  } else if (vortex.releasing) {
    // 놓으면 방출되어 서서히 풀린다
    vortex.out -= real * (VORTEX_BURST / VORTEX_UNWIND);
    if (vortex.out <= 0) { vortex.releasing = false; vortex.out = 0; vortex.charge = 0; }
  }

  const vActive = vortex.on || vortex.releasing;
  const vR = VORTEX_R0 + (Math.min(w, h) * VORTEX_R1 - VORTEX_R0) * vortex.charge;
  const vS = (VORTEX_S0 + (VORTEX_S1 - VORTEX_S0) * vortex.charge) * vortex.out;
  const vR2 = vR * vR;

  // --- 바람 ---
  const windOn = ptr.active && (ptr.vx !== 0 || ptr.vy !== 0);
  const wR2 = WIND_R * WIND_R;

  // 시간에 따라 장 자체가 천천히 표류한다
  const ox1 = t * DRIFT1, oy1 = t * DRIFT1 * 0.6;
  const ox2 = t * DRIFT2 * 0.5, oy2 = t * DRIFT2;

  for (let b = 0; b < NB; b++) {
    const spd = SPEED * BUCKETS[b].speed;
    const end = bStart[b + 1];

    for (let i = bStart[b]; i < end; i++) {
      const x = px[i], y = py[i];
      qx[i] = x; qy[i] = y;

      // 2옥타브 Perlin 을 각도로 읽는다
      const nz = perlin2((x + ox1) * F1, (y + oy1) * F1)
               + OCT2_AMP * perlin2((x + ox2) * F2, (y + oy2) * F2);
      const a = nz * TAU * WIND_TURNS;
      let ax = Math.cos(a) * spd;
      let ay = Math.sin(a) * spd;

      if (windOn) {
        const dx = x - ptr.x, dy = y - ptr.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < wR2) {
          const f = 1 - Math.sqrt(d2) / WIND_R;
          const ff = f * f * WIND_GAIN;
          ax += ptr.vx * ff;
          ay += ptr.vy * ff;
        }
      }

      if (vActive) {
        const dx = x - vortex.x, dy = y - vortex.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < vR2 && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const f = (1 - d / vR) * vS * spd;
          // 접선 + 약한 구심 — 순수 회전이면 고리 하나로 굳는다
          ax += (-dy / d) * f - (dx / d) * f * VORTEX_INFLOW;
          ay += ( dx / d) * f - (dy / d) * f * VORTEX_INFLOW;
        }
      }

      let nx = x + ax * dt, ny = y + ay * dt;

      life[i] -= dt;
      if (life[i] <= 0 || nx < -2 || nx > w + 2 || ny < -2 || ny > h + 2) {
        place(i);
      } else {
        px[i] = nx; py[i] = ny;
      }
    }
  }
}

function draw() {
  // 잔상: 캔버스를 지우지 않고 덮는다. 합성을 매 프레임 명시적으로 설정한다 —
  // lighter 가 덮기에 남아 있으면 페이드가 사라지고 5초 만에 순백이 된다(실측:
  // f100 에 청색 클립, f300 에 rgb(255,255,255)). 흔히 말하는 "덮기가 가산으로
  // 밝힌다" 는 설명은 틀렸다. 입자 0개로 2000프레임 돌려도 rgb(5,5,7) 에 머문다
  // (premultiplied 0.066*5 = 0.33 이 8비트에서 0 으로 양자화). 진짜 버그는 덮기가
  // 빼기를 멈추는 것이다.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = COVER;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'lighter';
  // butt 캡. round 는 34,000 세그먼트 x 양쪽 = 68,000 개 원형 캡을 래스터화해 1.70배 비싸고
  // (실측 76.10 vs 44.90ms), 세그먼트가 2~6px 이고 굵기가 1px 미만이면 눈으로 구별할 수 없다.
  ctx.lineCap = 'butt';

  for (let b = 0; b < NB; b++) {
    const end = bStart[b + 1];
    if (end <= bStart[b]) continue;
    const bk = BUCKETS[b];
    ctx.strokeStyle = bk.color;
    ctx.globalAlpha = bk.alpha;
    ctx.lineWidth = bk.width;

    // 버킷 전체를 하나의 path 로 모아 stroke() 를 한 번만 호출한다.
    // 입자별 beginPath/stroke 는 104.90ms, 이 형태는 48.55ms (실측 34,000 입자).
    ctx.beginPath();
    for (let i = bStart[b]; i < end; i++) {
      const x0 = qx[i], y0 = qy[i], x1 = px[i], y1 = py[i];
      if (x0 === x1 && y0 === y1) continue;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
  }

  // 다음 프레임의 덮기와 UI 가 알려진 상태에서 시작하도록 되돌린다.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

// ============================================================================
// 시작
// ============================================================================

function start() {
  resize();
  paintBlack();                 // setup 마지막에 한 번 검정 — 첫 프레임 흰 번쩍임 방지
  lastMs = performance.now();
  raf = requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
window.addEventListener('pagehide', () => { if (raf) cancelAnimationFrame(raf); raf = 0; });

start();

// 콘솔에서 상태를 들여다볼 수 있게. Phase 2b 의 리팩터 후에는 사라진다.
window.__currents = {
  info: () => ({ w, h, scale, n, t: +t.toFixed(2),
                 backing: [canvas.width, canvas.height],
                 vortex: { ...vortex } }),
};
