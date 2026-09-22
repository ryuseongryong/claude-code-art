// main.js — 뷰 컨트롤러
//
// 세 뷰(아트리움 / 갤러리 / 전시실)를 body[data-view] 로 전환한다.
// 전시실의 캔버스는 단 하나이고 작품이 그 위에 마운트/언마운트된다.
//
// 규율 두 가지:
//   (a) 작품을 바꿀 때 반드시 이전 piece.destroy() 를 먼저 부른다. 그리고 그것만으로는
//       부족하다 — 라우터는 async(await import)이므로 generation 토큰으로 직렬화한다.
//   (b) import 가 실패하면 검은 화면으로 두지 않고 플래카드에 사유를 적는다.

import { WINGS, WORKS } from './data.js';
import { makeControlHost } from './engine.js';

// ============================================================================
// 상수
// ============================================================================

const FADE_MS = 450;            // #stage 의 opacity 트랜지션과 같아야 한다
// 체류 29100ms + 페이드 450x2 = 정확히 30000ms 주기. 30000 으로 잡으면 작품마다 3% 밀린다.
const TOUR_DWELL_MS = 29100;

const CAPTION_DELAY_MS = 3000;  // 입장 후 캡션이 나타나기까지
const CAPTION_BACK_MS = 1800;   // 포인터가 멈춘 뒤 다시 나타나기까지
const CAPTION_MAX_SHOWS = 3;    // 이만큼 보여주면 영구히 물러난다
const CAPTION_MAX_MS = 45000;

// 드리프트 임계. 캡션이 투어보다 낮은 이유: 캡션은 먼저 비켜야 하고 투어는 버텨야 한다.
const DRIFT_CAPTION = 24;       // CSS px 누적
const DRIFT_TOUR = 48;
const DRIFT_RESET_MS = 400;     // 이만큼 포인터 이벤트가 없으면 누적을 0 으로

const PREVIEW_DELAY_MS = 120;   // 호버 의도 디바운스
const PREVIEW_BUDGET = 0.18;
const PREVIEW_FPS = 24;

const ENTER_KEY = 'gh:entered';
const CHOREO_MS = 2000;

// 투어를 취소하지 않는 키. Cmd-Tab / Alt-Tab 으로 창에 돌아오면 맨 Meta/Alt keydown 이
// 배달되므로(실측), 이걸 걸러내지 않으면 키오스크가 관람객이 아무것도 하기 전에 죽는다.
const BARE_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Tab', 'F5',
                           'NumLock', 'ScrollLock', 'ContextMenu', 'Dead', 'Unidentified']);

// ============================================================================
// 파생 데이터 — 한 곳에서만 만든다
// ============================================================================

// 열린 작품 목록. 이전/다음과 자동 관람이 모두 이 배열을 쓴다. 한 곳에서 파생하는 것이
// "다음은 Soon 을 건너뛰고 순환한다" 를 두 군데서 따로 구현하지 않는 유일한 방법이다.
const OPEN = WORKS.filter((w) => w.module);
const BY_NO = new Map(WORKS.map((w) => [w.no, w]));
const wingOf = (w) => WINGS[w.wing];

// ============================================================================
// DOM
// ============================================================================

const $ = (sel) => document.querySelector(sel);
const body = document.body;
const stage = $('#stage');
const placardHost = makeControlHost($('#p-controls'));
const captionEl = $('#caption');
const liveEl = $('#live');
const previewCanvas = $('#preview');

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

// ============================================================================
// 상태
// ============================================================================

let piece = null;               // 전시실에 마운트된 작품
let current = -1;               // OPEN 안의 인덱스 (-1 = 없음)
let gen = 0;                    // 라우팅 세대 토큰 — async 전이를 직렬화한다

const caption = { state: 'hidden', shows: 0, shownAt: 0, timer: 0, retired: false };
const tour = { on: false, timer: 0, ac: null };
const preview = { piece: null, card: null, timer: 0, no: null };

// 드리프트 감지기 하나, 소비자 셋(캡션·투어·프리뷰). 이벤트별 크기로는 지터와 의도를
// 구분할 수 없다 — 1px 떨림 3번의 movementX/Y 는 {0,1} {0,0} {0,0} 이고 283px 스윕은
// 10 이벤트에 282.1px 를 누적한다(실측). 누적 거리만이 깨끗하게 갈라진다.
const drift = { acc: 0, lastAt: 0, lx: 0, ly: 0, has: false };

// ============================================================================
// 유틸
// ============================================================================

function nextFrame() {
  return new Promise((res) => requestAnimationFrame(() => res()));
}

function afterTransition(el, ms) {
  if (reduced.matches) return Promise.resolve();   // transition:none 이면 이벤트가 안 온다
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (done) return; done = true; el.removeEventListener('transitionend', fin); res(); };
    el.addEventListener('transitionend', fin);
    setTimeout(fin, ms + 120);
  });
}

function announce(text) { liveEl.textContent = text; }

// ============================================================================
// 갤러리 — 정확히 한 번 빌드한다
// ============================================================================

function buildGallery() {
  const root = $('#wings');
  const nav = $('#topnav');
  let i = 0;                    // stagger 순서. Soon 카드도 순서를 차지한다.

  for (const key of Object.keys(WINGS)) {
    const wing = WINGS[key];
    const works = WORKS.filter((w) => w.wing === key);
    if (!works.length) continue;

    const section = document.createElement('section');
    section.className = 'wing';
    section.id = `wing-${key}`;
    // 관 accent 를 여기 주입하면 자손 카드가 전부 물려받는다 — 관을 더해도 CSS 를 고칠 일이 없다.
    section.style.setProperty('--accent', wing.accent);

    const link = document.createElement('a');
    link.className = 'topnav__link';
    link.href = '#gallery';
    link.dataset.wing = key;
    link.textContent = `${wing.index} ${wing.name}`;
    link.addEventListener('click', () => {
      location.hash = '#gallery';
      requestAnimationFrame(() => section.scrollIntoView({ block: 'start' }));
    });
    nav.appendChild(link);

    const head = document.createElement('div');
    head.className = 'wing__head';
    // innerHTML 은 보간 없는 정적 마크업이다(빈 껍데기만 만든다). 카탈로그 값은 전부
    // 아래의 textContent 로만 들어간다 — data.js 에 무엇이 들어와도 HTML 로 해석되지 않는다.
    head.innerHTML = `<span class="wing__index"></span><h3 class="wing__name"></h3>
                      <span class="wing__ko"></span><span class="wing__sub"></span>`;
    head.querySelector('.wing__index').textContent = wing.index;
    head.querySelector('.wing__name').textContent = wing.name;
    head.querySelector('.wing__ko').textContent = wing.ko;
    head.querySelector('.wing__sub').textContent = wing.sub;
    section.appendChild(head);

    const blurb = document.createElement('p');
    blurb.className = 'wing__blurb';
    blurb.textContent = wing.blurb;
    section.appendChild(blurb);

    const grid = document.createElement('div');
    grid.className = 'wing__works';

    for (const w of works) {
      const open = Boolean(w.module);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.dataset.no = w.no;
      card.style.setProperty('--i', String(i++));
      if (!open) {
        // disabled 가 아니라 aria-disabled 다. disabled 는 탭 순서에서 빼버려서 스크린리더
        // 사용자가 "작품 05, Soon" 을 들을 수 없다 — 그건 전시 정보다.
        card.setAttribute('aria-disabled', 'true');
        card.dataset.state = 'soon';
      }
      card.setAttribute('aria-label',
        `${w.no} ${w.title} ${w.ko}${open ? '' : ' — 아직 열리지 않았습니다'}`);
      // 위와 같다: 정적 껍데기 + textContent 만.
      card.innerHTML = `<span class="card__no"></span><span class="card__state"></span>
                        <h4 class="card__title"></h4><p class="card__ko"></p>
                        <p class="card__medium"></p>`;
      card.querySelector('.card__no').textContent = `No. ${w.no}`;
      card.querySelector('.card__state').textContent = open ? 'OPEN' : 'SOON';
      card.querySelector('.card__title').textContent = w.title;
      card.querySelector('.card__ko').textContent = w.ko;
      card.querySelector('.card__medium').textContent = `${w.medium} · ${w.year}`;

      card.addEventListener('click', () => {
        if (!w.module) { flashUnavailable(w.no); return; }
        goToWork(w.no);
      });
      if (open) {
        card.addEventListener('pointerenter', (e) => {
          if (e.pointerType === 'touch') return;
          schedulePreview(card, w);
        });
        card.addEventListener('pointerleave', () => stopPreview());
        card.addEventListener('focus', () => stopPreview());
      }
      grid.appendChild(card);
    }

    section.appendChild(grid);
    root.appendChild(section);
  }

  $('#meta-works').textContent = `${WORKS.length} WORKS`;
  $('#meta-wings').textContent = `${Object.keys(WINGS).length} WINGS`;
}

function flashUnavailable(no) {
  const card = document.querySelector(`.card[data-no="${no}"]`);
  if (!card) return;
  card.classList.remove('is-unavailable');
  void card.offsetWidth;                  // 애니메이션 재시작
  card.classList.add('is-unavailable');
  setTimeout(() => card.classList.remove('is-unavailable'), 1900);
  card.scrollIntoView({ block: 'center' });
  announce(`작품 ${no} 는 아직 열리지 않았습니다`);
}

// ============================================================================
// 호버 프리뷰 — 카드마다가 아니라 공유 캔버스 하나
// ============================================================================

function schedulePreview(card, work) {
  if (preview.no === work.no) return;
  stopPreview();
  preview.timer = setTimeout(() => mountPreview(card, work), PREVIEW_DELAY_MS);
}

async function mountPreview(card, work) {
  if (body.dataset.view !== 'gallery') return;
  const my = work.no;
  preview.no = my;
  preview.card = card;
  card.appendChild(previewCanvas);
  try {
    const mod = await import(work.module);
    if (preview.no !== my) return;         // 그 사이 다른 카드로 넘어갔다
    const p = new mod.default();
    // 프리뷰는 60fps 를 낼 필요가 없고, 작품의 비용은 면적 비례 + budgetScale 이라
    // 260x160 카드에서는 저절로 싸진다. 실측: 작품 01 이 0.487ms, 작품 02 는 격자가
    // 면적 비례이므로 4000칸.
    p.mount(previewCanvas, { budgetScale: PREVIEW_BUDGET, fps: PREVIEW_FPS });
    preview.piece = p;
    requestAnimationFrame(() => previewCanvas.classList.add('is-on'));
  } catch (e) {
    console.warn('프리뷰 로드 실패:', work.module, e);
    stopPreview();
  }
}

function stopPreview() {
  clearTimeout(preview.timer);
  preview.timer = 0;
  preview.no = null;
  previewCanvas.classList.remove('is-on');
  if (preview.piece) { preview.piece.destroy(); preview.piece = null; }
  if (previewCanvas.parentElement) previewCanvas.remove();
  preview.card = null;
}

// ============================================================================
// 도슨트 캡션 — 4상태 기계
// ============================================================================

function captionReset(work) {
  clearTimeout(caption.timer);
  caption.state = 'hidden';
  caption.shows = 0;
  caption.retired = false;
  caption.shownAt = 0;
  captionEl.dataset.state = 'hidden';
  captionEl.setAttribute('aria-hidden', 'true');
  if (!work) return;
  $('#c-no').textContent = `No. ${work.no}`;
  $('#c-title').textContent = work.title;
  $('#c-rule').textContent = work.note;
  $('#c-hint').textContent = work.hint;
  caption.timer = setTimeout(captionShow, CAPTION_DELAY_MS);
}

function captionShow() {
  if (caption.retired || body.dataset.view !== 'room') return;
  caption.state = 'shown';
  caption.shows += 1;
  caption.shownAt = performance.now();
  captionEl.dataset.state = 'shown';
  captionEl.setAttribute('aria-hidden', 'false');
}

function captionDim() {
  if (caption.state !== 'shown') return;
  caption.state = 'dimmed';
  captionEl.dataset.state = 'dimmed';
  captionEl.setAttribute('aria-hidden', 'true');
  // 충분히 보여줬으면 영구히 물러난다 — 긴 체류에서 작품을 가리지 않게.
  if (caption.shows >= CAPTION_MAX_SHOWS ||
      (caption.shownAt && performance.now() - caption.shownAt > CAPTION_MAX_MS)) {
    caption.retired = true;
    return;
  }
  clearTimeout(caption.timer);
  caption.timer = setTimeout(captionShow, CAPTION_BACK_MS);
}

function captionArm() {
  // 반복 이동은 복귀 타이머만 재무장한다. 3초 초기 지연을 되돌리지 않는다.
  if (caption.state !== 'dimmed' || caption.retired) return;
  clearTimeout(caption.timer);
  caption.timer = setTimeout(captionShow, CAPTION_BACK_MS);
}

// ============================================================================
// 드리프트 감지기 — 캡션과 투어가 공유한다
// ============================================================================

window.addEventListener('pointermove', (e) => {
  const now = performance.now();
  if (!drift.has || now - drift.lastAt > DRIFT_RESET_MS) drift.acc = 0;
  else drift.acc += Math.hypot(e.clientX - drift.lx, e.clientY - drift.ly);
  drift.lx = e.clientX; drift.ly = e.clientY; drift.lastAt = now; drift.has = true;

  if (body.dataset.view === 'room') {
    if (drift.acc > DRIFT_CAPTION) captionDim();
    else captionArm();
  }
  if (tour.on && drift.acc > DRIFT_TOUR) stopTour('포인터 이동');
}, { passive: true, capture: true });

// ============================================================================
// 자동 관람
// ============================================================================

function startTour() {
  if (tour.on || !OPEN.length) return;
  tour.on = true;
  $('[data-action="tour"]').setAttribute('aria-pressed', 'true');
  $('#tourbar').hidden = false;

  // 취소 감지기는 window 에, 투어 소유 AbortController 로 붙인다. 캔버스에 붙이지 않는
  // 이유: 투어 취소가 작품의 포인터 처리를 건드려서는 안 된다. 작품 01 의 바람은 투어
  // 중에도 계속 불어야 한다 — 투어 취소는 30초 진행 타이머만 멈춘다.
  tour.ac = new AbortController();
  const signal = tour.ac.signal;
  const opt = { capture: true, passive: true, signal };
  window.addEventListener('pointerdown', (e) => { if (e.isPrimary) stopTour('클릭'); }, opt);
  window.addEventListener('click', () => stopTour('클릭'), opt);
  window.addEventListener('touchstart', () => stopTour('터치'), opt);
  window.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > 8) stopTour('스크롤'); }, opt);
  window.addEventListener('keydown', (e) => {
    if (e.repeat || BARE_KEYS.has(e.key) || e.key.length > 12) return;
    stopTour('키 입력');
  }, { capture: true, signal });

  announce('자동 관람을 시작합니다');
  const start = current >= 0 ? current : 0;
  goToWork(OPEN[start].no, { fade: true }).then(armTourTimer);
}

function armTourTimer() {
  clearTimeout(tour.timer);
  if (!tour.on) return;
  tour.timer = setTimeout(() => advanceTour(), TOUR_DWELL_MS);
}

async function advanceTour() {
  if (!tour.on) return;
  // OPEN 은 module 이 있는 작품만 담으므로 여기서 Soon 을 걸러낼 필요가 없다.
  // 갓 마운트된 작품은 언제나 자기 주기의 시작이라 "용해 중인 작품으로 들어가는" 경우도 없다.
  const next = (current + 1) % OPEN.length;
  await goToWork(OPEN[next].no, { fade: true });
  armTourTimer();
}

function stopTour(why) {
  if (!tour.on) return;
  tour.on = false;
  clearTimeout(tour.timer);
  if (tour.ac) { tour.ac.abort(); tour.ac = null; }
  $('[data-action="tour"]').setAttribute('aria-pressed', 'false');
  $('#tourbar').hidden = true;
  announce(`자동 관람을 해제했습니다 (${why})`);
}

// ============================================================================
// 라우터
//
// hashchange 만 듣는다. popstate 도 들으면 location.hash = '#work-02' 한 번에 핸들러가
// 2회 호출된다(실측 — Chrome 이 same-document 해시 할당에 둘 다 발사). 핸들러가 async
// (await import)이므로 두 실행이 모두 destroy 를 지나쳐 두 작품이 같은 캔버스에 동시에
// 그려진다. pushState 는 쓰지 않는다 — 아무 이벤트도 발사하지 않아(실측) 수동 렌더
// 호출이 필요해지고 분기가 재발한다.
// ============================================================================

function hash() { return location.hash.replace(/^#/, ''); }

function goToWork(no, opts) {
  const target = `#work-${no}`;
  if (location.hash === target) return route(opts);   // 같은 해시 재할당은 무이벤트다
  pendingOpts = opts;
  location.hash = target;
  return routePromise();
}

// hashchange 로 진입하는 route() 에 옵션을 전달하기 위한 한 칸 버퍼
let pendingOpts = null;
let routeResolvers = [];
function routePromise() {
  return new Promise((res) => routeResolvers.push(res));
}
function settleRoute() {
  const rs = routeResolvers; routeResolvers = [];
  for (const r of rs) r();
}

async function route(optsOverride) {
  const my = ++gen;
  const opts = optsOverride || pendingOpts || {};
  pendingOpts = null;
  const h = hash();

  // --- 아트리움 ---
  if (h === '') { leaveRoom(); setView('atrium'); settleRoute(); return; }

  // --- 갤러리 ---
  if (h === 'gallery') { leaveRoom(); setView('gallery'); settleRoute(); return; }

  const m = h.match(/^work-(\w+)$/);
  if (!m) { leaveRoom(); setView('gallery'); settleRoute(); return; }

  const work = BY_NO.get(m[1]);

  // --- 카탈로그에 없는 번호 --- 갤러리로. 아트리움이 아니다: 작품을 찾아온 사람을
  // 작품이 있는 곳에 둔다. 낡은 북마크는 소리칠 일이 아니라 토스트도 띄우지 않는다.
  if (!work) { leaveRoom(); setView('gallery'); settleRoute(); return; }

  // --- 아직 열리지 않은 작품 --- import 전에 가드한다. 안 그러면 await import(null) 의
  // 리졸버 오류 문구가 관람객에게 노출된다.
  if (!work.module) {
    leaveRoom();
    setView('gallery');
    flashUnavailable(work.no);
    settleRoute();
    return;
  }

  await showWork(work, my, opts);
  settleRoute();
}

function setView(v) {
  if (body.dataset.view === v) return;
  body.dataset.view = v;
  if (v !== 'gallery') stopPreview();
  if (v === 'atrium' || v === 'gallery') {
    document.documentElement.style.removeProperty('--accent');
  }
}

function leaveRoom() {
  clearTimeout(caption.timer);
  captionEl.dataset.state = 'hidden';
  captionEl.setAttribute('aria-hidden', 'true');
  if (piece) { piece.destroy(); piece = null; }
  current = -1;
  stage.classList.remove('is-fading');
  stage.setAttribute('aria-label', '');
  placardHost.clear();
}

async function showWork(work, my, opts) {
  const idx = OPEN.findIndex((w) => w.no === work.no);
  const wing = wingOf(work);
  const fade = Boolean(opts.fade) && piece && !reduced.matches;

  if (fade) {
    stage.classList.add('is-fading');
    await afterTransition(stage, FADE_MS);
    if (my !== gen) return;
  }

  // 규율 (a): 다음 작품을 마운트하기 전에 반드시 이전 것을 destroy 한다.
  // 엔진의 destroy() 가 캔버스까지 지운다 — 작품 01 은 캔버스를 지우지 않고 세척만 하므로
  // 작품 02 의 무늬가 잔존율 0.934^n 로 남아 페이드인 내내 보인다(250ms 후 35.9%).
  if (piece) { piece.destroy(); piece = null; }
  placardHost.clear();

  setView('room');
  current = idx;
  document.documentElement.style.setProperty('--accent', wing.accent);

  $('#p-no').textContent = `No. ${work.no}`;
  $('#p-wing').textContent = `${wing.index} · ${wing.sub}`;
  $('#p-title').textContent = work.title;
  $('#p-ko').textContent = work.ko;
  $('#p-medium').textContent = `${work.medium} · ${work.year}`;
  $('#p-note').textContent = work.note;
  $('#a-where').textContent = `${idx + 1} / ${OPEN.length}`;
  $('#p-error').hidden = true;
  stage.setAttribute('aria-label', `${work.title} — ${work.note}`);
  captionReset(work);

  try {
    const mod = await import(work.module);
    // 로딩 중에 방문자가 다른 카드를 눌렀다 — 이 마운트를 포기한다. 규율 (a) 를
    // destroy 만으로 지킬 수 없는 이유가 이 레이스다.
    if (my !== gen) return;
    if (typeof mod.default !== 'function') throw new TypeError('default export 가 클래스가 아닙니다');

    piece = new mod.default();
    // 규율 (b): 작품이 프레임 안에서 던져도 검은 화면으로 두지 않는다.
    piece.onError = (err) => failPlacard(work, err, '작품 실행 중 오류');
    piece.mount(stage);
    if (typeof piece.controls === 'function') piece.controls(placardHost);

    // 페이드인 전에 한 프레임 기다린다 — frame() 이 최소 한 번 그리게. 이게 없으면
    // 빈 캔버스에 페이드인해 희끗한 팝이 보인다.
    await nextFrame();
    if (my !== gen) return;
    stage.classList.remove('is-fading');
  } catch (err) {
    if (my !== gen) return;
    stage.classList.remove('is-fading');
    failPlacard(work, err, '작품을 불러오지 못했습니다');
  }
}

function failPlacard(work, err, label) {
  const el = $('#p-error');
  el.hidden = false;
  el.textContent = `${label}\n${work.module} — ${err && err.message ? err.message : String(err)}`;
  console.error(`[main] ${label}: ${work.module}`, err);
  announce(label);
  stopTour('로드 실패');
}

// ============================================================================
// 이전 / 다음 — OPEN 배열만 인덱싱하므로 Soon 작품은 자동으로 건너뛴다
// ============================================================================

function step(delta) {
  if (!OPEN.length) return;
  const base = current < 0 ? 0 : current;
  const i = (base + delta + OPEN.length) % OPEN.length;
  goToWork(OPEN[i].no, { fade: true });
  if (tour.on) armTourTimer();
}

// ============================================================================
// 입력
// ============================================================================

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  switch (btn.dataset.action) {
    case 'home':  location.hash = ''; break;
    case 'enter': location.hash = '#gallery'; break;
    case 'exit':  location.hash = '#gallery'; break;
    case 'prev':  step(-1); break;
    case 'next':  step(+1); break;
    case 'tour':  tour.on ? stopTour('버튼') : startTour(); break;
  }
});

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'Escape') {
    if (body.dataset.view === 'room') location.hash = '#gallery';
    else if (body.dataset.view === 'gallery') location.hash = '';
    return;
  }
  // 나가기는 data-view 를 직접 바꾸지 않고 해시로 한다. 같은 해시 재할당은 아무 이벤트도
  // 내지 않아서(실측), URL 이 #work-01 인 채로 나가면 같은 카드를 다시 눌러도 죽는다.
  if (k === 'ArrowLeft' && body.dataset.view === 'room') { step(-1); return; }
  if (k === 'ArrowRight' && body.dataset.view === 'room') { step(+1); return; }
  if (k === 'p' || k === 'P') { tour.on ? stopTour('P 키') : startTour(); }
});

window.addEventListener('hashchange', () => route());

// ============================================================================
// 입장 연출 — 세션 내 재방문에는 생략
// ============================================================================

function choreograph() {
  if (reduced.matches) return;
  let seen = null;
  try { seen = sessionStorage.getItem(ENTER_KEY); } catch { seen = '1'; }   // 프라이빗 모드
  if (seen) return;
  try { sessionStorage.setItem(ENTER_KEY, '1'); } catch { /* 무해 */ }
  body.classList.add('is-entering');
  $('#gallery').classList.add('is-entering');
  // 2초 안에 끝난다. 클래스는 제거되고 다시 붙지 않으므로 전시실에서 갤러리로 돌아올 때
  // 재생되지 않는다 — 그리드는 여전히 정확히 한 번만 빌드된다.
  setTimeout(() => {
    body.classList.remove('is-entering');
    $('#gallery').classList.remove('is-entering');
  }, CHOREO_MS);
}

// ============================================================================
// 시작
// ============================================================================

buildGallery();
choreograph();
route();

// 자동 관람을 자동으로 시작하지 않는다. 요청하지 않은 30초 작품 교체 캐러셀이 바로
// prefers-reduced-motion 이 막으려는 전정기관 자극이다. P 키와 버튼은 계속 작동한다.
reduced.addEventListener('change', () => { if (reduced.matches) stopTour('모션 축소 설정'); });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(tour.timer); stopPreview(); }
  else if (tour.on) armTourTimer();
});

window.__gh = {
  view: () => body.dataset.view,
  state: () => ({
    view: body.dataset.view, hash: location.hash, current,
    open: OPEN.map((w) => w.no),
    piece: piece && { n: piece.n, cells: piece.NC, frameMs: +piece.frameMs.toFixed(1),
                      budget: piece.budgetScale, w: piece.w, h: piece.h },
    caption: { ...caption, timer: undefined },
    tour: { on: tour.on },
    preview: { no: preview.no, mounted: Boolean(preview.piece) },
    error: $('#p-error').hidden ? null : $('#p-error').textContent,
  }),
  startTour, stopTour, step, goToWork,
  rawPiece: () => piece,          // 디버그: 작품 내부 상태를 직접 들여다볼 때만 쓴다
  hoverCard: (no) => {
    const card = document.querySelector(`.card[data-no="${no}"]`);
    card.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: false }));
  },
  unhoverCard: (no) => {
    const card = document.querySelector(`.card[data-no="${no}"]`);
    card.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse', bubbles: false }));
  },
};
