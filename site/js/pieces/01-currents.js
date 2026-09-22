// 01 — Whispering Currents / 속삭이는 해류
//
// 규칙: 벡터장의 각도는 노이즈에서 온다. 입자는 그 각도를 따라 흐르고, 화면은 지워지지 않아
// 지나간 자리가 빛으로 남는다.
//
// 엔진이 캔버스·DPR·RAF·시계·포인터를 소유한다. 이 파일은 setup() 과 frame(dt, t) 만 구현한다.
// document 를 직접 만지지 않는다 — 컨트롤은 controls(host) 의 팩토리로 만든다.

import { Piece, TAU, clamp, makeRng } from '../engine.js';

// --- 입자 ---
// 화면 면적에 비례해 6000~34000 으로 묶는다. 1920x1080 -> round(2073600/61) = 33,993.
const AREA_PER_PARTICLE = 61;
const N_MIN = 6000;
const N_MAX = 34000;

const LIFE_MIN = 2.2;           // s — 수명이 끝나면 재배치. 없으면 모든 입자가
const LIFE_MAX = 7.0;           //     수렴선으로 모여 화면이 몇 줄로 굳는다

// --- 벡터장 ---
const F1 = 0.0028;              // 1옥타브 주파수 (CSS px^-1) — 주기 약 360 CSS px
const F2 = 0.0079;              // 2옥타브 — 잔결
const OCT2_AMP = 0.5;
const WIND_TURNS = 2;           // 노이즈 [-1,1] -> 각도 몇 바퀴
const DRIFT1 = 7.5;             // 옥타브별 시간 표류 (CSS px/s) — 장 자체가 천천히 흐른다
const DRIFT2 = -13.0;

// --- 잔상 ---
// 캔버스를 지우지 않고 매 프레임 이 색으로 덮는다.
// 감쇠 0.934^n: 50% 10.15프레임(167ms), 10% 31프레임(517ms), 완전 소멸 75프레임(833ms).
const COVER = 'rgba(5,5,7,0.066)';

// --- 색 버킷 ---
// 입자별 strokeStyle 은 104.90ms, 색 6버킷(6회 stroke) 은 48.55ms, 단일 path 는 46.99ms.
// 즉 버킷 6개의 대가는 3% 뿐이라 색 다양성은 사실상 무료다. 대신 입자별 색은 2.2배 비싸다.
// 버킷을 입자 인덱스로 나누면 각 버킷이 연속 구간이 되어 정렬도 세그먼트 버퍼도 필요 없다.
//
// 색은 R 을 낮게 잡는다. 가산 합성에서는 채널 하나가 클립될 때까지 R:G:B 비율이 유지되므로,
// 수렴선처럼 여러 번 겹치는 픽셀에서 파랑을 지키려면 비율이 극단적이어야 한다.
// 26:91:143 은 포화 시 (46,162,255) 로 강한 시안블루가 되는 반면
// 124:198:255 는 G 까지 포화해 희끗한 흰색이 된다.
//
// 굵기는 전부 1.0 이하다. 실측: 34,000 세그먼트에서 폭 0.8 과 1.0 은 24.1 / 24.5ms 로
// 사실상 같은데(빠른 경로), 최대 1.35 가 섞이면 44.90ms 로 1.83배 뛴다.
// 그래서 "어두운 층을 안개처럼" 은 굵기가 아니라 알파로 만든다 — 그건 공짜다.
//
// 알파는 버킷별이고, 어느 버킷도 최대 채널 침전이 ~10 을 넘지 않게 맞췄다. 가산 합성의
// 클립 임계는 채널당 프레임당 (255-5)*0.066 = 16.5 이므로 1.6배 겹침 여유가 남는다.
// alpha 0.30 이면 한 번 맞을 때 76 을 침전시켜 임계의 4.6배 — 수렴선이 4프레임 만에
// #ffffff 로 클립되어 색 정보가 전부 날아간다.
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
const VORTEX_INFLOW = 0.22;     // 접선력 대비 구심력 비율 — 0 이면 고리 하나로 굳는다

export default class Currents extends Piece {
  setup() {
    this.bg = '#050507';
    this.rnd = makeRng(0x9e3779b9);
    this.speed = this.speed ?? 62;   // CSS px/s. 프레임당 세그먼트 길이 = speed * 배수 * dt.
    this._buildNoise();
    this.vortex = { on: false, releasing: false, x: 0, y: 0, charge: 0, out: 0 };
    this.bStart = new Int32Array(NB + 1);
    this._allocate(this._countFor(this.w, this.h));
    for (let i = 0; i < this.n; i++) this._place(i);
  }

  // ---------------------------------------------------- 2옥타브 Perlin 노이즈
  // 실측 2옥타브 79.0 ns/eval. 34000 입자 x 2옥타브 = 68,000 eval = 5.37ms/frame.
  // 예산의 34% 지만 진짜 병목은 이게 아니라 드로우 콜이다(위 BUCKETS 주석 참고).
  // 순열 테이블은 작품마다 자기 rng 로 만든다 — 엔진이 공유하면 한 작품의 난수 소비가
  // 다른 작품의 장면을 바꾸는 결합이 생긴다.

  _buildNoise() {
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {                 // Fisher-Yates
      const j = (this.rnd() * (i + 1)) | 0;
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    const p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    this.perm = p;
  }

  _perlin2(x, y) {
    const P = this.perm;
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const A = P[X] + Y, B = P[X + 1] + Y;
    const n00 = grad2(P[A],     xf,     yf);
    const n10 = grad2(P[B],     xf - 1, yf);
    const n01 = grad2(P[A + 1], xf,     yf - 1);
    const n11 = grad2(P[B + 1], xf - 1, yf - 1);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return a + v * (b - a);
  }

  // ------------------------------------------------------------------- 입자

  _countFor(cw, ch) {
    const base = clamp(Math.round((cw * ch) / AREA_PER_PARTICLE), N_MIN, N_MAX);
    // budgetScale 은 프리뷰 캔버스와 자동 감쇠가 쓰는 손잡이다. 프리뷰(260x160)에서
    // 6000 하한을 그대로 지키면 2.557ms 인데 면적 비례 1049 는 0.487ms 다(5.3배).
    return Math.max(300, Math.round(base * this.budgetScale));
  }

  _allocate(count) {
    this.n = count;
    this.px = new Float32Array(count); this.py = new Float32Array(count);
    this.qx = new Float32Array(count); this.qy = new Float32Array(count);
    this.life = new Float32Array(count);
    for (let b = 0; b <= NB; b++) this.bStart[b] = Math.round((b * count) / NB);
  }

  _place(i) {
    const x = this.rnd() * this.w, y = this.rnd() * this.h;
    this.px[i] = x; this.py[i] = y;
    this.qx[i] = x; this.qy[i] = y;     // 같은 점에서 시작 -> 첫 프레임에 긴 줄이 그려지지 않는다
    this.life[i] = LIFE_MIN + this.rnd() * (LIFE_MAX - LIFE_MIN);
  }

  // 리사이즈: 입자 수를 새 면적에 맞추고 기존 입자는 비율로 옮긴다.
  // 전부 재배치하면 화면이 한 번 리셋된 것처럼 튄다.
  onResize() {
    const want = this._countFor(this.w, this.h);
    if (want === this.n) {
      for (let i = 0; i < this.n; i++) {
        if (this.px[i] < 0 || this.px[i] > this.w || this.py[i] < 0 || this.py[i] > this.h) {
          this._place(i);
        }
      }
      return;
    }
    const oldN = this.n, oPx = this.px, oPy = this.py, oLife = this.life;
    this._allocate(want);
    for (let i = 0; i < this.n; i++) {
      if (i < oldN) {
        const x = clamp(oPx[i], 0, this.w), y = clamp(oPy[i], 0, this.h);
        this.px[i] = x; this.py[i] = y; this.qx[i] = x; this.qy[i] = y; this.life[i] = oLife[i];
      } else this._place(i);
    }
  }

  // --------------------------------------------------------------- 인터랙션

  onPointerDown() {
    const p = this.pointer, v = this.vortex;
    v.on = true; v.releasing = false;
    v.x = p.x; v.y = p.y; v.charge = 0; v.out = 1;
  }

  onPointerUp() {
    const v = this.vortex;
    if (!v.on) return;
    v.on = false; v.releasing = true; v.out = VORTEX_BURST;
  }

  controls(host) {
    host.slider('흐름 속도 / flow', 20, 140, this.speed, 2, (x) => { this.speed = x; });
    host.button('해류 다시 그리기 / reseed', () => {
      this.rnd = makeRng((Math.round(this.t * 1e6) ^ 0x5bf03635) | 1);
      this._buildNoise();
      for (let i = 0; i < this.n; i++) this._place(i);
    });
  }

  // -------------------------------------------------------------------- 프레임

  frame(dt, t) {
    const g = this.ctx, w = this.w, h = this.h, p = this.pointer, v = this.vortex;

    // --- 소용돌이 충전/방출 ---
    // this.real(엔진이 주는 실경과, 0.25s 캡)로 잰다. dt 로 재면 프레임이 116ms 인 기계에서
    // "1.4초 충전" 이 3.3초가 된다(0.05/0.117 = 0.43, 실측 비율과 일치).
    const real = this.real;
    if (v.on) {
      v.charge = Math.min(1, v.charge + real / VORTEX_CHARGE);
      v.out = 1;
    } else if (v.releasing) {
      v.out -= real * (VORTEX_BURST / VORTEX_UNWIND);
      if (v.out <= 0) { v.releasing = false; v.out = 0; v.charge = 0; }
    }

    const vActive = v.on || v.releasing;
    const vR = VORTEX_R0 + (Math.min(w, h) * VORTEX_R1 - VORTEX_R0) * v.charge;
    const vS = (VORTEX_S0 + (VORTEX_S1 - VORTEX_S0) * v.charge) * v.out;
    const vR2 = vR * vR;

    const windOn = p.active && (p.vx !== 0 || p.vy !== 0);
    const wR2 = WIND_R * WIND_R;

    // 시간에 따라 장 자체가 천천히 표류한다
    const ox1 = t * DRIFT1, oy1 = t * DRIFT1 * 0.6;
    const ox2 = t * DRIFT2 * 0.5, oy2 = t * DRIFT2;

    const px = this.px, py = this.py, qx = this.qx, qy = this.qy, life = this.life;
    const bStart = this.bStart;

    for (let b = 0; b < NB; b++) {
      const spd = this.speed * BUCKETS[b].speed;
      const end = bStart[b + 1];

      for (let i = bStart[b]; i < end; i++) {
        const x = px[i], y = py[i];
        qx[i] = x; qy[i] = y;

        // 2옥타브 Perlin 을 각도로 읽는다
        const nz = this._perlin2((x + ox1) * F1, (y + oy1) * F1)
                 + OCT2_AMP * this._perlin2((x + ox2) * F2, (y + oy2) * F2);
        const a = nz * TAU * WIND_TURNS;
        let ax = Math.cos(a) * spd;
        let ay = Math.sin(a) * spd;

        if (windOn) {
          const dx = x - p.x, dy = y - p.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < wR2) {
            const f = 1 - Math.sqrt(d2) / WIND_R;
            const ff = f * f * WIND_GAIN;
            ax += p.vx * ff;
            ay += p.vy * ff;
          }
        }

        if (vActive) {
          const dx = x - v.x, dy = y - v.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < vR2 && d2 > 1e-4) {
            const d = Math.sqrt(d2);
            const f = (1 - d / vR) * vS * spd;
            // 접선 + 약한 구심 — 순수 회전이면 고리 하나로 굳는다
            ax += (-dy / d) * f - (dx / d) * f * VORTEX_INFLOW;
            ay += ( dx / d) * f - (dy / d) * f * VORTEX_INFLOW;
          }
        }

        const nx = x + ax * dt, ny = y + ay * dt;

        life[i] -= dt;
        if (life[i] <= 0 || nx < -2 || nx > w + 2 || ny < -2 || ny > h + 2) {
          this._place(i);
        } else {
          px[i] = nx; py[i] = ny;
        }
      }
    }

    // --- 그리기 ---
    // 잔상: 캔버스를 지우지 않고 덮는다. 합성을 매 프레임 명시적으로 설정한다 —
    // lighter 가 덮기에 남아 있으면 페이드가 사라지고 5초 만에 순백이 된다(실측:
    // f100 에 청색 클립, f300 에 rgb(255,255,255)). 흔히 말하는 "덮기가 가산으로 밝힌다"
    // 는 설명은 틀렸다: 입자 0개로 2000프레임 돌려도 rgb(5,5,7) 에 머문다
    // (premultiplied 0.066*5 = 0.33 이 8비트에서 0 으로 양자화). 진짜 버그는 덮기가
    // 빼기를 멈추는 것이다.
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = COVER;
    g.fillRect(0, 0, w, h);

    g.globalCompositeOperation = 'lighter';
    // butt 캡. round 는 34,000 세그먼트 x 양쪽 = 68,000 원형 캡이라 1.70배 비싸고
    // (실측 76.10 vs 44.90ms), 세그먼트가 2~6px 이고 굵기가 1px 미만이면 구별할 수 없다.
    g.lineCap = 'butt';

    for (let b = 0; b < NB; b++) {
      const end = bStart[b + 1];
      if (end <= bStart[b]) continue;
      const bk = BUCKETS[b];
      g.strokeStyle = bk.color;
      g.globalAlpha = bk.alpha;
      g.lineWidth = bk.width;

      // 버킷 전체를 하나의 path 로 모아 stroke() 를 한 번만 호출한다.
      g.beginPath();
      for (let i = bStart[b]; i < end; i++) {
        const x0 = qx[i], y0 = qy[i], x1 = px[i], y1 = py[i];
        if (x0 === x1 && y0 === y1) continue;
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
      }
      g.stroke();
    }
    // 엔진이 frame() 직후 합성/알파를 되돌리지만, 이 작품은 명시적으로도 되돌려
    // 파일만 읽어도 상태가 닫힌 것이 보이게 한다.
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }
}

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
