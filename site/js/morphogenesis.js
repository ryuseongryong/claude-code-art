// 02 — Morphogenesis / 형태발생
//
// Gray-Scott 반응-확산. 두 화학종 U(먹이)와 V(자가촉매)가 서로 다른 속도로 확산하며
// V + 2U -> 3V 로 반응한다. 그 비대칭이 Turing 무늬를 만든다.
//
// PHASE 2a: 일부러 currents.js 와 공통 코드를 공유하지 않는다. 캔버스 셋업, DPR,
// RAF 루프, dt/t 시계, 포인터 처리를 그대로 다시 썼다. 두 파일을 나란히 놓고 무엇이
// 중복인지 눈으로 확인하는 것이 목적이다. Phase 2b 에서 engine.js 로 추출한다.
//
// 코드 모양이 작품 01 과 정반대가 되도록 의도했다:
//   01 은 고정 개수의 float 입자가 무상태 벡터장을 따라 흐르고 획으로 그려진다.
//   02 는 고정 크기 Float32Array 격자가 이중 버퍼로 PDE 를 돌고 ImageData 로 그려진다.

// ============================================================================
// 상수
// ============================================================================

// --- 시계 ---
// 작품 01 과 같은 이유로 두 개다. dt 는 물리/포인터용(1/20초 캡), real 은 UI 타이밍용.
// 다만 이 작품의 반응-확산은 스펙대로 dt 를 상수에 접어넣어 1 로 두고 프레임당 고정
// 8스텝을 돈다 — 그래서 dt 는 포인터 속도 정규화에만 쓰인다.
const DT_CAP = 1 / 20;
const REAL_CAP = 0.25;

// --- 격자 ---
// 화면보다 거칠게 잡고 ImageData 로 그려 부드럽게 확대한다.
// 1920x1080 -> round(2073600/26) = 79,754 칸 ~ 스펙의 "약 8만 칸".
const AREA_PER_CELL = 26;
const CELL_MIN = 4000;
const CELL_MAX = 80000;

// --- Gray-Scott ---
// Du/Dv 는 스펙의 0.16/0.08 에서 바꿨다(승인됨). 아래 네 F/k 프리셋은 Karl Sims
// 튜토리얼 값이고, 그 값들은 이 커널 + dt=1 + dA=1.0/dB=0.5 로 교정된 것이다.
// 0.16/0.08 은 정확히 그 0.16배여서 실측 결과:
//   - 무늬 폭이 2~3셀(자기상관 첫 영점 d=3~4)로 격자에 고착 -> 확대하면 흐린 디더
//   - mitosis 와 leopard 가 Pearson r=0.9204 로 같은 그림 (프리셋 4개, 보이는 건 3가지)
//   - 변화가 0.10~0.21초 만에 95% 종료 -> 관람객이 자라는 것을 볼 수 없다
//   - 최종 피복률이 F/k 가 아니라 씨앗 밀도에 좌우된다
// 1.0/0.5 는 여전히 수치적으로 안정하다: 커널의 Fourier 심볼 범위가 [-1.6, 0] 이고
// (최소는 체커보드 (pi,pi)) 명시적 Euler 조건은 dt*D <= 2/1.6 = 1.25 다.
// Du=1.0 -> 증폭 |1 - 1.0*1.6| = 0.6 < 1. 4000스텝에서 NaN/Inf 0회.
const DU = 1.0;
const DV = 0.5;

// 3x3 라플라시안: 중심 -1, 직교 0.2, 대각 0.05.
// 합 = -1 + 4*0.2 + 4*0.05 = 0 (실측 5.55e-17, IEEE-754 반올림 잔차).
// 합이 0 인 것은 load-bearing 이다. 한 가중치를 건드려 합을 +0.05 로 만들면 20000스텝 후
// min=Infinity, -0.05 면 8.7e-44 (장 전체 소멸). 합이 0 이 아니면 확산 연산자가 아니라
// 균일 지수 이득/감쇠 항이 된다.
// 이 커널은 표준 등방 9점 스텐실 (1/6)*[[1,4,1],[4,-20,4],[1,4,1]] 의 정확히 0.3배다.
const K_ORTHO = 0.2;
const K_DIAG = 0.05;

const STEPS = 8;                // 프레임당 스텝 수

const PRESETS = [
  { key: '1', name: '세포분열', en: 'Mitosis', F: 0.0367, k: 0.0649 },
  { key: '2', name: '산호',     en: 'Coral',   F: 0.0545, k: 0.0620 },
  { key: '3', name: '표범',     en: 'Leopard', F: 0.0350, k: 0.0650 },
  { key: '4', name: '미로',     en: 'Maze',    F: 0.0290, k: 0.0570 },
];

// --- 씨앗 ---
// U=1, V=0 은 고정점이다. 씨앗을 잘못 고르면 검은 화면이거나 얼어붙은 정지 화면이다.
// 실측(320x250, 4000스텝):
//   중앙 20x20 정사각형 -> 피복 0.11~0.32%, bit-exact 고정점(3000스텝에서 max|dV|=0.000e+0)
//   iid 노이즈 V~U(0,0.5) -> 네 프리셋 전부 사망 (Vstd=0.0000)
//   꽉 찬 블롭 12개 r=6  -> mitosis, leopard 사망
//   희소 스페클 p=0.5%   -> 네 프리셋 전부 생존, 가장 긴 관람 가능 onset
// 그래서 희소 스페클이다. 블롭도 균일 노이즈도 아니다.
const SEED_P = 0.005;

// --- 붓 ---
// "끌면 V 를 붓처럼 심는다". 단 꽉 찬 원반은 무늬를 죽인다 — 내부가 공간적으로 균일하면
// Turing 불안정성이 없어 U 를 고갈시키고 블록째 붕괴한다. 실측: mitosis 와 leopard 는
// 반경 8셀 이상이면 진폭(0.25/0.5/1.0)·감쇠(hard/linear) 무관하게 매번 사망(18/18).
// 스페클 붓은 r=16 밀도 0.15 에서 네 프리셋 모두 자란다.
const BRUSH_R_CSS = 30;         // CSS px
const BRUSH_DENSITY = 0.2;      // 반경 안에서 씨앗이 되는 셀의 비율

// --- 색 ---
// V 의 최대는 프리셋별로 0.35~0.47 뿐이고 중위값은 0.013~0.15 다. 그래서 naive 255*v 는
// 최대 바이트 89~121, 평균 17~42 로 어두운 배경에서 희미한 회색 얼룩이 된다.
// smoothstep(0.05, 0.34) 로 펴면 픽셀당 표준편차가 25~39 -> 83~115 바이트로 오른다.
// 정규화는 프리셋 공통이다 — 프리셋별로 하면 프리셋 간 실제 차이를 숨기고,
// 과도 구간에서 vmax 가 흔들려 색이 펄럭인다.
// 상한은 0.40 이다. 감사가 권한 0.34 는 픽셀당 표준편차(대비)를 최대화하지만, V 분포가
// 본질적으로 이봉형이라(배경 ~0, 무늬 몸통 0.37~0.43) 몸통 전체가 램프 정점으로 클립되어
// 색이 납작해진다. 0.40 이면 정점은 가장 밝은 심부만 차지하고 몸통은 램프 중상단에 앉는다.
const V_LO = 0.05;
const V_HI = 0.40;

// life 관의 톤: --bg -> 거의 검은 이끼 -> 옥 -> accent.
// accent(#8fe39a) 를 램프의 정점에만 둔다. 중간에 두면 무늬의 몸통 전체가 accent 색이 되어
// 미술관 벽이 아니라 스크린세이버로 읽힌다(밝은 램프로 먼저 시도했다가 되돌렸다).
// 램프는 곧 작품이다 — 밝히면 표본이 아니라 네온이 된다.
const RAMP = [
  [0.00, 0x0a, 0x0b, 0x0f],
  [0.30, 0x0d, 0x24, 0x19],
  [0.58, 0x1e, 0x5c, 0x3e],
  [0.82, 0x4a, 0xa8, 0x6e],
  [1.00, 0x8f, 0xe3, 0x9a],     // life 관 accent — 정점에만
];

// ============================================================================
// 난수 — xorshift32. 작품 01 과 같은 이유(재현성)로 Math.random 을 쓰지 않는다.
// ============================================================================

let rngState = 0x6d2b79f5;
function rnd() {
  let s = rngState;
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  rngState = s >>> 0;
  return rngState / 4294967296;
}

// ============================================================================
// 상태
// ============================================================================

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

let w = 0, h = 0;               // CSS px
let GW = 0, GH = 0, NC = 0;     // 격자 크기와 칸 수

let u, v, u2, v2;               // Float32Array 이중 버퍼
let img = null;                 // ImageData(GW, GH)
const LUT = new Uint8ClampedArray(256 * 3);

let preset = 0;

let raf = 0;
let lastMs = 0;
let t = 0;                      // 누적 시간 (s)
let steps = 0;                  // 누적 스텝 — 무늬 성숙도의 척도

// --- 포인터 ---
// 이벤트는 원시 상태만 기록하고 프레임 경계에서 한 번 스냅샷한다.
const raw = { x: -1e5, y: -1e5, down: false, active: false, pid: -1 };
const ptr = { x: -1e5, y: -1e5, vx: 0, vy: 0, active: false, down: false };
let lastPx = -1e5, lastPy = -1e5;

// ============================================================================
// 캔버스 리사이즈 + DPR
// ============================================================================

function resize() {
  const rect = canvas.getBoundingClientRect();
  const cw = Math.max(1, Math.round(rect.width));
  const ch = Math.max(1, Math.round(rect.height));

  // 작품 01 은 여기서 DPR 을 읽어 백킹스토어를 CSS x scale 로 잡는다.
  // 이 작품은 다르다: 백킹스토어를 격자 크기로 잡고 CSS 가 늘리게 한다.
  // 실측 이유 — 320x250 -> 1920x1080 을 JS 로 확대하면
  //   imageSmoothingQuality 'high' 111.05ms / 'medium' 62.88 / 'low' 16.38 / off 3.28
  // 인데 물리 8스텝은 12.42ms 다. 즉 'high' 는 물리의 9배다.
  // 백킹스토어를 격자로 두면 컴포지터가 GPU 에서 bilinear 를 무료로 해준다: 0.07ms, 1586배.
  // (putImageData 는 스케일되지 않는다 — ctx.scale(8,8) 후에도 8x8 만 덮는다. 실측.)
  const cells = Math.min(CELL_MAX, Math.max(CELL_MIN, Math.round((cw * ch) / AREA_PER_CELL)));
  const gw = Math.max(16, Math.round(Math.sqrt(cells * cw / ch)));
  const gh = Math.max(16, Math.round(cells / gw));

  const first = (GW === 0);
  const changed = (gw !== GW || gh !== GH);

  w = cw; h = ch;

  if (changed) {
    const oldU = u, oldV = v, oGW = GW, oGH = GH;
    GW = gw; GH = gh; NC = GW * GH;
    canvas.width = GW;
    canvas.height = GH;
    // transform 은 항등이다 — 이 작품의 그리기 단위는 격자 칸이다.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;   // putImageData 는 어차피 스케일하지 않는다
    img = ctx.createImageData(GW, GH);
    u = new Float32Array(NC); v = new Float32Array(NC);
    u2 = new Float32Array(NC); v2 = new Float32Array(NC);
    if (first || !oldU) seed();
    else resample(oldU, oldV, oGW, oGH);
  }

  paintBg();
}

function paintBg() {
  // 첫 프레임 전에도 배경색 — 흰 번쩍임 방지. 이 작품은 매 프레임 전면 ImageData 를
  // 쓰므로 이후로는 필요 없다.
  ctx.fillStyle = '#0a0b0f';
  ctx.fillRect(0, 0, GW, GH);
}

// 리사이즈로 격자 크기가 바뀌면 기존 무늬를 최근접으로 재표본한다.
// 다시 파종하면 몇 초간 자란 무늬가 사라져 리셋된 것처럼 보인다.
function resample(oldU, oldV, oGW, oGH) {
  for (let y = 0; y < GH; y++) {
    const sy = Math.min(oGH - 1, (y * oGH / GH) | 0) * oGW;
    const dy = y * GW;
    for (let x = 0; x < GW; x++) {
      const sx = Math.min(oGW - 1, (x * oGW / GW) | 0);
      u[dy + x] = oldU[sy + sx];
      v[dy + x] = oldV[sy + sx];
    }
  }
}

// ============================================================================
// 격자
// ============================================================================

function seed() {
  u.fill(1); v.fill(0);
  // 희소 스페클. 꽉 찬 블롭이나 균일 노이즈로 바꾸면 무늬가 죽거나 얼어붙는다
  // (위 SEED_P 주석의 실측 표 참고).
  for (let i = 0; i < NC; i++) if (rnd() < SEED_P) v[i] = 1;
  steps = 0;
}

function buildLUT() {
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let s = 0;
    while (s < RAMP.length - 2 && x > RAMP[s + 1][0]) s++;
    const a = RAMP[s], b = RAMP[s + 1];
    const f = (x - a[0]) / (b[0] - a[0] || 1);
    LUT[i * 3]     = a[1] + (b[1] - a[1]) * f;
    LUT[i * 3 + 1] = a[2] + (b[2] - a[2]) * f;
    LUT[i * 3 + 2] = a[3] + (b[3] - a[3]) * f;
  }
}
buildLUT();

// 반응-확산 한 스텝. dt 는 상수에 접어넣어 1 이라 곱셈이 없다.
// 인덱스 산술은 분기 wrap + 행 오프셋 호이스팅이다. 오프셋 테이블(Int32Array)은 쓰지 않는다
// — 실측 2% 손해(19.45 -> 19.79 ms/step 상당). V8 이 이미 정수 modulo 를 strength-reduce 한다.
// 진짜 이득은 Float32 vs Float64 = 1.77배인데 그건 이미 타입 선택에 들어 있다.
function step(F, k) {
  const gw = GW, gh = GH;
  for (let y = 0; y < gh; y++) {
    const rowM = (y === 0 ? gh - 1 : y - 1) * gw;
    const rowP = (y === gh - 1 ? 0 : y + 1) * gw;
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      const xm = x === 0 ? gw - 1 : x - 1;
      const xp = x === gw - 1 ? 0 : x + 1;
      const i = row + x;

      const a = u[i], b = v[i];

      const lu = (u[row + xm] + u[row + xp] + u[rowM + x] + u[rowP + x]) * K_ORTHO
               + (u[rowM + xm] + u[rowM + xp] + u[rowP + xm] + u[rowP + xp]) * K_DIAG
               - a;
      const lv = (v[row + xm] + v[row + xp] + v[rowM + x] + v[rowP + x]) * K_ORTHO
               + (v[rowM + xm] + v[rowM + xp] + v[rowP + xm] + v[rowP + xp]) * K_DIAG
               - b;

      const abb = a * b * b;
      u2[i] = a + DU * lu - abb + F * (1 - a);
      v2[i] = b + DV * lv + abb - (F + k) * b;
    }
  }
  // 이중 버퍼 교환
  let tu = u; u = u2; u2 = tu;
  let tv = v; v = v2; v2 = tv;
  steps++;
}

// 스페클 붓. 반경 안의 셀 일부만 V=1 로 심는다. U 는 건드리지 않는다.
function paint(cx, cy) {
  const r = Math.max(1.5, BRUSH_R_CSS / w * GW);
  const r2 = r * r;
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) {
    const yy = ((y % GH) + GH) % GH;          // 경계는 wrap — 시뮬레이션과 같게
    const row = yy * GW;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      if (rnd() >= BRUSH_DENSITY) continue;
      const xx = ((x % GW) + GW) % GW;
      v[row + xx] = 1;
    }
  }
}

function render() {
  const d = img.data;
  const inv = 1 / (V_HI - V_LO);
  for (let i = 0, p = 0; i < NC; i++, p += 4) {
    // smoothstep
    let s = (v[i] - V_LO) * inv;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    s = s * s * (3 - 2 * s);
    const q = (s * 255) | 0;
    const j = q * 3;
    d[p] = LUT[j]; d[p + 1] = LUT[j + 1]; d[p + 2] = LUT[j + 2]; d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
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
});

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  raw.x = e.clientX - r.left;
  raw.y = e.clientY - r.top;
  raw.active = true;
});

canvas.addEventListener('pointerup', () => { raw.down = false; });
canvas.addEventListener('pointercancel', () => { raw.down = false; raw.active = false; });
canvas.addEventListener('pointerleave', () => { raw.active = false; });
canvas.addEventListener('pointerenter', () => { raw.active = true; });

function snapshotPointer(dt) {
  ptr.x = raw.x; ptr.y = raw.y;
  ptr.active = raw.active; ptr.down = raw.down;

  // vx/vy 는 CSS px per SECOND. 프레임당으로 두면 60Hz 와 120Hz 에서 세기가 달라진다.
  if (lastPx > -9e4 && dt > 0) {
    const rx = (ptr.x - lastPx) / dt;
    const ry = (ptr.y - lastPy) / dt;
    ptr.vx += (rx - ptr.vx) * 0.25;
    ptr.vy += (ry - ptr.vy) * 0.25;
  }
  lastPx = ptr.x; lastPy = ptr.y;

  // 감쇠가 없으면 커서가 멈춘 뒤 마지막 속도가 영구히 남는다. 0.001^dt 는 약 70ms 반감.
  const decay = Math.pow(0.001, dt);
  ptr.vx *= decay; ptr.vy *= decay;
}

window.addEventListener('keydown', (e) => {
  const i = PRESETS.findIndex((p) => p.key === e.key);
  if (i >= 0) { preset = i; return; }        // F/k 만 바꾼다 — 자란 무늬가 눈앞에서 변형된다
  if (e.key === 'r' || e.key === 'R') seed();
});

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

  // 끌면 V 를 심는다. 격자 좌표로 환산한다 — 격자는 캔버스보다 약 4.5배 거칠다.
  if (ptr.down && ptr.active) {
    paint(ptr.x / w * GW, ptr.y / h * GH);
  }

  const p = PRESETS[preset];
  for (let s = 0; s < STEPS; s++) step(p.F, p.k);

  render();

  raf = requestAnimationFrame(frame);
}

// ============================================================================
// 시작
// ============================================================================

function start() {
  resize();
  paintBg();
  lastMs = performance.now();
  raf = requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
window.addEventListener('pagehide', () => { if (raf) cancelAnimationFrame(raf); raf = 0; });

start();

window.__morpho = {
  info: () => ({ w, h, grid: [GW, GH], cells: NC, t: +t.toFixed(2), steps,
                 preset: PRESETS[preset].en,
                 backing: [canvas.width, canvas.height] }),
  stats: () => {
    let mn = Infinity, mx = -Infinity, sum = 0, sum2 = 0, bad = 0;
    for (let i = 0; i < NC; i++) {
      const x = v[i];
      if (!Number.isFinite(x)) { bad++; continue; }
      if (x < mn) mn = x; if (x > mx) mx = x;
      sum += x; sum2 += x * x;
    }
    const mean = sum / NC;
    return { vMin: +mn.toFixed(4), vMax: +mx.toFixed(4), vMean: +mean.toFixed(4),
             vStd: +Math.sqrt(Math.max(0, sum2 / NC - mean * mean)).toFixed(4), nonFinite: bad };
  },
  seed: () => seed(),
  setPreset: (i) => { preset = i; },
};
