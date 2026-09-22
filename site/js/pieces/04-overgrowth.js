// 04 — Overgrowth / 붐비는 선
//
// 규칙: 선은 자기 자신에게서 일정한 간격을 지키려 하고, 자리가 남은 곳마다 두 점 사이로
// 새 점이 끼어든다. 그래서 길어지고, 갈 곳이 없어지면 접힌다.
//
// 구조 대비: 01 은 고정 개수 float 입자 + 무상태 벡터장, 02 는 고정 크기 격자 PDE,
// 03 은 고정 개수 입자 + 인력점 — 셋 다 setup() 에서 한 번 할당하는 고정 크기 자루다.
// 04 는 원소 수가 시뮬레이션의 출력이다. 순환 단일 연결 리스트(nxt: Int32Array)에
// O(1) 중간 삽입, bump 할당자 + free list, 프레임당 계수 정렬 공간 해시.
// 타입 배열은 configure() 에서 한 번만 잡고 절대 키우지 않는다.
//
// 이 작품은 잔상을 쓰지 않는다. 매 프레임 배경을 불투명하게 덮는다 — 01 이 빛으로
// 기억한다면 04 는 구조로 기억한다. 접힌 자리가 곧 기록이다. 그리고 그 불투명 fillRect 가
// 공유 캔버스에서 01 의 'lighter' 와 미청소 잔상을 확실히 지워준다.

import { Piece, TAU, clamp, makeRng } from '../engine.js';

const BG = '#0a0b0f';

// 세대(분할 깊이)별 5색. 안쪽(오래된) -> 바깥쪽(새로운).
// 알파가 곧 작품이다 — 밝히면 표본이 아니라 스크린세이버가 된다. 내부가 --bg 로 물러나는
// 것이 이 작품의 전부다.
const PAL = ['#25424b', '#366d68', '#5aa382', '#8fe39a', '#cfeecd'];
// 프론티어 버킷만 3중으로 그어 색수차를 만든다 — 자라는 끝이 등고선이 아니라 유리로 읽힌다.
const FRINGE = ['#7fe0d0', '#cfeecd', '#a9c8ef'];
const FRINGE_ALPHA = [0.22, 0.62, 0.22];
const FRINGE_DX = [-1.1, 0, 1.1];

// 반발 half-stencil 오프셋. 모듈 스코프에 호이스팅되어야 한다 — 프레임당 리터럴로 두면
// 이 작품의 최대 할당원이 된다.
const OFF_X = [1, 1, 1, 0];
const OFF_Y = [-1, 0, 1, 1];

const MAX_RINGS = 8;
const DENS_OK = 5;              // 이웃이 이보다 많으면 "여기는 자리가 없다" — 삽입을 거부한다
const KA = 0.20;                // 스프링(이웃과의 거리를 L 로)
const KS = 0.11;                // 곡률 평활(이웃 중점 쪽으로)
const KR = 0.62;                // 반발 세기
// 기본 성장률. 0.20 에서는 30초에 노드가 1100 밖에 안 됐다 — 자동 관람 슬롯이 30초인데
// 가장 읽기 좋은 구간(감사 기준 3611 노드)에 도달하지 못한다. 밀도 게이트가 붐비는 곳의
// 삽입을 거부하므로 실효 성장률은 이 값보다 한참 낮다.
const GR = 0.45;
const BREATH_S = 13;            // s — L 이 +-5.5% 로 숨쉬는 주기
const BREATH_A = 0.055;

// 세대 주기. 필수다 — 캡에 닿으면 군체가 잼된다(실측 평균 노드 이동 0.60 px/s).
// 주기가 없으면 46초 후 전시실이 정지 화면이 된다. 위상은 작품 자신의 누적 시간에서
// 파생해 자동 관람이 예측할 수 있게 한다.
const HOLD_S = 6;
const DISSOLVE_S = 2.5;
const FADEIN_S = 0.9;

const PR_K = 0.16;              // 포인터 영향 반경 = min(w,h) * 이 값
const PUSH_K = 0.5;             // * Leff — 호버가 밀어내는 세기
const PULL_K = 0.35;            // * Leff — 누를 때 프론티어가 당겨지는 세기
const ENTRY_BOOST = 2.2;        // 포인터 진입 순간의 배수
const ENTRY_S = 0.45;           // s — 1.0 으로 내려오는 시간
const SMEAR = 0.008;            // pointer.vx/vy 에 곱한다 — 아래 주석의 단위 경고 참고
const PLANT_COOLDOWN = 0.5;     // s — 연타로 8링과 노드 예산을 1초에 태우지 못하게
const IDLE_PLANT_S = 12;        // s — 손대지 않은 키오스크가 군체 봉합을 볼 수 있게

export default class Overgrowth extends Piece {
  setup() {
    this.bg = BG;
    this.rnd = makeRng(0x9e10d3b7);
    this.growthMul = this.growthMul ?? 1;
    this.spacingMul = this.spacingMul ?? 1;
    this._configure();
    this._reset();
  }

  // ------------------------------------------------------------------ 할당

  _configure() {
    const w = this.w, h = this.h;
    // 크기를 면적에서 도출한다. min(W,H) 에서 도출하면 레터박스 캔버스가 더 비싸지는
    // 역전이 생긴다(2560x400 이 2560x1440 보다 62% 비쌌다 — 실측).
    const s = clamp(Math.sqrt(w * h) / 1100, 0.85, 2.0) * this.spacingMul;
    this.L = 9.0 * s;
    this.SPLIT = 1.7 * this.L;
    this.R = 2.0 * this.L;                       // 반발 반경 == 해시 셀 크기
    this.MAXSTEP = 0.45 * this.L;

    const cap = Math.min(6500, Math.max(420, Math.round(w * h / 95)));
    this.MAX = Math.max(240, Math.round(cap * this.budgetScale / Math.max(1, this.spacingMul ** 2)));
    this.maxEff = this.MAX;

    const M = this.MAX;
    this.x = new Float32Array(M); this.y = new Float32Array(M);
    this.fx = new Float32Array(M); this.fy = new Float32Array(M);
    this.nxt = new Int32Array(M);                // 순환 next. free-list 체인도 겸한다
    this.gen = new Uint8Array(M);
    this.dens = new Uint8Array(M);
    this.order = new Int32Array(M);
    this.ringHead = new Int32Array(MAX_RINGS);
    this.ringStart = new Int32Array(MAX_RINGS + 1);
    this.splitAccR = new Float64Array(MAX_RINGS);

    this._grid();
  }

  _grid() {
    this.gw = Math.max(1, Math.ceil(this.w / this.R));
    this.gh = Math.max(1, Math.ceil(this.h / this.R));
    this.cells = this.gw * this.gh;
    this.cellCnt = new Int32Array(this.cells);
    this.cellStart = new Int32Array(this.cells + 1);
    this.cellItems = new Int32Array(this.MAX);
  }

  _reset() {
    this.free = 0;
    for (let i = 0; i < this.MAX - 1; i++) this.nxt[i] = i + 1;
    this.nxt[this.MAX - 1] = -1;
    this.n = 0;
    this.ringN = 0;
    this.ringHead.fill(-1);
    this.splitAccR.fill(0);
    this.maxGen = 1;
    this.phase = 'grow';
    this.phaseT = 0;
    this.vis = 0;                                // 0 -> 1 페이드인
    this.entry = 1;
    this.lastPlant = -99;
    this.lastPointerAt = 0;
    this.autoPlants = 0;
    this._wasActive = false;

    // 군체 3개로 시작하고 워밍업을 돌린다.
    // 이유: 링 하나에서 시작하면 4.2초에 노드가 255개(ink 0.26%)뿐이라 들어온 관람객이
    // 처음 10초간 거의 빈 화면을 본다. 자동 관람 슬롯은 30초다. 프론티어가 셋이면 성장이
    // 3배 빠르고, 워밍업이 도착 시점을 이미 접힌 조직으로 만든다 — 관람객은 씨앗이 아니라
    // 자란 정원에 도착한다. 비용은 마운트 때 한 번, 240회 반복 x ~0.5ms = ~120ms 이고
    // main.js 의 페이드인 뒤에 숨는다.
    const r0 = Math.max(8, Math.min(this.w, this.h) * 0.10);
    const cx = this.w * 0.5, cy = this.h * 0.5;
    const spread = Math.min(this.w, this.h) * 0.19;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU + 0.4;
      this._plant(cx + Math.cos(a) * spread, cy + Math.sin(a) * spread * 0.8, r0);
    }
    this._warmup(240, 1 / 24);
    this.vis = 1;                                // 워밍업된 상태로 도착하므로 페이드인 불필요
  }

  /** 시뮬레이션을 헤드리스로 미리 돌린다. 그리기는 하지 않는다. */
  _warmup(iters, dt) {
    const dtf = Math.min(dt * 60, 3);
    for (let s = 0; s < iters; s++) {
      if (this.n <= 0 || this.n >= this.maxEff) break;
      this._flatten();
      this._hash();
      this._springs(this.L);
      this._repel();
      this._integrate(dtf);
      this._grow(dt, this.L);
    }
  }

  // --------------------------------------------------------- 링 / 노드 원시연산

  _alloc() {
    if (this.free < 0 || this.n >= this.maxEff) return -1;
    const i = this.free;
    this.free = this.nxt[i];
    this.n++;
    return i;
  }

  /** 새 군체를 심는다. 반환값은 성공 여부. */
  _plant(cx, cy, radius) {
    if (this.ringN >= MAX_RINGS) return false;
    const k = Math.max(10, Math.round(TAU * radius / this.L));
    if (this.n + k > this.maxEff) return false;
    let head = -1, prev = -1;
    for (let j = 0; j < k; j++) {
      const i = this._alloc();
      if (i < 0) break;
      const a = (j / k) * TAU;
      this.x[i] = cx + Math.cos(a) * radius;
      this.y[i] = cy + Math.sin(a) * radius;
      this.gen[i] = 0;
      this.dens[i] = 0;
      if (head < 0) head = i; else this.nxt[prev] = i;
      prev = i;
    }
    if (head < 0) return false;
    this.nxt[prev] = head;                       // 순환을 닫는다
    this.ringHead[this.ringN++] = head;
    return true;
  }

  /** i 다음에 노드를 하나 끼운다. O(1) 재연결. */
  _insertAfter(i) {
    const j = this.nxt[i];
    const k = this._alloc();
    if (k < 0) return -1;
    this.x[k] = (this.x[i] + this.x[j]) * 0.5;
    this.y[k] = (this.y[i] + this.y[j]) * 0.5;
    this.gen[k] = Math.min(254, Math.max(this.gen[i], this.gen[j]) + 1);
    this.dens[k] = 0;
    this.nxt[i] = k;
    this.nxt[k] = j;
    if (this.gen[k] > this.maxGen) this.maxGen = this.gen[k];
    return k;
  }

  // ------------------------------------------------------------- 엔진 훅

  /**
   * 면적 대역 정책이며 load-bearing 이다. 새 면적이 마운트 면적의 0.7~2.0배 안이면
   * 격자만 다시 만들고 노드는 전부 유지한다. 대역 밖이면 재구성 + 재파종한다.
   * 실측 이유: 2560x1440 -> 1280x720 으로 노드 6500 을 들고 그냥 regrid 하면 items/cell 이
   * 1.72 -> 6.89 로 뛰어 15.49ms p50 / 18.11ms p99 가 된다 — 프레임 드랍.
   * 이 주석을 지우고 onResize 를 bare regrid 로 "단순화" 하면 그 절벽이 조용히 돌아온다.
   */
  onResize() {
    const area = this.w * this.h;
    const ratio = this._mountArea ? area / this._mountArea : 1;
    if (!this._mountArea) this._mountArea = area;
    if (ratio >= 0.7 && ratio <= 2.0) { this._grid(); return; }
    this._mountArea = area;
    this._configure();
    this._reset();
  }

  onPointerDown() {
    if (this.phase === 'dissolve') return;
    if (this.t - this.lastPlant < PLANT_COOLDOWN) return;   // 연타 방어
    this.lastPlant = this.t;
    const r = Math.min(this.w, this.h) * 0.03;
    this._plant(this.pointer.x, this.pointer.y, r);
  }

  // onPointerUp 은 의도적으로 구현하지 않는다 — pointer.down 이 이미 false 로 떨어진다.

  controls(host) {
    host.slider('성장 속도 / growth', 0.3, 2.5, this.growthMul, 0.05, (v) => { this.growthMul = v; });
    host.slider('결 / grain (재시작)', 0.7, 1.6, this.spacingMul, 0.05, (v) => {
      this.spacingMul = v;
      this._configure();                         // 간격이 바뀌면 재할당이 필요하다
      this._reset();
    });
    host.button('새 군체 / reseed', () => this._reset());
  }

  // ------------------------------------------------------------------ 프레임

  frame(dt, t) {
    // 엔진의 1/20초 dt 캡을 프레임 단위로 표현한다 — 탭 전환이 적분기를 터뜨리지 못한다.
    const dtf = Math.min(dt * 60, 3);
    const Leff = this.L * (1 + BREATH_A * Math.sin(TAU * t / BREATH_S));

    this._phaseTick(dt);
    this._pointerTick(dt, t);

    if (this.n > 0) {
      this._flatten();
      this._hash();
      this._springs(Leff);
      this._repel();
      this._integrate(dtf);
      if (this.phase === 'grow') this._grow(dt, Leff);
    }
    this._draw();
  }

  _phaseTick(dt) {
    this.phaseT += dt;
    if (this.phase === 'grow') {
      this.vis = Math.min(1, this.vis + dt / FADEIN_S);
      if (this.n >= this.maxEff) { this.phase = 'hold'; this.phaseT = 0; }
    } else if (this.phase === 'hold') {
      if (this.phaseT >= HOLD_S) { this.phase = 'dissolve'; this.phaseT = 0; }
    } else if (this.phase === 'dissolve') {
      this.vis = Math.max(0, 1 - this.phaseT / DISSOLVE_S);
      if (this.phaseT >= DISSOLVE_S) { this._reset(); }
    }
  }

  _pointerTick(dt, t) {
    const p = this.pointer;
    if (p.active || p.down) this.lastPointerAt = t;
    // 진입 버스트: 없으면 3초 관람객은 커서가 무슨 일을 했는지 알 수 없다.
    if ((p.active || p.down) && !this._wasActive) this.entry = ENTRY_BOOST;
    this._wasActive = p.active || p.down;
    if (this.entry > 1) this.entry = Math.max(1, this.entry - (ENTRY_BOOST - 1) * dt / ENTRY_S);

    // 키오스크 자동 심기 — 이 작품의 최고 트릭(군체가 눌려 붙어 봉합선을 만드는 것)을
    // 손대지 않은 전시장도 볼 수 있게 한다.
    if (this.phase === 'grow' && t - this.lastPointerAt > IDLE_PLANT_S &&
        this.ringN < 3 && this.n > 0.35 * this.maxEff && this.autoPlants < 3 &&
        t - this.lastPlant > PLANT_COOLDOWN * 4) {
      const minD = Math.min(this.w, this.h) * 0.12;
      for (let tries = 0; tries < 12; tries++) {
        const cx = this.w * (0.15 + this.rnd() * 0.7);
        const cy = this.h * (0.15 + this.rnd() * 0.7);
        let ok = true;
        for (let r = 0; r < this.ringN && ok; r++) {
          const head = this.ringHead[r];
          if (head < 0) continue;
          if (Math.hypot(cx - this.x[head], cy - this.y[head]) < minD) ok = false;
        }
        if (!ok) continue;
        if (this._plant(cx, cy, Math.min(this.w, this.h) * 0.03)) {
          this.autoPlants++; this.lastPlant = t;
        }
        break;
      }
    }
  }

  /** 링들을 order[] 로 평탄화하고 ringStart[] 를 기록한다. O(n) 포인터 추적. */
  _flatten() {
    const order = this.order, nxt = this.nxt;
    let w = 0;
    for (let r = 0; r < this.ringN; r++) {
      this.ringStart[r] = w;
      const head = this.ringHead[r];
      if (head < 0) continue;
      let i = head, guard = 0;
      do { order[w++] = i; i = nxt[i]; } while (i !== head && ++guard < this.MAX && w < this.MAX);
    }
    this.ringStart[this.ringN] = w;
    this.flatN = w;
  }

  /** 계수 정렬로 공간 해시를 다시 만든다. 할당 0, O(n + cells). */
  _hash() {
    const { cellCnt, cellStart, cellItems, order, flatN, gw, gh, R } = this;
    cellCnt.fill(0);
    for (let q = 0; q < flatN; q++) {
      const i = order[q];
      const cx = clamp((this.x[i] / R) | 0, 0, gw - 1);
      const cy = clamp((this.y[i] / R) | 0, 0, gh - 1);
      cellCnt[cy * gw + cx]++;
    }
    let acc = 0;
    for (let c = 0; c < this.cells; c++) { cellStart[c] = acc; acc += cellCnt[c]; }
    cellStart[this.cells] = acc;
    const cursor = this._cursor || (this._cursor = new Int32Array(this.cells));
    if (cursor.length !== this.cells) this._cursor = new Int32Array(this.cells);
    const cur = this._cursor;
    for (let c = 0; c < this.cells; c++) cur[c] = cellStart[c];
    for (let q = 0; q < flatN; q++) {
      const i = order[q];
      const cx = clamp((this.x[i] / R) | 0, 0, gw - 1);
      const cy = clamp((this.y[i] / R) | 0, 0, gh - 1);
      cellItems[cur[cy * gw + cx]++] = i;
    }
  }

  _springs(Leff) {
    const { order, ringStart, ringN, x, y, fx, fy, nxt, dens } = this;
    for (let r = 0; r < ringN; r++) {
      const from = ringStart[r], to = ringStart[r + 1];
      const len = to - from;
      if (len < 3) continue;
      for (let q = from; q < to; q++) {
        const i = order[q];
        const prev = order[q > from ? q - 1 : to - 1];
        const next = nxt[i];
        let ax = 0, ay = 0;
        // 이웃과의 거리를 Leff 로
        for (const j of [prev, next]) {
          const dx = x[j] - x[i], dy = y[j] - y[i];
          const d = Math.hypot(dx, dy) || 1e-6;
          const k = (d - Leff) / d * KA;
          ax += dx * k; ay += dy * k;
        }
        // 곡률 평활 — 이웃 중점 쪽으로
        ax += ((x[prev] + x[next]) * 0.5 - x[i]) * KS;
        ay += ((y[prev] + y[next]) * 0.5 - y[i]) * KS;
        fx[i] = ax; fy[i] = ay;                  // 누적이 아니라 대입
        dens[i] = 0;
      }
    }
  }

  /**
   * 대칭 half-stencil 반발. 각 무순서 쌍을 정확히 한 번만 방문한다 —
   * 셀 내 상삼각 + OFF_X/OFF_Y 로 전방 4셀.
   */
  _repel() {
    const { cellStart, cellItems, gw, gh, R, x, y, fx, fy, dens } = this;
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        const c = cy * gw + cx;
        const a0 = cellStart[c], a1 = cellStart[c + 1];
        if (a1 <= a0) continue;
        // 셀 내부: 상삼각
        for (let a = a0; a < a1; a++) {
          const i = cellItems[a];
          for (let b = a + 1; b < a1; b++) pair(this, i, cellItems[b]);
        }
        // 전방 4셀
        for (let k = 0; k < 4; k++) {
          const nx = cx + OFF_X[k], ny = cy + OFF_Y[k];
          if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
          const d = ny * gw + nx;
          const b0 = cellStart[d], b1 = cellStart[d + 1];
          for (let a = a0; a < a1; a++) {
            const i = cellItems[a];
            for (let b = b0; b < b1; b++) pair(this, i, cellItems[b]);
          }
        }
      }
    }

    function pair(self, i, j) {
      const dx = x[i] - x[j], dy = y[i] - y[j];
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R || d2 < 1e-9) return;
      const d = Math.sqrt(d2);
      const f = (1 - d / R) * KR / d;
      fx[i] += dx * f; fy[i] += dy * f;
      fx[j] -= dx * f; fy[j] -= dy * f;
      if (dens[i] < 255) dens[i]++;
      if (dens[j] < 255) dens[j]++;
    }
  }

  _integrate(dtf) {
    const { order, flatN, x, y, fx, fy, dens, MAXSTEP } = this;
    const p = this.pointer;
    const PR = Math.min(this.w, this.h) * PR_K;
    const Leff = this.L;
    const push = PUSH_K * Leff * this.entry;
    const pull = PULL_K * Leff;
    const hovering = p.active && !p.down;
    const pressing = p.down;
    const pad = 4;

    for (let q = 0; q < flatN; q++) {
      const i = order[q];
      let ax = fx[i], ay = fy[i];

      if (hovering || pressing) {
        const dx = x[i] - p.x, dy = y[i] - p.y;
        const d = Math.hypot(dx, dy);
        if (d < PR && d > 1e-6) {
          const fall = 1 - d / PR;
          if (hovering) {
            // 커서는 조직이 피해 자라는 돌이다.
            const k = fall * fall * push / d;
            ax += dx * k; ay += dy * k;
            // pointer.vx/vy 는 CSS px per SECOND 다. engine.js 가 프레임당으로 정규화하면
            // 이 상수는 60배 과해진다 — 이 파일에서 엔진의 포인터 규약에 의존하는 유일한 숫자다.
            ax += p.vx * fall * SMEAR;
            ay += p.vy * fall * SMEAR;
          } else if (dens[i] <= DENS_OK) {
            // 프론티어만 먹이를 향해 손을 뻗는다. 균일하게 당기면 내부 노드가 직선 현으로
            // 끌려나온다.
            const k = fall * pull / d;
            ax -= dx * k; ay -= dy * k;
          }
        }
      }

      let sx = ax * dtf, sy = ay * dtf;
      const s = Math.hypot(sx, sy);
      if (s > MAXSTEP) { const k = MAXSTEP / s; sx *= k; sy *= k; }
      x[i] = clamp(x[i] + sx, pad, this.w - pad);
      y[i] = clamp(y[i] + sy, pad, this.h - pad);
    }
  }

  _grow(dt, Leff) {
    const { order, ringStart, ringN, dens, nxt, x, y, SPLIT } = this;
    for (let r = 0; r < ringN; r++) {
      const from = ringStart[r], to = ringStart[r + 1];
      const len = to - from;
      if (len < 3) continue;
      // 링마다 다른 성장률 — 8개 군체가 눈에 보이게 다른 속도로 자란다.
      const jitter = 0.85 + 0.30 * fract(r * 0.618);
      this.splitAccR[r] += GR * jitter * this.growthMul * len * dt;
      let take = Math.floor(this.splitAccR[r]);
      this.splitAccR[r] -= take;

      const p = this.pointer;
      const PR = Math.min(this.w, this.h) * PR_K;
      while (take-- > 0) {
        let i = order[from + ((this.rnd() * len) | 0)];
        // 누르고 있으면 삽입 지점의 75% 를 커서 근처에서 뽑고 밀도 게이트를 완화한다.
        let gate = DENS_OK;
        if (p.down && this.rnd() < 0.75) {
          let best = -1, bd = Infinity;
          for (let s = 0; s < 6; s++) {
            const c = order[from + ((this.rnd() * len) | 0)];
            const d = Math.hypot(x[c] - p.x, y[c] - p.y);
            if (d < bd) { bd = d; best = c; }
          }
          if (best >= 0 && bd < PR) { i = best; gate = DENS_OK + 2; }
        }
        if (dens[i] > gate) continue;            // 여기는 자리가 없다
        if (this._insertAfter(i) < 0) break;     // 예산 소진
      }

      // 해상도 패스: SPLIT 보다 긴 에지에 중점을 넣는다
      let i = this.ringHead[r], guard = 0;
      if (i < 0) continue;
      const start = i;
      do {
        const j = nxt[i];
        const dx = x[j] - x[i], dy = y[j] - y[i];
        if (dx * dx + dy * dy > SPLIT * SPLIT) {
          if (this._insertAfter(i) < 0) break;
          i = nxt[i];                            // 새로 넣은 노드를 건너뛴다
        }
        i = nxt[i];
      } while (i !== start && ++guard < len * 2 + 8);
    }
  }

  /**
   * 드로우 콜 7회. ImageData 없음, 가산 합성 없음.
   * 링 슬라이스별로 걸어야 한다 — order[] 를 평탄하게 순회하면 링 A 의 머리에서 링 B 로
   * 직선 현이 그려져 렌더 오류처럼 보이는 글리치가 된다. 이걸 "최적화" 로 평탄화하면 재발한다.
   */
  _draw() {
    const g = this.ctx, w = this.w, h = this.h;
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = BG;
    g.fillRect(0, 0, w, h);                      // 불투명 — 01 의 잔상을 확실히 지운다

    if (!this.flatN || this.vis <= 0) return;

    const { order, ringStart, ringN, gen, nxt, x, y } = this;
    const lw = Math.max(0.9, 0.105 * this.L);
    const nb = PAL.length;
    const gk = nb / Math.max(1, this.maxGen);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = lw;

    for (let b = 0; b < nb; b++) {
      const passes = b === nb - 1 ? 3 : 1;       // 프론티어만 3중 색수차
      for (let pz = 0; pz < passes; pz++) {
        g.strokeStyle = passes === 3 ? FRINGE[pz] : PAL[b];
        g.globalAlpha = this.vis * (passes === 3 ? FRINGE_ALPHA[pz] : 0.5 + 0.12 * b);
        const ox = passes === 3 ? FRINGE_DX[pz] : 0;
        g.beginPath();
        for (let r = 0; r < ringN; r++) {
          const from = ringStart[r], to = ringStart[r + 1];
          if (to - from < 3) continue;
          let open = false;
          for (let q = from; q < to; q++) {
            const i = order[q];
            const j = nxt[i];
            const bi = Math.min(nb - 1, (gen[i] * gk) | 0);
            if (bi !== b) { open = false; continue; }
            if (!open) { g.moveTo(x[i] + ox, y[i]); open = true; }
            g.lineTo(x[j] + ox, y[j]);
          }
        }
        g.stroke();
      }
    }
    g.globalAlpha = 1;                           // 01/02/03 이 부분 알파를 물려받지 않게
  }
}

function fract(v) { return v - Math.floor(v); }
