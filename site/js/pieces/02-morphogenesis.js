// 02 — Morphogenesis / 형태발생
//
// 규칙: 두 물질이 서로 다른 속도로 번지며 서로를 만든다. 느린 쪽이 남고 빠른 쪽이 퍼져,
// 그 속도 차이만으로 무늬가 생긴다.
//
// 작품 01 과 코드 모양이 정반대다: 01 은 고정 개수 float 입자가 무상태 벡터장을 따라 흐르고
// 획으로 그려지고, 02 는 고정 크기 Float32Array 격자가 이중 버퍼로 PDE 를 돌고 ImageData 로
// 그려진다. 공유하는 것은 Piece 계약뿐이다.

import { Piece, clamp, makeRng } from '../engine.js';

// --- 격자 ---
// 화면보다 거칠게 잡고 ImageData 로 그려 부드럽게 확대한다.
// 1920x1080 -> round(2073600/26) = 79,754 칸 ~ 스펙의 "약 8만 칸". 실측 377x212 = 79,924.
const AREA_PER_CELL = 26;
const CELL_MIN = 2500;
const CELL_MAX = 80000;

// --- Gray-Scott ---
// Du/Dv 는 스펙의 0.16/0.08 에서 바꿨다(승인됨). 아래 네 F/k 프리셋은 Karl Sims 튜토리얼
// 값이고, 그 값들은 이 커널 + dt=1 + dA=1.0/dB=0.5 로 교정된 것이다. 0.16/0.08 은 정확히
// 그 0.16배여서 실측 결과: 무늬 폭이 2~3셀로 격자에 고착(자기상관 첫 영점 d=3~4),
// mitosis 와 leopard 가 Pearson r=0.9204 로 같은 그림, 변화가 0.10~0.21초 만에 95% 종료,
// 최종 피복률이 F/k 가 아니라 씨앗 밀도에 좌우.
// 1.0/0.5 는 여전히 안정하다: 커널의 Fourier 심볼 범위가 [-1.6, 0] 이고(최소는 체커보드
// (pi,pi)) 명시적 Euler 조건은 dt*D <= 2/1.6 = 1.25. Du=1.0 -> 증폭 |1-1.6| = 0.6 < 1.
const DU = 1.0;
const DV = 0.5;

// 3x3 라플라시안: 중심 -1, 직교 0.2, 대각 0.05.
// 합 = -1 + 4*0.2 + 4*0.05 = 0 (실측 5.55e-17, IEEE-754 반올림 잔차).
// 합이 0 인 것은 load-bearing 이다. +0.05 로 만들면 20000스텝 후 min=Infinity, -0.05 면
// 8.7e-44(장 전체 소멸). 합이 0 이 아니면 확산 연산자가 아니라 균일 지수 이득/감쇠 항이 된다.
// 이 커널은 표준 등방 9점 스텐실 (1/6)*[[1,4,1],[4,-20,4],[1,4,1]] 의 정확히 0.3배다.
const K_ORTHO = 0.2;
const K_DIAG = 0.05;

const STEPS = 8;                // 프레임당 스텝 수. dt 는 상수에 접어넣어 1 이다.

const PRESETS = [
  { name: '세포분열', en: 'Mitosis', F: 0.0367, k: 0.0649 },
  { name: '산호',     en: 'Coral',   F: 0.0545, k: 0.0620 },
  { name: '표범',     en: 'Leopard', F: 0.0350, k: 0.0650 },
  { name: '미로',     en: 'Maze',    F: 0.0290, k: 0.0570 },
];

// --- 씨앗 ---
// U=1, V=0 은 고정점이다. 씨앗을 잘못 고르면 검은 화면이거나 얼어붙은 정지 화면이다.
// 실측(320x250, 4000스텝):
//   중앙 20x20 정사각형 -> 피복 0.11~0.32%, bit-exact 고정점(3000스텝에서 max|dV|=0.000e+0)
//   iid 노이즈 V~U(0,0.5) -> 네 프리셋 전부 사망 (Vstd=0.0000)
//   꽉 찬 블롭 12개 r=6  -> mitosis, leopard 사망
//   희소 스페클 p=0.5%   -> 네 프리셋 전부 생존, 가장 긴 관람 가능 onset
// 그래서 희소 스페클이다. 블롭도 균일 노이즈도 아니다. verify.mjs 는 정적 검사라 이걸
// 잡을 수 없으므로 이유를 여기 남긴다.
const SEED_P = 0.005;

// 프리셋을 바꿀 때 흩뿌리는 밀도. SEED_P 보다 옅다 — 기존 무늬를 덮지 않으면서 새 F/k 가
// 자랄 핵만 남기는 정도다.
const SPRINKLE_P = 0.002;

// --- 붓 ---
// 꽉 찬 원반은 무늬를 죽인다 — 내부가 공간적으로 균일하면 Turing 불안정성이 없어 U 를
// 고갈시키고 블록째 붕괴한다. 실측: mitosis 와 leopard 는 반경 8셀 이상이면 진폭
// (0.25/0.5/1.0)·감쇠(hard/linear) 무관하게 매번 사망(18/18). 스페클 붓은 r=16 밀도
// 0.15 에서 네 프리셋 모두 자란다.
const BRUSH_R_CSS = 30;         // CSS px
const BRUSH_DENSITY = 0.2;      // 반경 안에서 씨앗이 되는 셀의 비율

// --- 색 ---
// V 의 최대는 프리셋별로 0.35~0.47 뿐이고 중위값은 0.013~0.15 다. naive 255*v 는 최대
// 바이트 89~121, 평균 17~42 로 어두운 배경에서 희미한 회색 얼룩이 된다.
// 정규화는 프리셋 공통이다 — 프리셋별로 하면 프리셋 간 실제 차이를 숨기고, 과도 구간에서
// vmax 가 흔들려 색이 펄럭인다.
// 상한 0.40: 감사가 권한 0.34 는 대비를 최대화하지만 V 분포가 이봉형이라(배경 ~0, 무늬
// 몸통 0.37~0.43) 몸통 전체가 램프 정점으로 클립되어 색이 납작해진다.
const V_LO = 0.05;
const V_HI = 0.40;

// life 관의 톤: --bg -> 거의 검은 이끼 -> 옥 -> accent.
// accent(#8fe39a) 를 정점에만 둔다. 중간에 두면 무늬의 몸통 전체가 accent 가 되어 미술관
// 벽이 아니라 스크린세이버로 읽힌다. 램프는 곧 작품이다 — 밝히면 표본이 아니라 네온이 된다.
const RAMP = [
  [0.00, 0x0a, 0x0b, 0x0f],
  [0.30, 0x0d, 0x24, 0x19],
  [0.58, 0x1e, 0x5c, 0x3e],
  [0.82, 0x4a, 0xa8, 0x6e],
  [1.00, 0x8f, 0xe3, 0x9a],     // life 관 accent — 정점에만
];

export default class Morphogenesis extends Piece {
  /**
   * 백킹스토어를 격자 크기로 잡고 CSS 가 늘리게 한다.
   * 실측 이유 — 320x250 -> 1920x1080 을 JS 로 확대하면
   *   imageSmoothingQuality 'high' 111.05ms / 'medium' 62.88 / 'low' 16.38 / off 3.28
   * 인데 물리 8스텝은 12.42ms 다. 즉 'high' 는 물리의 9배다. 백킹스토어를 격자로 두면
   * 컴포지터가 GPU 에서 bilinear 를 무료로 해준다: 0.07ms, 1586배.
   * (putImageData 는 스케일되지 않는다 — ctx.scale(8,8) 후에도 8x8 만 덮는다. 실측.)
   *
   * 크기를 면적에서 도출하고 min(W,H) 에서 도출하지 않는다. min(W,H) 기준이면 레터박스
   * 캔버스(2560x400)가 2560x1440 보다 62% 더 비싸지는 역전이 생긴다(실측).
   */
  pixelSize(cssW, cssH) {
    const base = clamp(Math.round((cssW * cssH) / AREA_PER_CELL), CELL_MIN, CELL_MAX);
    const cells = Math.max(CELL_MIN, Math.round(base * this.budgetScale));
    const gw = Math.max(16, Math.round(Math.sqrt(cells * cssW / cssH)));
    const gh = Math.max(16, Math.round(cells / gw));
    return { w: gw, h: gh };
  }

  setup() {
    this.bg = '#0a0b0f';
    this.rnd = makeRng(0x6d2b79f5);
    // 기본값은 미로(3)다. 격자 8만 칸 상한(성능 예산)에서 1920x1080 은 셀당 5.09 CSS px 라
    // 확대율이 5배다. 세포분열은 그 배율에서 고립된 점들이 흐릿한 덩어리로 읽히는데,
    // 미로와 산호는 18~22셀 주기의 연결된 구조라 확대가 유기적인 부드러움으로 읽힌다.
    this.preset = this.preset ?? 3;
    this.stepsRun = 0;
    // pixelSize() 로 백킹스토어를 정했으므로 this.w/this.h 가 곧 격자 크기다.
    this.GW = this.w; this.GH = this.h;
    this.NC = this.GW * this.GH;
    this.u = new Float32Array(this.NC); this.v = new Float32Array(this.NC);
    this.u2 = new Float32Array(this.NC); this.v2 = new Float32Array(this.NC);
    this.img = this.ctx.createImageData(this.GW, this.GH);
    this.lut = buildLUT();
    this._seed();
    this.ctx.imageSmoothingEnabled = false;   // putImageData 는 어차피 스케일하지 않는다
  }

  _seed() {
    const { u, v, NC, rnd } = this;
    u.fill(1); v.fill(0);
    for (let i = 0; i < NC; i++) if (rnd() < SEED_P) v[i] = 1;
    this.stepsRun = 0;
    this._deadChecks = 0;
  }

  /** 장을 지우지 않고 새 핵만 흩뿌린다. 프리셋 전환 때 쓴다 — 아래 SPRINKLE_P 주석 참고. */
  _sprinkle(p) {
    const { v, NC, rnd } = this;
    for (let i = 0; i < NC; i++) if (rnd() < p) v[i] = 1;
    this._deadChecks = 0;
  }

  /**
   * 생존 감시. V 의 분산이 0 에 가까운 상태가 이어지면 다시 파종한다.
   * 필요한 이유(실측): 자란 무늬에 F/k 만 바꾸면 죽을 수 있다. 산호(피복 69%)에서 표범
   * (F=0.035, k=0.065)으로 바꾸니 피복이 0.00% 로 완전 사망했다 — 밀집한 장에서 표범은
   * 소멸 영역이다. 관람객이 "표범" 을 눌러 검은 화면을 받는 일은 없어야 한다.
   * 붓으로 거대한 얼룩을 칠해 U 를 고갈시킨 경우도 같은 그물이 잡는다.
   * 비용: 2048칸 표본이라 프레임당 무시할 수준이고 60프레임마다 한 번만 돈다.
   */
  _watchLiveness() {
    const v = this.v, NC = this.NC;
    const stride = Math.max(1, (NC / 2048) | 0);
    let n = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < NC; i += stride) { const x = v[i]; sum += x; sum2 += x * x; n++; }
    const mean = sum / n;
    const variance = sum2 / n - mean * mean;
    if (variance < 1e-5) {
      // 처음에는 흩뿌려 되살리고, 그래도 안 되면 완전히 다시 파종한다.
      if (++this._deadChecks === 2) this._sprinkle(SEED_P);
      else if (this._deadChecks >= 5) this._seed();
    } else {
      this._deadChecks = 0;
    }
  }

  /**
   * 격자 크기가 바뀌면 기존 무늬를 최근접으로 재표본한다. 다시 파종하면 몇 초간 자란
   * 무늬가 사라져 리셋된 것처럼 보인다.
   */
  onResize() {
    if (this.w === this.GW && this.h === this.GH) return;
    const oldU = this.u, oldV = this.v, oGW = this.GW, oGH = this.GH;
    this.GW = this.w; this.GH = this.h;
    this.NC = this.GW * this.GH;
    this.u = new Float32Array(this.NC); this.v = new Float32Array(this.NC);
    this.u2 = new Float32Array(this.NC); this.v2 = new Float32Array(this.NC);
    this.img = this.ctx.createImageData(this.GW, this.GH);
    this.ctx.imageSmoothingEnabled = false;
    if (!oldU) { this._seed(); return; }
    const u = this.u, v = this.v, GW = this.GW, GH = this.GH;
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

  controls(host) {
    host.choice('무늬 / pattern', PRESETS.map((p) => p.name), this.preset, (i) => this.setPreset(i));
    host.button('다시 파종 / reseed', () => this._seed());
  }

  /**
   * 장을 지우지 않고 F/k 만 바꾼다 — 자란 무늬가 눈앞에서 다른 무늬로 변형되는 게 이 작품의
   * 가장 좋은 순간이라 재파종으로 그걸 버리지 않는다. 다만 새 핵을 조금 흩뿌린다:
   * 어떤 전환(산호 -> 표범)은 밀집한 장을 완전히 죽이기 때문이다(실측 피복 69% -> 0.00%).
   * 감사에 따르면 네 프리셋 모두 희소 스페클에서는 자라므로, 새 핵이 있으면 옛 무늬가
   * 사라지는 동안 새 무늬가 올라온다.
   */
  setPreset(i) {
    this.preset = i;
    this._sprinkle(SPRINKLE_P);
  }

  frame() {
    const p = PRESETS[this.preset];

    // 끌면 V 를 심는다. 엔진이 포인터를 이 작품의 논리 좌표계(= 격자 칸)로 이미 환산해 준다.
    const ptr = this.pointer;
    if (ptr.down && ptr.active) this._paint(ptr.x, ptr.y);

    for (let s = 0; s < STEPS; s++) this._step(p.F, p.k);
    if (this.stepsRun % (STEPS * 60) < STEPS) this._watchLiveness();
    this._render();
  }

  /**
   * 반응-확산 한 스텝. dt 는 상수에 접어넣어 1 이라 곱셈이 없다.
   * 인덱스 산술은 분기 wrap + 행 오프셋 호이스팅이다. 오프셋 테이블(Int32Array)은 쓰지 않는다
   * — 실측 2% 손해(19.45 -> 19.79 ms/step 상당). V8 이 이미 정수 modulo 를 strength-reduce
   * 한다. 진짜 이득은 Float32 vs Float64 = 1.77배인데 그건 이미 타입 선택에 들어 있다.
   */
  _step(F, k) {
    const gw = this.GW, gh = this.GH;
    const u = this.u, v = this.v, u2 = this.u2, v2 = this.v2;
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
    this.u = u2; this.u2 = u;      // 이중 버퍼 교환
    this.v = v2; this.v2 = v;
    this.stepsRun++;
  }

  /** 스페클 붓. 반경 안의 셀 일부만 V=1 로 심는다. U 는 건드리지 않는다. */
  _paint(cx, cy) {
    const GW = this.GW, GH = this.GH, v = this.v, rnd = this.rnd;
    const r = Math.max(1.5, BRUSH_R_CSS / (this.cssW || GW) * GW);
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

  _render() {
    const d = this.img.data, v = this.v, NC = this.NC, lut = this.lut;
    const inv = 1 / (V_HI - V_LO);
    for (let i = 0, q = 0; i < NC; i++, q += 4) {
      let s = (v[i] - V_LO) * inv;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      s = s * s * (3 - 2 * s);                  // smoothstep
      const j = ((s * 255) | 0) * 3;
      d[q] = lut[j]; d[q + 1] = lut[j + 1]; d[q + 2] = lut[j + 2]; d[q + 3] = 255;
    }
    this.ctx.putImageData(this.img, 0, 0);
  }
}

function buildLUT() {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let s = 0;
    while (s < RAMP.length - 2 && x > RAMP[s + 1][0]) s++;
    const a = RAMP[s], b = RAMP[s + 1];
    const f = (x - a[0]) / (b[0] - a[0] || 1);
    lut[i * 3]     = a[1] + (b[1] - a[1]) * f;
    lut[i * 3 + 1] = a[2] + (b[2] - a[2]) * f;
    lut[i * 3 + 2] = a[3] + (b[3] - a[3]) * f;
  }
  return lut;
}
