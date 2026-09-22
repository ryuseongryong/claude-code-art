#!/usr/bin/env node
// verify.mjs — 카탈로그와 Piece 계약을 브라우저 없이 정적 검사한다. 리포 루트에서 실행한다.
//
// 브라우저 없이 되는 이유: Node 에는 document/window 전역이 없어서 모듈 스코프의 DOM 접근은
// import 시점에 ReferenceError 로 던진다. 그리고 import 성공만으로는 부족하므로(가드형
// 우회는 Node 에서 조용히 통과한다) engine.js 의 소스도 스캔한다.
//
// 렌더 루프의 단위 테스트는 만들지 않는다(스펙 7). 여기서 잡는 것은 "계약이 깨졌는가" 이고
// "그림이 예쁜가" 는 브라우저 육안 확인으로 갈음한다.

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 경로를 site/js/ 기준으로 다시 잡는다. WORKS[].module 은 main.js 기준 상대 경로이고
// main.js 는 site/js/ 에 있다. verify.mjs 는 루트에 있으므로 같은 지정자를 그대로 쓰면
// ERR_MODULE_NOT_FOUND 가 난다 — "파일이 없다" 처럼 보이는 오해까지 곁들여서.
const ROOT = pathToFileURL(process.cwd() + '/');
const JS = new URL('./site/js/', ROOT);

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

// ============================================================================
// 0. 카탈로그와 엔진을 읽는다
// ============================================================================

let WINGS, WORKS, Piece;
try {
  ({ WINGS, WORKS } = await import(new URL('data.js', JS)));
  check(true, 'data.js import');
} catch (e) {
  check(false, 'data.js import', e.message);
  process.exit(1);
}
try {
  ({ Piece } = await import(new URL('engine.js', JS)));
  check(typeof Piece === 'function', 'engine.js 가 Piece 를 export 한다');
} catch (e) {
  // 모듈 스코프에서 document/window 를 만졌으면 여기서 잡힌다.
  check(false, 'engine.js import', e.message);
  process.exit(1);
}

// ============================================================================
// 1. engine.js 모듈 스코프 DOM 금지 — 소스 스캔
//
// import 성공은 필요조건일 뿐 충분조건이 아니다. 아래 두 관용구는 Node 에서 조용히
// 통과하고 브라우저에서는 모듈 스코프에서 DOM 을 만진다(실측):
//   typeof window !== 'undefined' && window.matchMedia(...)
//   if (typeof window !== 'undefined') { window.addEventListener(...) }
//
// 규칙: engine.js 에서 DOM 식별자는 함수/메서드/클래스 본문 안에만 나올 수 있다.
// 모듈 스코프(함수도 클래스도 아닌 자리)에 나오면 FAIL 이다.
// ============================================================================

const DOM_IDENT = /\b(document|window|navigator|location|matchMedia|localStorage|sessionStorage|requestAnimationFrame|cancelAnimationFrame|performance|ResizeObserver|AbortController|getComputedStyle|alert|fetch)\b/g;

/** 주석과 문자열/템플릿 리터럴을 같은 길이의 공백으로 바꾼다(오프셋 보존). */
function blankOutLiterals(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; blank(i, Math.min(n, j + 2)); i = j + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      blank(i + 1, j);                 // 따옴표는 남겨 구조를 유지한다
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * 각 문자가 "함수/클래스 본문 안" 인지 표시한다.
 * { 를 만나면 그 { 가 무엇을 여는지 판정한다:
 *   if / for / while / switch / catch 의 블록  -> 제어 블록(여전히 모듈 스코프)
 *   함수 시그니처의 ) 뒤, => 뒤, class 선언 뒤 -> 함수/클래스 본문
 *   그 밖(= 뒤의 객체 리터럴 등)                -> 모듈 스코프
 */
function markFunctionBodies(src) {
  const inFn = new Uint8Array(src.length);
  const stack = [];                       // true = 함수/클래스 본문
  let depthFn = 0;
  const CTRL = /(?:^|[^\w$])(if|for|while|switch|catch)\s*$/;
  const CLASS = /(?:^|[^\w$])class(?:\s+[\w$]+)?(?:\s+extends\s+[\w$.]+)?\s*$/;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      const before = src.slice(0, i);
      let isFn = false;
      if (CLASS.test(before)) {
        isFn = true;
      } else if (/=>\s*$/.test(before)) {
        isFn = true;
      } else if (/\)\s*$/.test(before)) {
        // ) 뒤의 { — 그 ) 의 짝 ( 앞을 보고 제어문인지 함수인지 가른다.
        let j = before.lastIndexOf(')');
        let d = 0;
        for (; j >= 0; j--) {
          if (before[j] === ')') d++;
          else if (before[j] === '(') { d--; if (d === 0) break; }
        }
        const head = before.slice(0, Math.max(0, j));
        isFn = !CTRL.test(head);
      }
      stack.push(isFn);
      if (isFn) depthFn++;
    }
    inFn[i] = depthFn > 0 ? 1 : 0;
    if (c === '}') {
      const was = stack.pop();
      if (was) depthFn--;
    }
  }
  return inFn;
}

function scanModuleScopeDom(file) {
  const raw = readFileSync(new URL(file, JS), 'utf8');
  const src = blankOutLiterals(raw);
  const inFn = markFunctionBodies(src);
  const hits = [];
  DOM_IDENT.lastIndex = 0;
  let m;
  while ((m = DOM_IDENT.exec(src))) {
    if (inFn[m.index]) continue;          // 함수/클래스 본문 안이면 허용
    const line = raw.slice(0, m.index).split('\n').length;
    hits.push(`${file}:${line} ${m[1]}`);
  }
  return hits;
}

{
  const hits = scanModuleScopeDom('engine.js');
  check(hits.length === 0, 'engine.js 는 모듈 스코프에서 DOM 을 만지지 않는다',
        hits.slice(0, 5).join(', '));
}

// ============================================================================
// 2. WINGS
// ============================================================================

const HEX6 = /^#[0-9a-f]{6}$/i;
for (const [key, wing] of Object.entries(WINGS)) {
  check(HEX6.test(wing.accent || ''), `전시관 ${key} accent 가 6자리 hex`,
        `accent=${JSON.stringify(wing.accent)}`);
}

// ============================================================================
// 3. WORKS — 번호 중복, 전시관 존재
// ============================================================================

{
  const seen = new Map();
  const dups = [];
  for (const w of WORKS) {
    if (seen.has(w.no)) dups.push(w.no);
    seen.set(w.no, true);
  }
  check(dups.length === 0, 'WORKS[].no 중복 없음', dups.join(', '));
}

for (const w of WORKS) {
  check(Boolean(WINGS[w.wing]), `작품 ${w.no} 의 wing "${w.wing}" 이 WINGS 에 있다`);
}

// ============================================================================
// 4. 각 작품의 Piece 계약
// ============================================================================

/**
 * name 이 C 자신의 프로토타입 체인(Piece.prototype 이전)에 구현되어 있는가.
 *
 * `name in C.prototype` 은 Piece 가 스텁을 선언하면 아무것도 구현하지 않은 서브클래스에도
 * true 다 — 런타임에 터질 작품을 통과시킨다. 그래서 Piece 에 스텁을 두지 않는다.
 * `Object.hasOwn(C.prototype, name)` 만 보면 중간 베이스 클래스에서 상속한 정당한 작품을
 * 실패시킨다(Phase 2 의 목적 자체가 공통 스캐폴딩 추출이므로 가장 일어날 법한 리팩터다).
 * 그래서 Piece.prototype 까지 걷는 유계 탐색이다.
 */
function implemented(C, name) {
  let p = C.prototype;
  while (p && p !== Piece.prototype) {
    if (Object.hasOwn(p, name)) return true;
    p = Object.getPrototypeOf(p);
  }
  return false;
}

/** destroy 를 재정의한 클래스가 체인 안에 있는가. 있으면 RAF 누수 위험이다. */
function overridesDestroy(C) {
  let p = C.prototype;
  while (p && p !== Piece.prototype) {
    if (Object.hasOwn(p, 'destroy')) return true;
    p = Object.getPrototypeOf(p);
  }
  return false;
}

for (const w of WORKS) {
  if (!w.module) {
    check(true, `작품 ${w.no} 은 Soon 카드 (module: null)`);
    continue;
  }

  const url = new URL(w.module, JS);
  if (!check(existsSync(url), `작품 ${w.no} 모듈 파일 존재 (${w.module})`)) continue;

  let mod;
  try {
    mod = await import(url);
  } catch (e) {
    // 모듈 스코프에서 DOM 을 만졌거나 문법 오류다.
    check(false, `작품 ${w.no} 이 브라우저 없이 import 된다`, e.message);
    continue;
  }
  check(true, `작품 ${w.no} 이 브라우저 없이 import 된다`);

  const C = mod.default;
  if (!check(typeof C === 'function', `작품 ${w.no} 이 클래스를 default export 한다`,
             `typeof default = ${typeof C}`)) continue;

  // Object.getPrototypeOf(C) === Piece 는 중간 클래스에서 오탐한다
  // (class Work extends Field extends Piece -> false). 프로토타입 체인을 걷는 형태가 옳다.
  check(C.prototype instanceof Piece, `작품 ${w.no} 이 Piece 를 상속한다`);
  check(implemented(C, 'setup'), `작품 ${w.no} 이 setup() 을 구현한다`);
  check(implemented(C, 'frame'), `작품 ${w.no} 이 frame() 을 구현한다`);
  check(!overridesDestroy(C), `작품 ${w.no} 이 destroy() 를 재정의하지 않는다`,
        '정리는 teardown() 으로 한다 — super.destroy() 를 잊으면 RAF 가 살아남는다');
  check(scanModuleScopeDom(w.module).length === 0,
        `작품 ${w.no} 이 모듈 스코프에서 DOM 을 만지지 않는다`,
        scanModuleScopeDom(w.module).slice(0, 3).join(', '));
}

// ============================================================================
// 5. 열린 작품이 하나라도 있는가 — 카탈로그 전체가 Soon 이면 전시가 비어 있다
// ============================================================================

check(WORKS.some((w) => w.module), '열린 작품이 하나 이상 있다');

// ============================================================================

console.log('');
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('ALL PASS');
