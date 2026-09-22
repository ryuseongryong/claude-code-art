# Generative Hours

코드가 스스로 그리는 제너러티브 아트 전시. 빌드 도구 없는 정적 사이트이고, 외부 런타임
라이브러리를 쓰지 않는다(Google Fonts CSS만 예외). `python3 -m http.server`로 열리는 파일이
그대로 S3에 올라간다.

레퍼런스: <https://reborn.zerojin.art/>

## 보기

```bash
cd site && python3 -m http.server 8000
```

→ <http://localhost:8000/>

| 조작 | 결과 |
|---|---|
| 전시 입장 / 카드 클릭 | 아트리움 → 갤러리 → 전시실 |
| `P` 또는 자동 관람 버튼 | 열린 작품을 30초씩 순회 (아무 조작이나 하면 해제) |
| `←` `→` | 이전 / 다음 작품 (Soon 작품은 건너뛴다) |
| `Esc` | 전시실 → 갤러리 → 아트리움 |
| `#work-01` … | 딥링크 |

## 전시

| 번호 | 제목 | 규칙 | 조작 |
|---|---|---|---|
| 01 | Whispering Currents / 속삭이는 해류 | 벡터장의 각도는 노이즈에서 온다 | 마우스 = 반경 150px 바람. 길게 누르면 소용돌이가 1.4초에 걸쳐 충전 |
| 02 | Morphogenesis / 형태발생 | 두 물질이 서로 다른 속도로 번지며 서로를 만든다 | 끌면 씨앗이 흩뿌려진다. 프리셋 4개 |
| 03 | Gravity Garden / 중력 정원 | 보이지 않는 인력점이 궤도를 정하고 색은 반지름이 정한다 | 가까이 가면 흩어지고 멀어지면 복귀 |
| 04 | Overgrowth / 붐비는 선 | 선은 자기 자신을 피하려 하고, 자리가 남은 곳마다 새 점이 끼어든다 | 커서는 조직이 피해 자라는 돌. 누르면 그쪽으로 자라고 클릭하면 새 군체 |
| 05 | Standing Waves / 서 있는 파동 | — | Soon |

## 구조

```
site/
├── package.json        {"type":"module"} — ESM 범위를 site/ 로 한정한다 (§ 함정 참고)
├── index.html          한 문서에 세 뷰. body[data-view] 가 atrium/gallery/room 전환
├── css/style.css       어두운 미술관 톤. 관 accent 를 --accent 로 주입
└── js/
    ├── data.js         카탈로그. 순수 데이터, 로직 0
    ├── engine.js       Piece 기반 클래스 + 컨트롤 팩토리
    ├── main.js         라우터 · 도슨트 캡션 · 자동 관람 · 호버 프리뷰
    └── pieces/*.js     작품. 한 파일 = 한 작품
verify.mjs              브라우저 없이 카탈로그·Piece 계약 정적 검사
lib/media-art-stack.ts  S3 + CloudFront(OAC) 배포
docs/superpowers/specs/  설계 문서 + 실측 감사 기록
```

### 작품을 더하는 방법

`data.js` 한 항목 + `pieces/` 파일 하나. 그게 전부다.
작품 03과 04를 Soon에서 Open으로 올릴 때 `main.js` · `style.css` · `index.html`을 한 줄도
고치지 않았다. 새 전시관을 더할 때도 CSS를 고치지 않는다 — accent가 CSS 변수로 주입되어
카드·플래카드·캡션이 물려받는다.

```js
// site/js/pieces/05-waves.js
import { Piece } from '../engine.js';

export default class Waves extends Piece {
  setup() { /* 한 번 할당. this.w / this.h 는 CSS px */ }
  frame(dt, t) { /* this.ctx 에 그린다 */ }
  // 선택: onResize() onPointerDown() onPointerUp() controls(host) pixelSize(w,h) teardown()
  // destroy() 는 재정의하지 않는다 — verify.mjs 가 검사한다
}
```

### Piece 계약

엔진이 캔버스 리사이즈·백킹스토어 스케일·RAF·`dt`/`t` 시계·포인터 정규화·`mount()`/`destroy()`를
소유한다. 작품은 `setup()`과 `frame(dt, t)`만 구현한다.

- **좌표는 CSS px.** `pointer = { x, y, vx, vy, active, down }`, 속도는 **CSS px per second**.
- **`dt`는 1/20초로 캡**(탭 복귀 시 적분기 보호). UI 성 타이밍은 `this.real`(0.25초 캡)을 쓴다.
- **`this.budgetScale`**은 작업량 손잡이다. 작품은 비용을 **면적의 함수**로 선언하고 여기에 곱한다.
  호버 프리뷰가 0.18로 낮추고, 프레임이 밀리면 엔진이 0.8배씩 자동 감쇠한다.
- 리스너/타이머는 `this.on()` / `this.later()` / `this.onDispose()`로만 만든다 —
  `destroy()`가 `AbortController` 하나로 전부 걷어간다.
- **`engine.js`는 모듈 스코프에서 `document`/`window`를 만지지 않는다.** 이 제약이 `verify.mjs`를
  가능하게 한다. 엔진 내부는 `#private`이라 작품이 같은 이름을 써도 충돌하지 않는다.

## 검증

```bash
node verify.mjs      # 카탈로그 + Piece 계약 (브라우저 불필요)
npx jest             # 배포 불변식
npx tsc --noEmit     # 타입 검사
npx cdk synth        # CloudFormation 템플릿 (Docker 불필요)
```

`verify.mjs`가 브라우저 없이 되는 이유: Node에는 `document`/`window` 전역이 없어 모듈 스코프의
DOM 접근은 import 시점에 던진다. import 성공만으로는 부족해서
(`if (typeof window !== 'undefined') { … }`는 Node에서 조용히 통과한다) 소스도 스캔한다.

렌더 루프의 단위 테스트는 만들지 않는다. 대신 브라우저 육안 확인으로 갈음한다 — 그 판단이
옳았던 이유는 아래에.

## 알아두면 좋은 함정

전부 실측으로 확인했다. 근거는 `docs/superpowers/specs/`에 있다.

**`.gitignore`의 `*.js`가 `site/js/**`를 삼킨다.** 네거션은 재귀형(`!site/js/**/*.js`)이어야 한다.
`!site/js/*.js`는 `pieces/`를 놓치고, 그 실패는 로컬에서 보이지 않는다 — 파일이 디스크에 있으니
`verify.mjs`도 CDK 스테이징도 통과한다. 깨지는 건 남의 빈 클론뿐이다.

**루트 `package.json`에 `"type":"module"`을 넣으면 안 된다.** `tsc`(TS2835), `jest`
(`module is not defined`), 그리고 `cdk synth`(cdk.json의 app이 `npx tsc &&…`)가 동시에 깨진다.
`site/package.json`으로 범위를 한정한다.

**지표가 초록인데 작품이 죽어 있을 수 있다.** 작품 03은 60fps·NaN 0·메모리 정상이었지만 중력
상수가 830배 작아서 입자가 프레임당 0.06px만 움직였다 — 궤도가 아니라 먼지였다. 눈으로 보지
않으면 잡히지 않는다.

**같은 기법이 밀도에 따라 반대 선택을 요구한다.** 미청소 잔상을 쓰는 작품 01과 03이 각각
`lighter`와 `source-over`를 쓴다. 가산 합성은 입자가 많아 겹칠 때만 밝기를 쌓기 때문이다.

**`lighter`를 덮기에 남기면 5초 만에 순백이 된다.** 흔한 설명("덮기가 가산으로 밝힌다")은 틀렸다 —
입자 0개로 2000프레임 돌려도 원래 색에 머문다. 진짜 버그는 덮기가 **빼기를 멈추는** 것이다.

**Inter · Space Mono · Cormorant Garamond는 셋 다 한글 글리프가 없다.** Noto Sans KR 없이는
한글 폰트가 없는 키오스크에서 모든 설명이 빈칸이 된다.

**`div[role=button][tabindex=0]`에서는 Enter/Space가 클릭을 만들지 않고 Space가 스크롤한다.**
카드는 네이티브 `<button>`이어야 한다.

**해시 한 번 할당에 `hashchange`와 `popstate`가 둘 다 발사된다.** 둘 다 들으면 async 라우터가
두 번 돌아 두 작품이 같은 캔버스에 동시에 그려진다. 그리고 같은 해시 재할당은 아무 이벤트도
내지 않아서, 나가기를 `data-view` 직접 변경으로 하면 같은 카드를 다시 눌러도 죽는다.

## 배포

```bash
npx cdk bootstrap    # 계정/리전에 처음이라면
npx cdk deploy       # CfnOutput 으로 전시 URL 이 나온다
npx cdk destroy      # removalPolicy DESTROY + autoDeleteObjects 라 깨끗이 지워진다
```

버킷은 퍼블릭 접근이 전면 차단되고 CloudFront가 OAC로만 읽는다.
**404를 `index.html`로 돌리지 않는다** — 이건 SPA가 아니고, 돌리면 모듈 경로가 틀렸을 때
브라우저가 JS 대신 HTML을 200으로 받아 엉뚱한 오류를 내거나 조용한 검은 화면이 된다.
요청이 실패한 게 그대로 보여야 한다.
