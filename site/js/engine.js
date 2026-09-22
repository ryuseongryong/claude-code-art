// engine.js — Piece 기반 클래스와 컨트롤 팩토리
//
// 하드 제약: 이 파일은 모듈 스코프에서 document 나 window 를 만지지 않는다.
// 클래스/함수 정의와 순수 상수만 모듈 스코프에 둔다. 이 제약이 verify.mjs 를 가능하게 한다 —
// Node 에는 document/window 전역이 없으므로 모듈 스코프의 DOM 접근은 import 시점에 던진다.
// 주의: `static HOST = document.body` 같은 정적 필드도 클래스 정의 시점에 평가되므로 위반이다.
// 그리고 `typeof window !== 'undefined' && window.matchMedia(...)` 같은 가드형 우회는 Node 에서
// 조용히 통과하므로 verify.mjs 가 소스도 스캔한다.
//
// 소유 분담
//   엔진: 캔버스 리사이즈, 백킹스토어 스케일, RAF 핸들, dt/t/real 시계, 포인터 리스너와
//         정규화, 컨텍스트 상태 리셋, 캔버스 지우기, 컨트롤 호스트, 리스너/타이머 해제
//   작품: setup(), frame(dt, t)            [필수]
//         onResize(), onPointerDown(), onPointerUp(), controls(host),
//         pixelSize(cssW, cssH), teardown() [선택]
//
// 작품은 destroy() 를 재정의하지 않는다. 정리 훅은 teardown() 이다.
// 실측: destroy() 를 재정의하고 super.destroy() 를 잊으면 RAF 가 살아남고(live RAF handles = 1),
// 메서드를 non-writable 로 만들어도 서브클래스가 섀도잉할 수 있다. 그래서 규율이 아니라
// verify.mjs 가 정적으로 검사한다 — 어떤 piece 의 own prototype 에도 destroy 가 없어야 한다.

// ============================================================================
// 순수 상수
// ============================================================================

export const TAU = Math.PI * 2;

// dt 는 물리용이라 1/20초로 캡한다 — 탭을 나갔다 돌아왔을 때 적분기가 터지지 않게.
// real 은 UI 성 타이밍용이라 캡이 더 느슨하다. 둘이 필요한 이유: 프레임이 116ms 걸리는
// 기계에서 dt 는 0.05 만 나아가고 벽시계는 0.117 이 흐른다(실측 비율 0.43). 물리에는 그게
// 맞지만 "길게 누르면 1.4초에 걸쳐 충전" 은 관람객에게 한 약속이라 실경과로 재야 한다.
export const DT_CAP = 1 / 20;
export const REAL_CAP = 0.25;

// DPR 상한 2 만으로는 부족하다. 3840x2160 @dpr2 는 7680x4320 = 33.2M px = 126.6 MiB 이고,
// 모든 작품이 매 프레임 하는 전면 fillRect 하나가 10.79ms — 예산의 65% 를 입자 한 개
// 그리기 전에 쓴다(실측 0.33 ns/px, 완전 선형). 아래 상한은 1920x1080@2, 2560x1440@2,
// 3840x2160@2·@3 을 모두 2309x1299 = 2,999,391 px = 11.4 MiB ~ 0.97ms 로 수렴시킨다.
export const PX_CAP = 3_000_000;
export const MAX_DIM = 4096;      // 여러 모바일 GPU 가 이 위의 캔버스를 거부한다

// 자동 감쇠. 기준은 절대 ms 가 아니라 "관측된 최소 rAF 간격"(= 화면의 vsync 주기)의 배수다.
// 절대값으로 하면 60Hz 에서 여유롭게 60fps 를 내는 작품도 간격이 정확히 16.7ms 로 나와
// 복구 조건(<5ms)을 영원히 만족하지 못한다 — 한 번 감쇠하면 다시 못 올라간다.
const DEGRADE_MULT = 1.5;       // 최소 간격의 1.5배를 넘으면 느린 것 (60Hz -> 25ms).
                                // 1.35 는 과민했다 — 열 프레임에 한 번 떨어지는 작품도
                                // EWMA 24ms 가 되어 불필요하게 감쇠했다(작품 03 실측).
const RESTORE_MULT = 1.12;      // 1.12배 미만이면 매 프레임 vsync 를 맞히는 것 (-> 18.7ms)
const DEGRADE_MS_FLOOR = 20;    // 아주 빠른 화면(165Hz)에서 과민해지지 않게
const DEGRADE_FRAMES = 60;
const RESTORE_FRAMES = 180;
const BUDGET_MIN = 0.25;
const INTERVAL_FLOOR = 6;       // ms — 165Hz 도 6.06ms 다
const WARMUP_FRAMES = 20;       // 내비게이션 직후의 몰린 rAF 를 minIv 관측에서 제외한다
const BUDGET_COOLDOWN_MS = 2500; // 예산 조정 사이의 최소 벽시계 간격

// ============================================================================
// 유틸 — 순수 함수
// ============================================================================

export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

export function lerp(a, b, t) { return a + (b - a) * t; }

export function smoothstep(lo, hi, x) {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 백킹스토어 배율. DPR 상한 2 + 절대 픽셀 상한 + 변 길이 상한을 동시에 적용한다. */
export function backingScale(cssW, cssH, dpr) {
  let s = Math.min(dpr || 1, 2, Math.sqrt(PX_CAP / Math.max(1, cssW * cssH)));
  const bw = cssW * s, bh = cssH * s;
  if (bw > MAX_DIM || bh > MAX_DIM) s *= MAX_DIM / Math.max(bw, bh);
  return s;
}

/**
 * xorshift32 PRNG 팩토리. 작품마다 자기 시드로 자기 인스턴스를 만든다.
 * 공유하지 않는 이유: 한 작품의 난수 소비가 다른 작품의 장면을 바꾸는 결합이 생긴다.
 */
export function makeRng(seed) {
  let s = (seed | 0) || 0x9e3779b9;
  return function rnd() {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// ============================================================================
// Piece
// ============================================================================

export class Piece {
  // 진짜 private. `_` 는 관례일 뿐이어서 작품이 같은 이름을 쓰면 엔진이 조용히 오작동한다
  // (작품 04 가 _reset() 을 정의했더니 mount() 가 setup() 전에 그것을 불러 터졌다).
  // #private 는 언어 차원에서 섀도잉이 불가능하므로 이 버그 계열이 구조적으로 사라진다.
  #raf;
  #lastMs;
  #dead;
  #mounted;
  #ac;
  #timers;
  #disposers;
  #raw;
  #lastPx;
  #lastPy;
  #ewma;
  #bodyEwma;
  #minIv;
  #frames;
  #throttleMs;
  #slow;
  #fast;
  #lastBudgetAt;
  #minFrameMs;
  #cursor;

  constructor() {
    // --- 엔진이 채우는 것 ---
    this.canvas = null;
    this.ctx = null;
    this.w = 0;                 // CSS px — 작품이 쓰는 논리 좌표계
    this.h = 0;
    this.scale = 1;             // 백킹스토어 배율
    this.pw = 0;                // 백킹스토어 크기 (px)
    this.ph = 0;
    this.t = 0;                 // 누적 시간 (s), dt 캡이 적용된 것
    this.real = 0;              // 이번 프레임의 실경과 (s), REAL_CAP 캡

    // 포인터. 좌표는 CSS px, 속도는 CSS px per SECOND.
    this.pointer = { x: -1e5, y: -1e5, vx: 0, vy: 0, active: false, down: false };

    // 비용 손잡이. 작품은 자기 작업량을 면적의 함수로 선언하고 여기에 곱한다.
    // 프리뷰 호스트가 낮추고, 아래 자동 감쇠도 이 값을 움직인다.
    this.budgetScale = 1;

    // --- 내부 ---
    this.#raf = 0;
    this.#lastMs = 0;
    this.#dead = false;
    this.#mounted = false;
    this.#ac = null;            // AbortController — 엔진을 거친 모든 리스너
    this.#timers = new Set();
    this.#disposers = [];
    this.#raw = { x: -1e5, y: -1e5, down: false, active: false };
    this.#lastPx = -1e5;
    this.#lastPy = -1e5;
    this.#ewma = 16.7;          // rAF 간격 EWMA (ms) — 거버너가 보는 값
    this.#bodyEwma = 0;         // frame() 본문 시간 EWMA (ms) — 진단용
    this.#minIv = 16.7;         // 관측된 최소 rAF 간격 = vsync 주기의 대리값
    this.#frames = 0;
    this.#throttleMs = 0;       // 프리뷰 스로틀 목표 (ms), 0 이면 없음
    this.#slow = 0;
    this.#fast = 0;
    this.#lastBudgetAt = -1e9;
    this.onError = null;        // main.js 가 꽂는다 — 플래카드에 사유를 쓰기 위해
  }

  // --------------------------------------------------------------- 생명주기

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{budgetScale?: number, fps?: number}} [opts]
   */
  mount(canvas, opts = {}) {
    if (this.#mounted) return this;
    this.#mounted = true;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (opts.budgetScale) this.budgetScale = opts.budgetScale;
    // 프리뷰는 60fps 를 낼 필요가 없다. 스로틀을 걸면 거버너의 기준도 같이 올려야 한다 —
    // 안 그러면 20fps 로 의도적으로 제한한 프리뷰가 "느리다" 고 판정되어 끝없이 감쇠한다.
    this.#minFrameMs = opts.fps ? 1000 / opts.fps : 0;
    this.#throttleMs = this.#minFrameMs;
    this.#ewma = this.#minFrameMs || 16.7;
    this.#minIv = this.#ewma;
    this.#frames = 0;

    this.#ac = new AbortController();
    const signal = this.#ac.signal;
    const c = canvas;

    // 포인터: 이벤트는 원시 상태만 기록하고 프레임 경계에서 한 번 스냅샷한다.
    // 한 프레임에 pointermove 가 여러 번 오면 속도가 왜곡되기 때문이다.
    const at = (e) => {
      const r = c.getBoundingClientRect();
      this.#raw.x = e.clientX - r.left;
      this.#raw.y = e.clientY - r.top;
    };
    c.addEventListener('pointerdown', (e) => {
      at(e);
      this.#raw.down = true;
      this.#raw.active = true;
      // 터치 탭은 pointermove 를 전혀 만들지 않으므로(실측) active 를 down 과 함께 켠다.
      try { c.setPointerCapture(e.pointerId); } catch { /* 캡처 불가 — 무해 */ }
      this.#call('onPointerDown');
    }, { signal });
    c.addEventListener('pointermove', (e) => { at(e); this.#raw.active = true; }, { signal });
    c.addEventListener('pointerup', (e) => {
      at(e);
      this.#raw.down = false;
      if (e.pointerType === 'touch') this.#raw.active = false;
      this.#call('onPointerUp');
    }, { signal });
    c.addEventListener('pointercancel', () => {
      this.#raw.down = false; this.#raw.active = false;
      this.#call('onPointerUp');
    }, { signal });
    c.addEventListener('pointerleave', () => { this.#raw.active = false; }, { signal });
    c.addEventListener('pointerenter', () => { this.#raw.active = true; }, { signal });

    // 리사이즈: ResizeObserver 가 window.resize 보다 정확하다(요소가 레이아웃으로 바뀔 때도 잡는다).
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this.#resize());
      ro.observe(c);
      this.#disposers.push(() => ro.disconnect());
    } else {
      this.on(c.ownerDocument.defaultView, 'resize', () => this.#resize());
    }

    this.#resize();          // setup() 전에 w/h 와 백킹스토어를 확정한다
    this.#resetCtx();           // 컨텍스트 상태를 알려진 값으로
    this.#clear();           // 이전 작품의 픽셀을 지운다 — 작품에 맡기지 않는다
    this.setup();
    this.#paintBg();         // setup 마지막에 한 번 — 첫 프레임 흰 번쩍임 방지
    this.#resetCtx();

    this.#lastMs = performance.now();
    this.#raf = requestAnimationFrame(this.#tick);
    return this;
  }

  /**
   * 작품이 재정의하지 않는다. 멱등이고, 작품의 teardown() 이 던져도 나머지 정리가 끝난다.
   */
  destroy() {
    if (this.#dead) return;
    this.#dead = true;
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    if (this.#ac) this.#ac.abort();          // 엔진을 거친 모든 리스너가 사라진다
    for (const id of this.#timers) clearTimeout(id);
    this.#timers.clear();
    for (const d of this.#disposers) { try { d(); } catch (e) { report(e); } }
    this.#disposers.length = 0;
    try { this.#call('teardown'); } catch (e) { report(e); }
    if (this.ctx) { this.#resetCtx(); this.#clear(); }
    this.canvas = null;
    this.ctx = null;
    this.#mounted = false;
  }

  // ------------------------------------------------------- 작품이 쓰는 엔진 API

  /** 리스너를 엔진의 AbortController 에 매어 등록한다. destroy() 가 전부 떼어낸다. */
  on(target, type, fn, opts) {
    if (!this.#ac) return;
    target.addEventListener(type, fn, { ...(opts || {}), signal: this.#ac.signal });
  }

  /** destroy() 가 자동으로 지우는 setTimeout. */
  later(fn, ms) {
    const id = setTimeout(() => { this.#timers.delete(id); fn(); }, ms);
    this.#timers.add(id);
    return id;
  }

  /** destroy() 시 호출될 정리 함수를 등록한다. */
  onDispose(fn) { this.#disposers.push(fn); }

  /**
   * rAF 간격 EWMA (ms). 자동 감쇠가 보는 값이다.
   * frame() 본문 시간이 아니라 간격을 재는 이유: 브라우저는 path 명령을 모아뒀다가
   * 컴포지트 시점에 래스터화하므로 frame() 직후의 performance.now() 는 래스터화 비용을
   * 전혀 포함하지 않는다. 실측: 작품 01 이 rAF 간격 66.7ms 일 때 본문은 5.26ms 로 나왔다
   * — 래스터화가 프레임의 94% 인데 거버너에는 보이지 않았다.
   */
  get frameMs() { return this.#ewma; }

  /** frame() 본문만의 시간 EWMA (ms). 진단용 — 래스터화는 포함되지 않는다. */
  get bodyMs() { return this.#bodyEwma; }

  // --- 진단용 getter. 내부는 #private 이므로 밖에서 읽을 통로를 명시적으로 둔다. ---
  get dead() { return this.#dead; }
  get liveRaf() { return this.#raf; }
  get minInterval() { return this.#minIv; }
  get pendingTimers() { return this.#timers.size; }
  get pendingDisposers() { return this.#disposers.length; }

  // --------------------------------------------------------- 작품이 구현하는 것

  // setup() 과 frame(dt, t) 는 필수다.
  // 여기에 던지는 스텁을 선언하지 않는다 — 스텁이 있으면 verify.mjs 의
  // `'setup' in C.prototype` 검사가 무의미해지고, 아무것도 구현하지 않은
  // 서브클래스를 통과시킨다. 없으면 런타임에 TypeError 로 즉시 드러난다.

  // --------------------------------------------------------------------- 내부

  #call(name, ...args) {
    const fn = this[name];
    if (typeof fn === 'function') return fn.apply(this, args);
    return undefined;
  }

  /** 컨텍스트 상태를 알려진 값으로 되돌린다. 한 작품이 다음 작품을 오염시키지 못하게. */
  #resetCtx() {
    const g = this.ctx;
    if (!g) return;
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.filter = 'none';
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
  }

  /**
   * 캔버스를 비운다. 필수다 — 작품 01 은 캔버스를 지우지 않고 세척만 하므로,
   * 작품 02 에서 01 로 넘어가면 반응-확산 무늬가 잔존율 0.934^n 로 남는다
   * (실측 250ms 후 35.9%, 1000ms 후 1.66%). 페이드인 내내 보인다.
   */
  #clear() {
    const g = this.ctx;
    if (!g) return;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.restore();
  }

  #paintBg() {
    const g = this.ctx;
    if (!g) return;
    g.fillStyle = this.bg || '#050507';
    g.fillRect(0, 0, this.w, this.h);
  }

  #resize() {
    const c = this.canvas;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    const view = c.ownerDocument.defaultView;
    const dpr = (view && view.devicePixelRatio) || 1;

    // 작품이 백킹스토어 크기를 직접 정할 수 있다. 작품 02 가 이걸 쓴다: 격자 크기로 잡고
    // CSS 가 늘리게 하면 컴포지터가 GPU 에서 bilinear 를 무료로 해준다(0.07ms vs JS 111ms).
    const want = this.#call('pixelSize', cssW, cssH);

    const first = (this.w === 0);
    this.w = cssW; this.h = cssH;

    if (want) {
      this.scale = 1;
      this.pw = Math.max(1, Math.round(want.w));
      this.ph = Math.max(1, Math.round(want.h));
      if (c.width !== this.pw || c.height !== this.ph) { c.width = this.pw; c.height = this.ph; }
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      // 이 경우 작품의 논리 좌표계는 백킹스토어 픽셀이다.
      this.w = this.pw; this.h = this.ph;
      this.cssW = cssW; this.cssH = cssH;
    } else {
      this.scale = backingScale(cssW, cssH, dpr);
      this.pw = Math.round(cssW * this.scale);
      this.ph = Math.round(cssH * this.scale);
      if (c.width !== this.pw || c.height !== this.ph) { c.width = this.pw; c.height = this.ph; }
      // 이후 모든 좌표는 CSS px. 이 한 줄이 "반경 150px" 를 DPR 과 무관하게
      // 물리적으로 같은 크기로 만든다.
      this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      this.cssW = cssW; this.cssH = cssH;
    }

    if (!first) { this.#resetCtx(); this.#call('onResize'); }
  }

  #snapshotPointer(dt) {
    const p = this.pointer, r = this.#raw;
    // 작품 02 처럼 논리 좌표계가 백킹스토어인 경우 CSS px 를 그 단위로 환산한다.
    const kx = this.cssW ? this.w / this.cssW : 1;
    const ky = this.cssH ? this.h / this.cssH : 1;
    p.x = r.x * kx; p.y = r.y * ky;
    p.active = r.active; p.down = r.down;

    if (this.#lastPx > -9e4 && dt > 0) {
      const rx = (p.x - this.#lastPx) / dt;
      const ry = (p.y - this.#lastPy) / dt;
      p.vx += (rx - p.vx) * 0.25;            // 저역통과 — 이벤트 단위 지터 제거
      p.vy += (ry - p.vy) * 0.25;
    }
    this.#lastPx = p.x; this.#lastPy = p.y;

    // 감쇠가 없으면 커서가 멈춘 뒤 마지막 속도가 영구히 남아 바람이 영원히 분다.
    // 0.001^dt 는 약 70ms 반감.
    const decay = Math.pow(0.001, dt);
    p.vx *= decay; p.vy *= decay;
  }

  #tick = (nowMs) => {
    if (this.#dead) return;
    this.#raf = requestAnimationFrame(this.#tick);

    const elapsed = (nowMs - this.#lastMs) / 1000;
    if (this.#minFrameMs && elapsed * 1000 < this.#minFrameMs) return;   // 프리뷰용 스로틀
    this.#lastMs = nowMs;

    const dt = Math.min(DT_CAP, elapsed);
    this.real = Math.min(REAL_CAP, elapsed);
    this.t += dt;

    this.#snapshotPointer(dt);

    const t0 = performance.now();
    try {
      this.frame(dt, this.t);
    } catch (err) {
      // 작품의 예외로 RAF 가 조용히 죽지 않게. main.js 가 플래카드에 사유를 쓴다.
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
      report(err);
      if (typeof this.onError === 'function') this.onError(err);
      return;
    }
    // 작품이 lighter 를 켜둔 채 반환해도 다음 프레임의 덮기와 다음 작품이 안전하게 시작한다.
    this.#resetCtx();

    this.#bodyEwma += (performance.now() - t0 - this.#bodyEwma) * 0.1;
    // 거버너에는 rAF 간격을 준다 — 래스터화와 컴포지트까지 포함된 유일한 정직한 척도다.
    // 첫 프레임과 탭 복귀 프레임의 병적인 간격이 EWMA 를 끌지 않도록 200ms 로 자른다.
    this.#govern(Math.min(200, elapsed * 1000));
  };

  /**
   * 자동 감쇠. "작품 04 가 기존 성능을 깨지 않는다" 를 산문이 아니라 측정으로 만든다.
   * 비용을 면적의 함수로 선언하게 하고, 느려지면 그 함수의 배율만 낮춘다.
   */
  #govern(ms) {
    this.#ewma += (ms - this.#ewma) * 0.1;

    // 관측된 최소 간격을 vsync 주기의 대리값으로 쓴다.
    // 첫 WARMUP 프레임은 무시한다 — 내비게이션 직후에는 rAF 가 몰려 발사돼 6ms 대 간격이
    // 관측되고(실측 minIv 6.3), 그러면 복구 기준이 7.1ms 로 내려가 60fps 를 내는 작품도
    // 영원히 복구되지 않는다. 그 뒤로는 1.004배/프레임으로 천천히 올라가 조건 변화를 따라간다.
    if (++this.#frames > WARMUP_FRAMES) {
      this.#minIv = Math.max(INTERVAL_FLOOR, Math.min(ms, this.#minIv * 1.004));
    }

    const degradeAt = Math.max(DEGRADE_MS_FLOOR, this.#minIv * DEGRADE_MULT, this.#throttleMs * 1.3);
    const restoreAt = Math.max(this.#minIv * RESTORE_MULT, this.#throttleMs * 1.1);

    // 쿨다운: 느린 기계에서는 60프레임이 4초 넘게 걸리므로 프레임 수만으로는 계단이
    // 촘촘해진다. 벽시계로도 최소 간격을 둬서 관람객이 연속된 조정을 알아채지 못하게 한다.
    const cool = (this.t * 1000 - this.#lastBudgetAt) > BUDGET_COOLDOWN_MS;

    if (this.#ewma > degradeAt) {
      this.#fast = 0;
      if (++this.#slow >= DEGRADE_FRAMES && cool && this.budgetScale > BUDGET_MIN) {
        this.#slow = 0;
        this.#lastBudgetAt = this.t * 1000;
        this.budgetScale = Math.max(BUDGET_MIN, this.budgetScale * 0.8);
        this.#reconfigure();
      }
    } else if (this.#ewma < restoreAt) {
      this.#slow = 0;
      if (++this.#fast >= RESTORE_FRAMES && cool && this.budgetScale < 1) {
        this.#fast = 0;
        this.#lastBudgetAt = this.t * 1000;
        this.budgetScale = Math.min(1, this.budgetScale / 0.8);
        this.#reconfigure();
      }
    } else { this.#slow = 0; this.#fast = 0; }   // 이력 구간 — 아무것도 하지 않는다
  }

  /**
   * budgetScale 이 바뀌었으니 작품을 새 예산에 맞춘다.
   *
   * setup() 을 다시 부르지 않는다. "예산 변경" 은 "리사이즈" 와 정확히 같은 문제이고
   * 두 작품의 onResize() 는 이미 리셋 없이 적응하도록 쓰여 있다(01 은 입자를 재할당하며
   * 위치를 보존하고, 02 는 격자를 최근접 재표본한다). budgetScale 은 _countFor 와
   * pixelSize 안에 들어 있으므로 _resize() 하나면 전파된다.
   *
   * 실측으로 배운 것: 처음에는 _clear() + setup() + _paintBg() 를 했는데, 느린 기계에서
   * 21초에 7번 감쇠가 일어나며 그때마다 캔버스가 지워지고 노이즈 순열까지 재생성돼
   * 작품이 계속 리셋됐다(최종 ink 0.02%). 전시장에서는 허용될 수 없다.
   */
  #reconfigure() {
    this.#resize();
    this.#resetCtx();
    this.#ewma = this.#minIv;   // 새 구성을 기준으로 다시 잰다
  }
}

// 예외를 삼키지 않고 알린다. console 은 모듈 스코프가 아니라 함수 본문에서만 쓴다.
function report(err) {
  if (typeof console !== 'undefined' && console.error) console.error('[engine]', err);
}

// ============================================================================
// 컨트롤 팩토리
//
// 작품 파일은 document 를 만지지 않는다. document.createElement 는 이 함수들의 본문에서만
// 호출되므로 모듈 스코프 제약을 위반하지 않는다(실측: 본문 안이면 Node import 가 통과한다).
// ============================================================================

/**
 * 컨트롤 호스트를 만든다. main.js 가 플래카드의 컨테이너를 넘기고, 작품의 controls(host) 가
 * host.slider / host.button / host.readout 만 쓴다.
 */
export function makeControlHost(root) {
  const doc = root.ownerDocument;

  function field(labelText, cls) {
    const wrap = doc.createElement('div');
    wrap.className = 'ctl ' + cls;
    const label = doc.createElement('span');
    label.className = 'ctl__label';
    label.textContent = labelText;
    wrap.appendChild(label);
    return { wrap, label };
  }

  return {
    root,

    slider(labelText, min, max, value, step, onInput) {
      const { wrap } = field(labelText, 'ctl--slider');
      const input = doc.createElement('input');
      input.type = 'range';
      input.min = String(min); input.max = String(max);
      input.step = String(step); input.value = String(value);
      const out = doc.createElement('span');
      out.className = 'ctl__value';
      const show = () => { out.textContent = input.value; };
      show();
      input.addEventListener('input', () => { show(); onInput(parseFloat(input.value)); });
      wrap.appendChild(input);
      wrap.appendChild(out);
      root.appendChild(wrap);
      return wrap;
    },

    button(labelText, onClick) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'ctl ctl--button';
      b.textContent = labelText;
      b.addEventListener('click', onClick);
      root.appendChild(b);
      return b;
    },

    /** 라디오처럼 동작하는 버튼 묶음. 선택된 것에 aria-pressed="true" 가 붙는다. */
    choice(labelText, options, index, onPick) {
      const { wrap } = field(labelText, 'ctl--choice');
      const group = doc.createElement('span');
      group.className = 'ctl__choices';
      const btns = options.map((opt, i) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'ctl__choice';
        b.textContent = opt;
        b.setAttribute('aria-pressed', String(i === index));
        b.addEventListener('click', () => {
          btns.forEach((x, j) => x.setAttribute('aria-pressed', String(j === i)));
          onPick(i);
        });
        group.appendChild(b);
        return b;
      });
      wrap.appendChild(group);
      root.appendChild(wrap);
      return wrap;
    },

    readout(labelText) {
      const { wrap } = field(labelText, 'ctl--readout');
      const out = doc.createElement('span');
      out.className = 'ctl__value';
      wrap.appendChild(out);
      root.appendChild(wrap);
      return { set(text) { out.textContent = text; } };
    },

    clear() { root.replaceChildren(); },
  };
}
