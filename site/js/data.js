// data.js — 전시 카탈로그. 순수 데이터, 로직 0.
//
// 로직이 들어가면 "작품 추가 = data.js 한 항목 + 파일 하나" 가 깨진다.
// 이 파일은 브라우저와 Node 에서 모두 import 된다(verify.mjs).
//
// 필드 의미 — 캡션과 플래카드가 이걸 그대로 쓴다. 새 필드를 만들지 않는 이유는
// 도슨트 캡션이 필요한 "규칙 한 문장" 과 "조작 힌트" 가 이미 note 와 hint 이기 때문이다.
//
//   no      두 자리 문자열. 중복 금지 (verify.mjs 가 검사).
//   wing    WINGS 의 키여야 한다 (verify.mjs 가 검사).
//   title   영문 제목. 플래카드와 카드의 큰 글씨.
//   ko      한국어 제목.
//   medium  재료 표기. 미술관 라벨의 "oil on canvas" 자리.
//   year    제작 연도.
//   note    이 작품이 쓰는 규칙 한 문장. 플래카드 본문이자 도슨트 캡션의 규칙 줄.
//   hint    조작 힌트 한 문장. 캡션 전용.
//   module  site/js/ 기준 상대 경로. null 이면 갤러리에 "Soon" 카드로 남는다.

export const WINGS = {
  flow: {
    key: 'flow',
    index: 'Ⅰ',
    name: 'Forces & Flow',
    ko: '힘과 흐름',
    sub: 'FORCES & FLOW',
    accent: '#7cc6ff',
    blurb: '보이지 않는 장(場)이 보이는 것을 움직인다. 노이즈에서 각도를 읽고, 중력점이 궤도를 정한다.',
  },
  life: {
    key: 'life',
    index: 'Ⅱ',
    name: 'Living Systems',
    ko: '살아있는 계',
    sub: 'LIVING SYSTEMS',
    accent: '#8fe39a',
    blurb: '단순한 국소 규칙이 스스로 형태를 만든다. 아무도 전체를 설계하지 않았는데 무늬가 생긴다.',
  },
};

export const WORKS = [
  {
    no: '01',
    wing: 'flow',
    title: 'Whispering Currents',
    ko: '속삭이는 해류',
    medium: 'Canvas 2D · 2옥타브 Perlin 벡터장 · 입자 34,000',
    year: 2026,
    note: '벡터장의 각도는 노이즈에서 온다. 화면은 지워지지 않아 입자가 지나간 자리가 빛으로 남는다.',
    hint: '마우스를 움직이면 반경 150px의 바람이 붑니다. 길게 누르면 소용돌이가 1.4초에 걸쳐 충전되고, 놓으면 서서히 풀립니다.',
    module: './pieces/01-currents.js',
  },
  {
    no: '02',
    wing: 'life',
    title: 'Morphogenesis',
    ko: '형태발생',
    medium: 'Canvas 2D · Gray-Scott 반응-확산 · 격자 80,000칸',
    year: 2026,
    note: '두 물질이 서로 다른 속도로 번지며 서로를 만든다. 느린 쪽이 남고 빠른 쪽이 퍼져, 그 속도 차이만으로 무늬가 생긴다.',
    hint: '끌면 씨앗이 흩뿌려집니다. 무늬 버튼으로 네 가지 반응 상수를 오갈 수 있습니다.',
    module: './pieces/02-morphogenesis.js',
  },
  {
    no: '03',
    wing: 'flow',
    title: 'Gravity Garden',
    ko: '중력 정원',
    medium: 'Canvas 2D · 다중 인력점 궤도계',
    year: 2026,
    note: '보이지 않는 인력점 몇 개가 궤도를 정한다. 색은 궤도 반지름이 결정하고, 반지름이 바뀌면 색도 바뀐다.',
    hint: '커서를 가까이 가져가면 흩어지고, 멀어지면 서서히 궤도로 돌아옵니다.',
    module: './pieces/03-gravity.js',
  },
  {
    no: '04',
    wing: 'life',
    title: 'Overgrowth',
    ko: '붐비는 선',
    medium: 'Canvas 2D · 분화 성장 · 순환 연결 리스트',
    year: 2026,
    note: '선은 자기 자신에게서 일정한 간격을 지키려 하고, 자리가 남은 곳마다 두 점 사이로 새 점이 끼어든다. 그래서 길어지고, 갈 곳이 없어지면 접힌다.',
    hint: '커서는 조직이 피해 자라는 돌입니다. 누르고 있으면 그쪽으로 자라고, 클릭하면 새 군체가 생깁니다.',
    module: './pieces/04-overgrowth.js',
  },
  {
    no: '05',
    wing: 'flow',
    title: 'Standing Waves',
    ko: '서 있는 파동',
    medium: 'Canvas 2D · 파동 간섭',
    year: 2026,
    note: '두 파동이 만나 서로를 지우거나 키운다. 지워진 자리가 선이 되어 남는다.',
    hint: '아직 열리지 않았습니다.',
    module: null,
  },
];
