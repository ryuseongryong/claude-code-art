# Generative Hours — 설계 문서

제너러티브 아트 전시 사이트. 빌드 도구 없는 정적 사이트 + CDK로 S3/CloudFront 배포.
레퍼런스: <https://reborn.zerojin.art/> (같은 셸 아키텍처 — `body[data-view]`, 단일 `#stage` 캔버스, 아트리움/갤러리/전시실).

이 문서의 모든 수치는 **실측값**이다. 근거는 `docs/superpowers/specs/2026-09-22-generative-hours-audit.md`에 정리한다.
측정 환경: Graviton2 Neoverse-N1 4 vCPU, Node v20.20.2, Chromium 1243 (SwiftShader **소프트웨어 래스터** — GPU 없음).
따라서 순수 JS 수치(Perlin, Gray-Scott, ImageData 루프)는 실기와 비슷하고, 캔버스 래스터화 수치는
**비관적 상한**이다. 전이 가능한 신호는 같은 프로세스 안의 A/B 비율이다.

---

## 1. 목표와 제약

| 항목 | 내용 |
|---|---|
| 산출물 | `site/index.html`, `site/css/style.css`, `site/js/*.js`, `site/js/pieces/*.js` |
| 빌드 | 없음. ES 모듈만. 외부 런타임 라이브러리 금지(Google Fonts CSS만 허용) |
| 로컬 | `python3 -m http.server`로 열린다 (Python 3.9.25 확인) |
| 배포 | 같은 파일이 그대로 S3에 올라간다. CDK로 S3 + CloudFront(OAC) |
| 검증 | 렌더 루프 단위 테스트 없음. `node verify.mjs`로 카탈로그·Piece 계약 정적 검사 + 브라우저 육안 |
| 비사용 | Amazon Bedrock |

## 2. 전체 구조

```
media-art/
├── .gitignore                 ← !site/js/**/*.js 네거션 추가 (치명적)
├── verify.mjs                 ← 브라우저 없이 계약 검사
├── bin/media-art.ts           ← 변경 없음
├── lib/media-art-stack.ts     ← S3 + CloudFront(OAC) + BucketDeployment
└── site/
    ├── package.json           ← {"type":"module"} — ESM 범위를 site/로 한정
    ├── index.html             ← 한 문서 안에 세 뷰
    ├── css/style.css          ← 어두운 미술관 톤, 관별 accent는 CSS 변수
    └── js/
        ├── data.js            ← 순수 데이터, 로직 0
        ├── engine.js          ← Piece 기반 클래스 + 컨트롤 팩토리
        ├── main.js            ← 뷰 컨트롤러 / 라우터 / 오토투어 / 캡션 / 프리뷰
        └── pieces/
            ├── 01-currents.js
            ├── 02-morphogenesis.js
            ├── 03-gravity.js
            └── 04-overgrowth.js
```

### 2.1 리포지토리 위생 — 먼저 고칠 두 가지

**(a) `.gitignore`**. 현재 1행이 `*.js`다(CDK TS 빌드 산출물 제외용이지만 `tsconfig.json`에 `noEmit: true`가
있어 보호할 대상이 없다). `git check-ignore -v site/js/currents.js` → `.gitignore:1:*.js`. 즉 작품 파일 전체가
커밋되지 않는다. 네거션은 **반드시 재귀형**이어야 한다:

```gitignore
!site/js/**/*.js
```

`!site/js/*.js`(한 단계)는 `site/js/pieces/*.js`를 되살리지 못하고, 아무도 불평하지 않는다 —
로컬 디스크에는 파일이 있어 `verify.mjs`가 ALL PASS를 찍고, CDK도 워킹 트리에서 스테이징하므로 배포까지
정상으로 보인다. 깨지는 건 **다른 사람의 빈 클론**뿐이다. 검증: `git check-ignore -v site/js/*.js site/js/pieces/*.js`가
`!`로 시작하는 패턴만(또는 아무것도) 보고해야 한다.

**(b) `site/package.json` = `{"type":"module"}`**. `verify.mjs`가 `site/js/*.js`를 `import`할 때 Node가 ESM으로
인식해야 한다. Node 20의 무플래그 detect-module 덕에 이 파일 없이도 동작하지만 파일마다
`MODULE_TYPELESS_PACKAGE_JSON` 경고가 stderr로 쏟아져 PASS/FAIL 줄을 덮는다. 이 파일을 두면 경고가 0이 된다.

**루트** `package.json`에 `"type":"module"`을 넣으면 안 된다. 실측 결과 세 가지가 동시에 깨진다:
`tsc` → `TS2835` (bin/media-art.ts의 확장자 없는 상대 경로), `jest` → `module is not defined in ES module scope`
(jest.config.js가 CommonJS), **`cdk synth` → EXIT=1** (cdk.json의 app이 `npx tsc && …`라 앞의 실패를 물려받음).
이건 "CDK가 깨졌다"로 오진되는 함정이다.

`site/package.json`은 BucketDeployment로 S3에 올라간다(18바이트, 내용은 `{"type":"module"}`뿐).
스펙 1의 "같은 파일이 그대로 올라간다"를 지키기 위해 **제외하지 않는다**.

---

## 3. 엔진 계약 — `site/js/engine.js`

### 3.1 하드 제약

**모듈 스코프에서 `document`/`window`를 만지지 않는다.** 클래스·함수 정의와 순수 상수(`const TAU = Math.PI*2`)만
모듈 스코프에 둔다. 이 제약이 요구사항 7의 `verify.mjs`를 **가능하게 하는 유일한 조건**이다.

주의: `static HOST = document.body` 같은 정적 필드도 클래스 정의 시점에 평가되므로 위반이다.
그리고 `typeof window !== 'undefined' && window.matchMedia(…)` 같은 **가드형 우회는 Node에서 조용히 통과**한다
— 그래서 `verify.mjs`는 import에 더해 소스 스캔도 한다(§7).

### 3.2 소유 분담

| 주체 | 소유 |
|---|---|
| **엔진** | 캔버스 리사이즈, 백킹스토어 스케일, RAF 핸들, dt/t 시계, 포인터 리스너·정규화, 컨트롤 호스트의 자식, 컨텍스트 상태 리셋, 캔버스 지우기 |
| **작품** | `setup()`, `frame(dt,t)` (필수) / `onResize()`, `onPointerDown()`, `onPointerUp()`, `controls(host)`, `teardown()` (선택) |

작품은 **`destroy()`를 재정의하지 않는다.** 정리 훅은 `teardown()`이다.
실측: `destroy()`를 재정의하고 `super.destroy()`를 잊으면 RAF가 살아남는다(`live RAF handles = 1`).
메서드를 non-writable로 만들어도 서브클래스가 섀도잉할 수 있다. 그래서 규율이 아니라
**`verify.mjs`가 정적으로 검사한다** — 어떤 piece의 own prototype에도 `destroy`가 없어야 한다.

작품이 리스너나 타이머를 직접 만들려면 엔진 API를 거친다: `this.on(target, ev, fn)`(엔진의
`AbortController.signal`을 붙인다), `this.later(fn, ms)`(자동 해제), `this.onDispose(fn)`.

### 3.3 백킹스토어 — DPR 상한만으로는 부족하다

```js
const PX_CAP = 3_000_000;          // 백킹스토어 픽셀 절대 상한
const MAX_DIM = 4096;              // 여러 모바일 GPU가 이 위를 거부한다
scale = Math.min(dpr, 2, Math.sqrt(PX_CAP / (cssW * cssH)));
```

DPR 2 상한만 두면 3840×2160 화면에서 7680×4320 = 33.2M px = 126.6 MiB가 나온다. 모든 작품이 매 프레임 하는
전면 `fillRect` **하나가 10.79ms** — 16.6ms 예산의 65%를 입자 한 개 그리기 전에 쓴다(0.33 ns/px 선형 확인).
위 식은 1920×1080@2, 2560×1440@2, 3840×2160@2·@3을 **모두 2309×1299 = 2,999,391 px = 11.4 MiB ≈ 0.97 ms**로 수렴시킨다.

`ctx.setTransform(scale, 0, 0, scale, 0, 0)` — 이후 작품의 모든 좌표는 **CSS px**이다.
이 한 줄이 작품 01의 "반경 150px"를 DPR과 무관하게 물리적으로 같은 크기로 만든다.

**예외: 픽셀 해상도를 직접 정하는 작품.** 선택 훅 `pixelSize(cssW, cssH)`가 `{w, h}`를 반환하면 엔진은
백킹스토어를 그 크기로 잡고 transform을 항등으로 둔다. 작품 02가 이걸 쓴다(§5.4).

### 3.4 시계

```js
dt = Math.min(elapsed, 1/20);   // 탭 복귀 시 물리 폭주 방지
t += dt;                        // 작품이 보는 누적 시간
```

`real`(캡 없는 실경과)도 필요한 곳이 있으므로 엔진은 `this.real`로 따로 노출한다(캡션 타이밍 등 UI용).

### 3.5 포인터 규약 — 단위를 못 박는다

이벤트는 원시 상태만 기록하고 **프레임 경계에서 한 번 스냅샷**한다. 한 프레임에 `pointermove`가 여러 번 오면
속도가 왜곡되기 때문이다.

```js
pointer = { x, y, vx, vy, active, down }
```

- **`x`/`y`는 CSS px.** `(e.clientX - rect.left)`. `ctx`가 이미 `scale`로 변환돼 있어 그리기 단위와 일치한다.
- **`vx`/`vy`는 CSS px per SECOND.** `(x - lastX) / dt`, 저역통과 `v += (raw - v) * 0.25`.
  그리고 **매 프레임 감쇠** `v *= Math.pow(0.001, dt)` (≈70ms 반감). 스펙에 감쇠가 없는데,
  없으면 커서가 멈춘 뒤 마지막 속도가 영구히 남아 **바람이 영원히 분다**.
- **`active`** = 포인터가 캔버스 위에 있다 (`pointerenter`/`pointerleave`, `pointercancel`에 강제 false).
- **`down`** = 주 버튼 또는 접촉 중 (`pointerdown` → `pointerup`/`pointercancel`).
- `pointerdown`에 `canvas.setPointerCapture(e.pointerId)` — 드래그가 캔버스를 벗어나도 유지.
- **터치**: 탭은 `pointermove`를 전혀 만들지 않는다(실측: `pointerdown → pointerup → lostpointercapture → pointerout`).
  `pointerType === 'touch'`면 `active = down`으로 둔다.
- **`#stage { touch-action: none }`** 필수. 기본값 `auto`면 작품 02의 드래그가 페인팅 대신 페이지를 스크롤한다(실측).
- 첫 프레임 가드: 이전 좌표가 센티넬이면 속도 0. 안 그러면 첫 프레임에 거대한 속도가 나온다.

### 3.6 컨텍스트 위생 — "캔버스는 끝까지 하나"의 실제 비용

캔버스 하나를 작품들이 돌려 쓰므로 한 작품이 남긴 상태가 다음 작품을 오염시킨다.
엔진이 책임진다:

- `mount()`에서: `clearRect` → `globalCompositeOperation='source-over'` → `globalAlpha=1` → `filter='none'`.
  **`clearRect`는 필수다.** 작품 01은 캔버스를 지우지 않고 세척만 하므로, 작품 02에서 01로 넘어가면
  반응-확산 무늬가 잔존율 0.934ⁿ로 남는다 — 250ms 후 35.9%, 1000ms 후 1.66%. 페이드인 내내 보인다.
- `frame()` 호출 **직후**에도 같은 3개를 리셋. 작품이 `lighter`를 켜둔 채 반환해도 다음 프레임/다음 작품이 안전하다.

### 3.7 예산 손잡이 하나 — `budgetScale`

프리뷰 비용과 "작품 04가 기존 성능을 깨지 않는다"를 **같은 메커니즘**으로 푼다.

```js
this.budgetScale   // 기본 1. 프리뷰 호스트가 0.2. 자동 감쇠가 0.8배씩.
```

- 각 작품은 자기 작업량을 **면적의 함수**로 선언하고 `budgetScale`을 곱한다.
- 엔진은 프레임 시간 EWMA를 유지한다. 20ms를 60프레임 연속 넘으면 `budgetScale *= 0.8`(하한 0.25) 후
  `setup()` 재실행. 5ms 미만이 180프레임 이어지면 한 칸 복구.
- 비용을 **면적의 함수로 선언**하게 만드는 것이 요점이다. 산문으로 된 목표보다 검토 가능하다.

**절대 `min(W, H)`에서 비용을 도출하지 않는다.** 실측 반례: `lam = min(W,H)/4.3`로 크기를 잡은 후보는
2560×400(레터박스)에서 2560×1440보다 **62% 더 비쌌다**(31,453 vs 19,425 셀). 작은 캔버스가 더 비싸지는 역전.
면적(`w*h` 또는 `sqrt(w*h)`)에서 도출한다.

### 3.8 컨트롤 팩토리

작품 파일은 `document`를 만지지 않는다. `controls(host)`의 `host`가 팩토리를 제공한다:

```js
host.slider(label, min, max, value, step, onInput) → HTMLElement
host.button(label, onClick)                        → HTMLElement
host.readout(label)                                → { set(text) }
```

팩토리 안에서만 `document.createElement`를 호출한다(함수 본문이므로 모듈 스코프 규칙 위반 아님 — 실측 확인).

### 3.9 오류 격리

`frame()` 호출을 `try/catch`로 감싼다. 예외가 나면 RAF를 끊고 `onError(err)`를 호출한다.
`main.js`가 이 훅으로 플래카드에 사유를 쓴다 — 요구사항 5(엔진이 루프 소유)와
요구사항 "검은 화면 금지"를 동시에 만족시키는 지점.

---

## 4. 카탈로그 — `site/js/data.js`

순수 데이터. 로직 0. 로직이 들어가면 "작품 추가 = 한 항목 + 한 파일"이 깨진다.

```js
export const WINGS = {
  flow: { key:'flow', index:'Ⅰ', name:'Forces & Flow', ko:'힘과 흐름',
          sub:'FORCES & FLOW', accent:'#7cc6ff' },
  life: { key:'life', index:'Ⅱ', name:'Living Systems', ko:'살아있는 계',
          sub:'LIVING SYSTEMS', accent:'#8fe39a' },
};
```

`accent`는 6자리 hex여야 한다(`verify.mjs`가 검사). CSS 변수 `--wing-accent`로 주입되어 카드·플래카드·캡션이
물려받는다 — **전시관을 더해도 CSS를 고치지 않는다.**

```js
export const WORKS = [
  { no, wing, title, ko, medium, year, note, hint, module }, …
];
```

필드 의미를 data.js 헤더 주석에 못 박는다:

- **`note`** = 이 작품이 쓰는 규칙 한 문장. 플래카드 본문 **이자** 도슨트 캡션의 규칙 줄.
- **`hint`** = 조작 힌트 한 문장. 캡션 전용.

스펙 8이 필드 목록을 `no/wing/title/ko/medium/year/note/hint/module`로 못 박았으므로 `rule` 필드를
**추가하지 않는다.** `note`/`hint`가 이미 정확히 그 역할이다. 캡션 바인딩은 번호=`no`, 제목=`title`,
규칙=`note`, 힌트=`hint`.

`module`이 `null`인 항목은 갤러리에 "Soon" 카드로 남는다. Open/Soon은 `work.module !== null`에서
**빌드 시점에 파생**되므로, Soon → Open 승격은 정말로 data.js 한 줄 수정이다.

최종 카탈로그: 01 Currents(flow), 02 Morphogenesis(life), 03 Gravity Garden(flow),
04 Overgrowth(life), 05 `module: null` (Soon 카드 1장 — 구조가 살아있다는 증거로 남긴다).

---

## 5. 작품

### 5.1 작품 01 — Whispering Currents (flow)

2옥타브 Perlin 노이즈를 각도로 읽은 벡터장 위를 입자가 흐른다.

```
입자 수  = clamp(round(area / 61), 6000, 34000) * budgetScale
           // 1920×1080 → 33,993 ≈ 스펙의 34,000
벡터장   = angle = fbm2(x*F, y*F, t*DRIFT) * TAU * 2   (2옥타브, 진폭 1 + 0.5)
잔상     = 매 프레임 rgba(5,5,7,0.066) 덮기, 캔버스를 지우지 않는다
합성     = 입자는 'lighter'
바람     = 포인터 이동, 반경 150 CSS px
소용돌이 = 길게 누르면 1.4초에 걸쳐 충전
           반경  90 → min(w,h)*0.42
           강도  1.4 → 5.2
           놓으면 방출되어 서서히 풀린다
```

**실측이 바꾼 세 지점:**

**(a) 드로우 콜 배칭 — Phase 1부터.** 병목은 Perlin이 아니다.
1920×1080 / N=34,000, 같은 프로세스에서 인터리브 3패스의 최소값:

| 전략 | ms/frame |
|---|---|
| 노이즈 + 적분만 | 5.63 |
| 입자별 `beginPath/moveTo/lineTo/stroke` + 입자별 `strokeStyle` | **104.90** |
| 색 6버킷 = 6회 `stroke()` | 48.55 |
| 단일 path + 단일 `stroke()` | 46.99 |
| 입자별 `fillRect(x,y,1,1)` | 51.74 (더 나쁘다) |

드로우 콜이 프레임의 **94%**, 노이즈 비용의 **17.6배**. 배칭은 2.23배.
6버킷 vs 1패스가 3% 차이이므로 **색 다양성은 사실상 무료**다.
버킷 메모리 레이아웃은 무의미하다(흩어진 gather 93.5 vs 연속 93.0 ms) — 입자를 색으로 정렬하지 않는다.

**(b) 합성 순서를 매 프레임 명시.**

```js
ctx.globalCompositeOperation = 'source-over';
ctx.fillStyle = 'rgba(5,5,7,0.066)';
ctx.fillRect(0, 0, w, h);
ctx.globalCompositeOperation = 'lighter';
/* … 버킷별 단일 path + stroke … */
ctx.globalCompositeOperation = 'source-over';
```

`lighter`가 덮기에 남아 있으면 **페이드가 사라지고 5초 만에 순백**이 된다
(측정: f10 rgb(15,25,37) → f100 rgb(105,205,255) 청색 클립 → f300 rgb(255,255,255)).
흔히 말하는 "덮기가 가산으로 밝힌다"는 설명은 **틀렸다** — 입자 0개로 2000프레임 돌려도 rgb(5,5,7)에 머문다
(premultiplied 0.066×5 = 0.33이 8비트에서 0으로 양자화). 진짜 버그는 덮기가 **빼기를 멈추는** 것이다.

**(c) stroke alpha 0.04.** 가산/페이드 균형의 클립 임계는 채널당 프레임당 `(255-5)*0.066 = 16.5`.
alpha 0.30이면 한 번 맞을 때 76을 침전시켜 임계의 4.6배 — Perlin 수렴선(매 프레임 지나가는 픽셀)이
4프레임 만에 `#ffffff`로 클립되어 색 정보가 날아간다. `rgba(124,198,255,0.04)`를 쓴다(임계 0.065 미만, 겹침 여유).

잔상 길이 참고: 50% 감쇠 10.15프레임(167ms), 10% 31프레임(517ms), 완전 소멸 75프레임(833ms).
오토투어 30초 슬롯은 안정적이다 — 수렴 계수 0.934로 99% 정착이 68프레임(1.13초), 슬롯의 1/26.

### 5.2 작품 02 — Morphogenesis (life)

Gray-Scott 반응-확산.

```
커널      3×3, 중심 -1, 직교 0.2, 대각 0.05, 경계 wrap
          → 표준 등방 9점 스텐실의 정확히 0.3배. 합 = 0 (실측 5.55e-17)
Du = 1.0, Dv = 0.5        ← 스펙의 0.16/0.08에서 변경 (아래 근거)
dt        상수에 접어넣어 1
격자      Float32Array 이중 버퍼
          cells = clamp(round(area / 26), 4000, 80000) * budgetScale
스텝      프레임당 8
프리셋    세포분열 .0367/.0649 · 산호 .0545/.062 · 표범 .035/.065 · 미로 .029/.057
```

**커널 합 0은 load-bearing이다.** 한 가중치를 건드려 합을 +0.05로 만들면 20000스텝 후 `min=Infinity`,
−0.05면 `8.7e-44`(장 전체 소멸). 합이 0이 아니면 확산 연산자가 아니라 균일 지수 이득/감쇠 항이 된다.

**dt=1은 안전하다.** 커널의 Fourier 심볼 범위 `[-1.6, 0]`(최소는 체커보드 (π,π)).
명시적 Euler 조건 `dt·D ≤ 2/1.6 = 1.25`. Du=1.0 → 증폭 `|1-1.6| = 0.6 < 1`. NaN/Inf는 ~90회 실행에서 0회.

**Du/Dv 변경 근거.** 네 F/k 프리셋은 Karl Sims 튜토리얼 값이고, 그 값들은 이 커널 + dt=1 + **dA=1.0/dB=0.5**로
교정된 것이다. 스펙의 0.16/0.08은 정확히 그 0.16배다. Du=0.16에서 실측된 세 가지 결함:

| 증상 | Du=0.16/Dv=0.08 | Du=1.0/Dv=0.5 |
|---|---|---|
| 무늬 폭 (자기상관 첫 영점) | 3~4셀 → 8셀 주기 | 7~11셀 → 18~22셀 주기 |
| mitosis vs leopard 상관 | **r = 0.9204** (같은 그림) | 구분된다 |
| 90% 완성까지 (8스텝/프레임) | **0.10~0.21초** | 6.4~7.0초 |
| 최종 피복률 | 샘플 밀도에 좌우(9.6% @p=0.5% vs 20.1% @p=2%) | 샘플 독립(30.2% vs 27.5%) |
| 등방성 `C_ax(2)`/`C_diag(2)` | 0.506 / 0.229 (격자 고착) | 0.860 / 0.737 |

즉 Du=0.16은 무늬를 격자 스케일로 밀어넣어, 거친 격자를 확대하면 **모르포제네시스가 아니라 흐린 디더**가 되고,
프리셋 4개가 3가지로 보이고, 관람객은 자라는 것을 볼 수 없다. 사용자 승인 하에 Du=1.0/Dv=0.5로 변경한다.
나머지(커널, 네 프리셋, dt=1, 8스텝, 이중 버퍼, wrap)는 스펙 그대로.

**씨앗 — 스펙에 없고, 잘못 고르면 검은 화면이다.** `U=1, V=0`은 고정점이다. 320×250 / 4000스텝 실측:

| 씨앗 | 결과 |
|---|---|
| 중앙 20×20 정사각형 V=1 | mitosis/coral/leopard 피복 0.11~0.32%, **bit-exact 고정점**(3000스텝에서 `max|dV|=0.000e+0`) — 얼어붙은 정지 화면 |
| iid 노이즈 V~U(0,0.5) | **네 프리셋 전부 사망** (Vstd = 0.0000) |
| 꽉 찬 블롭 12개 r=6 | mitosis·leopard 사망 |
| **희소 스페클 p=0.5% V=1** | 네 프리셋 전부 생존. 가장 긴 관람 가능 onset |
| 희소 스페클 p=2% V=1 | 가장 견고 (피복 20.1/45.7/18.4/63.1%) |

```js
u.fill(1); v.fill(0);
for (let i = 0; i < n; i++) if (rnd() < 0.005) v[i] = 1;   // 희소 스페클 — 블롭도 균일 노이즈도 아니다
```

`verify.mjs`는 정적 검사라 이걸 잡을 수 없으므로 **씨앗 옆에 주석으로 이유를 남긴다.**

**붓 — 꽉 찬 원반은 무늬를 죽인다.** 시작 상태 U=1,V=0에서 원반 하나를 칠하고 2500스텝:
mitosis와 leopard는 **반경 8 이상이면 진폭(0.25/0.5/1.0)·감쇠(hard/linear) 무관하게 매번 사망**(18/18).
내부가 공간적으로 균일하면 Turing 불안정성이 없어 U를 고갈시키고 블록째 붕괴한다. r=1~2만 안정적으로 자란다.
포인터 크기 붓은 격자에서 8~24셀이라 정확히 사망 구간이다.

→ **스페클 붓**: 반경 내 각 셀에 `if (rnd() < 0.2) v[i] = 1` (U는 건드리지 않는다).
실측: r=16에서 밀도 0.15는 자라고 밀도 1.0은 죽는다. 캡션 힌트도 정직하게 "끌면 씨앗이 흩뿌려집니다".

**색 — `v*255`는 거의 안 보인다.** V 최대는 0.3496(미로) ~ 0.4738(산호), 중위값 0.013~0.15.
`255*v`는 최대 바이트 89~121, 평균 17~42. 어두운 배경에서 희미한 회색 얼룩이다.

```js
t = smoothstep(0.05, 0.34, v);        // 프리셋 공통 정규화 — 프리셋별로 하면 차이를 숨긴다
r = 10 + t * (232 - 10);              // --bg #0a0b0f → --ink #e8e4da
```

픽셀당 표준편차가 25~39바이트(naive)에서 83~115바이트로 오른다. 상한 0.34는 산호의 최상위 ~1%만 클립한다.

**업스케일 — JS로 하지 않는다.** 320×250 → 1920×1080 `drawImage` 실측:

| `imageSmoothingQuality` | ms |
|---|---|
| `'high'` | **111.05** |
| `'medium'` | 62.88 |
| `'low'` | 16.38 |
| `enabled = false` | 3.28 |
| 비교: 물리 8스텝 | 12.42 |
| 비교: `putImageData` 320×250 | 0.067 |

`'high'`는 물리의 9배다. 대신 **백킹스토어를 격자 크기로** 잡고 CSS가 늘린다 —
컴포지터가 GPU에서 bilinear를 무료로 한다. JS 비용 0.07ms, **1586배**.
`pixelSize(cssW, cssH)` 훅(§3.3)이 이걸 가능하게 한다. `#stage { width:100%; height:100% }`.

참고: `putImageData`는 스케일되지 않는다(실측: `ctx.scale(8,8)` 후에도 8×8 크기만 덮음).

**성능.** 80,000셀 × 8스텝 = 640,000 셀 업데이트/프레임, 25.8~30.4 ns/셀:

| 구현 | ms/step | ms/frame (8스텝) |
|---|---|---|
| 일반 wrap 조회 | 2.788 | 22.30 (예산 초과) |
| 분기 wrap + 행 오프셋 호이스팅 | 1.935 | 15.48 (93%) |
| 32,000셀, 분기 wrap | 0.774 | 6.19 (37%) |

`cells`가 면적 비례 + `budgetScale`이므로 자동 감쇠가 처리한다. 인라인 루프는
`x===0 ? w-1 : x-1` 분기 wrap을 쓴다. **오프셋 테이블은 쓰지 않는다** — 실측 2% 손해(19.45 → 19.79 ms).
V8이 이미 정수 modulo를 strength-reduce한다. 진짜 이득은 Float32 vs Float64 = **1.77배**(이미 스펙에 있다).

### 5.3 작품 03 — Gravity Garden (flow)

보이지 않는 인력점 몇 개를 파티클이 공전하고, 마우스가 다가가면 흩어지고 멀어지면 서서히 궤도로 복귀한다.

```
파티클   clamp(round(area / 2600), 240, 900) * budgetScale
인력점   5개. 화면 안쪽에 배치, 아주 느리게 표류
힘       중력 유사 g = G * m / (r² + soft²), soft로 특이점 제거
산란     포인터 반경 min(w,h)*0.18 안에서 (1-d/R)² * KICK 밖으로
복귀     산란 후 궤도 에너지로 부드럽게 수렴 (임계 미만 감쇠)
색       궤도 반지름에 따른 그라디언트 — 16버킷으로 양자화
```

실측: 1920×1080, 인력점 5개, 완전 O(N×A) 힘 루프 + 잔상 덮기, 인터리브 3패스 최소값:

| N | 입자별 `strokeStyle` | 16 반지름 버킷 |
|---|---|---|
| 400 | 2.21 ms | 1.69 ms |
| 800 | 3.78 ms | 2.74 ms |
| 1600 | 6.76 ms | 4.69 ms |

모든 구성이 16.6ms에 여유롭게 들어간다. **반지름 그라디언트는 16버킷으로 양자화**해
작품 01의 실수(입자별 `strokeStyle`)를 작은 규모로 반복하지 않는다(1.31~1.44배).

### 5.4 작품 04 — Overgrowth / 붐비는 선 (life)

**규칙(도슨트 캡션)**: 선은 자기 자신에게서 일정한 간격을 지키려 하고, 자리가 남은 곳마다 두 점 사이로
새 점이 끼어든다 — 그래서 길어지고, 갈 곳이 없어지면 접힌다.

**구조 대비**: 01은 고정 개수 float 입자 + 무상태 벡터장, 02는 고정 크기 격자 PDE, 03은 고정 개수 입자 + 인력점.
셋 다 `setup()`에서 한 번 할당하는 **고정 크기** 자료구조다. 04는 **원소 수가 시뮬레이션의 출력**이다 —
순환 단일 연결 리스트(`nxt: Int32Array`), O(1) 중간 삽입, bump 할당자 + free list, 프레임당 계수 정렬 공간 해시.

**자료구조** (`configure()`에서 한 번 할당, 절대 성장하지 않음. MAX 6500에서 **220.0 KB**):

```
x, y, fx, fy : Float32Array(MAX)   위치, 힘 누적
nxt          : Int32Array(MAX)     순환 next. free-list 체인도 겸한다
gen          : Uint8Array(MAX)     분할 깊이 = 색
dens         : Uint8Array(MAX)     지난 프레임 R 내 이웃 수 (프론티어 검출 + 성장 게이트)
order        : Int32Array(MAX)     링 순서로 평탄화, 매 프레임 재구축
ringHead : Int32Array(8) · ringStart : Int32Array(9) · splitAccR : Float64Array(8)
cellStart : Int32Array(cells+1) · cellCnt : Int32Array(cells) · cellItems : Int32Array(MAX)
```

**스케일 — 면적에서 도출한다** (`min(W,H)`에서 도출하면 레터박스에서 비용이 역전된다):

```
s    = clamp(sqrt(w*h)/1100, 0.85, 2.0) * spacingMul    // 2560×1440 → 1.745, 260×160 → 0.85
L    = 9.0*s     SPLIT = 1.7*L     R = 2.0*L (반발 반경 = 해시 셀 크기)     MAXSTEP = 0.45*L
MAX  = round(min(6500, max(420, round(w*h/95))) / max(1, spacingMul²))
```

셀 수가 2560×1440, 2560×400, 600×1600, 3840×2160에서 모두 3772~6420에 머무는 것을 확인했다.

**프레임당**: `dtf = min(dt*60, 3)`(엔진의 1/20초 캡을 프레임 단위로 표현 — 탭 전환이 적분기를 터뜨리지 못한다).
`Leff = L*(1 + 0.055*sin(2π·tAcc/13))` — 13초 호흡.

1. `nxt`를 따라 링을 `order[]`로 평탄화, `ringStart[]` 기록.
2. **계수 정렬**로 공간 해시 재구축(`cellCnt.fill(0)` → prefix sum → scatter). 할당 0, O(n + cells).
3. 스프링: `KA=0.20`으로 양쪽 이웃을 향해 `Leff`로, `KS=0.11`로 이웃 중점을 향한 곡률 평활.
4. 반발: **대칭 half-stencil**로 각 무순서 쌍을 정확히 한 번만 — 셀 내 상삼각 + 모듈 스코프
   `OFF_X=[1,1,1,0]`, `OFF_Y=[-1,0,1,1]`로 전방 4셀. `f = (1 - d/R)*0.62/d`.
   **오프셋 테이블은 모듈 스코프에 호이스팅되어야 한다** — 프레임당 리터럴로 두면 최대 할당원이었다.
5. 적분: `step = f*dtf`, `MAXSTEP` 클램프, 캔버스 클램프(pad 4).
   실측: 4000 px/s 적대적 포인터 스윕 3600프레임에서 비유한 좌표 0개, 박스 밖 노드 0개.
6. 성장(링별): `splitAccR[r] += GR_r * growthMul * ringLen * dt`,
   `GR_r = 0.20 * (0.85 + 0.30*fract(r*0.618))` — 8개 군체가 눈에 보이게 다른 속도로 자란다.
   정수부만큼 링의 랜덤 노드를 골라 `dens[i] > DENS_OK(=5)`면 **거부**("여기는 자리가 없다"),
   아니면 에지 중점에 노드 삽입. 그 뒤 `SPLIT`보다 긴 에지에 중점 추가.
7. **세대 주기(필수)**: `n ≥ MAX` → 6초 유지 → 2.5초 용해(알파 1→0) → 리셋 → 0.9초 페이드인. 주기 54초.
   실측: 캡에서 군체가 **잼된다** — 5초간 평균 노드 이동 3.00px = 0.60 px/s. 주기가 없으면 46초 후 정지 화면.
   주기 위상은 작품 자신의 누적 시간에서 파생(고정 54초)해 투어가 예측할 수 있게 한다.

**렌더(드로우 콜 7회, ImageData 없음, 가산 합성 없음)**: 불투명 `fillRect(BG)` → `gen` 버킷 5패스 →
프론티어 버킷(4)에 색수차 stroke 2회 추가.

```
PAL    = ['#25424b', '#366d68', '#5aa382', '#8fe39a', '#cfeecd']
bucket = min(4, (gen*5/maxGen)|0)
alpha  = vis * (0.5 + 0.12*bucket)      // 주석 필수: "알파가 곧 작품이다 — 밝히면 스크린세이버가 된다"
FRINGE = ['#7fe0d0', '#cfeecd', '#a9c8ef'] @ alpha 0.22/0.62/0.22, x 오프셋 -1.1/0/+1.1 CSS px
lineWidth = max(0.9, 0.105*L)
```

**링 슬라이스별로 걸어야 한다.** `order[]`를 평탄하게 순회하면 링 A의 머리에서 링 B로 직선 현이 그려진다
(프로토타입 스크린샷에서 확인). 이걸 "최적화"로 평탄화하면 렌더 오류처럼 보이는 글리치가 재발한다.
`frame()`은 반환 전 `globalAlpha = 1`을 복구한다.

**인터랙션** (문서화된 Piece 계약만 사용):

- **호버** (`active && !down`) — 커서가 조직이 피해 자라는 돌. `PR = min(w,h)*0.16` 안에서
  `(1-d/PR)² * PUSH` 밖으로, `PUSH = 0.5*Leff`. 더해 `pointer.vx/vy * (1-d/PR) * 0.008` 스미어.
  **주석 필수**: "`pointer.vx/vy`는 CSS px per SECOND — 엔진이 프레임당으로 정규화하면 이 상수는 60배 과하다."
  이 파일에서 엔진의 포인터 정규화에 의존하는 유일한 숫자다.
  **진입 버스트**: 포인터가 inactive→active로 바뀌면 `PUSH`에 `entryBoost`를 곱해 0.45초에 걸쳐 2.2 → 1.0.
  이게 없으면 3초 관람객은 커서가 무슨 일을 했는지 알 수 없다.
- **누르고 있기** (`down`) — 먹이 주기. (a) 그 프레임 삽입 지점의 75%를 커서 밑 9개 해시 셀에서 뽑고
  거기서는 밀도 게이트를 `DENS_OK+2`로 완화. (b) `(1-d/PR)*PULL` 당김, `PULL = 0.35*Leff`,
  **`dens[i] ≤ DENS_OK`인 노드에만** — 프론티어만 먹이를 향해 손을 뻗는다.
  이 제한이 없으면 내부 노드가 직선 현으로 끌려나온다.
- **`onPointerDown()`** — 커서에 새 군체 심기: 반경 `min(w,h)*0.03`, `max(10, round(2π·r/L))` 노드, 최대 8개.
  군체는 공유 해시로 서로 반발해 눌려 붙으며 봉합선(suture line)을 만든다.
  **0.5초당 1회로 스로틀** — 연타하면 8링과 6500노드 예산을 1초 안에 태우고 즉시 잼된다. 용해 단계에는 무시.
- **`onPointerUp()`** — 의도적으로 구현하지 않는다(`down`이 이미 false로 떨어진다). 주석으로 명시.
- **키오스크 자동 심기**: 12초간 포인터 이벤트 없고 `ringN < 3`이고 `n > 0.35*MAX`면, 기존 링 중심에서
  `min(w,h)*0.12` 이상 떨어진 랜덤 지점에 군체 1개 자동 심기. 세대당 최대 3회.
  이 작품의 최고 트릭(군체 봉합)을 손대지 않은 키오스크도 볼 수 있게 한다. 실측 8군체 1.98 ms.
- **`controls(host)`**: 성장 속도 슬라이더(0.3~2.5), 결 슬라이더(0.7~1.6, 재시작됨을 라벨에 명시),
  새 군체 버튼. 키보드 단축키 없음 — 갤러리의 `P`(오토투어)와 `Esc`가 계속 작동해야 한다.

**`onResize()` — 대역 정책이며 load-bearing이다.** 새 면적이 마운트 면적의 0.7~2.0배 안이면
`regrid()`만(노드 전부 유지, `cellStart`/`cellCnt`만 재구축). 대역 밖이면 재구성 + 재파종.
실측 이유: 2560×1440 → 1280×720으로 노드 6500을 들고 그냥 `regrid()`하면 items/cell이 1.72 → 6.89로 뛰어
**15.49 ms p50 / 18.11 ms p99** — 프레임 드랍. 이 숫자를 주석에 남겨 아무도 `onResize`를 단순화하지 않게 한다.

**성능 (실측, 소프트웨어 래스터 — 절대 ms는 비관적 하한, 작품 01 대비 비율이 방어 가능한 주장)**:

| 항목 | 값 |
|---|---|
| 시뮬 2560×1440 @6500노드 | p50 2.06 / p90 2.07 / **p99 2.14** ms |
| 시뮬 3840×2160 | p99 2.13 ms |
| 시뮬 260×160 프리뷰 (438노드) | p50 0.11 ms |
| 호버 / 누름 / 8군체 | 2.35 / 2.23 / 1.98 ms |
| 드로우 2560×1440 DPR2 | 43.6 ms = **작품 01(34k)의 0.56배** |
| 비교: 작품 01 프록시 12k / 34k | 42.4 / 77.8 ms |
| 메모리 | 220.0 KB 타입 배열, 프레임당 할당 0바이트 목표 |
| 30초 후 노드 수 | 3611 (캡 6500에 도달조차 안 한다) |

**수락 기준**: 같은 기계에서 작품 04가 작품 01(34k 입자) 아래에 머물러야 한다. 현재 0.56배.
공개적으로 "2560×1440에서 60fps"를 주장하기 전에 실제 전시 디스플레이에서 둘을 재측정한다.

**안전 거버너**(위 `onResize` 절벽용 그물, 6줄): `performance.now()`로 프레임 본문의 20프레임 중위값을 유지.
11ms를 20프레임 연속 넘으면 `MAX_eff = max(1800, MAX_eff*0.75)`, 5ms 미만이 60프레임 이어지면 한 칸 복구.

---

## 6. 전시 셸

### 6.1 `index.html` — 한 문서, 세 뷰

```
body[data-view="atrium" | "gallery" | "room"]
├── .grain / .vignette            (fixed 오버레이, pointer-events:none)
├── .topbar                       (브랜드 → 아트리움, 전시관 링크, Play 버튼)
├── main.atrium                   (히어로: eyebrow / 타이틀 / 리드 / 메타 / 전시 입장)
├── section.gallery               (전시관별 섹션 + 작품 카드 그리드)
└── section.room
    ├── canvas#stage              (전시실의 캔버스는 단 하나)
    ├── .placard                  (no · wing / title / ko / medium / note / 컨트롤 호스트)
    ├── .caption                  (도슨트 캡션 바: no · title / note / hint)
    ├── .actionbar                (이전 / 다음)
    └── .exit
```

폰트는 레퍼런스의 역할 분리를 따른다: Cormorant Garamond(serif) = 전시명·작품 제목,
Inter(sans) = 본문, Space Mono(mono) = 번호·라벨·메타.
CSS 변수 토큰: `--bg #0a0b0f`, `--bg-soft #12141b`, `--ink #e8e4da`, `--ink-dim #9a958a`,
`--line rgba(232,228,218,.14)`, `--wing-accent`(JS가 주입).

### 6.2 라우팅 — 해시가 뷰 상태의 유일한 표현

**`hashchange`만 듣는다.** `popstate`도 들으면 `location.hash = '#work-02'` 한 번에 핸들러가
**2회 호출**된다(실측 — Chrome이 same-document 해시 할당에 둘 다 발사). 핸들러가 `async`(`await import`)이므로
두 실행이 모두 destroy를 지나쳐 **두 작품이 같은 캔버스에 동시에** 그려진다.
`pushState`는 쓰지 않는다 — 아무 이벤트도 발사하지 않아(실측) 수동 렌더 호출이 필요해지고 분기가 재발한다.

**generation 토큰으로 직렬화**:

```js
let gen = 0;
async function route() {
  const my = ++gen;
  teardownCurrent();                       // await 전에 정리한다
  const mod = await import(url);
  if (my !== gen) return;                  // 낡았다 — 포기
  mount(mod.default);
}
```

**라우팅 표**:

| 해시 | 동작 |
|---|---|
| 없음 또는 `#` | 아트리움 |
| `#gallery` | 갤러리 |
| `#work-NN`, `module` 있음 | 전시실 + 마운트 |
| `#work-NN`, `module === null` | 갤러리 + 그 카드에 `.is-unavailable` + live-region "아직 열리지 않았습니다". **import 전에 가드** — 안 그러면 리졸버 오류 문구가 관람객에게 노출된다 |
| `#work-99` (카탈로그에 없음) | 갤러리 (아트리움이 아니다 — 작품을 찾아온 사람을 작품이 있는 곳에 둔다). 오류 토스트 없음 |
| 그 외 | 위와 같음 |

`location.hash`는 `''`로 지워도 URL에 맨 `#`가 남는다(실측) → `location.hash.replace(/^#/,'')`로 비교한다.

**같은 해시 재할당은 아무 이벤트도 내지 않는다**(실측). 그래서 나가기는 `data-view`를 직접 바꾸지 않고
`location.hash = ''` 또는 `'#gallery'`로 처리한다 — 안 그러면 Esc로 나온 뒤 같은 카드를 누를 때
URL이 이미 `#work-01`이라 **카드가 고장 난 것처럼 죽는다.** 보험: 해시 할당 후 값이 이미 목표였다면 `route()`를 직접 호출.

**이전/다음**: `const open = WORKS.filter(w => w.module)`를 **한 곳에서** 파생해 그 배열을 인덱싱,
`(i + n + open.length) % open.length`로 순환. Soon 작품을 건너뛴다. 오토투어도 같은 배열을 쓴다.

### 6.3 갤러리

- **그리드는 한 번만 빌드**(`DOMContentLoaded`의 `buildGallery()`).
- **카드는 네이티브 `<button type="button">`**. `div[role=button][tabindex=0]`에서는 Enter/Space가
  클릭을 만들지 않고 Space가 페이지를 스크롤한다(실측 `scrollY 0 → 525`). 키오스크에 키보드만 있으면
  전시가 조용히 열리지 않는다.
- **Soon 카드**는 `aria-disabled="true"` + `data-state="soon"`. `disabled` 속성은 쓰지 않는다 —
  `aria-disabled`는 탭으로 도달 가능하므로 스크린리더 사용자가 "작품 05, Soon"을 들을 수 있다(전시 정보다).
  클릭 핸들러는 `work.module === null`에서 조기 반환.
- `#stage`에 `role="img"` + `work.title` / `work.note`로 만든 `aria-label`.

**입장 연출**: `sessionStorage['gh:entered']` 플래그 + 갤러리 루트에 클래스 하나.

```js
if (!sessionStorage.getItem(KEY)) {
  galleryEl.classList.add('is-entering');
  sessionStorage.setItem(KEY, '1');
  setTimeout(() => galleryEl.classList.remove('is-entering'), 2000);
}
```

```css
.is-entering .card { animation: rise .5s both; animation-delay: calc(var(--i) * 90ms); }
```

`--i`는 빌드 시 인라인 커스텀 프로퍼티로 — **작품을 더해도 CSS를 고치지 않는다.**
5카드면 마지막 지연 360ms + 500ms = 860ms로 2초 예산 내. 클래스는 2초 후 제거되고 다시 붙지 않으므로
전시실에서 갤러리로 돌아올 때 재생되지 않는다. 그리드는 여전히 정확히 한 번만 빌드된다.
`sessionStorage`는 reload 후 값이 남고 새 탭에서는 `null`이다(실측) — 정확히 필요한 수명.

**호버 프리뷰**: 카드마다 캔버스를 두지 않고 **공유 캔버스 하나**(~200×120 CSS px)를 호버된 카드로
`appendChild`한다. 120ms 호버 의도 디바운스, `budgetScale = 0.2`, `mouseleave`에 destroy.
실측: 캔버스당 오버헤드는 무의미하다(M=16에서 0.035 ms/캔버스) — 비용은 **작품 사본 N개**다.
"전시실 캔버스는 하나"는 전시실 범위 제약이므로 갤러리의 프리뷰 캔버스는 위반이 아니다.

### 6.4 도슨트 캡션 — 4상태 기계

스펙은 "마우스가 움직이면 숨는다"만 말하고 **돌아오는 길을 말하지 않는다.** 그대로 두면 캡션은 일방통행 문이고,
마우스 이동이 곧 인터랙션인 작품 01에서는 1초 안에 영구히 사라진다 — 규칙 설명이 가장 필요한 작품에서.

```
HIDDEN ─(마운트 후 3000ms)→ SHOWN ─(드리프트 > 24 CSS px / 300ms)→ DIMMED ─(포인터 정적 1800ms)→ SHOWN
```

- SHOWN 진입: 400ms ease-out 슬라이드 업.
- DIMMED: `opacity 0` + `translateY 12px`, 200ms. **`display:none`이 아니다**(레이아웃 스래싱 방지).
- 반복 이동은 1800ms 타이머를 재무장할 뿐 3000ms 초기 지연을 되돌리지 않는다.
- 완전히 3회 보여졌거나 45초가 지나면 영구 DIM — 긴 체류에서는 작품을 가리지 않는다.
- 전시실을 나가면 HIDDEN으로 리셋.
- 드리프트 임계는 투어 취소(48px)보다 **낮게**(24px) — 캡션은 먼저 비켜야 하고 투어는 버텨야 한다.

### 6.5 오토투어 — "어떤 입력"을 의도로 재정의

스펙의 "어떤 입력이든 들어오면 해제"는 문자 그대로 구현 불가능하다.
작품 01은 **마우스 이동이 곧 바람**이고, 캡션도 같은 이벤트를 신호로 쓴다.
`pointermove` 하나로 취소하면 커서 1px 떨림, 트랙패드 스침, 책상 흔들림에 키오스크가 죽는다 —
"손을 대지 않아도 살아 있는 전시"라는 목표의 반대다. "어떤 keydown"도 치명적이다:
Cmd-Tab/Alt-Tab으로 창에 돌아오면 맨 `Meta`/`Alt` keydown이 배달된다(실측).

**취소 조건**(`window`에 `{capture:true, passive:true}`, 투어 소유 `AbortController`.
**캔버스에 붙이지 않는다** — 투어 취소가 작품의 포인터 처리를 건드리지 않게):

- `click` / `pointerdown` (`isPrimary`)
- `wheel` with `Math.abs(deltaY) > 8`
- `touchstart`
- `keydown` 중 `!e.repeat && !['Control','Shift','Alt','Meta','CapsLock','Tab','F5'].includes(e.key) && e.key.length <= 12`
- **누적 드리프트 > 48 CSS px**: 이벤트마다 `Math.hypot(dx,dy)`를 `drift`에 누적,
  400ms간 `pointermove`가 없으면 `drift = 0`.

실측 근거: 1px 떨림 3번의 `movementX/Y`는 `{0,1} {0,0} {0,0}` — **이벤트별 크기로는 지터와 의도를 구분할 수 없다.**
의도적인 283px 스윕은 10이벤트에 282.1px를 누적. 누적 거리만이 깨끗하게 갈라진다.

투어 취소는 **30초 진행 타이머만 멈춘다.** 작품은 계속 돌고, 작품 01의 바람도 계속 분다.
키 매칭은 `e.code` 또는 소문자화한 `e.key`로 — `p`와 `P`가 모두 `code=KeyP`다.

**페이드**. 단일 캔버스라 진짜 크로스페이드는 불가능하다. dip-to-black이 정직한 답이고
미술관 언어로도 옳다. **순서가 중요하고 스펙에 없다**:

```
opacity:0 → transitionend 대기 → handle.destroy() → ctx.clearRect (필수) →
await import() → mount() → rAF 1회 대기(frame()이 최소 한 번 그리도록) → opacity:1
```

rAF 대기가 없으면 빈 캔버스에 페이드인해 희끗한 팝이 보인다. `clearRect`는 §3.6의 유령 문제 때문에 필수다.

**타이밍**: FADE_OUT 450ms, FADE_IN 450ms, **체류 타이머 29100ms** → 정확히 30000ms 주기.
30000ms 체류 + 900ms 페이드로 잡으면 작품마다 3%씩 주기가 밀린다.
CSS `opacity` 트랜지션은 실측 447ms에 `transitionend`를 낸다.

오토투어는 작품 04가 용해 단계면 그 작품을 건너뛴다(검은 화면으로 마운트하지 않게).

### 6.6 `prefers-reduced-motion` 정책

**UI 모션만 억제한다.** 카드·타이틀·캡션 애니메이션과 `#stage` opacity 트랜지션을
`animation: none` / `transition: none`으로(페이드는 즉시 컷이 되고 그래도 괜찮다).

**작품은 계속 돈다.** 제너러티브 작품은 곧 콘텐츠이고 관람객이 의도적으로 거기 들어왔다.
`frame()`을 멈추면 그 설정을 쓰는 사람에게 전시는 검은 화면 + 플래카드일 뿐이다. 대신 두 가지 양보:

1. 오토투어를 **자동 시작하지 않는다**(`P` 키는 계속 작동). 요청하지 않은 30초 작품 교체 캐러셀이
   바로 이 설정이 막으려는 전정기관 자극이다.
2. 전시실에 작품 일시정지/재생 어포던스를 노출(엔진의 RAF에 연결).

미디어 쿼리는 **함수 안에서** 읽는다(모듈 스코프에서 읽으면 §3.1 위반이고, 그게 import 검사를 무력화하는 정확한 관용구다).
`change` 이벤트를 구독한다.

---

## 7. `verify.mjs`

브라우저 없이 `node verify.mjs`(리포 루트에서). PASS/FAIL 한 줄씩, 실패가 하나라도 있으면 exit 1.

**왜 브라우저 없이 되는가** (파일에 한 줄 주석으로):
> Node에는 `document`/`window` 전역이 없어 모듈 스코프의 DOM 접근은 import 시점에 던진다.
> 소스 스캔이 bare import가 조용히 통과시키는 가드형 우회를 덮는다.

**경로 재기준 — 루트에서 그냥 `import(work.module)`하면 실패한다.** 스펙은 경로가 `site/js/` 기준이라 하고
`main.js`가 `await import(work.module)`을 하는데, 그건 `main.js`가 `site/js/`에 있기 때문이다.
`verify.mjs`는 루트에 있으므로 같은 지정자가 `/pieces/…`로 해석되어 `ERR_MODULE_NOT_FOUND`가 난다(실측).

```js
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const JS = new URL('./site/js/', pathToFileURL(process.cwd() + '/'));
const { WINGS, WORKS } = await import(new URL('data.js', JS));
const { Piece }        = await import(new URL('engine.js', JS));
// 작품별: const url = new URL(w.module, JS); existsSync(url) → await import(url)
```

`existsSync`는 `file:` URL을 직접 받고 `import()`는 URL 객체를 받는다 — 문자열 저글링이 없다.

**검사 목록**:

1. 모든 `WORKS[].module` 파일이 실제로 존재한다 (경로는 `site/js/` 기준 상대).
2. 각 piece가 `typeof m.default === 'function'`이다.
   (평면 객체 default는 `default? true, isFn false`, named-only export는 `default? false` — 실측)
3. 각 piece가 **`C.prototype instanceof Piece`**다.
   `Object.getPrototypeOf(C) === Piece`는 **중간 클래스에서 오탐**한다(실측:
   `class Morpho extends GridPiece extends Piece` → `false`). Phase 2의 목적 자체가 공통 스캐폴딩 추출이므로
   이건 가장 일어날 법한 리팩터다. 올바른 코드에 빨간 불이 뜨면 검사를 무시하게 되어 검사가 없는 것보다 나쁘다.
4. `setup`과 `frame`이 piece 자신의 prototype 체인(`Piece.prototype` 이전)에 있다:

   ```js
   function implemented(C, name) {
     let p = C.prototype;
     while (p && p !== Piece.prototype) { if (Object.hasOwn(p, name)) return true; p = Object.getPrototypeOf(p); }
     return false;
   }
   ```

   `'setup' in C.prototype`은 `Piece`가 스텁을 선언하면 아무것도 구현하지 않은 서브클래스에도 true다 →
   런타임에 터질 작품을 통과시킨다. `Object.hasOwn(C.prototype, …)`만 보면 중간 베이스에서 상속한
   정당한 작품을 실패시킨다. **그래서 `Piece`에 던지는 스텁을 선언하지 않는다.**
5. 어떤 piece의 own prototype에도 **`destroy`가 없다**(§3.2의 누수 불변식).
6. 모든 `WORKS[].wing`이 `WINGS`에 존재한다.
7. `WORKS[].no`가 중복되지 않는다.
8. 모든 `WINGS`가 6자리 hex `accent`를 가진다 (`/^#[0-9a-f]{6}$/i`).
9. `engine.js` 소스 스캔: 줄 주석·블록 주석·문자열/템플릿 리터럴을 제거한 뒤 중괄호/괄호/대괄호 깊이를 추적해
   최상위 문장으로 쪼개고, depth 0에서
   `/\b(document|window|navigator|location|matchMedia|localStorage|sessionStorage|requestAnimationFrame)\b/`가
   나오면 FAIL. `const TAU = Math.PI*2` 같은 정당한 모듈 스코프 상수는 통과한다.

---

## 8. CDK — `lib/media-art-stack.ts`

설치된 `aws-cdk-lib` **2.270.0**에 대해 검증. `tsc --noEmit` EXIT=0, `cdk synth` EXIT=0 실증.

```ts
const bucket = new s3.Bucket(this, 'ExhibitionBucket', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,   // 명시 필수
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const dist = new cloudfront.Distribution(this, 'ExhibitionCdn', {
  defaultRootObject: 'index.html',
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
      originAccessLevels: [cloudfront.AccessLevel.READ],
    }),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    compress: true,
  },
  // errorResponses 없음 — SPA가 아니다
});

new s3deploy.BucketDeployment(this, 'DeployExhibition', {
  sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'site'))],
  destinationBucket: bucket,
  distribution: dist,
  distributionPaths: ['/*'],
});

new cdk.CfnOutput(this, 'ExhibitionUrl', { value: `https://${dist.distributionDomainName}/` });
```

**함정들**:

- **`blockPublicAccess`를 생략하면 템플릿에 `PublicAccessBlockConfiguration`이 아예 안 나온다.**
  cdk.json의 `@aws-cdk/aws-s3:publicAccessBlockedByDefault` 플래그는 이미 전달한 객체의 **미지정 하위 필드만
  채운다**(`setDefaultPublicAccessBlockConfig`). prop이 아예 없으면 아무것도 렌더되지 않고 S3 계정 기본값에
  의존하게 된다. 실측 확인: 그 줄만 제거하고 synth하면 `PublicAccessBlockConfiguration`이 `undefined`.
- **`origins.S3Origin`은 deprecated인데 타입 검사를 통과하면서 조용히 OAC 대신 OAI를 쓴다.**
  `tsc --noEmit` EXIT=0이고 synth 때 `[WARNING]` 한 줄만 난다. 템플릿은
  `AWS::CloudFront::CloudFrontOriginAccessIdentity` + `Principal.CanonicalUser`가 되어 스펙 위반이다.
  `S3BucketOrigin.withOriginAccessControl`은 버킷 정책 statement를 **자동으로 추가한다**
  (`s3:GetObject` + `AWS:SourceArn` 조건) — 수동 `addToResourcePolicy`가 필요 없다.
- **`autoDeleteObjects: true`와 `removalPolicy: DESTROY`는 둘 다 필수다.** RETAIN으로 바꾸면 synth가
  `CannotAutoDeleteObjectsProperty`로 EXIT=1.
- **`retainOnDelete`를 건드리지 않는다**(기본 true). `false`로 바꾸면 stack 해체 시
  `Custom::S3AutoDeleteObjects`와 경쟁해 간헐적 `DELETE_FAILED`의 원인이 된다.
  기본 `prune: true`가 `aws s3 sync --delete`로 낡은 파일을 처리한다.
- **Docker 불필요.** `command -v docker` → 없음인데 `cdk synth` EXIT=0.
  `AwsCliLayer` asset이 `"packaging": "file"`(prebuilt zip)이고 사이트/핸들러는 순수 JS로 zip되는 디렉터리 복사다.
  Docker는 `Source.asset()`에 `bundling`을 넘길 때만 필요하고 이 사이트는 필요 없다.
- **Content-Type 정상.** 핸들러가 `/opt/awscli/aws s3 sync`를 실행하고 awscli가 Python `mimetypes`로 추론한다:
  `.html → text/html`, `.css → text/css`, `.js → application/javascript`. 모두 유효한 ES 모듈 MIME이다.
- **CDK asset 스테이징은 `.gitignore`를 따르지 않는다** — 그래서 `*.js` 버그가 S3 업로드를 깨뜨리지는 않는다.
  그래도 git 자체를 위해 `.gitignore` 수정은 필요하다.
- `bin/media-art.ts`의 `import * as cdk from 'aws-cdk-lib/core'` 스타일은 이 버전에 subpath export가 있어 문제없다
  (`require('aws-cdk-lib/core').Stack === require('aws-cdk-lib').Stack` → true). 변경하지 않는다.
- `distributionPaths`는 `distribution`이 함께 넘어와야 한다(없으면 synth가 `ValidationError`).

배포는 **하지 않는다** — 사용자 결정: 스택 작성 + `cdk synth` 검증까지. `npx cdk bootstrap` / `npx cdk deploy`
명령만 안내한다.

---

## 9. 구현 순서

Phase 경계마다 커밋해 어느 단계로도 되돌아갈 수 있게 한다.

| Phase | 내용 | 산출물 |
|---|---|---|
| **0** | 리포 위생 | `.gitignore` 네거션, `site/package.json` |
| **1** | 작품 01을 **추상 없이 한 파일로** | `site/index.html`(전체화면 캔버스 하나), `site/js/currents.js` |
| **2a** | 작품 02를 **통째로 베껴** 씀 | `site/js/morphogenesis.js`. **중복 줄 번호 보고** |
| **2b** | Piece 계약 추출 | `site/js/engine.js`, `site/js/pieces/01-currents.js`, `02-morphogenesis.js` |
| **3** | 3단 전시 구조 + 카탈로그 | `data.js`, `index.html`(세 뷰), `main.js`, `css/style.css` |
| **3v** | 정적 검사 | `verify.mjs` |
| **4** | 배포 | `lib/media-art-stack.ts` + `cdk synth` 검증 |
| **5** | 작품 03 | `pieces/03-gravity.js`, data.js 한 항목 |
| **6** | 도슨트 캡션 | `main.js` + `style.css` |
| **7** | 오토투어 | `main.js` + Play 버튼 |
| **8** | 입장 연출 + 호버 프리뷰 | `main.js` + `style.css` |
| **9** | 작품 04 | `pieces/04-overgrowth.js`, data.js 한 항목 |

Phase 1과 2a의 의도적 중복은 **없애지 않고 커밋으로 남긴다** — 무엇이 중복인지 눈으로 보는 것이 Phase 2b의 전제다.

## 10. 확인 방법

```bash
# 로컬 전시
cd site && python3 -m http.server 8000     # → http://localhost:8000/

# 계약 검사
node verify.mjs

# 타입 검사 + 템플릿
npx tsc --noEmit
npx cdk synth

# 배포 (사용자가 직접)
npx cdk bootstrap        # 계정/리전에 처음이라면
npx cdk deploy
```

---

## 11. 구현에서 달라진 것

설계는 구현 전에 쓰였다. 브라우저 육안 확인이 잡아낸 것들을 여기 기록한다 —
전부 "지표는 초록인데 작품이 틀렸다" 는 종류다.

### 엔진 내부를 진짜 `#private` 으로 바꿨다

작품 04 가 `_reset()` 을 정의했더니 엔진의 `mount()` 가 `setup()` 전에 그것을 호출해
`TypeError: Cannot set properties of undefined` 로 터졌다. `Piece._reset()` 은 컨텍스트 상태를
되돌리는 내부 메서드였고 `_` 는 관례일 뿐이었다.

`destroy()` 를 "규율이 아니라 검증된 불변식으로" 막아두고 나머지 내부는 관례에 맡긴 것이 모순이었다.
`_call`, `_clear`, `_resize`, `_tick`, `_govern`, `_dead`, `_raf` 등 29개를 `#private` 으로 바꿨다 —
JS 의 `#` 는 언어 차원에서 섀도잉이 불가능하므로 이 버그 계열이 구조적으로 사라진다.
진단이 필요한 값은 getter 로 노출한다(`dead`, `liveRaf`, `minInterval`, `pendingTimers`,
`pendingDisposers`, `frameMs`, `bodyMs`).

참고로 이 사건은 규율 (b)의 유효성도 증명했다 — 검은 화면이 아니라 플래카드에 사유가 찍혔다.

### 거버너가 래스터화를 못 보고 있었다

`frame()` 직후의 `performance.now()` 는 브라우저가 path 명령을 모아뒀다가 컴포지트 시점에
래스터화하기 때문에 래스터화 비용을 전혀 포함하지 않는다. 실측: 작품 01 이 rAF 간격 71.7ms 일 때
본문은 5.03ms 였다 — 프레임의 94% 가 거버너에 보이지 않았고 9fps 에서도 감쇠가 발동하지 않았다.
rAF 간격을 재도록 바꿨고, 기준을 절대 ms 대신 관측된 최소 간격(= vsync 주기)의 배수로 뒀다.
절대값이면 60Hz 에서 여유롭게 60fps 를 내는 작품도 간격이 16.7ms 라 복구 조건을 영원히 못
만족해 한 번 감쇠하면 다시 못 올라간다.

그리고 감쇠가 작품을 리셋하고 있었다. `_reconfigure()` 가 `_clear() + setup()` 을 부르니 느린
기계에서 21초에 7번 화면이 지워졌다(최종 ink 0.02%). "예산 변경" 은 "리사이즈" 와 같은 문제이고
두 작품의 `onResize()` 는 이미 리셋 없이 적응하도록 쓰여 있으므로 `_resize()` 하나만 부르게 했다.
쿨다운(2.5초)도 더했다 — 느린 기계에서는 60프레임이 4초 넘게 걸려 계단이 촘촘해진다.

### 작품 02: 프리셋 전환이 무늬를 죽였다

산호(피복 69%)에서 표범으로 바꾸니 피복 0.00% — 밀집한 장에서 표범(F=0.035, k=0.065)은
소멸 영역이다. 전환 때 옅은 스페클(p=0.002)을 흩뿌리고, V 분산이 0 에 가까운 상태가 이어지면
되살리는 생존 감시(2048칸 표본, 60프레임마다)를 넣었다.

기본 프리셋은 미로다. 격자 8만 칸 상한에서 확대율이 5배라 세포분열의 고립된 점은 흐릿한
덩어리로 읽히지만, 미로와 산호는 18~22셀 주기의 연결된 구조라 확대가 유기적인 부드러움이 된다.

`V_HI` 는 감사 권고 0.34 대신 0.40 이다. 0.34 는 픽셀당 표준편차(대비)를 최대화하지만 V 분포가
이봉형이라(배경 ~0, 무늬 몸통 0.37~0.43) 몸통 전체가 램프 정점으로 클립되어 색이 납작해진다.

### 작품 03: 중력 상수가 830배 작았고, 합성이 반대였다

`v = sqrt(G*m*r^2/(r^2+soft^2)^1.5)` 에 `G=2600, r=200` 을 넣으면 3.5 px/s = 프레임당 0.06px 다.
입자가 사실상 정지해 세그먼트가 점이 되고 중력이 천천히 전부를 인력점으로 끌어모아 궤도가 아니라
먼지가 됐다. 60fps·NaN 0·메모리 정상 — 지표는 전부 초록인데 작품은 죽어 있었다.
단위를 역산해 `G=3.2e6` 으로 두니 r=60 에서 163 px/s, r=600 에서 73 px/s 의 케플러적 감소가 나온다.

그리고 **합성이 `lighter` 면 안 된다.** 가산 합성은 입자가 많아 겹칠 때만 밝기를 쌓는데 이 작품은
입자가 01 의 1/40 이라 획 하나가 혼자 보여야 한다. 긴 잔상을 위해 덮기 알파를 0.035 로 낮추면
클립 임계가 `255*0.035 = 8.9` 라 stroke 알파를 그 이하로 묶어야 하고, 그러면 갓 그린 획이
사실상 보이지 않는다(실측 lumaMax 58.9, ink 0.04%). `source-over` 로 바꾸니 lumaMax 218,
ink 7.07% 가 됐다. **같은 미청소 잔상 기법인데 합성 선택이 입자 밀도에 따라 반대가 된다.**

인력점은 균등 난수로 뽑으면 뭉친다(고정 시드에서 다섯 개가 오른쪽 절반에만 몰렸다).
best-candidate 표본으로 바꿨다. 색 정규화 기준도 화면 대각선 대신 실제 궤도 범위
(`min(w,h)*0.38`)로 바꿨다 — 대각선 기준이면 16버킷 중 1~5 만 쓰여 램프의 파란 절반이
화면에 전혀 나타나지 않는다.

### 작품 04: 씨앗 하나로는 첫 10초가 빈 화면이었다

링 하나에서 시작하면 4.2초에 노드가 255개(ink 0.26%)뿐이다. 자동 관람 슬롯은 30초다.
군체 3개로 시작하고 마운트 때 240회 헤드리스 워밍업을 돌려, 관람객이 씨앗이 아니라 이미 접힌
조직에 도착하게 했다 — 1초 시점에 노드 1622(ink 1.55%), 30초에 4270(4.50%).
마운트 비용 137ms 는 `main.js` 의 페이드인 뒤에 숨는다.
성장률도 0.20 에서 0.45 로 올렸다(밀도 게이트가 붐비는 곳의 삽입을 거부하므로 실효 성장률은
설정값보다 한참 낮다).

부수 효과가 좋았다: 세 군체가 눌려 붙어 봉합선을 만드는 것이 이 작품의 최고 트릭인데,
이제 아무 조작 없이도 보인다.

### 눈으로만 보이는 것 둘

Inter · Space Mono · Cormorant Garamond 는 **셋 다 한글 글리프가 없다.** 한글 폰트가 없는
키오스크에서는 모든 설명이 빈칸이 된다(headless Chromium 에서 실제로 그랬다). Noto Sans KR 을
`--sans` 와 `--mono` 스택 모두에 넣었다. `U+2715`(✕)도 없어서 나가기 버튼이 빈 원이었다 —
CSS 로 그렸다. 그리고 한글에 라틴 대문자용 트래킹 `.3em` 은 과하다("인 터 랙 티 브").

### 카탈로그 최종 상태

작품 01·02·03·04 가 열려 있고 05(Standing Waves)가 Soon 카드로 남는다.
작품 03 과 04 를 승격할 때 `main.js` · `style.css` · `index.html` 을 한 줄도 고치지 않았다 —
"작품 추가 = `data.js` 한 항목 + 파일 하나" 가 실제로 성립한다.
