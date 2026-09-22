// 03 — Gravity Garden / 중력 정원
//
// 규칙: 보이지 않는 인력점 몇 개가 궤도를 정한다. 색은 궤도 반지름이 결정하고,
// 반지름이 바뀌면 색도 바뀐다.
//
// 코드 모양은 작품 01 과 같은 계열(고정 개수 입자)이지만 장이 다르다: 01 은 무상태
// 노이즈장을 따라 흐르고, 03 은 몇 개의 인력점에 대한 O(N x A) 힘 합으로 가속된다.
// 그래서 01 은 위치만 적분하고 03 은 속도까지 적분한다(궤도는 속도의 기억이다).

import { Piece, TAU, clamp, makeRng } from '../engine.js';

// --- 입자 ---
// 실측(1920x1080, 인력점 5개, 완전 O(N x A) 힘 루프 + 잔상 덮기, 인터리브 3패스 최소값):
//   N=400  입자별 strokeStyle 2.21ms / 16버킷 1.69ms
//   N=800                      3.78ms /        2.74ms
//   N=1600                     6.76ms /        4.69ms
// 모든 구성이 16.6ms 에 여유롭게 들어간다. 1920x1080 -> round(2073600/2600) = 798.
const AREA_PER_PARTICLE = 1500;
const N_MIN = 240;
const N_MAX = 1400;

// --- 인력점 ---
const ATTRACTORS = 5;
// 중력 상수. 단위를 역산해서 정한다 — 감으로 잡으면 830배 틀린다(실제로 그랬다).
// 원궤도 속도는 v = sqrt(G*m*r^2/(r^2+soft^2)^1.5) 다.
// r=200, soft=46, m=1 에서 v 를 120 CSS px/s 로 두려면
//   v^2 = G*40000/8.64e6  ->  G = 14400*8.64e6/40000 = 3.11e6
// 이게 프레임당 2px 세그먼트가 되어 1.1초 잔상에서 130px 짜리 호(弧)로 읽힌다.
// G=2600 으로 뒀을 때는 v=3.5 px/s = 프레임당 0.06px 여서 입자가 사실상 정지했고,
// 중력이 천천히 전부를 인력점으로 끌어모아 궤도가 아니라 먼지가 됐다.
// 60fps·NaN 0·메모리 정상 — 지표는 전부 초록인데 작품은 죽어 있었다.
const G = 3.2e6;
const SOFT = 46;                // CSS px — 특이점 제거. r=0 에서 힘이 무한이 되지 않게.
const MASS_MIN = 0.7;
const MASS_MAX = 1.5;
const DRIFT = 9;                // 인력점이 아주 천천히 표류한다 (CSS px/s)
const INSET = 0.18;             // 인력점을 화면 안쪽에 둔다 (변 길이 비율)

// --- 궤도 ---
const DAMP = 0.06;              // 1/s — 약한 감쇠. 없으면 에너지가 쌓여 전부 탈출한다.
const V_MAX_K = 2.2;            // 국소 원궤도 속도의 이 배를 넘으면 자른다

// --- 산란 ---
const SCATTER_R = 0.18;         // * min(w,h)
const SCATTER_K = 1700;         // CSS px/s^2 — 밀어내는 가속도
const RETURN_K = 0.55;          // 1/s — 멀어지면 궤도로 복귀하는 세기

// --- 잔상 ---
// 작품 01 과 같은 미청소 세척이지만 감쇠가 훨씬 느리다. 감쇠 0.965^n:
// 50% 19프레임(0.33s), 10% 65프레임(1.1s). 궤도가 혜성 꼬리처럼 호(弧)로 남는다.
const COVER = 'rgba(6,7,12,0.035)';

// --- 색: 궤도 반지름 그라디언트 ---
// 반지름을 16버킷으로 양자화한다. 입자별 strokeStyle 은 1.31~1.44배 비싸고(실측),
// 작품 01 에서 배운 교훈을 작은 규모로 반복할 이유가 없다.
// 가산 합성이므로 R 을 낮게 잡는다 — 채널 하나가 클립될 때까지 R:G:B 비율이 유지된다.
const BUCKETS = 16;
// 안쪽(빠르고 뜨거운) -> 바깥쪽(느리고 찬). flow 관 accent #7cc6ff 를 중간에 둔다.
const RAMP = [
  [0.00, 0xff, 0xe4, 0xb0],     // 중심부: 흰 금색
  [0.22, 0xff, 0xb4, 0x7c],
  [0.45, 0x7c, 0xc6, 0xff],     // flow 관 accent
  [0.72, 0x2f, 0x6d, 0xc4],
  [1.00, 0x10, 0x26, 0x52],     // 외곽: 깊은 남색
];
// 합성은 'lighter' 가 아니라 'source-over' 다. 작품 01 과 반대인 이유가 있다:
// 가산 합성은 입자가 많아 서로 겹칠 때만 밝기를 쌓는다. 여기는 입자가 01 의 1/40 이라
// 획 하나가 혼자 보여야 하는데, 'lighter' 에서는 둘을 동시에 가질 수 없다 —
// 긴 잔상을 위해 덮기 알파를 0.035 로 낮추면 클립 임계가 255*0.035 = 8.9 라
// stroke 알파를 그 이하로 묶어야 하고 그러면 갓 그린 획이 사실상 보이지 않는다(실측
// lumaMax 58.9, ink 0.04%). 반대로 stroke 를 밝히면 매 프레임 지나가는 픽셀이 흰색으로
// 클립된다. 'source-over' 는 획이 자기 색 그대로 보이고 잔상은 덮기가 처리하며
// 클립도 색 변질도 없다 — 희소 입자 작품의 올바른 선택이다.
const STROKE_ALPHA = 0.62;
const LINE_W = 1.0;             // 1.0 초과는 1.83배 비싸다(실측) — 넘지 않는다

export default class GravityGarden extends Piece {
  setup() {
    this.bg = '#06070c';
    this.rnd = makeRng(0x2545f491);
    this.gravity = this.gravity ?? 1;
    this.colors = buildBuckets();
    this._placeAttractors();
    this._allocate(this._countFor(this.w, this.h));
    for (let i = 0; i < this.n; i++) this._seedParticle(i);
    // 색 정규화 기준은 실제 궤도가 도달하는 반지름이다. 화면 대각선(918px)으로 나누면
    // 궤도 범위 73~306px 가 0.08~0.33 에 몰려 16버킷 중 1~5 만 쓰이고, 램프의 파란 절반이
    // 화면에 전혀 나타나지 않는다(실측: 전부 금색이었다).
    this.rMax = Math.min(this.w, this.h) * 0.38;
  }

  _countFor(cw, ch) {
    const base = clamp(Math.round((cw * ch) / AREA_PER_PARTICLE), N_MIN, N_MAX);
    return Math.max(60, Math.round(base * this.budgetScale));
  }

  _allocate(count) {
    this.n = count;
    this.px = new Float32Array(count); this.py = new Float32Array(count);
    this.vx = new Float32Array(count); this.vy = new Float32Array(count);
    this.qx = new Float32Array(count); this.qy = new Float32Array(count);
    // 버킷별 세그먼트 버퍼. 프레임당 할당 0 을 위해 한 번만 잡는다.
    this.segX0 = new Float32Array(count); this.segY0 = new Float32Array(count);
    this.segX1 = new Float32Array(count); this.segY1 = new Float32Array(count);
    this.segB = new Uint8Array(count);
    this.bCount = new Int32Array(BUCKETS);
    this.bHead = new Int32Array(BUCKETS + 1);
    this.order = new Int32Array(count);
  }

  /**
   * 인력점 배치. 균등 난수로 뽑지 않고 best-candidate 표본을 쓴다 —
   * 균등 난수는 뭉치는 성질이 있어서 고정 시드로는 다섯 개가 화면 한쪽에만 몰릴 수 있고
   * (실제로 그랬다: 정원 전체가 오른쪽 절반에만 생겼다) 그건 운에 맡길 일이 아니다.
   * 후보 K 개를 뽑아 기존 점들에서 가장 먼 것을 고르면 개수와 무관하게 퍼짐이 보장된다.
   */
  _placeAttractors() {
    const A = ATTRACTORS;
    this.ax = new Float32Array(A); this.ay = new Float32Array(A);
    this.am = new Float32Array(A); this.aph = new Float32Array(A);
    const iw = this.w * INSET, ih = this.h * INSET;
    const bw = this.w - 2 * iw, bh = this.h - 2 * ih;
    for (let k = 0; k < A; k++) {
      let bx = 0, by = 0, best = -1;
      const tries = 1 + k * 6;                  // 첫 점은 자유, 뒤로 갈수록 까다롭게
      for (let c = 0; c < tries; c++) {
        const x = iw + this.rnd() * bw, y = ih + this.rnd() * bh;
        let d = Infinity;
        for (let j = 0; j < k; j++) {
          const dd = (x - this.ax[j]) ** 2 + (y - this.ay[j]) ** 2;
          if (dd < d) d = dd;
        }
        if (d > best) { best = d; bx = x; by = y; }
      }
      this.ax[k] = bx; this.ay[k] = by;
      this.am[k] = MASS_MIN + this.rnd() * (MASS_MAX - MASS_MIN);
      this.aph[k] = this.rnd() * TAU;           // 표류 위상 — 인력점마다 다른 리사주
    }
  }

  /** 가장 가까운 인력점을 중심으로 원궤도에 올린다. 그래야 처음부터 공전한다. */
  _seedParticle(i) {
    const k = (this.rnd() * ATTRACTORS) | 0;
    const rMin = SOFT * 1.6;
    const r = rMin + this.rnd() * (Math.min(this.w, this.h) * 0.34 - rMin);
    const a = this.rnd() * TAU;
    const x = this.ax[k] + Math.cos(a) * r;
    const y = this.ay[k] + Math.sin(a) * r;
    this.px[i] = x; this.py[i] = y;
    this.qx[i] = x; this.qy[i] = y;
    // 국소 원궤도 속도 v = sqrt(G*m*r^2/(r^2+soft^2)^1.5) 의 접선 방향.
    const v = this._circularSpeed(r, this.am[k]);
    const s = this.rnd() < 0.5 ? 1 : -1;        // 절반은 반대로 돈다 — 교차가 생긴다
    this.vx[i] = -Math.sin(a) * v * s;
    this.vy[i] =  Math.cos(a) * v * s;
  }

  _circularSpeed(r, m) {
    const d2 = r * r + SOFT * SOFT;
    return Math.sqrt(G * this.gravity * m * r * r / (d2 * Math.sqrt(d2))) || 0;
  }

  onResize() {
    // 인력점을 새 화면 비율로 옮긴다. 다시 뽑으면 정원 전체가 바뀐다.
    const sx = this.w / (this._lastW || this.w), sy = this.h / (this._lastH || this.h);
    if (this._lastW) {
      for (let k = 0; k < ATTRACTORS; k++) { this.ax[k] *= sx; this.ay[k] *= sy; }
    }
    this._lastW = this.w; this._lastH = this.h;
    this.rMax = Math.min(this.w, this.h) * 0.38;

    const want = this._countFor(this.w, this.h);
    if (want === this.n) return;
    const oldN = this.n, oPx = this.px, oPy = this.py, oVx = this.vx, oVy = this.vy;
    this._allocate(want);
    for (let i = 0; i < this.n; i++) {
      if (i < oldN) {
        this.px[i] = oPx[i]; this.py[i] = oPy[i];
        this.qx[i] = oPx[i]; this.qy[i] = oPy[i];
        this.vx[i] = oVx[i]; this.vy[i] = oVy[i];
      } else this._seedParticle(i);
    }
  }

  controls(host) {
    host.slider('중력 / gravity', 0.3, 2.2, this.gravity, 0.05, (x) => { this.gravity = x; });
    host.button('정원 다시 심기 / replant', () => {
      this.rnd = makeRng((Math.round(this.t * 1e6) ^ 0x41c64e6d) | 1);
      this._placeAttractors();
      for (let i = 0; i < this.n; i++) this._seedParticle(i);
    });
  }

  frame(dt, t) {
    const g = this.ctx, w = this.w, h = this.h, n = this.n, p = this.pointer;
    const px = this.px, py = this.py, vx = this.vx, vy = this.vy, qx = this.qx, qy = this.qy;
    const ax = this.ax, ay = this.ay, am = this.am, aph = this.aph;

    // 인력점이 아주 천천히 표류한다 — 궤도가 서서히 재편되어 같은 화면이 반복되지 않는다.
    const iw = w * INSET, ih = h * INSET;
    for (let k = 0; k < ATTRACTORS; k++) {
      const ph = aph[k];
      ax[k] = clamp(ax[k] + Math.cos(t * 0.11 + ph) * DRIFT * dt, iw, w - iw);
      ay[k] = clamp(ay[k] + Math.sin(t * 0.083 + ph * 1.7) * DRIFT * dt, ih, h - ih);
    }

    const scatterR = Math.min(w, h) * SCATTER_R;
    const sR2 = scatterR * scatterR;
    const scatterOn = p.active;
    const gg = G * this.gravity;
    const soft2 = SOFT * SOFT;
    const invRMax = 1 / this.rMax;

    this.bCount.fill(0);

    for (let i = 0; i < n; i++) {
      const x = px[i], y = py[i];
      qx[i] = x; qy[i] = y;

      // --- 인력점들의 힘 합 (O(N x A)) ---
      let fx = 0, fy = 0;
      let nearD2 = Infinity, nearM = 1;
      for (let k = 0; k < ATTRACTORS; k++) {
        const dx = ax[k] - x, dy = ay[k] - y;
        const d2 = dx * dx + dy * dy + soft2;
        const inv = 1 / d2;
        const f = gg * am[k] * inv * Math.sqrt(inv);   // 1/d^3 * d = 1/d^2 방향 정규화 포함
        fx += dx * f; fy += dy * f;
        if (d2 < nearD2) { nearD2 = d2; nearM = am[k]; }
      }

      // --- 마우스 산란: 가까이 가면 흩어진다 ---
      if (scatterOn) {
        const dx = x - p.x, dy = y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < sR2 && d2 > 1e-3) {
          const d = Math.sqrt(d2);
          const k = (1 - d / scatterR);
          const s = k * k * SCATTER_K / d;
          fx += dx * s; fy += dy * s;
        }
      }

      let nvx = vx[i] + fx * dt;
      let nvy = vy[i] + fy * dt;

      // --- 약한 감쇠 + 복귀 ---
      // 산란으로 얻은 여분의 운동에너지를 국소 원궤도 속도 쪽으로 서서히 돌려놓는다.
      // 이게 "멀어지면 서서히 궤도로 복귀한다" 의 실체다.
      const r = Math.sqrt(nearD2 - soft2) || 1;
      const vCirc = this._circularSpeed(r, nearM);
      const sp = Math.hypot(nvx, nvy) || 1e-6;
      const target = clamp(sp, 0, vCirc * V_MAX_K);
      const pull = 1 + (target / sp - 1) * Math.min(1, RETURN_K * dt * (scatterOn ? 0.25 : 1));
      const damp = 1 - DAMP * dt;
      nvx *= pull * damp; nvy *= pull * damp;

      vx[i] = nvx; vy[i] = nvy;
      let nx = x + nvx * dt, ny = y + nvy * dt;

      // 화면을 벗어난 입자는 다시 궤도에 올린다 — 탈출한 입자가 영원히 사라지면
      // 정원이 서서히 비어 버린다.
      if (nx < -40 || nx > w + 40 || ny < -40 || ny > h + 40) {
        this._seedParticle(i);
        continue;                              // 이 프레임에는 선을 그리지 않는다
      }
      px[i] = nx; py[i] = ny;

      // --- 궤도 반지름 -> 색 버킷 ---
      const b = clamp((Math.sqrt(nearD2) * invRMax * BUCKETS) | 0, 0, BUCKETS - 1);
      this.segX0[i] = x; this.segY0[i] = y;
      this.segX1[i] = nx; this.segY1[i] = ny;
      this.segB[i] = b;
      this.bCount[b]++;
    }

    // --- 버킷별 정렬 (계수 정렬, 할당 0) ---
    const bHead = this.bHead, order = this.order, bCount = this.bCount;
    bHead[0] = 0;
    for (let b = 0; b < BUCKETS; b++) bHead[b + 1] = bHead[b] + bCount[b];
    const cursor = this._cursor || (this._cursor = new Int32Array(BUCKETS));
    for (let b = 0; b < BUCKETS; b++) cursor[b] = bHead[b];
    for (let i = 0; i < n; i++) {
      if (this.segX0[i] === this.segX1[i] && this.segY0[i] === this.segY1[i]) continue;
      order[cursor[this.segB[i]]++] = i;
    }

    // --- 그리기 ---
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = COVER;
    g.fillRect(0, 0, w, h);

    // source-over 다 — 위 STROKE_ALPHA 주석 참고.
    g.lineCap = 'butt';
    g.lineWidth = LINE_W;
    g.globalAlpha = STROKE_ALPHA;

    for (let b = 0; b < BUCKETS; b++) {
      const from = bHead[b], to = cursor[b];
      if (to <= from) continue;
      g.strokeStyle = this.colors[b];
      g.beginPath();
      for (let j = from; j < to; j++) {
        const i = order[j];
        g.moveTo(this.segX0[i], this.segY0[i]);
        g.lineTo(this.segX1[i], this.segY1[i]);
      }
      g.stroke();
    }

    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }
}

function buildBuckets() {
  const out = [];
  for (let b = 0; b < BUCKETS; b++) {
    const x = b / (BUCKETS - 1);
    let s = 0;
    while (s < RAMP.length - 2 && x > RAMP[s + 1][0]) s++;
    const a = RAMP[s], c = RAMP[s + 1];
    const f = (x - a[0]) / (c[0] - a[0] || 1);
    const r = Math.round(a[1] + (c[1] - a[1]) * f);
    const gg = Math.round(a[2] + (c[2] - a[2]) * f);
    const bb = Math.round(a[3] + (c[3] - a[3]) * f);
    out.push(`rgb(${r},${gg},${bb})`);
  }
  return out;
}
