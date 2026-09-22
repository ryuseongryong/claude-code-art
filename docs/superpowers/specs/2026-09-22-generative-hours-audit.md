# Generative Hours — 스펙 감사 기록 (2026-09-22)

`Workflow` 도구로 9개 에이전트를 병렬 실행해 얻은 실측 감사다. 설계 문서
(`2026-09-22-generative-hours-design.md`)의 모든 수치가 여기서 나왔다.

측정 환경: Graviton2 Neoverse-N1 4 vCPU · Node v20.20.2 · Chromium 1243
(ANGLE/SwiftShader = **소프트웨어 래스터, GPU 없음**) · aws-cdk-lib 2.270.0.
따라서 순수 JS 수치는 실기와 비슷하고 캔버스 래스터화 수치는 **비관적 상한**이다.
전이 가능한 신호는 같은 프로세스 안의 A/B 비율이다.

에이전트에게는 리포를 읽기만 하고 실험은 `/tmp`에서 하도록 지시했다.

---

## Node/ESM interop feasibility of verify.mjs (spec item 7)

### 실측 확인

**V1.** BASELINE PREMISE IS FALSE: with root package.json having NO "type" field, `node verify.mjs` importing `./site/js/data.js` ALREADY WORKS on Node v20.20.2. Output: `WINGS keys [ 'flow', 'life' ]` + `EXIT=0`, plus a stderr warning `(node:526109) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///tmp/esmprobe/site/js/data.js is not specified and it doesn't parse as CommonJS. Reparsing as ES module because module syntax was detected. This incurs a performance overhead.` Node's unflagged detect-module is what makes it work: `node --no-experimental-detect-module verify.mjs` fails hard with `Error [ERR_REQUIRE_CYCLE_MODULE]: Cannot require() ES Module /tmp/esmprobe/site/js/data.js in a cycle` at `loadESMFromCJS (node:internal/modules/cjs/loader:1363:24)`.

**V2.** THE FULL IMPORT CHAIN WORKS UNMODIFIED: `verify2.mjs` at /tmp/esmprobe root imported engine.js, data.js, and both pieces. The relative specifier `import { Piece } from '../engine.js'` inside `site/js/pieces/01-currents.js` resolved correctly, and the `Piece` identity was SHARED across the direct import and the piece's import (extendsChain=true proves one cached engine.js module instance, not two).

**V3.** OPTION (a) site/package.json={"type":"module"} WORKS AND SILENCES THE WARNING. Node's nearest-package.json lookup DOES apply to a dynamic import of a deep path: with the file present, `node verify2.mjs` printed the piece results with ZERO stderr warning (previously one warning per .js file). `site/js/pieces/01-currents.js` is 2 dirs below site/package.json and still picked it up.

**V4.** OPTION (a) HAS ZERO COLLATERAL DAMAGE ON THE REAL TOOLCHAIN. On a copy of the real repo at /tmp/repocopy with site/package.json added: `npx tsc --noEmit` -> `tsc EXIT=0`; `npx jest` -> `Test Suites: 1 passed, 1 total / Tests: 1 passed`; `npm ls --depth=0` -> clean tree, no workspace confusion; `node verify.mjs` -> `ALL PASS / verify EXIT=0`.

**V5.** OPTION (b) ROOT "type":"module" BREAKS THREE THINGS, all measured before/after on /tmp/repocopy. BEFORE: tsc EXIT=0, jest 1 passed, `npx cdk synth --quiet` EXIT=0. AFTER adding "type":"module": (1) `npx tsc --noEmit` -> `bin/media-art.ts(3,31): error TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean '../lib/media-art-stack.js'?` EXIT=1. (2) `npx jest` -> `ReferenceError: module is not defined in ES module scope ... at file:///tmp/repocopy/jest.config.js:1:1`. (3) `npx cdk synth` -> EXIT=1, because cdk.json app is `npx tsc && npx tsx bin/media-art.ts` so it inherits the TS2835 failure.

**V6.** OPTION (c) data: URL WORKS FOR data.js BUT HARD-FAILS FOR PIECES. data.js via `import('data:text/javascript;base64,...')` -> OK. A piece -> `TypeError ERR_UNSUPPORTED_RESOLVE_REQUEST | Failed to resolve module specifier "../engine.js" from "data:text/javascript;base64,...": Invalid relative URL or base scheme is not hierarchical.` Rewriting the specifier to an absolute file: URL first does work (`c2 rewrite -> OK, proto===Piece? true`) but requires source-text surgery on every piece.

**V7.** OPTION (c) node:vm NEEDS A FLAG: bare `node` -> `vm.SourceTextModule typeof = undefined`; `node --experimental-vm-modules` -> `SourceTextModule typeof = function`. Plus you would have to hand-write the linker callback for '../engine.js'.

**V8.** OPTION (d) .mjs IS MIME-SAFE BUT UNNECESSARY. Traced the real chain in node_modules: BucketDeployment -> `new (lambda_layer_awscli_1()).AwsCliLayer(...)` + handler `runtime:lambda.Runtime.PYTHON_3_13`; the handler at custom-resource-handlers/dist/aws-s3-deployment/bucket-deployment-handler/index.py:226 does `s3_command = ["s3", "sync"]` with no --content-type; awscli 1.45.61 in the layer does `def guess_content_type(filename): return mimetypes.guess_type(filename)[0]`. Python stdlib mimetypes contains BOTH `'.js' : 'application/javascript'` and `'.mjs' : 'application/javascript'` (grepped from local python3.9 inspect.getsource); local check gave `.mjs ('application/javascript', None)` identical to `.js`. Both are valid JavaScript MIME types, so .mjs would load in a browser -- it just buys nothing.

**V9.** ASSERTION CODE PROVEN: `C.prototype instanceof Piece` is correct for BOTH the direct case (01 extends Piece) and the intermediate case (02 extends GridPiece extends Piece). `Object.getPrototypeOf(C) === Piece` is NOT: measured `01 | proto===Piece? true` vs `02 | proto===Piece? false`. `Object.getOwnPropertyNames(C.prototype)` returned `[ 'constructor', 'setup', 'frame' ]` for both, so it correctly requires setup/frame on the piece's OWN prototype rather than inherited.

**V10.** DOCUMENT/WINDOW AT MODULE SCOPE THROWS A PLAIN CATCHABLE ReferenceError AT IMPORT TIME: `const root = document.body;` at module scope -> `THREW ReferenceError: document is not defined`; `Math.min(window.devicePixelRatio, 2)` at module scope -> `THREW ReferenceError: window is not defined`; the clean engine.js -> `imported clean`. So a plain try/catch around `await import()` is the entire enforcement mechanism for the spec-5 hard constraint.

**V11.** FULL verify.mjs PASS AND FAIL PATHS BOTH PROVEN. Happy path printed 17 PASS lines + `ALL PASS` + EXIT=0. Then I injected 5 defects (bad accent `#8fe9`, wing `void` not in WINGS, deleted frame() from 01, `window.devicePixelRatio` at module scope in 03, nonexistent ./pieces/04-missing.js) and got exactly 5 FAIL lines including `FAIL work 03 imports in bare Node -- ReferenceError: window is not defined` and `FAIL work 04 module file exists`, then `5 FAILED` + `EXIT=1`.

**V12.** BucketDeployment SHIPS site/package.json TO S3. Real `npx cdk synth` of an S3+OAC+CloudFront+BucketDeployment stack produced cdk.out/asset.3909399d.../ containing exactly: index.html, js/data.js, js/engine.js, js/pieces/01-currents.js, js/pieces/02-morphogenesis.js, package.json. Local `python3 -m http.server` serves js/data.js as `Content-type: application/javascript` and package.json as `Content-type: application/json`.

**V13.** GITIGNORE: `git check-ignore -v` in the real repo confirms `.gitignore:1:*.js` ignores site/js/data.js, site/js/engine.js and site/js/pieces/01-currents.js, while `site/package.json` and `verify.mjs` are NOT ignored (exit 0 with no line for them) -- so the recommended fix file is committable even before the negation lands.

### 발견

#### [BLOCKER] The extends-Piece assertion named in the spec brief, Object.getPrototypeOf(SubClass) === Piece, false-negatives on any piece with an intermediate class

**왜 문제인가** — verify.mjs would print FAIL for a legitimate, contract-conforming work the moment anyone factors shared code into an intermediate base (e.g. a GridPiece for the reaction-diffusion ImageData/upscale plumbing shared by work 02 and a future work 04, which spec item 14 explicitly anticipates). Phase 2's whole point is extracting shared scaffolding, so this is the likeliest refactor in the project. A red verify.mjs on correct code trains the implementer to ignore the check, which is worse than having no check.

**근거**

```text
Replica /tmp/esmprobe with pieces/01-currents.js `export default class Currents extends Piece` and pieces/02-morphogenesis.js `class GridPiece extends Piece {...}; export default class Morpho extends GridPiece`. `node verify2.mjs` output:
  01 default? true | proto===Piece? true  | extendsChain? true | own props [ 'constructor', 'setup', 'frame' ]
  02 default? true | proto===Piece? false | extendsChain? true | own props [ 'constructor', 'setup', 'frame' ]
The `proto===Piece? false` on line 02 is the false negative. `C.prototype instanceof Piece` returned true for both (17 PASS lines, ALL PASS, EXIT=0 in the full verify.mjs run).
```

**수정** — Use the prototype-chain-walking form, not the one-level identity check:
  check(C.prototype instanceof Piece, `work ${w.no} extends Piece`);
(`Object.getPrototypeOf(C) === Piece` and `C.__proto__ === Piece` are both wrong here. If you prefer an explicit walk: `let p=C, ok=false; while(p){ if(p===Piece){ok=true;break;} p=Object.getPrototypeOf(p); }`.) Keep `Object.getOwnPropertyNames(C.prototype).includes('setup'|'frame')` as-is — verified to correctly require setup/frame on the piece's own prototype rather than accepting inherited stubs from the intermediate class.

#### [MAJOR] Adding "type":"module" to the ROOT package.json breaks tsc, jest and cdk synth — and buys nothing, because the import already works

**왜 문제인가** — This is the obvious-looking fix and it is a trap. It takes a green repo to three simultaneous failures, including `cdk synth`, which means Phase 4 cannot deploy at all. It would be diagnosed as "CDK is broken" rather than "the package.json edit did it". And the payoff is zero: verify.mjs already imports site/js/*.js successfully without it, so the only thing root type:module actually accomplishes is suppressing a stderr warning that site/package.json suppresses for free.

**근거**

```text
Measured on a full copy of the real repo at /tmp/repocopy (real node_modules, real cdk.json). BEFORE: `npx tsc --noEmit` -> tsc EXIT=0; `npx jest` -> `Test Suites: 1 passed, 1 total`; `npx cdk synth --quiet` -> EXIT=0. AFTER setting p.type="module":
1. `npx tsc --noEmit` -> `bin/media-art.ts(3,31): error TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean '../lib/media-art-stack.js'?` tsc EXIT=1
2. `npx jest` -> `ReferenceError: module is not defined in ES module scope\nThis file is being treated as an ES module because it has a '.js' file extension and '/tmp/repocopy/package.json' contains "type": "module". ... at file:///tmp/repocopy/jest.config.js:1:1`
3. `npx cdk synth --quiet >/dev/null 2>&1; echo $?` -> `real synth EXIT=1`, because `node -e '...cdk.json.app'` prints `npx tsc && npx tsx bin/media-art.ts`, which inherits the TS2835 error.
```

**수정** — Do NOT add "type":"module" to the root package.json. Add a separate one-line file instead:
  site/package.json  ->  {"type": "module"}
This scopes ESM to site/ only. Verified on /tmp/repocopy: tsc EXIT=0, jest 1 passed, npm ls clean, verify.mjs ALL PASS. If root type:module were ever forced anyway it would cost 3 edits (jest.config.js -> jest.config.cjs, `!jest.config.js` -> `!jest.config.cjs` in .gitignore, and `'../lib/media-art-stack'` -> `'../lib/media-art-stack.js'` in bin/media-art.ts) for no benefit.

#### [MAJOR] verify.mjs lives at the repo root, so it cannot `await import(work.module)` the way main.js does — the specifiers resolve against the wrong base

**왜 문제인가** — Spec item 7 says "paths are relative to site/js/" and spec item 8 says main.js does `await import(work.module)`. Those two facts only coexist because main.js itself sits in site/js/. verify.mjs sits at the repo ROOT, so the identical specifier resolves against the root and every module check dies with ERR_MODULE_NOT_FOUND — producing a verify.mjs that FAILs on a perfectly correct catalog. The failure is also misleading: it looks like the module files are missing.

**근거**

```text
In /tmp/repocopy (site/js/pieces/01-currents.js definitely present — confirmed in the cdk.out asset listing):
  node --input-type=module -e 'const {WORKS}=await import("./site/js/data.js"); try{ await import(WORKS[0].module); }catch(e){ console.log("naive FAIL:", e.code, "|", e.message.split("\n")[0]); }'
  -> naive FAIL: ERR_MODULE_NOT_FOUND | Cannot find module '/tmp/repocopy/pieces/01-currents.js' imported from /tmp/repocopy/[eval1]
Note the resolved path dropped site/js/. Rebasing onto site/js/ fixes it: the full verify.mjs using `new URL(w.module, JS)` printed `PASS work 01 module file exists (./pieces/01-currents.js)` and ALL PASS, EXIT=0.
```

**수정** — Establish an explicit site/js/ base URL once and resolve both the existence check and the import against it, so one expression covers both:
  import { existsSync } from 'node:fs';
  import { pathToFileURL } from 'node:url';
  const JS = new URL('./site/js/', pathToFileURL(process.cwd() + '/'));
  const { WINGS, WORKS } = await import(new URL('data.js', JS));
  const { Piece }        = await import(new URL('engine.js', JS));
  // per work: const url = new URL(w.module, JS);  existsSync(url) then await import(url)
`existsSync` accepts a file: URL directly, and `import()` accepts a URL object, so there is no path/URL string juggling. Using `process.cwd()` also makes `node verify.mjs` correctly require being run from the repo root, matching spec item 7.

#### [MAJOR] The data: URL and node:vm approaches for loading pieces are dead ends — pieces import ../engine.js and a data: URL has no hierarchical base

**왜 문제인가** — If chosen, this approach silently works during Phase 1 (data.js has no relative imports, so it passes) and then hard-fails the instant Phase 2 extracts engine.js and the pieces start importing `../engine.js` — i.e. it breaks exactly at the refactor boundary where verify.mjs is most needed. Worse, the natural "fix" (regex-rewriting specifiers to absolute file: URLs) makes verify.mjs depend on the textual form of the import statement in every piece, so a reformat or a bare `import '../engine.js'` breaks the checker.

**근거**

```text
/tmp/esmprobe/probe-data-url.mjs:
  A data.js via data: URL -> OK, WINGS = [ 'flow', 'life' ]
  B piece via data: URL -> FAIL: TypeError ERR_UNSUPPORTED_RESOLVE_REQUEST | Failed to resolve module specifier "../engine.js" from "data:text/javascript;base64,aW1wb3J0IHsgUGllY2UgfSBmcm9tICcuLi9lbmdpbmUuanMnOwo...": Invalid relative URL or base scheme is not hierarchical.
The rewrite workaround does work but requires source surgery: after `.replace("'../engine.js'", JSON.stringify(pathToFileURL('/tmp/esmprobe/site/js/engine.js').href))` -> `c2 rewrite -> OK, proto===Piece? true`.
node:vm needs a flag: bare `node` -> `c3 vm.SourceTextModule typeof = undefined`; `node --experimental-vm-modules` -> `SourceTextModule typeof = function` (and you would still have to write the linker callback yourself).
```

**수정** — Do not read-and-eval. Import the files by file: URL directly (see the JS-base fix above) — Node resolves `../engine.js` correctly from a real file: URL and, verified, shares ONE cached engine.js instance so `Piece` identity matches across verify.mjs's own import and the piece's import (`extendsChain? true` for both works). Drop data:/vm entirely.

#### [MAJOR] The planned .gitignore negation silently drops site/js/pieces/ if written one level deep (!site/js/*.js)

**왜 문제인가** — The brief says the root `*.js` will be "fixed with a negation". The intuitive negation `!site/js/*.js` re-includes data.js, engine.js and main.js but NOT site/js/pieces/*.js — and nothing complains. verify.mjs still prints ALL PASS locally because the files exist on disk; a fresh clone or CI has no pieces at all, and CDK's Source.asset('site') stages from the working tree so the deploy looks fine too. The break surfaces only as a black screen (or, per spec item 9's deliberate no-errorResponses choice, a visible 404) on someone else's machine.

**근거**

```text
Clean test in /tmp/gi2 (`git init`, touch site/js/data.js site/js/pieces/01.js jest.config.js), `git check-ignore -v` which reports the last matching pattern:
  === pattern: !site/js/**/*.js
  .gitignore:3:!site/js/**/*.js	site/js/data.js
  .gitignore:3:!site/js/**/*.js	site/js/pieces/01.js        <- both negated, both tracked
  === pattern: !site/js/*.js
  .gitignore:3:!site/js/*.js	site/js/data.js
  .gitignore:1:*.js	site/js/pieces/01.js                     <- falls back to *.js, IGNORED
Separately, `git check-ignore -v` in the real repo confirms `.gitignore:1:*.js` currently ignores site/js/data.js, site/js/engine.js and site/js/pieces/01-currents.js.
```

**수정** — Use the recursive form in .gitignore:
  !site/js/**/*.js
Then prove it rather than eyeballing it: `git check-ignore -v site/js/*.js site/js/pieces/*.js` must report only `!`-prefixed patterns (or nothing). `site/package.json` and `verify.mjs` need no negation — verified already un-ignored, since `*.js` does not match `.json` or `.mjs`.

#### [MINOR] Without site/package.json, Node emits one MODULE_TYPELESS_PACKAGE_JSON warning per site file and reparses each one; with it, one extra 18-byte object ships to S3

**왜 문제인가** — Two small, opposite costs worth deciding deliberately rather than discovering. Without the file: every `node verify.mjs` run prints a multi-line Node warning per imported .js file, which buries the PASS/FAIL lines during an already tight 2-hour budget, and Node itself says it "incurs a performance overhead" from reparsing. It also means the check silently depends on Node's recent unflagged syntax detection. With the file: BucketDeployment uploads it, so `https://<dist>/package.json` becomes a real public object.

**근거**

```text
Warning text (verbatim, on stderr): `(node:526109) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///tmp/esmprobe/site/js/data.js is not specified and it doesn't parse as CommonJS. Reparsing as ES module because module syntax was detected. This incurs a performance overhead. To eliminate this warning, add "type": "module" to /tmp/esmprobe/package.json.` Dependence on detect-module proven by `node --no-experimental-detect-module verify.mjs` -> `Error [ERR_REQUIRE_CYCLE_MODULE]: Cannot require() ES Module .../site/js/data.js in a cycle`. S3 exposure proven by real `npx cdk synth`: cdk.out/asset.3909399d666854520e9b47556946c0584d8d7f33c21c2b852a71bfc5274efcd1/ contains `package.json` alongside index.html and js/. Served as `Content-type: application/json` (curl against `python3 -m http.server`).
```

**수정** — Add site/package.json containing exactly `{"type": "module"}` and accept the public /package.json — its entire content is the string {"type":"module"}, it leaks nothing, and it keeps the spec-1 "SAME files upload verbatim to S3" promise intact. Do NOT reach for BucketDeployment's `exclude: ['package.json']` to hide it: that would make the S3 copy differ from the local tree, which is the one property spec item 1 asks you to preserve. (Warning is on stderr only — `node verify.mjs 2>/dev/null` printed clean stdout — so `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`, verified working on v20.20.2, is a viable no-new-file alternative, but it hides the signal instead of fixing the cause and has to be repeated in every invocation.)

---

## Canvas rendering performance and numerical budget (spec items 2, 10, 13, 14)

### 실측 확인

**V1.** Machine/JIT baseline: Graviton2 Neoverse-N1, 4 vCPU, Node v20.20.2 (`lscpu`, `node -v`). Reference integer loop `for(i<3e8) s+=i%7` = 891 ms. Browser is Playwright Chromium 1243 HeadlessChrome/153 at /home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome; WEBGL_debug_renderer_info reports `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)` = SOFTWARE rasterization, no GPU. Consequence I applied throughout: pure-JS numbers (Perlin, Gray-Scott, ImageData loops) are representative of a real mid-range device CPU; canvas rasterization numbers (stroke/fillRect/drawImage) are a software-raster UPPER bound and will be materially faster on a real GPU. I therefore treat within-one-process A/B ratios as the transferable signal and label absolute ms accordingly.

**V2.** Item 1 noise cost: a real 2-octave improved-Perlin fBm (two perlin2 calls, permutation table, grad2 switch) at 34000 particles = 68,000 evals/frame measures 5.371 ms/frame noise-only in Node = 79.0 ns/eval, and 5.63 ms/frame in Chromium including full Euler integration = 82.8 ns/eval (min of 3 interleaved passes, stable at 5.63/5.65/5.63). Single octave 34k evals = 1.938 ms / 57.0 ns/eval. So noise is 34% of a 16.6 ms budget on its own and DOES fit.

**V3.** Item 1 the real bottleneck is the canvas, not the noise. Single-process interleaved A/B at 1920x1080, N=34000, min of 3 passes: noise+integrate only = 5.63 ms; 34k separate beginPath/moveTo/lineTo/stroke with per-particle strokeStyle = 104.90 ms; 6 colour-bucket paths (6 stroke() calls) = 48.55 ms; ONE path ONE stroke = 46.99 ms; ImageData manual-fade + additive deposit + putImageData = 19.91 ms; ONE path with 17000 particles = 24.73 ms. Therefore stroke dispatch is ~99 ms of the naive 105 ms frame = 94%, i.e. 17.6x the noise cost. Batching = 104.90 -> 46.99 ms = 2.23x. Colour bucketing is essentially free: 6 buckets (48.55) vs 1 path (46.99) = 3% penalty.

**V4.** Item 1 negative result: ctx.fillRect(x,y,1,1) per particle instead of a stroke is WORSE, not better: 51.74 ms vs 19.43 ms for one batched path (same process, 1920x1080, N=34000).

**V5.** Item 1 negative result: the ImageData route is not free. Isolating it, the manual fade loop alone over a 1920x1080 buffer (2,073,600 px, `d[i]=(d[i]*239)>>8` x3 channels) costs 9.35 ms/frame, vs 0.705 ms for the equivalent ctx.fillRect cover. putImageData of 320x250 = 0.067 ms. So ImageData wins on software raster (19.91 vs 46.99 ms) but its dominant cost is device-independent JS that a GPU cannot accelerate, while the 41 ms stroke cost is rasterization that a GPU can.

**V6.** Item 2 composite ORDER, measured, 600 frames, pixel read via getImageData. Cover=source-over + additive deposit rgba(124,198,255,0.01): stable at rgb(5,16,31) from frame 50 through frame 600. Cover left on 'lighter' with the same deposit: rgb(15,25,37)@f10 -> rgb(55,105,157)@f50 -> rgb(105,205,255)@f100 -> rgb(205,255,255)@f200 -> rgb(255,255,255)@f300. So yes, leaving 'lighter' on is fatal, and it reaches white in ~300 frames = 5.0 s at 60 fps (blue channel clips at frame 100 = 1.67 s).

**V7.** Item 2 mechanism correction (measured, contradicts the usual explanation): with 'lighter' on the cover and ZERO particles drawn, the canvas held at exactly rgb(5,5,7) for all 2000 frames tested and never brightened. Reason: premultiplied 0.066 x 5 = 0.33 quantizes to 0 in 8-bit. So the cover does not additively brighten the canvas; the bug is that the cover stops SUBTRACTING, the fade disappears entirely, and any particle deposit then accumulates monotonically and unboundedly.

**V8.** Item 2 decay: theory n = ln(0.5)/ln(1-0.066) = 10.15 frames to 50%, 33.72 to 10%. Measured from #ffffff with only the cover applied: green channel <=128 at frame 10, <=26 at frame 31, reaches 1 at frame 50 and 0 at frame 75. So 50% in 167 ms, 10% in ~517 ms, fully gone by ~833 ms.

**V9.** Item 2 quantization defect: with the spec's rgba(5,5,7,0.066) cover the canvas settles to rgb(0,0,0), NOT rgb(5,5,7). Alpha sweep after 1200 frames from white: 0.066->rgb(0,0,0), 0.1->rgb(9,9,9), 0.15->rgb(6,6,6), 0.2->rgb(5,5,5), 0.25->rgb(4,4,8), 0.34->rgb(5,5,5), 0.5->rgb(6,6,8), 1.0->rgb(5,5,7).

**V10.** Item 3 Gray-Scott, 320x250 = 80,000 cells x 8 steps = 640,000 cell-updates/frame, Du=0.16 Dv=0.08 dt=1, 9-tap (-1/0.2/0.05), wrap, Float32Array double-buffered. Measured in Node, each variant in its OWN process, 2-3 repetitions, all producing a BIT-IDENTICAL checksum chk=59.730: modulo wrap 19.45-19.71 ms (30.4 ns/cell); precomputed offset-table wrap 19.79-19.98 ms (30.9 ns/cell); sliding-register window 20.21-20.28 ms; flat-index interior loop + table-wrapped border ring 16.78-17.04 ms (26.2 ns/cell); halo/ghost-border grid 16.50-16.57 ms (25.8 ns/cell).

**V11.** Item 3 the specifically requested measurement: modulo wrap vs precomputed offset-table wrap = 19.45 vs 19.79 ms, i.e. the offset table is a 0.98x PESSIMIZATION (2% slower), not a speedup. It adds two Int32Array loads per cell to remove an integer modulo that V8 already strength-reduces. Cross-checked in a fourth batched run: A 19.47 / B 19.98 / A 19.47 / B 19.79.

**V12.** Item 3 Float32 vs Float64: identical kernel, 320x250 x8 steps = 13.13 ms with Float32Array (1250 KiB working set) vs 23.21 ms with Float64Array (2500 KiB) = 1.77x. The spec's Float32Array choice is correct and is worth more than every index-arithmetic trick combined.

**V13.** Item 3 cost is linear in cells and in steps at a near-constant 26.2-27.8 ns/cell-update: 80,000 cells x8 = 17.04 ms, 51,200 x8 = 10.79, 43,200 x8 = 9.53, 37,632 x8 = 7.96, 30,000 x8 = 6.35, 19,200 x8 = 4.03. Same grid with fewer steps: 8->17.51, 6->13.12, 4->8.75, 2->4.38, 1->2.19 ms.

**V14.** Item 4 putImageData does NOT scale, measured directly: an 8x8 ImageData put onto a red-filled 64x64 canvas inside ctx.save(); ctx.scale(8,8); ctx.putImageData(id,0,0); ctx.restore() left 4032 pixels still red and covered exactly 64 pixels (= 8x8, the unscaled size; 4096 would mean it scaled). The two-canvas drawImage route covered 4096/4096 and produced an intermediate value 231 at a sampled pixel with imageSmoothingEnabled=true (bilinear), vs 255 with smoothing disabled (nearest).

**V15.** Item 4 the upscale is the dominant cost of work 02, not the physics. Attributed per-frame at 320x250 grid -> 1920x1080 (6x): sim 8 steps = 12.42 ms; colorize 80k cells into ImageData = 0.83 ms; putImageData 320x250 = 0.067 ms; drawImage upscale with imageSmoothingQuality 'high' = 111.05 ms, 'medium' = 62.88 ms, 'low' = 16.38 ms, imageSmoothingEnabled=false = 3.28 ms. 'high' is 33.8x smoothing-off and 8.9x the entire physics step. End-to-end spec'd frame measured 123.4 ms.

**V16.** Item 5 per-canvas overhead is negligible; N live canvases is not the problem. Trivial identical work on M attached 320x200 canvases: M=1 0.03 ms, M=4 0.14, M=8 0.28, M=12 0.42, M=16 0.56 = 0.035 ms per canvas. The cost is N copies of the WORK.

**V17.** Item 5 work 01 previews are cheap IF the count is area-proportional, and the spec's 6000 floor breaks that. At 320x200: area-proportional 1049 particles = 0.487 ms; the spec's clamp floor of 6000 particles = 2.557 ms (5.3x worse); a non-area-proportional 34000 = 14.39 ms for a SINGLE preview. Area-proportional ladder: 1920x1080/34000 = 21.47 ms, 640x400/4198 = 2.27, 360x220/1299 = 0.595, 320x200/1049 = 0.487, 240x150/600 = 0.277 ms.

**V18.** Item 5 work 02's FIXED ~80k grid makes previews non-viable: 80k grid, 8 steps rendered into a tiny 320x200 canvas still costs 15.60 ms (the canvas size is irrelevant, the grid is the cost). Shrinking the grid to ~10k cells (112x88) = 5.08 ms and ~5k (80x62) = 4.25 ms. So yes, the grid must become area-proportional.

**V19.** Item 5 sizing rule arithmetic verified to reproduce the measured points: cells = clamp(round(cssArea/26), 4000, 80000) yields 79,754 at 1920x1080 (= the spec's ~80,000) and 4,000 at 320x200; particles = clamp(round(cssArea/61), 800, 34000) yields 33,993 at 1920x1080 (= the spec's 34,000), 15,108 at 1280x720 and 1,049 at 320x200 (= the 0.487 ms measured case).

**V20.** Item 6 DPR-2 on 3840x2160 gives a 7680x4320 backing store = 33,177,600 px = 126.6 MiB at RGBA8. The cover fillRect alone, flushed with getImageData every frame, is perfectly linear at 0.325-0.347 ns/px: 921,600 px = 0.32 ms; 2,073,600 = 0.705; 3,686,400 = 1.22; 8,294,400 = 2.725; 14,745,600 = 4.815; 33,177,600 = 10.79 ms. So the fade alone consumes 65% of a 16.6 ms budget before a single particle is drawn.

**V21.** Item 6 full work-01 batched frame vs backing store, particle count clamped at 34000: 1280x720 (N=15111) 18.67 ms; 1920x1080 (34000) 46.22; 2560x1440 (34000) 50.05; 3840x2160 (34000) 54.68; 7680x4320 (34000) 65.59 ms. The clamp caps the particle term, so the +19.4 ms from 2.07M to 33.2M px is pure per-pixel cost.

**V22.** Item 6 recommended cap arithmetic verified: scale = min(dpr, 2, sqrt(3e6/(cssW*cssH))) maps css 1920x1080@dpr2 -> 2309x1299, css 2560x1440@dpr2 -> 2309x1299, css 3840x2160@dpr2 and @dpr3 -> 2309x1299, i.e. a hard 2,999,391 px / 11.4 MiB / ~0.97 ms fillRect ceiling on every display.

**V23.** Item 7 auto-tour 30s does NOT saturate; the system is a stable contraction. Recurrence C' = C(1-0.066) + D has contraction factor 0.934, so 63% settled in 1/0.066 = 15 frames and 99% in 68 frames = 1.13 s, versus 1800 frames in a 30 s slot = 26x the settling time. Measured fixed points after 900 frames (predicted 5 + D/0.066 vs measured R): D=1.28 pred 24.3 meas 5; D=2.55 pred 43.6 meas 31; D=5.10 pred 82.3 meas 61; D=10.20 pred 159.5 meas 136; D=16.57 pred 255 meas 241; D=25.50 pred 255 meas 255. Measured is consistently 12-20% BELOW ideal arithmetic because 8-bit truncation loses ~0.5-1 LSB per step, so real behaviour is even more stable than theory. Independently, the source-over case held rgb(5,16,31) unchanged from frame 50 to frame 600.

**V24.** Item 7 clip threshold: D_max = (255-5) x 0.066 = 16.5 per channel per frame, confirmed by the sweep above (D=16.57 -> 241, D=25.5 -> clipped 255). A spec-plausible per-particle stroke alpha of 0.30 on blue 255 deposits 76 per hit, 4.6x the threshold, so any pixel hit once per frame clips to pure white within ~4 frames.

**V25.** Item 10 work 03 Gravity Garden is not a performance risk. 1920x1080, 5 attractors, full O(N x A) force loop + trail cover, min of 3 interleaved passes: N=400 per-particle strokeStyle 2.21 ms / 16 radius buckets 1.69 ms; N=800 3.78 / 2.74 ms; N=1600 6.76 / 4.69 ms. Quantizing the radius gradient into 16 colour buckets gives 1.31-1.44x and every configuration fits 16.6 ms with room to spare.

**V26.** I made no changes under /home/ec2-user/capstone/media-art. I read package.json and listed site/ (site/js, site/css, site/js/pieces are empty). All benchmark artifacts live in /tmp/perfprobe: perlin.mjs, perlin-global.js, bench-noise.mjs, gs-variants.mjs, run-one.mjs, run-f.mjs, bench-gs.mjs, bench-mem.mjs, canvas-bench.cjs, canvas-bench2.cjs, decay.cjs, floor.cjs, previews.cjs, upscale.cjs, work01.cjs, work01b.cjs, ab.cjs, buckets.cjs, work03.cjs, final.cjs.

### 발견

#### [BLOCKER] Work 02 as specified cannot hit 60fps: the 80,000-cell x 8-step sim alone is 16.5ms, leaving 0ms for drawing

**왜 문제인가** — 640,000 cell-updates/frame at a measured floor of 25.8 ns/cell-update consumes the entire 16.6 ms frame before a single pixel is drawn. Work 02 will run at roughly 30 fps at best on a mid-range CPU and the RAF loop will be permanently frame-starved, which also starves the room UI (placard, caption slide-in, exit button) on the same main thread.

**근거**

```text
Node, each variant in its own process, bit-identical checksum chk=59.730. `node run-one.mjs A 320 250 8` -> 19.45-19.71 ms (30.4 ns/cell); flat-index interior variant E -> 16.78-17.04 ms (26.2 ns/cell); halo-border variant F -> 16.50-16.57 ms (25.8 ns/cell). Float64 for comparison: 23.21 ms. Cost is linear in cells at a near-constant 26-28 ns/cell across 12,288 -> 80,000 cells.
```

**수정** — Keep 8 steps (they are what makes the pattern move at a watchable rate) and shrink the grid to ~30,000 cells: 200x150 measures 6.35 ms, leaving ~10 ms for colorize + blit + UI. Derive it rather than hardcoding: `cells = clamp(Math.round(cssW*cssH/26), 4000, 30000)`. Combine with the flat-index interior loop (`for (let i=r+1; i<r+W-1; i++)` using `u[i-1], u[i+1], u[i-W], u[i+W], u[i-W-1], u[i-W+1], u[i+W-1], u[i+W+1]`) plus a separate border ring for wrap, which is a measured 1.16x, or a halo/ghost-border grid for 1.18x. Do NOT reach for a precomputed offset table (see separate finding). If the 80,000-cell look is non-negotiable, dropping to 4 steps/frame measures 8.75 ms, but that halves the visible reaction rate.

#### [BLOCKER] Work 02's "smoothly upscaled" blit costs 111ms/frame with imageSmoothingQuality 'high' — 9x the physics

**왜 문제인가** — The spec says the coarse grid is "drawn via ImageData and smoothly upscaled", and the obvious reading of "smoothly" is imageSmoothingQuality='high'. That single drawImage call is measured at 111 ms — it alone is 6.7 frames' worth of budget, making work 02 a slideshow regardless of how small the grid gets. Even 'low' (16.4 ms) exceeds the whole budget.

**근거**

```text
Chromium, 320x250 -> 1920x1080 (6x), each drawImage flushed with getImageData, 30 iterations after 6 warmups: smoothing 'high' 111.05 ms, 'medium' 62.88 ms, 'low' 16.38 ms, imageSmoothingEnabled=false 3.28 ms. Same process: sim 8 steps 12.42 ms, colorize 80k cells 0.83 ms, putImageData 320x250 0.067 ms. End-to-end spec'd frame 123.42 ms. (SwiftShader software raster, so absolute values are an upper bound — but the 33.8x 'high'-vs-off ratio is the transferable signal, and Skia's high-quality resample is a CPU-side multi-pass filter on many real configurations too.)
```

**수정** — Do no JS upscale at all. Size the visible #stage backing store to the grid (`stage.width = GW; stage.height = GH`) and let CSS stretch the element (`#stage{width:100%;height:100%}`); the compositor does the bilinear filter on the GPU for free. Measured JS cost of that path is 0.07 ms (putImageData only) vs 111.05 ms — 1586x. Because the engine owns resize, add a `logicalSize()` / `resolution` hook to the Piece contract so a work can declare a backing store smaller than the element instead of the engine always matching CSS x DPR. If you must keep a full-res #stage, use two canvases and `imageSmoothingQuality='low'` at most, never 'high'.

#### [BLOCKER] Work 01 at 34000 particles with per-particle beginPath/stroke is 105ms/frame; batching into one path per colour is a measured 2.2x and must be in Phase 1

**왜 문제인가** — Spec item 6 mandates Phase 1 be "work 01 in ONE file, zero abstraction", which is exactly the shape that produces 34,000 separate beginPath/moveTo/lineTo/stroke calls with a strokeStyle assignment per particle. That is 105 ms/frame = 9.5 fps. The path-dispatch cost is 94% of the frame and 17.6x the noise cost, so it will be misdiagnosed as "Perlin is too slow" and lead to gutting the vector field instead of fixing the draw call.

**근거**

```text
Single Chromium process, all strategies warmed then interleaved over 3 passes, 1920x1080, N=34000, min of 3: noise+integrate only 5.63 ms; 34k separate paths w/ per-particle strokeStyle 104.90 ms; 6 colour-bucket paths 48.55 ms; ONE path ONE stroke 46.99 ms; ImageData manual-fade+deposit 19.91 ms; ONE path at 17000 particles 24.73 ms. Also measured: ctx.fillRect(x,y,1,1) per particle is 51.74 ms vs 19.43 ms for a batched path — worse, not better. 2-octave Perlin itself is only 79.0 ns/eval (Node, 68k evals = 5.371 ms).
```

**수정** — Batch unconditionally, from Phase 1: accumulate every segment into ONE ctx.beginPath() and issue a single ctx.stroke(). If you want per-particle colour, quantize hue into K<=8 buckets and emit one path + one stroke per bucket — measured overhead of 6 buckets vs 1 path is 3% (48.55 vs 46.99 ms), so colour variety is effectively free while per-particle strokeStyle costs 2.2x. Note also that bucket memory layout does not matter: scattered Int32Array index gather 93.5 ms vs contiguous per-bucket ranges 93.0 ms vs split physics-then-draw 94.8 ms, all within 5% in one process — so do not spend time sorting particles by colour. Batching gets you to 47 ms on this software rasterizer; close the rest with the backing-store cap below and an adaptive particle clamp (17000 measures 24.73 ms).

#### [MAJOR] Cover fillRect with globalCompositeOperation still 'lighter' disables the fade entirely and reaches white in ~1.7-5s; the usual "it brightens" explanation is wrong

**왜 문제인가** — One missing reset between the particle pass and the next frame's cover turns the trail fade into a no-op, so every deposit accumulates without bound and the piece whites out. In auto-tour (item 12) each work runs 30 s = 1800 frames, so a kiosk left alone displays a solid white rectangle. The commonly-repeated explanation — that the cover additively brightens the canvas — is measurably false and will send you looking in the wrong place.

**근거**

```text
Chromium, 600 frames, getImageData per sample. Cover='lighter' + additive deposit rgba(124,198,255,0.01): rgb(15,25,37)@f10, rgb(55,105,157)@f50, rgb(105,205,255)@f100 (1.67 s, blue clipped), rgb(205,255,255)@f200, rgb(255,255,255)@f300 (5.0 s). Same deposit with cover='source-over': stable rgb(5,16,31) from f50 through f600. Mechanism proof: cover='lighter' with ZERO particles held at exactly rgb(5,5,7) for all 2000 frames tested — it never brightened, because premultiplied 0.066x5 = 0.33 quantizes to 0 in 8-bit. The defect is that the cover stops SUBTRACTING.
```

**수정** — Set the composite explicitly at both points every frame, never rely on leftover state: `frame(dt,t){ ctx.globalCompositeOperation='source-over'; ctx.fillStyle='rgba(5,5,7,0.066)'; ctx.fillRect(0,0,w,h); ctx.globalCompositeOperation='lighter'; /* ...one batched path + stroke... */ ctx.globalCompositeOperation='source-over'; }` — i.e. set source-over immediately before the cover and reset to source-over at the end of frame() so the placard/caption/UI draws and the next mount start from a known state. Best: have engine.js reset `globalCompositeOperation='source-over'`, `globalAlpha=1` and `filter='none'` in mount() and after each frame() call, so a work can never poison the one shared #stage canvas for the next work.

#### [MAJOR] DPR capped at 2 is not enough: a 4K display yields a 33.2M-pixel / 126.6 MiB backing store where the fade fillRect alone costs 10.8ms

**왜 문제인가** — On 3840x2160 with DPR 2 the engine allocates 7680x4320. The per-frame full-screen cover fillRect — which every work does — consumes 10.79 ms of a 16.6 ms budget before any particles, and that is the cheapest operation in the pipeline. 126.6 MiB per canvas also risks silent canvas-allocation failure on memory-capped browsers (iOS Safari), which is exactly the "black screen with no visible reason" outcome spec item 9 says to avoid.

**근거**

```text
Chromium, cover flushed with getImageData every frame, perfectly linear at 0.325-0.347 ns/px: 921,600 px 0.32 ms; 2,073,600 0.705; 3,686,400 1.22; 8,294,400 2.725; 14,745,600 4.815; 33,177,600 10.79 ms. Full batched work-01 frame vs backing store with N clamped at 34000: 1280x720 18.67 ms, 1920x1080 46.22, 2560x1440 50.05, 3840x2160 54.68, 7680x4320 65.59 ms — the +19.4 ms from 2.07M to 33.2M px is pure per-pixel cost since the clamp already caps the particle term.
```

**수정** — Add an absolute backing-store pixel cap alongside the DPR cap, in engine.js resize: `const CAP = 3_000_000; const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(CAP / (cssW * cssH))); canvas.width = Math.round(cssW * scale); canvas.height = Math.round(cssH * scale);` Verified: css 1920x1080@dpr2, 2560x1440@dpr2, 3840x2160@dpr2 and @dpr3 all land on 2309x1299 = 2,999,391 px = 11.4 MiB = ~0.97 ms fillRect. Also clamp each dimension to 4096 (`MAX_DIM`), since several mobile GPUs reject canvases above that. Expose `scale` to works so the pointer normalization and any px-space constants stay correct.

#### [MAJOR] Work 02's fixed ~80,000-cell grid makes item 13's card-hover mini preview impossible; the grid must become area-proportional

**왜 문제인가** — Spec item 4 fixes the grid at ~80,000 cells independent of screen size, and spec item 13 wants a live mini preview of that work on hover. Rendering an 80k-cell 8-step sim into a 320x200 card costs 15.60 ms whether the canvas is 320x200 or 1920x1080 — the grid is the cost, the canvas is not — so a single hover preview eats the entire gallery frame budget and the entrance stagger and card transitions will visibly jank on the exact interaction the choreography is meant to sell.

**근거**

```text
Chromium: 80k grid / 8 steps / 1920x1080 canvas = 123.42 ms; the identical sim drawn into a TINY 320x200 canvas = 15.60 ms (canvas size nearly irrelevant); ~10k grid (112x88) at 320x200 = 5.08 ms; ~5k grid (80x62) = 4.25 ms. Separately, per-canvas overhead is negligible — M live 320x200 canvases doing trivial work: M=1 0.03 ms, M=4 0.14, M=8 0.28, M=12 0.42, M=16 0.56 ms = 0.035 ms/canvas — so N canvases is not the problem, N copies of the work is.
```

**수정** — Two changes. (1) Make both works' cost area-proportional via the Piece contract, with rules verified to reproduce the spec's own numbers at full screen: `cells = clamp(Math.round(area/26), 4000, 80000)` gives 79,754 at 1920x1080 and 4,000 at 320x200; `particles = clamp(Math.round(area/61), 800, 34000)` gives 33,993 at 1920x1080, 15,108 at 1280x720, 1,049 at 320x200. Note this requires lowering work 01's spec'd 6000 floor to ~800: at 320x200 the 6000 floor measures 2.557 ms vs 0.487 ms area-proportional, a 5.3x penalty for pixels nobody can resolve. (2) Use exactly ONE shared preview canvas that is reparented into the hovered card (`card.appendChild(previewCanvas)`), behind a ~120 ms hover-intent debounce, running at a throttled 20-30 fps rather than 60, and destroy()ed on mouseleave. With rule (1) that is 0.487 ms every other frame for work 01 and ~4 ms for work 02 — affordable. For a tiny canvas to be cheap a piece must have NO fixed-size internal state: every allocation (particle arrays, grids, ImageData) must derive from the mount area in setup()/onResize, which is exactly what the current work-02 spec violates.

#### [MINOR] The precomputed offset-table wrap the plan assumes is a speedup is actually a 2% pessimization; the real 1.16x win is eliminating per-cell index arithmetic

**왜 문제인가** — Not a defect in the spec, but a concrete trap for the optimization budget: in a 2-hour build, implementing rowM/rowP/colM/colP tables is ~20 lines of fiddly indexing that buys negative performance, and having "optimized" it you will conclude the sim is irreducible and ship a 30 fps work 02 instead of shrinking the grid.

**근거**

```text
Node, each variant in its own process, 2-3 reps, all bit-identical (chk=59.730): modulo wrap 19.45 / 19.47 / 19.47 / 19.66 / 19.71 ms; offset-table wrap 19.79 / 19.79 / 19.82 / 19.98 ms => 0.98x. Sliding-register window 20.21-20.28 ms => 0.96x. Flat-index interior loop + border ring 16.78-17.04 ms => 1.16x. Halo/ghost-border grid 16.50-16.57 ms => 1.18x. Interior-only kernel with no wrap handling at all 13.13 ms, which bounds the whole index-arithmetic term at ~1.5x. An earlier same-process run that appeared to show 1.13x for the table was JIT cross-contamination and did not reproduce under process isolation.
```

**수정** — Skip the offset tables. Spend the time on, in order of measured value: Float32Array over Float64Array (1.77x — already in the spec, keep it), shrinking the grid (linear, unbounded), and only then the flat-index interior loop + separate border ring (1.16x). A halo grid of (W+2)x(H+2) with an edge-copy at the top of each step is 1.18x and is the cleanest to write correctly.

#### [MINOR] The rgba(5,5,7,0.066) cover quantizes its own tint to zero — work 01 fades to #000000, not the museum tone #050507

**왜 문제인가** — The 5,5,7 in the cover colour has no effect at alpha 0.066: premultiplied 0.066x5 = 0.33 truncates to 0 in 8-bit, so the canvas decays to pure black. Work 01's background will read as a black hole rather than the reference site's #0a0b0f / #050507 tone, and it will visibly mismatch the CSS background of the gallery and placard it sits next to — a design bug that looks like a colour-token mistake and will be hunted in CSS.

**근거**

```text
Chromium, 1200 frames from #ffffff with only the cover applied, settled value by alpha: 0.066 -> rgb(0,0,0); 0.1 -> rgb(9,9,9); 0.15 -> rgb(6,6,6); 0.2 -> rgb(5,5,5); 0.25 -> rgb(4,4,8); 0.34 -> rgb(5,5,5); 0.5 -> rgb(6,6,8); 1.0 -> rgb(5,5,7). Decay trace confirms it reaches 0: frame 34 rgb(19,19,19), frame 50 rgb(1,1,1), frame 75 rgb(0,0,0).
```

**수정** — Keep the cover as transparent black — `rgba(0,0,0,0.066)` — which is honest about what it actually does, and put the museum tone on the element instead: `#stage{background:var(--bg,#0a0b0f)}` with the canvas context created WITHOUT `{alpha:false}` so the CSS background shows through. That also makes the tone follow the per-wing accent/CSS variables for free, satisfying spec item 8's "adding a wing must require NO CSS edits". Do not chase the tint by raising the cover alpha: the settled values above are non-monotonic (0.1->9, 0.15->6, 0.2->5, 0.25->4) because of 8-bit rounding, so it is not tunable.

#### [MINOR] Per-particle stroke alpha of 0.30 exceeds the additive clip threshold by 4.6x, so flow-field convergence filaments clip to pure white

**왜 문제인가** — Answering item 7 precisely: the screen does not saturate globally, but individual pixels do. The additive/fade balance has a hard clip threshold of 16.5 per channel per frame; a stroke at alpha 0.30 on a blue-255 colour deposits 76 per hit. Any pixel that a particle crosses every frame — which is exactly what Perlin flow-field convergence lines are — clips to #ffffff within ~4 frames, flattening the bright cores into featureless white and destroying the hue information the palette is for. The long-press vortex (radius up to min(w,h)*0.42, strength to 5.2) concentrates particles and makes this worse.

**근거**

```text
Threshold derived from the measured recurrence and confirmed by sweep: D_max = (255-5) x 0.066 = 16.5. Chromium, 900 frames, predicted 5+D/0.066 vs measured R: D=1.28 -> 24.3/5; D=2.55 -> 43.6/31; D=5.10 -> 82.3/61; D=10.20 -> 159.5/136; D=16.57 -> 255/241; D=25.50 -> 255/255 (clipped). Measured runs 12-20% below ideal arithmetic because 8-bit truncation loses ~0.5-1 LSB/step.
```

**수정** — Cap the per-particle deposit so a once-per-frame hit stays under the threshold: stroke alpha <= 16.5/255 = 0.065, and use ~0.04 to leave headroom for the 2-5x overlap in convergence zones. Concretely `ctx.strokeStyle='rgba(124,198,255,0.04)'`. If you want brighter cores, raise the cover alpha in step — the fixed point is C_inf = D/0.066, so doubling the cover alpha to 0.132 doubles the sustainable deposit, at the cost of halving the trail length (already short: 50% decay in 10 frames / 167 ms, 10% in 31 frames / 517 ms, fully black by frame 75 / 833 ms — verify that ~0.5 s tail is the intended "trail", because it is much shorter than the 0.066 figure suggests).

#### [MINOR] Item 14's "work 04 without breaking existing performance" has no enforcement mechanism, and works 01/02 have already spent the whole budget

**왜 문제인가** — There is no unit-test story for render loops (item 7 deliberately), so nothing catches a regression. Works 01 and 02 as specified are at 47 ms and 123 ms respectively — both already over budget — so "does not break performance" is unverifiable and work 04 will be added on top of an unmeasured deficit. Work 03 by contrast is provably cheap, which shows the gap is in the contract, not the concept.

**근거**

```text
Measured per-frame at 1920x1080: work 01 naive 104.90 ms / batched 46.99 ms / ImageData 19.91 ms; work 02 as spec'd 123.42 ms (sim 12.42 + 'high' upscale 111.05); work 03 Gravity Garden with the full O(N x A) force loop, 5 attractors, min of 3 interleaved passes — N=400 2.21 ms per-particle-colour / 1.69 ms with 16 radius buckets; N=800 3.78 / 2.74 ms; N=1600 6.76 / 4.69 ms. Work 03 fits 16.6 ms at every size tested.
```

**수정** — Put a measurable cost contract in engine.js rather than a prose goal. (a) The engine already owns the clock; have it keep an EWMA of frame time and expose it, then let each Piece declare `static budget = { particles: a => clamp(a/61, 800, 34000) }` or `cells: a => clamp(a/26, 4000, 30000)` so every work's cost is a stated function of area and reviewable by inspection. (b) Add an auto-degrade step: if the EWMA frame time exceeds ~20 ms for 60 consecutive frames, scale the work's declared budget by 0.8 and re-setup. This is what makes the item-12 kiosk survive on unknown hardware and makes "work 04 does not break the others" an actual invariant. (c) Extend verify.mjs to statically assert every piece module exports a `budget` whose values are functions of area, not literals — that is checkable in Node without a browser, same as the existing Piece-contract checks. (d) For work 03 specifically, quantize the radius gradient into 16 buckets (1.31-1.44x measured) rather than assigning strokeStyle per particle, so it does not repeat work 01's mistake at a smaller scale.

---

## CDK correctness for the S3 + CloudFront + OAC stack (spec item 9), verified against aws-cdk-lib 2.270.0 as installed in /home/ec2-user/capstone/media-art/node_modules

### 실측 확인

**V1.** Installed version is aws-cdk-lib **2.270.0** (package.json says ^2.269.0), aws-cdk CLI 2.1142.0, Node v20.20.2, tsc 7.0.2. `node -e "console.log(require('aws-cdk-lib/package.json').version)"` -> `2.270.0`.

**V2.** CORRECT modern OAC API exists and is the right one. /home/ec2-user/capstone/media-art/node_modules/aws-cdk-lib/aws-cloudfront-origins/lib/s3-bucket-origin.d.ts:44-54 declares `export declare abstract class S3BucketOrigin extends cloudfront.OriginBase` with `static withOriginAccessControl(bucket: IBucket, props?: S3BucketOriginWithOACProps): cloudfront.IOrigin;` (line 48) and `static withOriginAccessIdentity(bucket: IBucket, props?: S3BucketOriginWithOAIProps): cloudfront.IOrigin;` (line 54, doc comment: 'OAI is a legacy feature and we **strongly** recommend you to use OAC via withOriginAccessControl()'). `S3BucketOriginWithOACProps` (line 15) has `originAccessControl?: IOriginAccessControlRef` (default: one is created) and `originAccessLevels?: AccessLevel[]` (default `[AccessLevel.READ]`).

**V3.** The modern helper AUTO-ADDS the bucket policy statement — no manual `addToResourcePolicy` needed. In aws-cloudfront-origins/lib/s3-bucket-origin.js, class `S3BucketOriginWithOAC.bind()` does: `this.originAccessControl||(this.originAccessControl=new cloudfront.S3OriginAccessControl(scope,"S3OriginAccessControl"))` then `grantDistributionAccessToBucket(...)` which builds `new iam.PolicyStatement({effect:ALLOW, principals:[new iam.ServicePrincipal("cloudfront.amazonaws.com")], actions:["s3:GetObject"], resources:[bucket.arnForObjects("*")], conditions:{StringEquals:{"AWS:SourceArn":`arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/${distributionId}`}}})` and calls `this.bucket.addToResourcePolicy(...)`. It also emits warning `@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac` if the bucket is imported (statementAdded=false).

**V4.** `AccessLevel` enum lives in aws-cloudfront/lib/origin-access-control.d.ts:43 with members READ, READ_VERSIONED, LIST, WRITE, DELETE; `S3OriginAccessControl` (L1-wrapping L2) at line 176; the L1 `CfnOriginAccessControl` exists at aws-cloudfront/lib/cloudfront.generated.d.ts:3260 but is NOT needed.

**V5.** `aws-cdk-lib/core` subpath export DOES exist in this version: aws-cdk-lib/package.json `exports['./core'] === './core/index.js'`, alongside `'.'`, `'./aws-s3'`, `'./aws-cloudfront'`, `'./aws-cloudfront-origins'`, `'./aws-s3-deployment'`. Mixing is safe — `require('aws-cdk-lib/core').Stack === require('aws-cdk-lib').Stack` -> `true`, and `stack instanceof barrel.Stack` -> `true`. So bin/media-art.ts's `import * as cdk from 'aws-cdk-lib/core'` style is fine and needs no change.

**V6.** My recommended stack COMPILES: `cd /tmp/ma-probe && npx tsc --noEmit` -> `tsc EXIT=0` (no output).

**V7.** My recommended stack SYNTHS: `npx cdk synth -q` -> `synth EXIT=0` (stderr contained only the line `AI agent detected`). cdk.out contains MediaArtStack.template.json, 4 assets, manifest.json, tree.json, validation-report.json.

**V8.** Template confirms all four public-access blocks: `PublicAccessBlockConfiguration: {BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true}` on `ExhibitionBucket0C2E5195`, with `UpdateReplacePolicy: Delete` / `DeletionPolicy: Delete`.

**V9.** Template confirms the OAC bucket-policy statement: `{"Action":"s3:GetObject","Condition":{"StringEquals":{"AWS:SourceArn":{"Fn::Join":["",["arn:",{"Ref":"AWS::Partition"},":cloudfront::",{"Ref":"AWS::AccountId"},":distribution/",{"Ref":"ExhibitionCdnB6D718CB"}]]}}},"Effect":"Allow","Principal":{"Service":"cloudfront.amazonaws.com"},"Resource":{"Fn::Join":["",[{"Fn::GetAtt":["ExhibitionBucket0C2E5195","Arn"]},"/*"]]}}`.

**V10.** Template confirms `AWS::CloudFront::OriginAccessControl` with `{OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4"}`, and the origin carries `OriginAccessControlId: {Fn::GetAtt: [ExhibitionCdnOrigin1S3OriginAccessControlF144B558, "Id"]}` plus the required legacy-empty `S3OriginConfig: {OriginAccessIdentity: ""}`.

**V11.** Template confirms distribution config: `DefaultRootObject: "index.html"`, `DefaultCacheBehavior.ViewerProtocolPolicy: "redirect-to-https"`, `DefaultCacheBehavior.Compress: true`, and NO CustomErrorResponses — `JSON.stringify(DistributionConfig).includes('CustomErrorResponses')` -> `false`.

**V12.** Outputs confirmed: `ExhibitionUrl = Fn::Join['', ['https://', Fn::GetAtt[ExhibitionCdnB6D718CB, 'DomainName'], '/']]`.

**V13.** BucketDeployment needs NO Docker in 2.270.0, and `cdk synth` works on this machine where Docker is absent. `command -v docker` -> nothing (`docker: NOT INSTALLED`); `which docker podman finch` all fail; `docker info` -> `command not found`. Yet synth exit 0. Reason from MediaArtStack.assets.json: the AwsCliLayer asset has `"packaging": "file"` (a prebuilt zip shipped by node_modules/@aws-cdk/asset-awscli-v1, referenced as `Code.fromAsset(ASSET_FILE)` in lambda-layer-awscli/lib/awscli-layer.js), and the handler + site assets are plain directory copies with `"packaging": "zip"` (zipped by the CLI in pure JS). Docker is only needed if you pass `bundling` to `Source.asset()`, which this site does not need.

**V14.** The deployment custom resource created: `Custom::CDKBucketDeployment` + `AWS::Lambda::Function` (Runtime `python3.13`, Architectures `[arm64]`, Handler `index.handler`, MemorySize 1024, Timeout 900) + `AWS::Lambda::LayerVersion` (AwsCliLayer) + IAM Role + IAM Policy + `AWS::Logs::LogGroup`. It is a SingletonFunction (`lambdaPurpose:"Custom::CDKBucketDeployment"`), so N BucketDeployments share one Lambda.

**V15.** distributionPaths requires the distribution object. aws-s3-deployment/lib/bucket-deployment.js: `if(props.distributionPaths){if(!props.distribution)throw new ValidationError(lit`DistributionSpecifiedDistributionPathsSpecified`,"Distribution must be specified if distribution paths are specified")}` and every path must start with `/`. Reproduced empirically: removing `distribution,` -> synth EXIT=1, `«DistributionSpecifiedDistributionPathsSpecified» Distribution must be specified if distribution paths are specified`. Passing it also adds `cloudfront:GetInvalidation`/`cloudfront:CreateInvalidation` on `*` to the handler role, and the CR gets `DistributionId: {Ref: ExhibitionCdnB6D718CB}`, `DistributionPaths: ["/*"]`, `WaitForDistributionInvalidation: true`.

**V16.** autoDeleteObjects + removalPolicy DESTROY are BOTH mandatory — not merely recommended. Changing only removalPolicy to RETAIN: synth EXIT=1 with `«CannotAutoDeleteObjectsProperty» Cannot use 'autoDeleteObjects' property on a bucket without setting removal policy to 'DESTROY'.` autoDeleteObjects adds to the template: `Custom::S3AutoDeleteObjects`, a dedicated `AWS::IAM::Role` + `AWS::Lambda::Function` (provider), the bucket tags `aws-cdk:auto-delete-objects=true` and `aws-cdk:cr-owned:<hash>=true`, and a bucket-policy statement allowing that role `s3:DeleteObject*, s3:GetBucket*, s3:List*, s3:PutBucketPolicy`.

**V17.** Content-Type is set correctly for this site. The handler shells out to `/opt/awscli/aws s3 sync --delete [--exclude ...] <contents_dir> s3://<bucket>` (index.py lines ~227-241, `aws_command` uses `aws="/opt/awscli/aws" # from AwsCliLayer`). aws s3 sync derives Content-Type from Python `mimetypes`. Checked with `python3 -c "import mimetypes; mimetypes.init(files=[])"` (pure built-in table, no /etc/mime.types — and /etc/mime.types does not exist here either): index.html -> text/html, style.css -> text/css, main.js -> application/javascript, piece.mjs -> application/javascript, x.webmanifest -> application/manifest+json. All are valid ES-module MIME types, so `<script type="module">` loads fine. (woff2 and .map return None -> binary/octet-stream, irrelevant since the spec allows only Google Fonts CSS externally.)

**V18.** `exclude` syntax is `exclude?: string[]` (aws-s3-deployment/lib/bucket-deployment.d.ts:49) and is forwarded verbatim as repeated `--exclude <pattern>` to `aws s3 sync`, landing in the template as `"Exclude": ["package.json", ".DS_Store"]`. Semantics reproduced with the CLI's own fnmatch-on-joined-rootdir logic: pattern `package.json` matches only `/contents/package.json` (True) and NOT `/contents/js/package.json` (False) — i.e. top-level only, which is exactly what is wanted for the site/package.json ESM shim. Note the d.ts warns this excludes from the *sync*, not from the asset: `find` on the staged asset dir cdk.out/asset.c3afdb8f.../ still lists `package.json`, so it affects the asset hash but is never uploaded.

**V19.** CDK asset staging does NOT honour .gitignore, so the repo's `*.js` .gitignore bug cannot break the S3 upload. The staged site asset contained css/style.css, index.html, js/data.js, js/engine.js, js/main.js, js/pieces/01-currents.js, package.json — all present despite root `.gitignore` line 1 being `*.js`. (The .gitignore fix is still needed for git itself.)

**V20.** `cdk synth` succeeds when site/ contains only empty subdirectories (the repo's current state: site/css, site/js, site/js/pieces and no files) — tested in /tmp/empty-test, EXIT=0. No trap there.

**V21.** Existing scaffold needs no changes. `npx jest` still passes (`Tests: 1 passed`). cdk.json's app command `npx tsc && npx tsx bin/media-art.ts` is a working typecheck gate (tsconfig has noEmit:true so `tsc` emits nothing). The env-agnostic stack (no `env` in bin/media-art.ts) synths and is deployable to any single region; S3+CloudFront+OAC need no region-specific lookup. cdk.out/validation-report.json is `{"version":"54.0.0","title":"Validation Report","pluginReports":[]}` — produced because of `@aws-cdk/core:annotationsInValidationReport`/`validateAgainstDefaultRules`, harmless, and cdk.out is already in .gitignore.

### 발견

#### [MAJOR] Omitting `blockPublicAccess` emits NO PublicAccessBlockConfiguration in 2.270.0 — spec item 9's "all public access blocked" silently goes unmet in the template

**왜 문제인가** — With `@aws-cdk/aws-s3:publicAccessBlockedByDefault: true` set in this repo's cdk.json (line present), it is tempting to think the flag makes BLOCK_ALL the default. It does not. Reading aws-s3/lib/bucket.js: `...S3_PUBLIC_ACCESS_BLOCKED_BY_DEFAULT)&&(publicAccessBlockConfig=this.setDefaultPublicAccessBlockConfig(props.blockPublicAccess))` — the flag only *fills in unspecified sub-fields* of a `blockPublicAccess` object you already passed (`setDefaultPublicAccessBlockConfig(o){return{blockPublicAcls:o.blockPublicAcls??!0, blockPublicPolicy:o.blockPublicPolicy??!0, ignorePublicAcls:o.ignorePublicAcls??!0, restrictPublicBuckets:o.restrictPublicBuckets??!0}}`). If the prop is absent entirely, nothing is rendered and you are relying on the S3 account-level default rather than an asserted, reviewable template property.

**근거**

```text
Removed only the line `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,` from the stack in /tmp/ma-probe and re-synthed: `npx cdk synth` -> EXIT=0, then `node -e "...b.Properties.PublicAccessBlockConfiguration"` printed `undefined`. With the line restored, the template contains `PublicAccessBlockConfiguration: {BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true}`.
```

**수정** — Always pass it explicitly: `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,` on the `s3.Bucket` props (line 15 of the recommended file). Do not rely on the cdk.json feature flag.

#### [MAJOR] The deprecated `origins.S3Origin` still compiles cleanly and silently gives you OAI, not OAC

**왜 문제인가** — `S3Origin` is marked `@deprecated` in the .d.ts but is still exported and fully type-checks. An implementer who reaches for the familiar `new origins.S3Origin(bucket)` gets `AWS::CloudFront::CloudFrontOriginAccessIdentity` and a `Principal.CanonicalUser` bucket-policy grant — a direct violation of spec item 9 ("readable only by CloudFront via OAC"). `tsc --noEmit` does not flag it; only a runtime jsii `[WARNING]` on stderr during synth, which is easy to miss.

**근거**

```text
In /tmp/oai-test I swapped the origin to `new origins.S3Origin(bucket)`. `npx tsc --noEmit` -> `tsc EXIT=0`. `npx cdk synth -q` -> `[WARNING] aws-cdk-lib.aws_cloudfront_origins.S3Origin#bind is deprecated. Use `S3BucketOrigin` or `S3StaticWebsiteOrigin` instead.` Template CloudFront resource types became `['AWS::CloudFront::CloudFrontOriginAccessIdentity','AWS::CloudFront::Distribution']` (no OriginAccessControl) and the grant became `{"Action":"s3:GetObject","Effect":"Allow","Principal":{"CanonicalUser":{"Fn::GetAtt":["ExhibitionCdnOrigin1S3Origin636603AF","S3CanonicalUserId"]}},...}` with no AWS:SourceArn condition. Deprecation declared at node_modules/aws-cdk-lib/aws-cloudfront-origins/lib/s3-origin.d.ts:23.
```

**수정** — Use `origins.S3BucketOrigin.withOriginAccessControl(bucket, { originAccessLevels: [cloudfront.AccessLevel.READ] })`. Add an assertions test or a grep gate asserting the template contains `AWS::CloudFront::OriginAccessControl` and does NOT contain `CloudFrontOriginAccessIdentity`.

#### [MAJOR] The Node-ESM fix must be `site/package.json`; putting `"type": "module"` in the ROOT package.json breaks the CDK build immediately

**왜 문제인가** — verify.mjs needs `site/js/**/*.js` to be treated as ESM, which requires `site/package.json` = `{"type":"module"}`. If instead the `"type": "module"` is added to the repo-root package.json (a plausible shortcut), tsc under `module/moduleResolution: NodeNext` rejects the existing extensionless relative import in bin/media-art.ts, and `__dirname` (used to locate site/ for `Source.asset`) becomes undefined at runtime. cdk.json's app command starts with `npx tsc`, so every `cdk synth`/`cdk deploy` dies.

**근거**

```text
In /tmp/esm-test I added `"type":"module"` to the root package.json only. `npx tsc --noEmit` -> `bin/media-art.ts(3,31): error TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean '../lib/media-art-stack.js'?` / `tsc EXIT=1`. The unmodified copy gives `tsc EXIT=0`.
```

**수정** — Create `site/package.json` containing exactly `{"type":"module"}` and leave the root package.json untouched (no `type` field). Keep it out of the upload with `exclude: ['package.json']` on the BucketDeployment. Add `site/package.json` to git (it is not matched by the `*.js` .gitignore rule).

#### [MINOR] Do not set `retainOnDelete: false` on the BucketDeployment — it races with autoDeleteObjects on `cdk destroy`

**왜 문제인가** — `retainOnDelete` defaults to `true` (aws-s3-deployment/lib/bucket-deployment.d.ts: `@default true - when resource is deleted/updated, files are retained`). Flipping it to `false` for 'cleanliness' makes the deployment custom resource try to delete the uploaded objects during stack teardown at the same time the `Custom::S3AutoDeleteObjects` provider is emptying the bucket, which is a known source of intermittent DELETE_FAILED. The default is already correct here because `autoDeleteObjects: true` handles teardown and `prune: true` handles stale files on each update.

**근거**

```text
Prop default read from node_modules/aws-cdk-lib/aws-s3-deployment/lib/bucket-deployment.d.ts (lines 74-81). Synthesized CR for my stack carries `"Prune": true` and no RetainOnDelete override; the template separately contains `Custom::S3AutoDeleteObjects` + its provider role/function from `autoDeleteObjects: true`.
```

**수정** — Leave `retainOnDelete` unset (default true). Rely on `prune: true` (default) for stale-file removal — the handler runs `aws s3 sync --delete`, confirmed at index.py: `s3_command=["s3","sync"]; if prune: s3_command.append("--delete")`.

#### [MINOR] `exclude` filters the sync, not the asset — site/package.json is still zipped, hashed and uploaded to the CDK assets bucket

**왜 문제인가** — Not a functional bug, but worth knowing: `exclude: ['package.json']` prevents the file reaching the exhibition bucket, yet the file is still part of the staged asset, so editing it changes the asset hash and triggers a full redeploy + `/*` invalidation. The d.ts itself flags this: 'If you want to just exclude files from the deployment package (which excludes these files evaluated when invalidating the asset), you should leverage the `exclude` property of `AssetOptions` when defining your source.'

**근거**

```text
`find /tmp/ma-probe/cdk.out/asset.c3afdb8f084096877c787ed27dd167ce77301830fea29197f3e3fb3b75be0848 -type f` lists `.../package.json` even though the CR properties show `"Exclude": ["package.json", ".DS_Store"]`. Doc comment at aws-s3-deployment/lib/bucket-deployment.d.ts:38-48.
```

**수정** — Either keep `exclude: ['package.json', '.DS_Store']` (simplest, correct behaviour) or move it to the source for true asset exclusion: `s3deploy.Source.asset(path.join(__dirname, '..', 'site'), { exclude: ['package.json'] })`. Do not use `exclude: ['*.json']` — reproduced with the CLI's fnmatch-on-joined-rootdir logic, `*.json` also matches nested files, which would drop `site/js/**/*.json` if any are added later.

---

## Internal contradictions and under-specification across the shell, the Piece contract, and the later enhancements (spec items 3, 4, 5, 8, 11, 12, 13)

### 실측 확인

**V1.** Repo is an empty scaffold as described: `find site` returns only `site`, `site/css`, `site/js`, `site/js/pieces` (4 dirs, zero files). `lib/media-art-stack.ts` is a 15-line empty stack. `.gitignore` line 1 is `*.js` with only `!jest.config.js` as a negation, so `site/js/*.js` is ignored. Node v20.20.2, typescript ~7.0.2, aws-cdk-lib ^2.269.0 confirmed from package.json.

**V2.** engine.js module-scope DOM rule IS self-consistent for helper factories: a file with `export function slider(host){ const el = document.createElement('input'); ... }` imports cleanly in Node — `IMPORT OK, exports: [ 'Piece', 'button', 'slider' ]`. Moving that `document.createElement` to module scope fails: `IMPORT FAILED: ReferenceError document is not defined`. A `static HOST = document.body` class field also fails the same way (static fields evaluate at class-definition time).

**V3.** A Node import success does NOT prove the absence of module-scope DOM access. `/tmp/probe/js/engine-bad2.js` contains module-scope `typeof window !== 'undefined' && window.matchMedia(...)` and `if (typeof window !== 'undefined') window.addEventListener('resize', ...)` and still printed `IMPORT OK, exports: [ 'DPR', 'Piece', 'slider' ]`. The guard short-circuits in Node and executes in a browser.

**V4.** verify.mjs contract checks must use exact predicates. Measured on 4 fixture modules: a named (non-default) export gives `default? false`; a plain object default gives `default? true isFn false`; `Object.prototype.isPrototypeOf.call(Piece, D)` and `D.prototype instanceof Piece` agree on every case. But `'setup' in D.prototype` returns **true** for a subclass that implements nothing when the base declares a stub, while `hasOwnProperty` returns false; and `hasOwnProperty` returns **false** (false failure) for a legitimate grandchild `class Work extends Field extends Piece`. A prototype-chain walk that stops at `Piece.prototype` returns the correct `true/false` for both.

**V5.** A work that overrides `destroy()` and forgets `super.destroy()` leaks a live RAF: measured `after Careless.destroy(): live RAF handles = 1 (expected 0)`. Making `Piece.prototype.destroy` non-writable does NOT prevent it — `subclass CAN still shadow a non-writable proto method: function`. An engine-owned `mount()` that returns an opaque `{destroy}` handle does prevent it: a deliberately sabotaging subclass (own `destroy(){}`, throwing `teardown()`) still gave `live RAF after handle.destroy() x2 = 0`, with the throwing teardown swallowed.

**V6.** Hash-router double-fire is real. With both a `hashchange` and a `popstate` listener registered, ONE `location.hash='#work-02'` assignment produced `router handler invocations for ONE navigation = 2`. Chrome fires popstate AND hashchange for a same-document hash assignment.

**V7.** `history.pushState({...},'','#work-02')` fired NEITHER hashchange NOR popstate (empty log). Back from that entry fired both `popstate hash=#work-01` and `hashchange #work-02 -> #work-01`.

**V8.** Re-assigning the SAME hash fires nothing: `set SAME #work-01 again : []`. Clearing with `location.hash=''` does fire, but leaves the URL as `http://127.0.0.1:8099/index.html#` (trailing bare `#`).

**V9.** Pointer units are ambiguous by exactly the DPR factor. At `deviceScaleFactor: 2`: `cssRect: [800,600]`, `backing: [1600,1200]`, and `mouse.move(400,300)` delivered `clientX/Y = 400/300` — i.e. events are CSS px, the canvas drawing surface is 2x that.

**V10.** A per-event movement threshold cannot distinguish jitter. Three ~1px drifts produced three pointermove events with `movementX/Y` of `{0,1}`, `{0,0}`, `{0,0}`. A deliberate 283px sweep produced 10 events totalling `282.1` px of |movement|. Cumulative distance over a window separates them cleanly; per-event magnitude does not.

**V11.** "Any keydown cancels" catches bare modifiers: pressing Control/Shift/Meta/Tab/F5 each produced a keydown (`Control code=ControlLeft`, `Shift code=ShiftLeft`, `Meta code=MetaLeft`, `Tab`, `F5`). Also `p` and `P` both report `code=KeyP`, so key matching must use `e.code` or a lowercased `e.key`.

**V12.** Cards must be native `<button>`. On `div[role=button][tabindex=0]`, Enter and Space produced NO click (`[]`) and Space scrolled the page from `scrollY 0 -> 525`. On a native `<button>` the same presses produced two clicks. `aria-disabled="true"` leaves an element focusable (`ariaDisabledFocusable: true`) while `disabled` removes it from the tab order (`nativeDisabledFocusable: false`).

**V13.** A touch tap produces NO pointermove at all: measured `["pointerdown:touch","pointerup:touch","lostpointercapture:touch","pointerout:touch"]`. `getComputedStyle(canvas).touchAction` is `auto` by default, so a paint-drag on work 02 will pan/scroll instead of painting.

**V14.** A CSS opacity transition on the single #stage canvas is a working crossfade substitute: `c.style.opacity='0'` with `transition:opacity .45s` resolved `transitionend` at `transitionMs: 447` (`computed: '0.45s'`), and clearing + returning to opacity 1 works.

**V15.** prefers-reduced-motion is testable and live-observable: default `matches: false`, after `emulateMedia({reducedMotion:'reduce'})` `matches: true`, and `matchMedia(...).addEventListener` exists (`hasAddEventListener: true`).

**V16.** sessionStorage has exactly the right lifetime for the "skip on revisit within the session" flag: after `reload()` the flag read back `1`; in a NEW browser context/tab it read `null`.

**V17.** Work 01's trail wash leaves a visible ghost of the previous work on the shared canvas. With per-frame `rgba(5,5,7,0.066)`, residue = 0.934^n: 35.91% after 250ms, 15.83% after 450ms, 1.66% after 1000ms, 0.03% after 2000ms; 68 frames (~1133ms @60fps) to fall under 1%.

**V18.** Tour cadence arithmetic: to hold a true 30000ms period with a 450ms fade-out and 450ms fade-in, the dwell timer must be 29100ms, not 30000ms.

**V19.** Work 02's grid is ~4.5x coarser per axis than the canvas: 356x225 = 80100 cells vs a 1600x1200 backing store (ratio 1600/356 = 4.49), so no single pointer coordinate convention serves both works without an explicit conversion.

### 발견

#### [BLOCKER] Item 12 "ANY input cancels tour mode" is literally unimplementable alongside work 01 (mouse = wind) and item 11 (mousemove hides caption)

**왜 문제인가** — Work 01's whole interaction IS mousemove, and item 11 uses mousemove as a signal too. If any pointermove cancels the tour, the kiosk exits tour mode on the first 1px of cursor drift, on a trackpad brush, or the moment a passerby bumps the desk — which defeats the stated goal ("a gallery kiosk that stays alive untouched"). "Any keydown" is equally fatal: returning to the kiosk window with Cmd-Tab or Alt-Tab delivers a bare Meta/Alt keydown and kills the tour before the visitor has done anything.

**근거**

```text
Measured in headless Chromium (/tmp/probe/browser2.mjs): three ~1px cursor drifts each fired a pointermove, with movementX/Y of {0,1}, {0,0}, {0,0} — so a per-event magnitude test is useless. A deliberate 283px sweep fired 10 events totalling 282.1px of |movement|. Separately (/tmp/probe/browser3.mjs) pressing Control, Shift, Meta, Tab and F5 each produced a keydown: "Control code=ControlLeft", "Shift code=ShiftLeft", "Meta code=MetaLeft", "Tab code=Tab", "F5 code=F5".
```

**수정** — Redefine "input that cancels" as DELIBERATE intent, and keep the artwork's pointer feed entirely separate from the cancel detector. Concretely, in main.js: (1) cancel immediately on `click`/`pointerdown` (primary button, `isPrimary`), on `wheel` with `Math.abs(deltaY) > 8`, on `touchstart`, and on `keydown` filtered to `!e.repeat && !['Control','Shift','Alt','Meta','CapsLock','Tab','F5'].includes(e.key) && e.key.length <= 12`; (2) for pointer movement use a CUMULATIVE distance gate — accumulate `Math.hypot(e.clientX-lx, e.clientY-ly)` per event into `drift`, reset `drift = 0` whenever 400ms passes with no pointermove, and cancel only when `drift > 48` CSS px. The measured numbers make this unambiguous: jitter accumulates 1-3px, a real sweep accumulates 282px in ~150ms. (3) Register these on `window` with `{capture:true, passive:true}` in a dedicated AbortController owned by the tour, NOT on the canvas, so cancelling the tour never touches the piece's own pointer handling. The piece keeps receiving wind the whole time — cancelling the tour only stops the 30s advance timer, it does not interrupt the work.

#### [BLOCKER] Item 8's closed field list (no/wing/title/ko/medium/year/note/hint/module) contradicts item 11's per-work "rule" sentence and item 4's "one entry + one file"

**왜 문제인가** — Item 11 requires a docent caption containing "a one-sentence rule this work uses" plus an interaction hint, per work. Item 8 enumerates data.js's fields exhaustively and `rule` is not among them. Adding a `rule` field violates item 8's list; NOT adding it forces the rule sentence into main.js or a work file, which violates item 4 (adding a work would then require editing main.js, not just "one entry + one file") and violates item 4's "catalog is PURE data, zero logic".

**근거**

```text
Spec item 8: "WORKS entries have fields: no, wing, title, ko, medium, year, note, hint, module." Spec item 11: caption shows "the work number, title, a one-sentence 'rule this work uses' ... and an interaction hint." Item 4: "Adding a work must be 'one entry in data.js + one file'." These three cannot all hold as written.
```

**수정** — Reuse the existing fields rather than adding one — this satisfies all three items with zero new schema. Bind the caption as: number = `no`, title = `title`, rule sentence = `note`, interaction hint = `hint`. That is exactly what `note` and `hint` already are (the placard already shows `note`; `hint` has no other consumer in item 8's spec, so it is free). Write it down explicitly in a data.js header comment: "note = the one-sentence rule this work uses (placard body AND caption rule); hint = the one-sentence interaction hint (caption only)". If the placard needs longer prose than a caption bar can hold, the minimal deviation is to add ONE field `rule` and amend item 8's list in the same commit — but prefer the reuse, because it keeps the field list literally as item 8 states it and keeps main.js and style.css untouched when work 05 is added.

#### [BLOCKER] verify.mjs as specified cannot enforce item 5's module-scope rule: a successful Node import provably misses guarded module-scope DOM access

**왜 문제인가** — Item 7 specifies verify.mjs checks the Piece contract by importing the files. Item 5's HARD CONSTRAINT is that engine.js touches no document/window at module scope. Import success is necessary but not sufficient: the common defensive idioms (`typeof window !== 'undefined' && window.matchMedia(...)`, a guarded `window.addEventListener`) import cleanly in Node and then execute DOM code at module scope in a browser. verify.mjs would print PASS on an engine.js that breaks the exact constraint it is supposed to guard.

**근거**

```text
Ran `node -e "import('/tmp/probe/js/engine-bad2.js')..."`. That file's module scope contains `const REDUCED = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;` and `if (typeof window !== 'undefined') window.addEventListener('resize', () => {});`. Result: `IMPORT OK, exports: [ 'DPR', 'Piece', 'slider' ]`. For contrast, unguarded module-scope access DOES fail: engine-bad1.js (`const TEMPLATE = document.createElement('div')`) and engine-bad3.js (`static HOST = document.body`) both gave `IMPORT FAILED: ReferenceError document is not defined`.
```

**수정** — Yes — verify.mjs must do BOTH, and this is ~15 lines. (a) Keep the import (it catches the unguarded cases, including the non-obvious `static X = document.body` class field, which evaluates at class-definition time). (b) Add a static scan of engine.js source: strip line comments, block comments and string/template literals, then split the source into top-level statements by tracking brace/paren/bracket depth, and FAIL if any token matching /\b(document|window|navigator|location|matchMedia|localStorage|sessionStorage|requestAnimationFrame)\b/ appears at depth 0 outside a `class`/`function` body. State the rule in one line in the file: "DOM identifiers may appear only inside function or method bodies in engine.js; at brace-depth 0 they are a failure." Also print WHY it works headless, as item 7 asks: "Node has no document/window global, so any module-scope DOM access throws on import; the source scan covers the guarded cases that a bare import would silently allow." Note the depth-0 scan also correctly permits `const TAU = Math.PI*2` and `const DPR_CAP = 2`, which are legitimate module-scope constants.

#### [BLOCKER] Router double-fire: one hash navigation invokes the route handler twice, producing a double mount and a destroy/mount race against `await import()`

**왜 문제인가** — Item 8 requires `#work-01` deep links, prev/next, Esc-to-exit, Back-button behaviour, and discipline (a) "always call the previous piece.destroy() BEFORE switching". The natural implementation listens to both `hashchange` (for deep links/back) and `popstate` (for history). Chrome fires BOTH for a single same-document hash assignment, so `location.hash='#work-02'` runs the route handler twice. Because the handler is `async` (it does `await import(work.module)`), two overlapping runs both pass the destroy step before either finishes mounting — the second mount overwrites `current` while the first piece's RAF is still live, leaking a loop onto the one shared canvas and producing two works drawing at once. This is exactly the failure discipline (a) exists to prevent, and discipline alone cannot stop it.

**근거**

```text
/tmp/probe/browser2.mjs: registered both listeners incrementing one counter, then `location.hash='#work-02'`. Output: `router handler invocations for ONE navigation = 2`. Also measured: `history.pushState({...},'','#work-02')` fires NEITHER event (empty log), while Back from that entry fires BOTH `popstate hash=#work-01` and `hashchange #work-02 -> #work-01`.
```

**수정** — Pick ONE navigation primitive and ONE listener, and serialize the async transition. Concretely: use `location.hash` as the single source of truth and listen ONLY to `hashchange` (plus one call to `route()` on DOMContentLoaded for the initial deep link). Never call `pushState` — it fires nothing, so it would silently require a manual render call and reintroduce the divergence. Then guard the handler with a generation token: `let gen = 0; async function route(){ const my = ++gen; ... const mod = await import(work.module); if (my !== gen) return; /* stale, abandon */ ... }`, and tear down before the await, not after. Also normalize: `location.hash=''` leaves a trailing bare `#` in the URL (measured `http://127.0.0.1:8099/index.html#`), so compare `location.hash.replace(/^#/,'')` rather than the raw string.

#### [MAJOR] Re-entering the work you just left is dead: assigning the same hash fires no event

**왜 문제인가** — If exiting a room sets `body.dataset.view='gallery'` without changing the URL (the obvious implementation, since "exit" is a view switch not a navigation), the URL still reads `#work-01`. Clicking the 01 card then assigns `location.hash='#work-01'` — identical to the current value — which fires nothing, so the view never changes and the card appears broken. The same dead click happens on Esc-exit followed by re-click.

**근거**

```text
/tmp/probe/browser.mjs: `set #work-01 : ["popstate hash=#work-01 ...","hashchange (none) -> #work-01"]` then `set SAME #work-01 again : []` — an empty event log for the second assignment.
```

**수정** — Make the hash the only representation of view state, so exit is itself a navigation: `exit()` does `location.hash = ''` (which DOES fire — measured) rather than mutating `data-view` directly. Then every card click is guaranteed to be a real transition. Belt and braces: after assigning the hash, if `location.hash` was already the target, call `route()` directly.

#### [MAJOR] Item 5's pointer contract {x, y, vx, vy, active, down} is under-specified on units, velocity scale, decay, and touch — and the two works need different coordinate spaces

**왜 문제인가** — Work 01 needs a "150px" wind radius and `min(w,h)*0.42` vortex radius; work 02 paints onto a grid ~4.5x coarser per axis than the canvas. With no stated convention, `x` is ambiguous by exactly the DPR factor: the same 150 means 150 CSS px on a 1x display and 75 CSS px on a 2x display, so the wind radius silently halves on a retina screen. `vx/vy` with no unit are per-frame on a 60Hz monitor and half that on 120Hz, so the wind strength is framerate-dependent. Nothing in the spec resets vx/vy, so after the cursor stops the last velocity persists and the wind never stops — a stale gust blows forever. And `active` vs `down` is never defined, which matters because touch behaves nothing like mouse.

**근거**

```text
At deviceScaleFactor 2 the probe measured `cssRect: [800,600]`, `backing: [1600,1200]`, and `mouse.move(400,300)` delivered `clientX/Y = 400/300` — events are CSS px, the drawing surface is 2x. Grid arithmetic: 356x225 = 80100 cells vs 1600x1200 = 1,920,000 backing pixels, ratio 4.49 per axis. Touch tap produced `["pointerdown:touch","pointerup:touch","lostpointercapture:touch","pointerout:touch"]` — NO pointermove at all, and a `pointerout` immediately after lift. `getComputedStyle(canvas).touchAction` is `auto` by default.
```

**수정** — Pin exactly one convention and document it at the top of engine.js: **pointer.x/y are BACKING-STORE pixels** (`(e.clientX - rect.left) * dpr`), matching the units `frame()` already draws in, and the engine also exposes `this.w`/`this.h` in the same backing units. Work 01 then writes `const R = 150 * this.dpr` and `min(this.w,this.h)*0.42` needs no change. Work 02 converts once: `gx = Math.floor(p.x / this.w * GRID_W)`. **vx/vy are backing px per SECOND**, computed as `(x - lastX) / dt` and low-pass filtered `v += (raw - v) * 0.25`, with an explicit decay applied every frame in the engine (`v *= Math.pow(0.001, dt)`, ~halving every 70ms) so the wind dies ~200ms after the cursor stops — the spec omits this and it is the difference between wind and a permanent gust. **`active`** = a pointer is currently over the canvas (`pointerenter`/`pointerleave`, and forced false on `pointercancel`); **`down`** = a primary button or contact is engaged (`pointerdown`→`pointerup`/`pointercancel`). For touch, call `canvas.setPointerCapture(e.pointerId)` on pointerdown (so drag-paint survives leaving the canvas) and set `active = down` on touch pointerType, because the measured event stream gives no pointermove before contact and fires `pointerout` on lift. Set `touch-action: none` on `#stage` in style.css — without it the measured default `auto` makes work 02's paint-drag scroll the page instead.

#### [MAJOR] Discipline (a) "always destroy() before mounting" is unenforceable by convention: a work that overrides destroy() without super.destroy() leaks a live RAF onto the one shared canvas, and sealing the method does not help

**왜 문제인가** — Item 3 says the room has exactly one canvas forever and item 8 makes correct teardown a matter of discipline. One forgotten `super.destroy()` in one work file leaves that work's RAF loop running while the next work mounts onto the same canvas — two works drawing simultaneously forever, which is both a visual corruption and an unbounded CPU leak on a kiosk that runs for hours. Discipline is the wrong mechanism when the cost of one slip is permanent.

**근거**

```text
/tmp/probe/probe-destroy.mjs simulated the engine's RAF loop: a subclass whose `destroy(){ this.grid = null; }` omits `super.destroy()` gave `after Careless.destroy(): live RAF handles = 1 (expected 0)`. Making the base method non-writable does not stop it: `subclass CAN still shadow a non-writable proto method: function` (subclass methods are defined on the subclass prototype, so the base descriptor is irrelevant). /tmp/probe/probe-handle.mjs verified the handle pattern: a subclass with its own `destroy(){}` AND a throwing `teardown()` still yielded `live RAF after handle.destroy() x2 = 0`, with `teardown threw (swallowed): boom`.
```

**수정** — Make leaks impossible by construction. The engine exports `mount(PieceClass, canvas, host)` which returns an opaque handle `{ destroy() }`; main.js holds the HANDLE, never the piece, and calls `handle.destroy()`. A work cannot shadow a method it does not own. Inside the handle, destroy is idempotent (`if (dead) return; dead = true;`) and does, in order: `cancelAnimationFrame`, `abortController.abort()` (which removes every listener registered through the engine), run and clear a disposer array, `host.replaceChildren()` to drop the injected controls DOM, null the piece's references, then call the optional `teardown()` hook inside try/catch so a throwing work cannot abort the rest of the cleanup. Allocate teardown responsibility explicitly: **ENGINE owns** the RAF handle, the resize listener/ResizeObserver, all canvas pointer listeners, the controls host's children, the clock, and clearing the canvas; **WORK owns** only things it created that the engine has no handle on — and it must create them through engine APIs: listeners via `this.on(target, ev, fn)` (which passes `{signal: this.ctx.signal}`), timers via `this.later(fn, ms)` (auto-cleared), and anything else via `this.ctx.onDispose(fn)`. Yes a work may add its own listeners, but only through `this.on`. Typed arrays and offscreen canvases need no explicit disposal once the piece object is unreachable — but they ARE the reason main.js must drop its reference to the piece (an 80,000-cell Float32Array pair is trivial; a leaked closure holding a 1600x1200 offscreen canvas is 7.7MB per leak).

#### [MAJOR] "One canvas forever" vs item 12's "smooth fade between works" vs item 13's hover preview — and work 01's no-clear trails leave a ghost of the previous work

**왜 문제인가** — A true crossfade needs both works rendering at once, which two of the spec's constraints forbid (one canvas; destroy before mount). Worse, there is a subtler collision nobody states: work 01 builds trails by NOT clearing and only washing with `rgba(5,5,7,0.066)` per frame. When the tour hands off from Morphogenesis to Currents on the shared canvas, work 02's reaction-diffusion pattern is still in the backing store and work 01 never clears it — so it decays slowly rather than disappearing, and it is plainly visible for the entire fade-in.

**근거**

```text
Residue after n frames = 0.934^n: 35.91% at 250ms, 15.83% at 450ms, 1.66% at 1000ms, 0.03% at 2000ms; 68 frames (~1133ms @60fps) to drop under 1%. Separately verified the single-canvas fade works: a CSS `transition:opacity .45s` on `#stage` resolved `transitionend` at `transitionMs: 447` (`computed: '0.45s'`), and clear-then-return-to-opacity-1 behaves.
```

**수정** — (1) Fading the single canvas to the page background is the honest option and it is sufficient — it is a dip-to-black, not a crossfade, which is correct museum language anyway. Order matters, and the spec does not state it: set `opacity:0` → await `transitionend` → `handle.destroy()` → `ctx.clearRect(0,0,w,h)` (MANDATORY, in the engine's mount path, precisely because of the trail residue above — do not leave it to the works) → `await import()` → `mount()` → await ONE rAF so `frame()` has drawn at least once → `opacity:1`. Without that single-frame wait you fade in on a blank canvas and see a white-ish pop. (2) Timing: FADE_OUT 450ms, FADE_IN 450ms, dwell timer **29100ms** so the period stays exactly 30000ms as item 12 requires — scheduling 30000ms of dwell plus 900ms of fade drifts the cadence by 3% per work. (3) The hover preview canvas does NOT viol"one canvas": item 3 scopes the constraint to the ROOM ("The room has exactly ONE canvas"), and the preview lives in the gallery view. Keep it honest by making it literally one shared preview canvas (~200x120 CSS px) that is moved into the hovered card via `card.appendChild(previewCanvas)` rather than one canvas per card — that preserves the spirit, bounds the cost to a single extra context, and means the number of cards never affects GPU memory.

#### [MAJOR] Item 8's "gallery grid built EXACTLY ONCE" vs item 13's "stagger skipped on revisit" vs item 10's promotion of a Soon card — the interaction is never specified

**왜 문제인가** — If the grid is built once, the stagger cannot be "replayed by rebuilding", and the naive implementation (inline `animation-delay` set at build time) re-runs the animation every time the gallery view is re-shown after leaving a room — so a visitor sees the entrance choreography again every time they press Esc. Conversely if you skip the stagger by never adding the class, cards built as Soon and later promoted to Open (item 10) need their light-up state re-derived, and nothing says where that state lives.

**근거**

```text
sessionStorage has exactly the needed lifetime: after `page.reload()` the flag read back `1`; in a new browser context the same key read `null`. So it survives F5 (correct: same visit, don't replay) and resets for the next visitor (correct: a fresh kiosk session replays).
```

**수정** — Build the grid once in a `buildGallery()` called from DOMContentLoaded, and put the choreography entirely in CSS driven by ONE class on the gallery root, added once: `const KEY='gh:entered'; if (!sessionStorage.getItem(KEY)) { galleryEl.classList.add('is-entering'); sessionStorage.setItem(KEY,'1'); setTimeout(()=>galleryEl.classList.remove('is-entering'), 2000); }`. Stagger via `.is-entering .card { animation: rise .5s both; animation-delay: calc(var(--i) * 90ms); }` with `--i` set as an inline custom property at build time — so adding a work needs no CSS edit, satisfying item 4. With 4 cards the last delay is 270ms + 500ms = 770ms, comfortably inside item 13's 2-second budget. Because the class is removed after 2s and never re-added, re-entering the gallery from a room does not replay it — the grid is still built exactly once. Open vs Soon is derived purely from `work.module !== null` at build time, so item 10's promotion is literally the one-line data.js edit it claims to be.

#### [MAJOR] Cards are not keyboard-accessible unless they are native <button>, and "Soon" cards have no specified semantics

**왜 문제인가** — Item 8 describes "clicking a card" with no keyboard story. If cards are `div`s (the visually natural choice for a card grid), keyboard users cannot open a work at all, and Space scrolls the gallery instead — on a kiosk with a physical keyboard this is the only input path and it silently fails. Soon cards also need to announce that they are not openable, or a screen-reader user tabs into a dead control.

**근거**

```text
Measured: on `div[role=button][tabindex=0]`, Enter and Space produced no click event (`[]`) and Space scrolled the page `scrollY 0 -> 525`. The same presses on a native `<button>` produced `["click on c-btn","click on c-btn"]`. Also: `aria-disabled="true"` leaves the element focusable (`ariaDisabledFocusable: true`), while the `disabled` attribute removes it from the tab order (`nativeDisabledFocusable: false`).
```

**수정** — Make every card a native `<button type="button">` styled as a card (`all: unset` plus card styles) — you get focus, Enter, Space and the click event for free, and no Space-scroll. For Soon cards use `aria-disabled="true"` plus `data-state="soon"` and NOT the `disabled` attribute: aria-disabled keeps the card reachable by Tab so a screen-reader user can still hear "Work 04, Soon", which is exhibition information, while the click handler early-returns on `work.module === null`. Add `aria-label` combining `no`, `title` and (for Soon) the word "Soon", and give the grid `role="list"` semantics off (a button grid is fine as-is). Give `#stage` `role="img"` with an `aria-label` from `work.title` + `work.note` so the room is not an unlabelled canvas.

#### [MAJOR] Item 11's caption has no return path: "slides in after 3s, hides when the mouse moves" never says how it comes back

**왜 문제인가** — As written the caption is a one-way door — after the first mousemove it is gone for the rest of the visit, so on work 01, where mousemove is the interaction, the docent caption is guaranteed to be invisible within the first second of anyone actually using the work. That is the one work that most needs its rule explained. The spec also collides with finding 1: mousemove is simultaneously "the artwork", "hides the caption", and (naively) "cancels the tour" — three different meanings for one event.

**근거**

```text
Spec item 11: "The caption slides in 3 seconds after entering, and hides briefly when the mouse moves so it never disturbs the work." The word "briefly" implies a return that is never defined (no delay, no trigger, no behaviour on repeated movement). Empirically, sustained pointer movement produces a continuous event stream (10 events for a single 283px sweep), so a naive hide-on-move keeps the caption suppressed for as long as the cursor is in motion.
```

**수정** — Specify a 4-state machine in main.js, driven by the same cumulative-drift detector as the tour cancel (one detector, three consumers — resolves the triple meaning): HIDDEN → (3000ms after mount, via the engine's disposer-tracked timer) → SHOWN (slide up, 400ms ease-out) → on drift > 24 CSS px within 300ms → DIMMED (opacity 0, translateY 12px, 200ms; NOT display:none, so no layout thrash) → after 1800ms of pointer quiescence → back to SHOWN. Repeated movement re-arms the 1800ms timer rather than restarting the 3000ms initial delay. The caption auto-DIMs permanently only after it has been fully shown 3 times or 45s have elapsed, whichever comes first, so a long dwell eventually leaves the work unobstructed as item 11 intends. Exiting the room resets to HIDDEN. Use a lower drift threshold (24px) than the tour cancel (48px) so the caption yields before the tour does — the caption should be eager to get out of the way, the tour should not.

#### [MAJOR] Deep-link routing table is under-specified: null-module works, unknown work numbers, hashchange while mounted, Back from room, and prev/next wrap/skip semantics

**왜 문제인가** — Item 8 asks for `#work-01` deep links plus prev/next plus Esc plus a Back button, and requires (discipline b) that a failed import writes the reason into the placard rather than showing black. But a deep link to a Soon work (`#work-04`, module null) is not an import failure — `await import(null)` throws a module-resolution error, so the honest "reason" text would be a confusing resolver message rather than "this work is not open yet". `#work-99` has no catalog entry at all. And "does next from the last OPEN work wrap, and does it skip Soon works" is exactly the kind of decision that produces a visible bug either way if left to the implementer.

**근거**

```text
Measured: `await import('./js/pieces/99-nope.js')` rejects with `TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:8099/js/pieces/99-nope.js`; `await import(null)` rejects with `TypeError: Failed to resolve module specifier 'null'`. Back from a pushState entry fired `popstate hash=#work-01` AND `hashchange #work-02 -> #work-01`, and `location.hash` then read `#work-01` — so hash-based history gives correct Back behaviour for free, but only if the router is hash-driven (pushState fired neither event).
```

**수정** — Write this table into main.js as the single `route()` function: (1) no hash or `#` → view=atrium. (2) `#gallery` → view=gallery. (3) `#work-NN` where NN matches a WORKS entry with a non-null module → view=room, mount it. (4) `#work-NN` matching an entry with `module === null` → view=gallery, and flash that card with a `.is-unavailable` class plus a live-region message "Work NN is not open yet" — guard with `if (!work.module)` BEFORE the import so the resolver error never reaches the user. (5) `#work-99` with no matching entry → view=gallery (NOT atrium: the user asked for a work, put them where works are) and no error toast, since a stale bookmark is not a failure worth shouting about. (6) any other hash → treat as (5). (7) hashchange while a piece is mounted → run the same generation-guarded transition (destroy → clear → import → mount), which makes Back-from-room and Esc-to-gallery the identical code path. Esc sets `location.hash=''`... use `#gallery` if the user arrived via a card, so Back goes room→gallery→atrium in the order visited. prev/next: build `const open = WORKS.filter(w => w.module)` ONCE, index into THAT array, and wrap with `(i + n + open.length) % open.length` — so next from the last open work wraps to the first and Soon works are skipped, as item 6's own parenthetical demands. The tour (item 12) iterates the same `open` array, which is why it must be derived in exactly one place.

#### [MAJOR] verify.mjs's "setup and frame on its prototype" check has two opposite failure modes depending on which predicate you pick

**왜 문제인가** — Item 7 says "has setup and frame on its prototype". `'setup' in D.prototype` is true for a subclass that implements nothing, the moment `Piece` declares stubs (which is the natural way to document a required override) — so the check passes works that will crash at runtime. `hasOwnProperty` on `D.prototype` is false for a legitimate work that inherits `setup` from an intermediate base class — so the check fails working code, and item 14's fourth work is exactly the case where a shared helper base becomes tempting.

**근거**

```text
/tmp/probe/probe-inherit.mjs: with `class Piece { setup(){throw} frame(){throw} }` and `class Lazy extends Piece {}` — `'setup' in Lazy.prototype = true` but `hasOwnProperty('setup') = false`. With `class Field extends Piece { setup(){} frame(){} }` and `class Work extends Field {}` — `Work.prototype instanceof Piece = true` but `hasOwn setup on Work.prototype = false <-- FALSE POSITIVE FAILURE`. A chain walk that stops at `Piece.prototype` returned `true` for Work and `false` for Lazy — correct on both.
```

**수정** — Do NOT declare throwing stubs on `Piece` (they make the `in` check meaningless), and check with a bounded chain walk: `function implemented(D, name){ let p = D.prototype; while (p && p !== Piece.prototype) { if (Object.hasOwn(p, name)) return true; p = Object.getPrototypeOf(p); } return false; }`. Also fix the sibling checks measured in the same run: `default` must be tested as `typeof m.default === 'function'` (a plain object default gave `default? true isFn false`, and a named-only export gave `default? false`), and subclass-ness with `m.default.prototype instanceof Piece` (verified to agree with `Object.prototype.isPrototypeOf.call(Piece, D)` on every fixture). Resolve `WORKS[].module` against `site/js/` with `new URL(work.module, pathToFileURL('site/js/'))` and `fs.existsSync` before importing, so a typo'd path prints a clean FAIL line instead of an ERR_MODULE_NOT_FOUND stack.

#### [MINOR] prefers-reduced-motion policy is unstated — and "stop all motion" would blank the exhibition

**왜 문제인가** — Item 13's entrance choreography and item 11's caption slide are decoration and must respect the media query. But the works ARE motion: honouring reduced-motion by stopping `frame()` would render a black canvas and a placard, i.e. the exhibition would show nothing to the users who asked for less motion. There is no safe default here, so it needs a written policy rather than an implementer's guess.

**근거**

```text
Confirmed the query is observable and live: default `matches: false`, after `emulateMedia({reducedMotion:'reduce'})` `matches: true`, and `matchMedia('(prefers-reduced-motion: reduce)').addEventListener` exists (`hasAddEventListener: true`), so the preference can change mid-session.
```

**수정** — Write the policy into style.css and main.js: reduced-motion suppresses UI motion only — inside `@media (prefers-reduced-motion: reduce)` set `animation: none` / `transition: none` on cards, title, caption and the `#stage` opacity transition (the fade becomes an instant cut, which still reads fine). The ARTWORK keeps running: a generative work is the content, and the visitor navigated to it deliberately. Two concessions instead: (a) the auto-tour does not auto-start under reduced motion (the P key still works — an unrequested 30s work-swap carousel is exactly the vestibular trigger the preference is about), and (b) the room shows a pause/play affordance for the work itself, wired to the engine's RAF, so stopping is available rather than imposed. Read the preference inside a function (never at module scope in engine.js — that is the precise idiom measured to defeat the import check in finding 3) and subscribe to its `change` event.

---

## Numerical correctness and visual viability of the Gray-Scott parameters (spec item 2, work 02 "Morphogenesis")

### 실측 확인

**V1.** KERNEL SUMS TO ZERO. `node /tmp/gs/kernel.mjs`: `sum = -1 + 4*0.2 + 4*0.05 = -1 + 0.8000000000000001 + 0.2 = 5.551115123125783e-17` (exact 0 in real arithmetic; the residual is IEEE-754 double rounding of 4*0.2, not a modelling error). The kernel is EXACTLY 0.3x the standard isotropic 9-point Laplacian (1/6)*[[1,4,1],[4,-20,4],[1,4,1]]: measured ratios `diag 0.05/(1/6)=0.300000, ortho 0.2/(4/6)=0.300000, center -1/(-20/6)=0.300000`. So it is the standard Gray-Scott/Karl-Sims 9-point stencil, second-order accurate and isotropic, with an implied cell size h=1/sqrt(0.3)=1.8257 (equivalently Du_eff=0.048, Dv_eff=0.024 in h=1 units; the Dv/Du=2 ratio is untouched).

**V2.** ZERO SUM IS LOAD-BEARING, MEASURED. `node /tmp/gs/kernel2.mjs`, diffusion-only, uniform 0.5 field, 20000 steps, Float32: spec kernel -> `min=5.0000e-1 max=5.0000e-1 (drift 0.000e+0)` (bit-exact). Perturbing one weight so the sum is +0.05 -> `min=Infinity max=-Infinity (drift NaN)`. Sum -0.05 -> `min=8.6881e-44` (whole field annihilated). On a random field the spec kernel conserves total mass to `relative change 6.860e-6` over 5000 steps and flattens to the mean. A non-zero sum turns the diffusion operator into a uniform exponential gain/decay term, so it is not a diffusion operator at all.

**V3.** STABILITY: dt=1 IS SAFE, WITH 7.8x MARGIN. Fourier symbol of the kernel on a wrapped grid, scanned over 721x721 wavenumbers: range `[-1.600000, 0.000000]`, minimum at (kx,ky)=(pi,pi) (checkerboard), matching the analytic -1+0.2*(-4)+0.05*(+4) = -1.6. Explicit Euler needs |1+dt*D*lambda|<=1 => dt*D <= 2/1.6 = 1.2500. Measured: Du=0.16 -> checkerboard amplification 0.7440 (margin 7.81x); Dv=0.08 -> 0.8720 (margin 15.63x). Reaction terms are also small: dt*(F+k) = 0.0860..0.1165 for the four presets. Du=1.0 would still be stable (amplification |1-1.6|=0.6).

**V4.** NO NaN/Inf ANYWHERE. Across ~90 runs (4 presets x 13 seedings x 4000 steps, plus 5000-step runs, plus 168 brush runs, plus Du=0.16/0.4/0.64/1.0 sweeps) every `nan/inf` column read `0/0`. Values stayed in U in [0.216, 1.0000] and V in [0, 0.4738] with NO clamping in the update; clamping to [0,1] is unnecessary for these numbers.

**V5.** ALL FOUR PRESETS PRODUCE A LIVING PATTERN WITH THESE EXACT NUMBERS *ONLY* WITH A SPARSE SPECKLE SEED. `node /tmp/gs/seeds.mjs` (320x250=80,000 cells, 4000 steps). With sparse p=2% V=1: mitosis cov=20.07% Vstd=0.1176, coral 45.70%/0.1530, leopard 18.38%/0.1140, maze 63.14%/0.0982 -- all alive. With a central 20x20 square: mitosis 0.11%, coral 0.32%, leopard 0.11% (frozen specks), maze 7.48% after 4000 steps. With iid noise V~U(0,0.5) everywhere: ALL FOUR die to Vstd=0.0000. With 12 filled blobs r=6: mitosis and leopard die to Vstd=0.0000.

**V6.** THE CENTRED-SQUARE SEED REACHES A BIT-EXACT FIXED POINT. `node /tmp/gs/frozen.mjs`: mitosis/coral/leopard `step 3000: max|dV/step|=0.000e+0  max|dU/step|=0.000e+0` and the same at step 5000; only maze still moves (`max|dV/step|=5.419e-3`). It is not merely slow -- the image is literally frozen.

**V7.** FEATURE SIZE AT Du=0.16/Dv=0.08 IS 2-3 CELLS. `node /tmp/gs/du.mjs` autocorrelation of V after 4000 steps (sparse seed): mitosis C(1)=0.75 C(2)=0.37 C(3)=0.03 C(4)=-0.09 (first zero at d=4); leopard identical; maze first zero at d=3. At Du=1.0/Dv=0.5 the same measurement gives C(1)=0.97 C(2)=0.87 C(4)=0.55, first zero at d=7..11, period 18-22 cells.

**V8.** AT Du=0.16 THE PATTERN IS SEED-LOCKED, NOT SELF-ORGANISING. `node /tmp/gs/similar.mjs`: from an identical seed, mitosis vs leopard V fields correlate at Pearson r=0.9204 (they are the same picture; dF=0.0017, dk=-0.0001 apart). `node /tmp/gs/tempo2.mjs`: final coverage depends on seed density at Du=0.16 (mitosis 9.6% at p=0.5% vs 20.1% at p=2%) but is seed-independent at Du=1.0 (30.2% vs 27.5%).

**V9.** TEMPO. `node /tmp/gs/tempo.mjs` / `tempo2.mjs`, 8 steps/frame @60fps = 480 steps/s. At Du=0.16 with p=2% seed, Vstd reaches 95% of its final value by step 50-100 = 0.10-0.21 s, then only micro-drifts (max|dV|/step 1.2e-3..5.4e-3). At Du=1.0/Dv=0.5 with p=0.5% seed: step@90%-coverage = 3050 (mitosis), 3375 (coral), 3150 (leopard) => 6.4 s / 7.0 s / 6.6 s.

**V10.** BRUSH: BIG FILLED DISCS OF V SELF-ANNIHILATE. `node /tmp/gs/brush.mjs` (168 runs from the trivial state U=1,V=0, 2500 steps). mitosis and leopard: every disc with r>=8 at any amplitude (0.25/0.5/1.0, hard or linear falloff) ends `DIED to uniform, Vstd=0.0000, Umin=0.999`; r=4 hard at amp 0.25/0.5 also dies. r=1..2 always survives/grows. coral never dies but goes static for r>=8. maze grows at every radius. `node /tmp/gs/brush2.mjs`: a SPECKLED disc (only a random 15-35% of cells set to V=1) grows at r=16 for every preset, where the same disc at density 1.0 dies.

**V11.** OBSERVED V RANGES (320x250, sparse p=2% seed, 4000 steps), from `node /tmp/gs/color.mjs`: mitosis V max=0.4358 p50=0.0146 p90=0.3371; coral max=0.4738 p50=0.0949 p90=0.3680; leopard max=0.4269 p50=0.0131 p90=0.3313; maze max=0.3496 p50=0.1500 p90=0.2884. U spans [0.2717, 1.0]. So naive 255*v peaks at byte 89 (maze) to 121 (coral) with mean byte 17-42.

**V12.** PER-FRAME COST. `node /tmp/gs/perf.mjs` (node v20.20.2, arm64, V8, JIT warmed, 300 timed iterations): 80,000 cells, generic wrap-lookup implementation 2.788 ms/step => 22.30 ms for 8 steps (OVER the 16.67 ms budget by 5.6 ms); hand-optimised branch-wrapped implementation 1.935 ms/step => 15.48 ms (93% of the budget). At 32,000 cells: 6.19 ms/frame (37%). ImageData fill for 80,000 px: 0.572 ms/frame.

### 발견

#### [BLOCKER] The spec never says what setup() seeds, and 3 of the 4 obvious choices give a black or frozen screen with these exact numbers

**왜 문제인가** — U=1,V=0 is a fixed point, and the spec is silent on the seed. Measured on the spec's exact numbers (320x250=80,000 cells, Du=0.16, Dv=0.08, dt=1, 4000 steps): a central 20x20 square of V=1 leaves mitosis/coral/leopard as a 0.11-0.32%-of-screen speck that reaches a BIT-EXACT fixed point by step 3000 (max|dV/step| = 0.000e+0) -- a still image on a black field; maze crawls to 7.5% coverage after 4000 steps (8.3 s). iid noise V~U(0,0.5) over the whole grid kills ALL FOUR to Vstd=0.0000. Twelve filled blobs r=6 kill mitosis and leopard to Vstd=0.0000. Only a sparse single-cell speckle works: at p=2% V=1 all four are alive (coverage 20.1/45.7/18.4/63.1%, Vstd 0.1176/0.1530/0.1140/0.0982).

**근거**

```text
node /tmp/gs/seeds.mjs (grid 320x250=80000, 4000 steps, Du=0.16 Dv=0.08 dt=1, no clamping). Columns: onset to V>0.1 covering 5%/15%/30%, coverage@4000, Vstd, verdict.

mitosis  F=.0367 k=.0649
  A central square20 V=1 U=.5 | never never never | 0.11% | 0.0096 | speck
  B central square20 V=1 U=1  | never never never | 0.12% | 0.0098 | speck
  C central square20 V=1 U=0  | never never never | 0.11% | 0.0096 | speck
  D iid noise V~U(0,.5)       | ---   ---   ---   | 0.00% | 0.0000 | DEAD
  E iid noise V~U(0,.05)      | never never never | 0.00% | 0.0000 | DEAD
  F sparse p=0.5% V=1         |    60 never never | 9.59% | 0.0845 | sparse
  G sparse p=2% V=1           |     6    28 never | 20.07%| 0.1176 | FULL
  H sparse p=8% V=1           |     0     4     6 | 9.40% | 0.0865 | sparse
  I sparse p=2% V=0.5         |    10    42 never | 20.34%| 0.1180 | FULL
  J 12 blobs r=6 V=1 U=1      | never never never | 0.00% | 0.0000 | DEAD
  K 12 blobs r=6 V=1 U=.5in   | never never never | 0.00% | 0.0000 | DEAD
  L 60 dots r=2 V=1           | never never never | 3.90% | 0.0565 | sparse
  M sq20 + iid noise .02      | never never never | 0.11% | 0.0096 | speck
coral  F=.0545 k=.062
  A square20 never/never/never | 0.32% | 0.0196 speck ; D iid noise DEAD 0.0000 ; F p=0.5% 80/410/never 23.07% FULL ; G p=2% 6/44/130 45.70% FULL ; H p=8% 0/4/6 67.78% FULL ; J blobs 2.58% sparse ; L 60 dots 310/never 5.59% sparse
leopard  F=.035 k=.065
  A square20 never 0.11% speck ; D iid noise DEAD ; F p=0.5% 49/never 7.48% ; G p=2% 6/27/never 18.38% FULL ; J blobs DEAD 0.0000 ; K blobs DEAD 0.0000
maze  F=.029 k=.057
  A square20 2990/never/never 7.48% ; D iid noise DEAD ; F p=0.5% 33/90/230 63.45% FULL ; G p=2% 6/20/44 63.14% FULL ; J blobs 480/1490/2560 48.91% FULL ; L 60 dots 70/530/1150 62.28% FULL

node /tmp/gs/frozen.mjs (central-square seed, max change per step):
mitosis  step 500: max|dV/step|=8.176e-5 | step 1000: 4.619e-7 | step 3000: 0.000e+0 | step 5000: 0.000e+0
coral    step 500: 1.365e-3 | step 1000: 1.296e-6 | step 3000: 0.000e+0 | step 5000: 0.000e+0
leopard  step 500: 6.646e-5 | step 1000: 2.585e-26 | step 3000: 0.000e+0 | step 5000: 0.000e+0
maze     step 500: 4.865e-3 | step 1000: 3.500e-3 | step 3000: 4.550e-3 | step 5000: 5.419e-3

(Note: the 'onset 0' entries for seed D are an artefact of the initial noise itself exceeding V>0.1; the 4000-step verdict DEAD is the real result.)
```

**수정** — Make the seed part of the spec, and make it a sparse speckle, not a blob and not smooth noise. Concretely in setup(): `u.fill(1); v.fill(0); for (let i=0;i<n;i++) if (rand() < 0.005) v[i] = 1;` (p=0.005 gives the longest watchable onset; p=0.02 is the most robust). Do NOT seed with a filled square, a filled blob, or per-cell uniform noise. Best measured onset per preset with p=0.5%: coral reaches 15% coverage at step 410, maze at step 90, mitosis/leopard saturate at step ~60-100. verify.mjs cannot catch this (it is a static check), so it belongs in a comment in 02-morphogenesis.js next to the seed.

#### [MAJOR] Du=0.16/Dv=0.08 under-resolves these F/k presets: features are 2-3 cells wide, mitosis and leopard render as the same image, and the pattern is finished 0.1 s after mount

**왜 문제인가** — The four F/k presets are the canonical Karl-Sims-tutorial values, which are calibrated to dA=1.0/dB=0.5 with this exact kernel and dt=1. At Du=0.16 the diffusion length shrinks by sqrt(0.16)=0.4, so on the spec's deliberately COARSE ~80,000-cell grid the pattern sits at the lattice scale: measured autocorrelation first zero at d=3-4 cells (C(3)=0.03 for mitosis). 'Smoothly upscaled' to a 1920px canvas that is a 6x blow-up of 2-cell speckle -- blurred dither, not morphogenesis. Three consequences I measured: (a) mitosis and leopard become pixel-for-pixel the same picture (Pearson r=0.9204 from an identical seed) -- 4 presets, 3 looks; (b) the final coverage is a function of the seed, not of F/k (mitosis 9.6% at p=0.5% vs 20.1% at p=2%), i.e. each seeded cell just becomes a dot instead of the field self-organising; (c) Vstd reaches 95% of its final value by step 50-100, i.e. 0.10-0.21 s at 8 steps/frame, so the visitor never sees anything grow. At Du=1.0/Dv=0.5 all three defects disappear and it is still numerically stable (checkerboard amplification |1-1.0*1.6| = 0.6 < 1; 4000 steps, no NaN).

**근거**

```text
node /tmp/gs/du.mjs -- autocorrelation of V, sparse p=2% seed, 4000 steps, 320x250:
Du/Dv     preset  | C(1) C(2) C(3) C(4) C(6) C(8) | first zero | period | cov   Vstd   Vmax
0.16/0.08 mitosis | 0.75 0.37 0.03 -0.09 -0.01 0.03 |  4 cells | 8  | 20.1% 0.1176 0.436
0.16/0.08 coral   | 0.78 0.48 0.23 0.09 0.07 0.07  | 17 cells | 21 | 45.7% 0.1530 0.474
0.16/0.08 leopard | 0.75 0.38 0.02 -0.11 -0.02 0.03 |  4 cells | 8  | 18.4% 0.1140 0.427
0.16/0.08 maze    | 0.73 0.21 -0.18 -0.20 0.23 0.08 |  3 cells | 7  | 63.1% 0.0982 0.350
1/0.5     mitosis | 0.97 0.87 0.72 0.55 0.20 -0.08 |  8 cells | 20 | 27.5% 0.1144 0.407
1/0.5     coral   | 0.96 0.84 0.67 0.47 0.05 -0.25 |  7 cells | 18 | 69.0% 0.1264 0.424
1/0.5     leopard | 0.97 0.90 0.79 0.67 0.40 0.17  | 11 cells | 22 | 12.4% 0.0856 0.402
1/0.5     maze    | 0.96 0.85 0.69 0.49 0.06 -0.28 |  7 cells | 19 | 64.0% 0.0978 0.349

node /tmp/gs/similar.mjs -- identical seed, 4000 steps, Pearson r between preset V fields:
  Du=0.16 Dv=0.08:  mitosis vs leopard r = 0.9204 ; mitosis vs coral 0.5447 ; coral vs leopard 0.5282 ; anything vs maze < 0.06
  F/k distance: mitosis vs leopard dF=0.0017 dk=-0.0001 (euclid 0.00170)

node /tmp/gs/tempo2.mjs -- steps to 90% of final coverage; 8 steps/frame @60fps = 480 steps/s:
Du/Dv     seed          preset  | cov@4000 | step@90%cov | seconds | max|dV|/step @4000
0.16/0.08 sparse p=0.5% mitosis |   9.6%   |    100      |  0.21s  | 4.22e-3
0.16/0.08 sparse p=0.5% coral   |  23.1%   |   2250      |  4.69s  | 5.07e-3
0.16/0.08 sparse p=0.5% leopard |   7.5%   |     75      |  0.16s  | 3.77e-3
0.16/0.08 sparse p=0.5% maze    |  63.5%   |    800      |  1.67s  | 8.52e-4
0.16/0.08 sparse p=2%   mitosis |  20.1%   |     50      |  0.10s  | 2.11e-3
0.16/0.08 sparse p=2%   leopard |  18.4%   |     50      |  0.10s  | 2.20e-3
1/0.5     sparse p=0.5% mitosis |  30.2%   |   3050      |  6.35s  | 2.22e-3
1/0.5     sparse p=0.5% coral   |  61.3%   |   3375      |  7.03s  | 2.55e-3
1/0.5     sparse p=0.5% leopard |  26.1%   |   3150      |  6.56s  | 2.04e-3
1/0.5     sparse p=2%   mitosis |  27.5%   |     25      |  0.05s  | 2.25e-3

node /tmp/gs/aniso.mjs -- isotropy (a resolved pattern has C_diag(2) between C_axis(2) and C_axis(3)):
0.16/0.08 mitosis C_ax(2)=0.506 C_diag(2)=0.229 (C_ax(3)=0.03 -> expected ~0.14)
1/0.5     mitosis C_ax(2)=0.860 C_diag(2)=0.737 (isotropic within 0.12)

ASCII of the final V field at Du=0.16 (node /tmp/gs/look.mjs) shows mitosis/leopard as isolated 1-2 cell dots and maze as a diagonal lattice-locked checker texture, not a maze.
```

**수정** — Keep the kernel, the four F/k presets, dt=1, 8 steps/frame and the double buffer; change only the two diffusion constants to Du=1.0, Dv=0.5 (the calibration these F/k values come from) -- measured stable, isotropic, period 18-22 cells, 6.4-7.0 s onset with a p=0.5% speckle seed, and seed-independent final coverage. If Du=0.16/Dv=0.08 must be kept verbatim, then drop the cell count to ~13,000 (e.g. 130x100) so the 2-3 cell features occupy the same screen area, and expect mitosis and leopard to look identical -- in which case replace one of them (e.g. leopard .035/.065 -> .062/.0609 'u-skate'/'bubbles', far from mitosis in the F/k plane).

#### [MAJOR] "Drag paints V like a brush" kills the pattern for mitosis and leopard at any usable brush size

**왜 문제인가** — A large filled disc of V is spatially uniform inside, so there is no Turing instability there; it drains U and then decays as a block. Measured from the trivial state U=1,V=0, 2500 steps: for mitosis and leopard EVERY disc of radius >= 8 cells, at amplitude 0.25, 0.5 or 1.0, hard-edged or linear falloff, ends at Vstd=0.0000 / Umin=0.999 -- i.e. the visitor drags a fat stroke and watches it vanish, leaving a black canvas. r=4 with a hard edge and amp<=0.5 also dies. Only r=1-2 reliably grows. coral never dies but goes static for r>=8; maze grows at every radius. A pointer-sized brush on a 320x250 grid is 8-24 cells, squarely in the dying range.

**근거**

```text
node /tmp/gs/brush.mjs -- grid 200x160, start U=1 V=0 (unseeded), ONE disc painted, 2500 steps:
preset  r  amp  falloff | cov0   cov@2500 Vstd    Umin  | result
mitosis 2 1.00 hard     | 0.04%   0.16%  0.0107  0.325 | GREW
mitosis 4 0.25 hard     | 0.15%   0.00%  0.0000  0.998 | DIED to uniform
mitosis 4 0.50 hard     | 0.15%   0.00%  0.0000  0.999 | DIED to uniform
mitosis 8 0.25/0.50/1.00 hard AND linear | 0.22-0.62% -> 0.00% | 0.0000 | DIED (6/6)
mitosis 16 all six variants | 0.92-2.49% -> 0.00% | 0.0000 | DIED (6/6)
mitosis 24 all six variants | 2.05-5.60% -> 0.00% | 0.0000 | DIED (6/6)
leopard 8,16,24 all six variants each | -> 0.00% | 0.0000 | DIED (18/18)
coral   4 1.00 hard     | 0.15%   0.43%  0.0198  0.315 | GREW
coral   8..24           | slowly shrinks, 'survived-static' (never dies)
maze    1..24 all       | GREW in all 36 runs (r=24 hard amp1.0: 5.60% -> 17.20%)
Also setting U inside the stroke does not rescue it: mitosis r=8 amp1.0 hard with U-in=0.5 and U-in=0.0 both DIED to uniform.

node /tmp/gs/brush2.mjs -- SPECKLE brush (same disc, only a random fraction of cells set to V=1):
preset  r  density | cov0   cov@2500 Vstd   | result
mitosis 16 0.15    | 0.35%   0.61%  0.0235  | GREW
mitosis 16 0.35    | 0.88%   0.39%  0.0183  | static
mitosis 16 1.00    | 2.49%   0.00%  0.0000  | DIED
mitosis  8 0.15    | 0.08%   0.30%  0.0165  | GREW
leopard 16 0.15    | 0.35%   0.49%  0.0214  | static (does not die)
leopard  8 1.00    | 0.62%   0.00%  0.0000  | DIED
coral   24 0.15    | 0.84%   5.05%  0.0673  | GREW
maze    24 0.15    | 0.84%  17.91%  0.0922  | GREW
```

**수정** — Make the brush a stochastic speckle rather than a filled disc: for each cell within the radius, `if (rand() < 0.2) v[i] = 1;` (leave U alone). Measured: density 0.15 grows at r=16 for every preset, where density 1.0 at r=16 kills mitosis and leopard. A filled disc is only safe at radius <= 2-3 grid cells, which is too small to feel like a brush. Document the rule in the docent caption/hint (spec item 11) as 'drag scatters seed', which is also the honest description of what the code does.

#### [MAJOR] 8 steps/frame over ~80,000 cells costs 15.5-22.3 ms per frame in V8 -- at or over the whole 60 fps budget before anything else runs

**왜 문제인가** — Measured on this machine (node v20.20.2, arm64, same V8 as Chrome, JIT warmed, 300 timed iterations): 80,000 cells at 2.788 ms/step with a wrap-lookup-table inner loop = 22.30 ms for the 8 steps of one frame, 5.6 ms OVER the 16.67 ms budget; a hand-optimised branch-wrapped loop gets it to 1.935 ms/step = 15.48 ms = 93% of the budget, leaving 1.2 ms for the 0.572 ms ImageData fill, the drawImage upscale, the docent caption and the CSS grain/vignette compositing. So the naive implementation of spec item 2 runs at ~40 fps on a dev machine and will be visibly worse on a visitor's laptop or phone -- and the auto-tour (item 12) is meant to run this untouched for hours.

**근거**

```text
node /tmp/gs/perf.mjs (node v20.20.2 arm64, 100 warm-up + 300 timed steps per row):
impl        grid     cells | ms/step | ms/frame (8 steps) | vs 16.67ms budget
generic     320x250  80000 |  2.788  |  22.30             | OVER by 5.6ms
fast/no-LUT 320x250  80000 |  1.935  |  15.48             | 93% used
generic     400x200  80000 |  2.677  |  21.42             | OVER by 4.7ms
fast/no-LUT 400x200  80000 |  1.935  |  15.48             | 93% used
generic     200x160  32000 |  1.073  |   8.58             | 51% used
fast/no-LUT 200x160  32000 |  0.774  |   6.19             | 37% used
generic     160x100  16000 |  0.538  |   4.31             | 26% used
fast/no-LUT 160x100  16000 |  0.387  |   3.10             | 19% used
ImageData fill for 80,000 px: 0.572 ms/frame
```

**수정** — Either cut the grid to ~32,000 cells (200x160: 6.19 ms/frame, 37% of budget) or cut to 4 steps/frame (7.7 ms at 80,000 cells). The measured tempo data says you lose nothing visually: with Du=1.0/Dv=0.5 and a p=0.5% seed the pattern needs 3050-3375 steps to develop, which at 4 steps/frame is 12.7-14.1 s -- still a watchable arrival. Also write the inner loop with branch wrapping (`x===0?w-1:x-1`) and hoisted row offsets rather than Int32Array lookup tables: same math, measured 1.44x faster (2.788 -> 1.935 ms/step).

#### [MINOR] Naive v*255 into ImageData caps the image at 35-48% grey; V never exceeds 0.474 in any preset

**왜 문제인가** — Measured V maxima are 0.3496 (maze) to 0.4738 (coral) and medians are 0.0131-0.15, so `255*v` produces a maximum byte of 89 (maze) to 121 (coral) with a mean byte of 17-42 out of 255. On the dark museum background (--bg #0a0b0f) the work reads as a barely-visible grey smudge, and maze -- the preset with the richest structure -- is the dimmest because its dynamic range is the narrowest.

**근거**

```text
node /tmp/gs/color.mjs (320x250, sparse p=2% seed, 4000 steps). Observed ranges:
preset  | V min  V p50   V p90   V p99   V p99.9 V max  | U min  U p1    U p50  U max
mitosis | 0.0000 0.0146  0.3371  0.3870  0.4168  0.4358 | 0.2764 0.3010 0.8806 1.0000
coral   | 0.0000 0.0949  0.3680  0.4506  0.4621  0.4738 | 0.2740 0.3151 0.7223 0.9997
leopard | 0.0000 0.0131  0.3313  0.3795  0.4104  0.4269 | 0.2768 0.3012 0.8820 0.9999
maze    | 0.0098 0.1500  0.2884  0.3143  0.3343  0.3496 | 0.2717 0.3053 0.5205 0.8136
Mapping comparison (byte values at V quantiles q01 q25 q50 q75 q90 q99 max, then per-pixel mean/stdev byte over the whole field):
mitosis  naive 255*v              |   0   0   4  23  86  99 111 | mean 18.1 stdev 30.0
mitosis  255*v/0.5 shared ceiling |   0   1   7  45 172 197 222 | mean 36.1 stdev 60.0
mitosis  255*smoothstep(.05,.35)  |   0   0   0  12 254 255 255 | mean 37.4 stdev 85.1
mitosis  255*(1-u)                |  (per-pixel) mean 50.0 stdev 52.6
coral    naive 255*v              |   0   4  24  83  94 115 121 | mean 38.1 stdev 39.0
coral    255*smoothstep(.05,.35)  |   0   0  15 250 255 255 255 | mean 90.0 stdev 114.5
maze     naive 255*v              |   6  19  38  68  74  80  89 | mean 42.3 stdev 25.0
maze     255*v/vmax per-preset    |  18  54 109 194 210 229 255 | mean 120.9 stdev 71.6
maze     255*smoothstep(.05,.35)  |   0   5  66 207 227 245 255 | mean 102.6 stdev 96.1
```

**수정** — Use ONE shared normalisation, not per-preset (per-preset re-normalising would make the presets look equally bright and hide the real difference, and vmax drifts during the transient): `t = smoothstep(0.05, 0.34, v)` then mix the museum ink colour over the background, e.g. `r = 10 + t*(232-10)` etc. from the site's --bg #0a0b0f / --ink #e8e4da. Measured per-pixel stdev rises from 25-39 bytes (naive) to 83-115 bytes. 0.34 as the top edge clips only coral's brightest ~1% (p99 = 0.4506) and puts maze's p99 (0.3143) at byte 245. If you want a second tone, the U field is independently useful: U spans [0.272, 1.0] with per-pixel stdev 37-62 bytes, so `255*(1-u)/0.73` gives a soft inverse layer for the wing accent.

---

## 작품 04 설계 경합 — 심사 결과

독립 후보 3개를 서로 다른 관점(구조 대비 / 시각 / 인터랙션)에서 설계하게 하고,
심사 에이전트가 상위 후보들의 핵심 루프를 **직접 재측정**한 뒤 승자를 골랐다.

| 후보 | 구조대비 | 시각 | 인터랙션 | 구현성 | 성능안전 | 합계 |
|---|---|---|---|---|---|---|
| Overgrowth | 10 | 9 | 8.5 | 9 | 9.5 | **46** |
| Sympathetic Strings | 5.5 | 6.5 | 9.5 | 7.5 | 7 | **36** |
| Quiet Interference | 7 | 10 | 8 | 6 | 3 | **34** |

**승자: Overgrowth**

### Overgrowth

Wins on being the only one of the three whose element count is an OUTPUT of the simulation rather than an input, and I verified that in the code, not the prose: `nxt: Int32Array` cyclic linked list, `_insertAfter` doing an O(1) mid-curve splice, a bump allocator with a free list, a per-frame counting-sort spatial hash, and a runtime-variable ring count. 01/02/03 are all a fixed-size bag or grid; nothing there has an analogue. Its numbers are the most honest of the three set — I reproduced p50 2.06 / p90 2.07 / p99 2.14 ms against claimed 2.05/2.08/2.13, 220.0 KB of typed arrays exactly, MAX 6500, L 15.709, grid 82x46 = 3772 cells exactly, n@30s = 3611 vs claimed 3618, and preview = 438 nodes at 0.11 ms. Its self-declared risks are also real: I measured the jam at the cap at 0.60 px/s of mean node movement (so the generation cycle is necessary, not decoration) and the shrink-resize cliff at 15.49 ms p50 / 18.11 ms p99 with items/cell 6.89 — WORSE than its own claimed 12.64 ms, which vindicates the onResize policy as load-bearing. It survived a 3600-frame hostile pointer sweep with 0 non-finite coords and 0 nodes out of the box, holds 2.13 ms p99 at 3840x2160, and its cell count stays in 3772-6420 across every aspect ratio I tried including 2560x400 and 600x1600. It is the only entrant whose real piece file I could import in Node and run for 240 s / 14,400 frames against a stub context (1.22 ms/frame mean, 5 beginPath per frame, one opaque fillRect per frame) — exactly the browser-free testability verify.mjs depends on. Loses on speed of legibility: nothing moves faster than a fraction of a pixel per frame, so a three-second visitor may not register that the cursor caused anything, and onPointerUp is unused. Also loses half a point on the 'one file' rule — the prototype is two files (piece04.mjs + core2.mjs) and the Growth class must be inlined. Biggest risk: the onResize band policy (0.7x..2.0x of mount area → regrid only, else reconfigure+reseed) is the ONLY thing standing between this piece and a verified 15.5 ms dropped-frame cliff; any future refactor that 'simplifies' onResize to a bare regrid() reintroduces it silently.

### Sympathetic Strings

Wins decisively on interaction: CATCH → STRETCH → SLIP at 96 px is the only genuinely new VERB in the field, unclaimed by 01's hold-to-charge, 02's drag-to-paint and 03's approach-to-scatter, and it is the only one of the three with instant tactile causality — one 0.6 s swipe produces 35 slips, each string ringing at its own pitch. I verified the instrument is real: layout gives S=23, M=284, gap 60.0 px, dx 9.05 px, len[0]=284 down to len[22]=109, so the 2.61:1 length ratio and the 1.38-octave pitch spread are correct; physics is 0.459 ms p50 (better than its claimed 0.6); the harp taper genuinely cuts stroked path from 58.9 to 40.6 kpx (ratio 0.689, exactly as claimed); and KAP=0.02 does blow up (155,063% of initial energy at t=3 s in my run vs their 216,365%) so the 0.005 hard cap is justified. It is also the cheapest to raster of the three (34.5 ms = 0.44x work-01 at 34k particles) and the cheapest preview (1.5 ms). Loses badly on structural contrast: strip the metaphor and it is an explicit finite-difference PDE on a multi-buffered Float32Array with 8 substeps per frame — which is work 02's structure reduced from 2-D to 1-D (02: two double-buffered grids, fixed stencil, 8 steps/frame; this: three buffers, 3-point stencil, 8 substeps/frame). The genuinely new parts (ragged row lengths, per-row identity, a runtime-mutable interior Dirichlet boundary, 2000:1 anisotropy, vector-path render) are real but are variations inside that same family, and it lands in the flow wing while being a life-wing-shaped PDE. Visual impact is unproven — it is the only entrant that produced no render at all, only benchmark harnesses, and I verified its composition is viewport-fragile: S = clamp(round(H/64),10,26) gives 23 strings at 1440p but only 14 at 1440x900 and 11 at 720p, so on a laptop the harp is half empty. Biggest risk: its headline performance figure is measured in the state where the piece is doing nothing. The advertised '8.4 ms untouched' is MODE:idle — near-flat strings — and its own results.jsonl shows flat 8.1 ms vs wavy 40.3 ms at S=31, a ~7x gap it concedes in prose; my independent measurement of all 23 strings actually ringing is 34.5 ms. So the working-state cost is ~4x the headline, the dt governor is mandatory rather than a nice-to-have, and that governor changes the composition (fewer strings means different lengths means different pitches) — the instrument retunes itself while the visitor watches. Secondary risk: two unresolved pointer-contract unknowns. I confirmed its frame signature is `frame(dt,t,p)` — the 2-arg call the engine contract specifies throws 'Cannot read properties of undefined (reading active)' — and it admits pointer velocity units are a guess with a 60x error mode.

### Quiet Interference

Wins on pure visual impact — I looked at its renders and P3.png is the single most beautiful frame in the field: silver prism-edged hairlines on near-black, saddle points pinching into X's, real moiré in the flattened regions, unmistakably 'an ink drawing that is alive'. The ±1.3 px chromatic offset is a genuine discovery. Its JS work is also excellent and completely honest: I rebuilt the pipeline myself and got tables 0.092 / evalGrid 0.715 / rms 0.063 / terraces 0.814 / nodal-as-one-banded-pass 0.481 = 2.17 ms total against its claimed 2.15, with 17,743 segments; sizing reproduces exactly (lam 334.9, cell 14.00, K 0.263, lattice 185x105 = 19,425); and the separable trick is even better than advertised — naive per-cell Math.cos measured 3.785 ms vs 0.715 separable, a 5.3x win. But it loses on the dimension that actually decides shipping, and loses catastrophically. On the identical rasteriser, same page, same forced flush, its draw costs 280.3 ms p50 at 2560x1440 DPR2 — 6.61x my work-01 proxy at 12,000 particles and 3.60x work-01 at its spec'd maximum of 34,000. Its central defence, 'any machine that runs 01 at 60 fps runs 04', is contradicted by direct comparative measurement on the same hardware, which is exactly the measurement it says is the defensible one. Worse, its own mitigation cannot save it: I measured the governor's bottom rung (nL=9, 11,102 segments) at 170.0 ms, and the irreducible 3-level chromatic nodal figure alone at 163.4 ms — the whole ladder has 1.7x of dynamic range against a roughly 17x shortfall, because the bright figure it cannot give up IS the floor. I also confirmed its letterbox inversion: 2560x400 yields a 443x71 = 31,453-cell lattice, 62% MORE cells than the 2560x1440 room, so it gets more expensive on a smaller canvas. Structural contrast scores mid: statelessness/seekability is a real and strong axis and level-set extraction to vector geometry is a genuinely different render primitive, but the underlying data structure is a Float32Array scalar grid coarser than the screen plus output Float32Arrays, which is the same family as 02's coarse-grid-then-upscale, and 'sample an analytic field on a lattice' is 01's idea with cos in place of Perlin. Implementability is the weakest of the three: it has no piece-shaped file at all (only prod.html with inlined logic), so unlike the other two I could not run a contract check on it, and it needs a self-timing governor, a 5-rung quality ladder, 24 segment buffers with silent-truncation handling, 3 precomputed round-robin masks and a precomputed style cache — the largest surface area in the field inside a 2-hour total project budget. Biggest risk: the performance hole is structural, not tunable — the thing that makes it beautiful (dense antialiased hairline coverage at DPR 2) is the thing that costs, and there is no rung below the bright figure that still looks like this piece.

### 준우승에서 이식할 것

- CHROMATIC FRINGE from Quiet Interference — its single best visual discovery and the cheapest to graft. Stroke the brightest generation bucket (bucket 4, the frontier) THREE times at x-offsets -1.1 / 0 / +1.1 CSS px in hue-neighbours of the wing accent: '#7fe0d0' at alpha 0.22, '#cfeecd' at alpha 0.62, '#a9c8ef' at alpha 0.22. That makes the growing edge read as glass rather than as a contour, for 2 extra stroke() calls on the thinnest bucket only (7 strokes/frame instead of 5). Overgrowth measured 43.6 ms draw vs 77.8 ms for work-01 at 34k particles on the same rasteriser, so there is real headroom for this and nothing else.
- THE SELF-TIMING GOVERNOR PATTERN from Quiet Interference (20-frame median of the frame body; step down after 20 consecutive frames over 11 ms, step back up after 60 frames under 5 ms). Interference needed it as a fig leaf for an unfixable raster cost and its ladder only spanned 1.7x; Overgrowth needs it for the one real cliff I measured (15.49 ms p50 after a shrink-resize) and its ladder has genuine range because lowering MAX_eff and raising spacingMul both cut cost quadratically.
- D2's LETTERBOX LESSON, stated as a rule in the file: never derive cost from min(W,H). Interference's lam = min(W,H)/4.3 makes 2560x400 cost 62% MORE than 2560x1440 (31,453 vs 19,425 cells) — verified. Overgrowth already derives from area (s = sqrt(w*h)/1100, MAX = area/95) and I confirmed its cell count stays in 3772-6420 across 2560x1440, 2560x400, 600x1600 and 3840x2160. Keep it and write the comment so nobody 'fixes' it.
- D2's 'THE ALPHAS ARE THE ARTWORK' comment, applied verbatim to Overgrowth's per-bucket alpha = 0.5 + 0.12*b. Interference's first tuning pass at alpha 0.5-1.0 produced a psychedelic screensaver (its s_F.png / s_G.png); the same failure mode applies here, where the whole point is that the interior recedes into #0a0b0f. A future maintainer 'fixing the dimness' destroys the piece.
- D2's framing that a white flash should be STRUCTURALLY IMPOSSIBLE rather than merely handled: setup() does exactly one opaque fillRect and the piece contains no light source. Overgrowth already satisfies this — say so explicitly in a comment, because it is also what wipes work 01's 'lighter' mode and never-cleared trails off the shared canvas.
- D2's SEEKABILITY DISCIPLINE, adapted. Overgrowth cannot be stateless, but Interference is right that a 30 s tour slot must not depend on frame history. Make the generation-cycle phase derived from the piece's own accumulated time with a fixed 54 s period so every tour slot lands in the legible growth phase, and have main.js's tour skip a work that is mid-dissolve rather than mounting into a fade-to-black.
- D3's TACTILE-IMMEDIACY THINKING — its 'first two seconds of touching it' narrative is the best piece of design writing in the field, and it exposes Overgrowth's weakest point (everything moves a fraction of a pixel per frame, so causality is invisible to a 3-second visitor). Graft an entry burst: on the pointer transitioning inactive→active, multiply PUSH by an entryBoost that ramps 2.2 → 1.0 over 0.45 s, so the void starts carving immediately and then settles into the slow behaviour.
- D3's KIOSK IDLE BEHAVIOUR ('2.4 s after the last pointer event the room starts playing it'). Overgrowth's best trick — colonies pressing into suture lines — is currently only reachable by clicking, so an untouched kiosk never sees it. Auto-plant: if no pointer event for 12 s and ringN < 3 and n > 0.35*MAX, plant one colony at a random point at least min(w,h)*0.12 from existing ring centroids; max 3 auto-plants per generation. I measured 8 colonies at 1.98 ms p50, so this is free.
- D3's RATE-LIMIT-THE-DESTRUCTIVE-CONTROL rule (it concluded its Chord button needs ~1.2 s of throttling). Overgrowth plants a colony per pointerdown, so a visitor mashing the canvas consumes all 8 rings and the whole 6500-node budget in under a second and the piece jams immediately. Cap it at one plant per 0.5 s.
- D3's ELEMENTS-HAVE-IDENTITY insight (shuffling its rows would destroy the instrument). Overgrowth's rings already are identities — it has a per-ring growth accumulator splitAccR[8] — so make the identity visible: give ring r a growth rate of GR * (0.85 + 0.30*fract(r*0.618)) so eight colonies visibly grow at different rates instead of looking like one substance.
- D3's habit of STATING THE ENGINE ASSUMPTION IN THE FILE. It flagged that its impulse constants assume pointer.vx/vy are CSS px per SECOND and that a per-frame engine would make them 60x too strong. Overgrowth has the identical exposure in exactly one place — the smear term ax += pointer.vx * fall * 0.008 — so put the units in a comment next to that line, because it is the only number in the piece that silently depends on engine.js's pointer normalisation.

### 최종 통합 스펙

```text
WORK 04 — "Overgrowth" / 붐비는 선
One file: site/js/pieces/04-overgrowth.js. Wing: life. Canvas 2D only, no new engine capability.
(The prototype at /tmp/w04g/web/piece04.mjs + /tmp/w04g/core2.mjs must be merged into ONE file: inline the
Growth class as a module-scope class declaration in 04-overgrowth.js. Module scope may contain ONLY
`const BG`, `const PAL`, `const FRINGE`, `const OFF_X/OFF_Y` and the two class declarations — no document,
no window — so verify.mjs can `await import()` it in Node.)

=== THE RULE (docent caption, verbatim) ===
"선은 자기 자신에게서 일정한 간격을 지키려 하고, 자리가 남은 곳마다 두 점 사이로 새 점이 끼어든다."
EN: "The line keeps a fixed distance from itself, and wherever it still finds room a new point is inserted
between two old ones — so it lengthens, and with nowhere left to go it folds."

=== MOOD ===
Background is exactly the site token --bg #0a0b0f, painted OPAQUELY as the first op of every frame. No trails,
no additive blending, no 'lighter'. Where 01 remembers with light, 04 remembers with structure: the folds ARE
the record. This is also what wipes 01's never-cleared trails and its 'lighter' composite off the shared canvas.
Palette, inward-old to outward-new over 5 generation buckets:
  PAL = ['#25424b', '#366d68', '#5aa382', '#8fe39a', '#cfeecd']
  bucket b = min(4, (gen*5/maxGen)|0);  globalAlpha = vis * (0.5 + 0.12*b)
  lineWidth = max(0.9, 0.105*L)  -> 1.65 CSS px at 2560x1440, 0.9 px on a preview card
  lineCap = lineJoin = 'round'
COMMENT REQUIRED IN FILE: "the alphas are the artwork — brightening these turns the piece into a screensaver."
GRAFTED CHROMATIC FRINGE: bucket 4 (the frontier) is stroked THREE times instead of once, at x-offsets
-1.1 / 0 / +1.1 CSS px, with FRINGE = ['#7fe0d0', '#cfeecd', '#a9c8ef'] at alpha 0.22 / 0.62 / 0.22.
Total 7 stroke() calls per frame. This makes the growing edge read as glass, not as a contour plot.
Speed: node displacement is a fraction of a pixel per frame; what you perceive is the frontier budding.
Growth is exponential, doubling time 3.5 s. Measured node counts from mount at 2560x1440: 5 s = 247,
15 s = 1277, 30 s = 3611, 45 s = 6436, cap 6500 at ~46 s — so a 30-second auto-tour slot lands squarely in the
most legible phase. Rest spacing 15.7 px at 2560x1440 with folds ~31 px apart: at saturation it reads as a brain
coral / Lichtenberg tissue filling a rounded hexagon, the four corners of the 16:9 frame left dark like an object
on a plinth. An almost imperceptible 13-second breath (rest length +-5.5%) so the whole reef inhales.

=== ALGORITHM — DIFFERENTIAL GROWTH on a set of cyclic linked polylines ===
All typed arrays allocated ONCE in configure(), never grown. MAX = capacity.
  x, y, fx, fy : Float32Array(MAX)    positions, force accumulators
  nxt          : Int32Array(MAX)      cyclic singly-linked "next"; doubles as the free-list chain
  gen          : Uint8Array(MAX)      subdivision depth (colour) = min(254, max(gen[i],gen[j])+1)
  dens         : Uint8Array(MAX)      neighbours within R last frame (frontier detector + growth gate)
  order        : Int32Array(MAX)      all rings flattened in ring order, rebuilt every frame
  ringHead : Int32Array(8), ringStart : Int32Array(9), splitAccR : Float64Array(8)
  cellStart : Int32Array(cells+1), cellCnt : Int32Array(cells), cellItems : Int32Array(MAX)
  bump allocator + free list; MAX_RINGS = 8.  MEASURED: 225,312 bytes = 220.0 KB at MAX 6500.

SCALE (derive from AREA, never from min(W,H) — that is the trap that inverts cost on a letterbox canvas):
  s = clamp(sqrt(w*h)/1100, 0.85, 2.0) * spacingMul        // 2560x1440 -> 1.745 ; 260x160 -> 0.85
  L = 9.0*s   SPLIT = 1.7*L   R = 2.0*L (repulsion radius == hash cell size)   MAXSTEP = 0.45*L
  MAX = round(min(6500, max(420, round(w*h/95))) / max(1, spacingMul^2))
        // 6500 in any room, 438 on a 260x160 preview card
  seed: one ring, radius max(8, min(w,h)*0.16), k = clamp(round(2*PI*r/L), 24, 160) nodes
  VERIFIED cell count stays 3772..6420 across 2560x1440, 2560x400, 600x1600 and 3840x2160.

PER FRAME. dtf = min(dt*60, 3) — exactly the engine's dt cap of 1/20 s expressed in frame units, so a
tab-switch cannot explode the integrator. L breathes: Leff = L*(1 + 0.055*sin(2*PI*tAcc/13)).
 1. Flatten rings into order[] by chasing nxt (O(n) pointer chase); record ringStart[].
 2. Rebuild the uniform spatial hash by COUNTING SORT: cellCnt.fill(0) -> prefix sum into cellStart ->
    scatter into cellItems. Zero allocation, O(n + cells). 2560x1440 -> 82x46 = 3772 cells,
    1.72 items/cell at saturation.
 3. Springs, per ring slice (prev = order[q-1] or the slice's last element, next = nxt[i]):
    KA = 0.20 spring toward Leff on both neighbours; KS = 0.11 curvature smoothing toward the neighbour
    midpoint. fx[i] = ax (ASSIGN, not accumulate).
 4. Repulsion, symmetric HALF-STENCIL so every unordered pair is visited exactly once: for each cell, the
    upper triangle within the cell plus four forward cells via module-scope
    OFF_X = [1,1,1,0], OFF_Y = [-1,0,1,1]. f = (1 - d/R)*0.62/d applied +f to i and -f to j;
    dens[i]++, dens[j]++. The offset table MUST stay hoisted to module scope — as a per-frame literal it was
    the dominant allocator.
 5. Integrate: step = f*dtf, clamped to MAXSTEP (7.07 px at 2560x1440), then clamped to the canvas with pad 4.
    The clamp is load-bearing: VERIFIED 0 non-finite coords and 0 nodes outside the box over a 3600-frame
    hostile pointer sweep at 4000 px/s with the button toggling every second.
 6. Growth, PER RING: splitAccR[r] += GR_r * growthMul * ringLen * dt, with
    GR_r = 0.20 * (0.85 + 0.30*fract(r*0.618))   // per-ring jitter so 8 colonies visibly differ
    Take the integer part; for each, pick a random node of that ring, REJECT it if dens[i] > DENS_OK = 5
    ("no room here"), else insert a node at the edge midpoint (O(1) relink via _insertAfter).
    Then a resolution pass: any edge longer than SPLIT gets a midpoint. DENS_OK is a brake, not a stop —
    3/4/5/6/7 give saturation at 96/64/48/41 s and 3 kills growth entirely.
 7. GENERATION CYCLE: n >= MAX -> hold 6 s -> dissolve over 2.5 s (render alpha 1->0) -> reset() ->
    fade in over 0.9 s. Period 54 s. This is MANDATORY, not decoration: I measured the colony JAMS at the cap —
    mean node movement 3.00 px over 5 s = 0.60 px/s, and the 13 s breathing does not lift it. Without the cycle
    the room goes static after ~46 s. Derive the cycle phase from the piece's own accumulated time (fixed 54 s
    period) so the phase is predictable for the auto-tour; main.js's tour should skip a work that is mid-dissolve
    rather than mounting into a fade-to-black.

RENDER (7 draw calls, no ImageData, no additive blending):
  opaque fillRect(BG) over the whole canvas, then 5 passes over order[] bucketed by gen, plus 2 extra
  fringe strokes on bucket 4. Each pass WALKS RING SLICES via ringStart[] and emits moveTo/lineTo runs,
  resetting `open` per ring. THE PER-RING WALK IS MANDATORY: iterating order[] flat draws a visible straight
  chord from ring A's head to ring B (caught in /tmp/w04g/shot_drag.png). Any future 'optimisation' that
  flattens that loop reintroduces a glitch that looks like a rendering error.
  frame() restores globalAlpha = 1 before returning so 01/02/03 cannot inherit a partial alpha.
  Drop the float stats (maxStepSeen / splitAcc / checks) off `this` — they were the only per-frame garbage
  (189-379 bytes of HeapNumber boxing).

=== INTERACTION (documented Piece contract only; no document access anywhere) ===
HOVER (pointer.active && !pointer.down) — your cursor is a stone the tissue grows around. Within
PR = min(w,h)*0.16 every node gets (1-d/PR)^2 * PUSH outward, PUSH = 0.5*Leff, plus a smear of
pointer.vx/vy * (1-d/PR) * 0.008.
  COMMENT REQUIRED next to the 0.008: "pointer.vx/vy are CSS px per SECOND — if engine.js ever normalises
  per frame this constant is 60x too strong." This is the only number in the piece that depends on the
  engine's pointer normalisation.
  GRAFTED ENTRY BURST: on pointer transition inactive->active, multiply PUSH by entryBoost which ramps
  2.2 -> 1.0 over 0.45 s, so the void starts carving immediately instead of over four seconds. Without this
  a three-second visitor cannot tell the cursor did anything.
  Parking the cursor inside the colony for 4 s carves a clean circular void that heals after you leave.
  MEASURED cost hovering non-stop: 2.35 ms p50 vs 2.06 idle.
PRESS-AND-HOLD (pointer.down) — feeding. (a) 75% of that frame's insertion sites are drawn from the 9 hash
cells under the cursor instead of uniformly along the ring, and the density gate is relaxed to DENS_OK+2 there;
(b) a pull of (1-d/PR)*PULL, PULL = 0.35*Leff, applied ONLY to nodes with dens[i] <= DENS_OK — only the
frontier reaches for food, never the interior. That restriction is why pressing cannot yank interior nodes into
straight chords (a strong uniform attraction of 1.5 did exactly that). MEASURED 2.23 ms p50.
onPointerDown() — plants a NEW colony at the cursor: a ring of radius min(w,h)*0.03 with
max(10, round(2*PI*r/L)) nodes, up to MAX_RINGS = 8. Colonies repel through the shared hash, so they press
together and form suture lines. RATE-LIMITED to one plant per 0.5 s — otherwise a visitor mashing the canvas
consumes all 8 rings and the whole node budget in under a second and the piece jams instantly.
Ignored during the dissolve phase. MEASURED 8 colonies: 1.98 ms p50.
onPointerUp() — deliberately NOT implemented; pointer.down already falls to false. Say so in a comment.
GRAFTED KIOSK IDLE: if no pointer event for 12 s AND ringN < 3 AND n > 0.35*MAX, auto-plant one colony at a
random point at least min(w,h)*0.12 from existing ring centroids. Max 3 auto-plants per generation. This is
what makes the piece's best trick — colonies suturing — reachable by an untouched gallery kiosk.
controls(host) — engine factories only, the file never touches document:
  host.slider('성장 속도 / growth', 0.3, 2.5, 1, 0.05, v => g.growthMul = v)
  host.slider('결 / grain', 0.7, 1.6, 1, 0.05, v => { g.configure(w,h,{spacingMul:v}); g.reset(); })
      // label must say it restarts the colony; spacing change reallocates.
      // 0.7 -> L 11.0, ~2.30 ms ; 1.6 -> L 25.1, cap auto-scales to 2539, ~0.98 ms
  host.button('새 군체 / reseed', () => g.reset())
Keyboard: none, so the gallery's P (auto-tour) and Esc keep working.

=== CONTRACT FIT ===
Hooks: setup(), frame(dt, t), onResize(), onPointerDown(), controls(host). onPointerUp intentionally absent.
Consumes only this.ctx (already DPR-scaled, so the piece works purely in CSS px), this.w / this.h in CSS px,
this.pointer = {x, y, vx, vy, active, down}, and the dt/t clock with dt capped at 1/20 s. Requires NO new
engine capability: no second canvas, no offscreen buffer, no ImageData, no WebGL, no rAF of its own, no
document, no window, no external library.
onResize(): area-band policy, and it is LOAD-BEARING. If the new area is within 0.7x..2.0x of the mount area,
call regrid() only (keep every node, rebuild just cellStart/cellCnt). OUTSIDE that band, reconfigure + reseed.
MEASURED WHY: a bare regrid() from 2560x1440 to 1280x720 holding 6500 nodes drives items/cell from 1.72 to 6.89
and costs 15.49 ms p50 / 18.11 ms p99 — a dropped frame. Put that number in a comment so nobody 'simplifies'
onResize back to a bare regrid().
GRAFTED SAFETY GOVERNOR (6 lines, the net for exactly that cliff): keep a 20-frame median of the frame body
timed with performance.now(); if it exceeds 11 ms for 20 consecutive frames, set MAX_eff = max(1800,
MAX_eff*0.75) and stop growth above it; if it stays under 5 ms for 60 frames, restore one step. Unlike a
quality ladder over render passes, this ladder has real dynamic range because cost is roughly linear in node
count and quadratic in spacing.
data.js — one entry, replacing one module:null "Soon" card; the life wing already exists so NO CSS edit:
  { no:'04', wing:'life', title:'Overgrowth', ko:'붐비는 선',
    medium:'Canvas 2D, differential growth', year:2026,
    note:'...', hint:'끌어 보세요 — 손끝을 피해 자라고, 누르면 그쪽으로 자랍니다',
    module:'./pieces/04-overgrowth.js' }
Supports #work-04 deep links, prev/next, Esc and the 30 s auto-tour with no main.js change.
verify.mjs passes unchanged: default export, extends Piece, setup and frame on the prototype, wing 'life'
exists in WINGS, no '04' is unique.

=== PERFORMANCE BOUND (all measured by me on a 4-vCPU aarch64 box, Node v20.20.2, Chromium 1243 with
SOFTWARE rasterisation / no GPU, load avg 0.3-0.4, getImageData flush forced. Absolute ms are a pessimistic
floor; the RATIO to work 01 on identical hardware is the defensible claim.) ===
SIMULATION, steady state at 6500 nodes:
  2560x1440       p50 2.06  p90 2.07  p99 2.14  max 2.15 ms
  1280x720        p50 1.99  p90 2.00  p99 2.01  max 2.03 ms
  260x160 preview p50 0.11  p90 0.12  p99 0.12  max 0.12 ms   (438 nodes, hard cap)
  hover 2.35 | press 2.23 | 8 colonies 1.98 | 3840x2160 p99 2.13 ms
DRAW, 2560x1440 DPR2, software rasteriser, same page and flush as the baselines:
  Overgrowth 6500 nodes .......  43.6 ms  = 1.03x work-01 at 12,000 particles
                                          = 0.56x work-01 at the spec's max 34,000 particles
  work-01 proxy 12k / 34k .....  42.4 / 77.8 ms
  full-canvas fade fillRect ....  4.8 ms (the floor every piece pays)
  preview 260x160, 438 nodes ...  3.8 ms
  => ACCEPTANCE CRITERION: 04 must stay under work 01 at 34k particles on the same machine. It is at 0.56x.
     Any machine that runs 01 at 60 fps runs 04. Re-measure both on the real exhibition display before any
     public "60 fps at 2560x1440" claim is made.
CONTRACT-RUN PROOF, no browser: importing the real piece file in Node and running 14,400 frames (240 s of
simulated time, 4 complete generation cycles) against a stub 2D context costs 1.22 ms/frame mean, with exactly
one opaque fillRect and 5 beginPath per frame. This is the same browser-free testability verify.mjs depends on.
MEMORY: 220.0 KB of typed arrays at MAX 6500 with an 82x46 cell grid, allocated once in configure() and never
grown. Per-frame allocation target 0 bytes after dropping the float stats off `this`. Over a 30 s auto-tour leg
the node count is bounded at 6500 by construction (the bump allocator returns -1 and growth simply stops), and
measured n at 30 s from a fresh mount is 3611 — the cap is never even reached inside a tour slot.
DOES NOT DEGRADE 01-03: works mount one at a time (main.js destroys before switching, one canvas forever), so
there is no concurrent cost; 04 holds no timers and no listeners of its own and its 220 KB dies with the
instance; setup() forces globalCompositeOperation='source-over', globalAlpha=1 and an opaque fillRect, which is
exactly what wipes 01's 'lighter' mode and its never-cleared trails; frame() restores globalAlpha=1 on exit.
```

