# 점심 메뉴 추천기 — 작업 이어가기 (Handoff)

VSCode Claude에서 이 프로젝트를 이어서 작업할 때 참고할 문서. 이 파일을 새 저장소(`doxoba/vibecoding`) 루트에 같이 넣어두면 다음에 열었을 때 맥락을 바로 파악할 수 있음.

---

## 1. 프로젝트 목적

매일 점심 메뉴 고르기가 어려워서 만드는 도구. 조건:

- 기준 주소: **서울 금천구 가산디지털1로 136**
- 반경 **100m 단위로 100~500m 중 선택** (기본값 300m, 화면 상단 "반경" 칩에서 바꾸면 즉시 재검색됨, `localStorage`에 저장)
- **1호선 철길 왼쪽(서쪽)** 구역만 후보
- 조건(형태/맛/종류)을 **멀티셀렉트로 선택 가능하되 필수는 아님** (예: 면+매운맛 선택 → 짬뽕집, 매운라멘집 등)
- 결과: **식당명 + 추천메뉴(대표 1개) + 그 식당의 다른메뉴**

## 2. 산출물 현황

| 위치 | 상태 |
|---|---|
| `lunch-recommender.html` | 구현 완료. 단일 HTML/CSS/JS 파일, 의존성 없음 |
| `doxoba/vibecoding` (main 브랜치) | **배포 완료.** `CONFIG.KAKAO_JS_KEY` 실제 키 채워져 있고, GitHub Pages가 main 브랜치에서 서빙 중 |
| 실사용 URL | **https://doxoba.github.io/vibecoding/lunch-recommender.html** (카카오 도메인 등록도 완료돼 있어 라이브 데이터로 뜸 — 빨간 배너 없음, 2026-09-16 확인) |
| Claude Artifact | 발행돼 있었음: https://claude.ai/code/artifact/31bc9d8b-acbd-44e1-92fc-1c3a5220b6d5 (카카오는 CSP로 막혀 항상 예시 데이터 모드 — 참고용, 실사용은 위 GitHub Pages URL 사용) |
| `qoxopa/notion` 저장소 | 로컬 커밋(`f5bda65`)만 존재, **push 안 됨** (예전 이슈, 그대로 미해결 — 지금은 `doxoba/vibecoding`이 유일한 정본) |

## 3. 핵심 설계 결정 사항

- **카카오맵 JS SDK**로 런타임에 데이터를 가져옴 (좌표를 코드에 하드코딩하지 않음):
  - `kakao.maps.services.Geocoder.addressSearch()`로 사무실 주소 → 좌표 변환
  - `kakao.maps.services.Places.categorySearch('FD6', {location, radius, sort:DISTANCE})`로 사용자가 고른 반경 내 음식점 검색
  - **적응형 분할 탐색(`deepCategorySearch`)**: 카카오 Local API는 한 번의 검색(원 하나)당 최대 45건 캡이 있다. 가산디지털단지는 REST API로 직접 대조해본 결과 200m 반경만 돼도 이 캡에 걸리는 밀집 지역이라, 이전의 "고정 5점 그리드" 방식은 400m에서 44%, 500m에서 59%가 누락됐다(2026-09-16 감사 결과, `scratchpad/kakao_audit2.py` 참고 — 세션별 스크래치패드라 재현하려면 다시 작성 필요). 지금은 캡에 걸린 원을 4등분해서 다시 검색하고, 이걸 캡에 안 걸릴 때까지(또는 `CONFIG.SEARCH_MAX_DEPTH`/`SEARCH_MIN_SUBRADIUS_M` 한도까지) 재귀적으로 반복한다. 500m까지는 실측으로 그라운드트루스와 일치함을 확인했다. 그래도 한도에 걸린 채 캡이 남아있으면 `state.searchIncomplete=true`가 되어 목록 패널에 "누락 가능성" 경고가 뜬다.
  - `Places.keywordSearch('가산디지털단지역')` / `keywordSearch('독산역')`로 철길 위 두 지점을 실시간 조회 → 외적(cross product) 부호로 사무실과 같은 쪽에 있는 식당만 필터링 (좌표 하드코딩 없이 자동 계산)
- **경계 오차 안전장치**: 식당별로 수동 포함/제외 토글 제공 (자동 판정이 틀렸을 때 직접 보정 가능), `localStorage`에 저장돼 재검색해도 유지됨
- **메뉴 데이터 문제**: 카카오 API는 메뉴 정보를 안 줌 → 카테고리명/메뉴명 키워드 기반 자동 추정(`TAG_RULES`, 30여 개 규칙) + 사용자가 직접 편집하는 UI 제공, `localStorage`에 영구 저장 (식당 id 기준 병합이라 재검색해도 편집 내용 안 사라짐). 실사용 중 "곱창/막창이 무조건 매운맛으로 잡힘" 버그를 신고받아 수정함(양념/불/매운 표기가 있을 때만 매운맛, 나머지는 보통) — `TAG_RULES`처럼 메뉴 판정 로직 자체를 바꿀 땐 `TAG_RULES_VERSION`을 올려서 이미 캐싱된(24시간 TTL) 메뉴가 옛 판정 그대로 재사용되지 않고 자동으로 재조회·재태깅되게 해야 함
- **종류(cuisine) 8분류**: 처음엔 한식/중식/일식/양식/카페-디저트/기타였는데, 실제 점심 고를 때 궁금한 건 "국밥집인지 백반집인지 구내식당인지"라 국가 기준 분류가 안 맞는다는 피드백을 받아 재편함(2026-09-16, 사용자가 8개 카테고리와 대표 메뉴 예시를 직접 정의): **구내식당/한식뷔페 · 국밥/탕/찌개 · 제육/백반/정식 · 중식 · 면류/분식 · 돈까스/일식/양식 · 아시안/세계요리 · 간편식/식단관리**. 카카오 category_name 기반 규칙(`CUISINE_CATEGORY_KEYWORDS`)이 최우선, 못 찾으면 메뉴명 키워드(`TAG_RULES.cuisine`) 폴백, 그래도 없으면 `제육/백반/정식`이 최종 기본값. category_name이 가끔 4번째 단에 프랜차이즈 브랜드명을 그대로 붙여주는 경우가 있어(예: "…찌개,전골 > 박가부대") 앞 3단(대/중/소분류)까지만 잘라서 매칭함. 개편 이전 `overrides`에 저장된 옛 분류값은 `CUISINE_OPTIONS`에 없으면 무시하고 자동 재추정하도록 방어 코드가 있음(`mergeRecord`)
- **Claude Artifact 대응**: Artifact의 CSP가 `dapi.kakao.com` 스크립트 로드를 막기 때문에, 같은 파일이 자동으로 로드 실패를 감지(script `onerror` + 4초 타임아웃 + API 상태 체크)해서 **내장된 예시(seed) 데이터로 자동 폴백**함. 저장소에서 정상 배포된 페이지는 라이브 카카오 연동, Artifact에서는 예시 데이터 — 파일 하나로 듀얼 모드 동작
- **구내식당/한식뷔페 "오늘의 메뉴" 사진** (2026-09-17 추가, 같은 날 포스트형 패턴 확장): 많은 구내식당은 메뉴를 텍스트가 아니라 카카오톡 채널로 올리는데, 두 가지 실제 패턴이 확인됐다 — ① **프로필 사진**을 그날 메뉴로 바꾸는 곳(씽씽푸드/더소울푸드/바른식탁), ② **채널 "소식"(포스트)**에 "9월 17일 목요일 메뉴안내" 식으로 날짜 제목을 달아 매일 올리는 곳(윤스푸드, `_aKxdLs`) — 옛 날짜 포스트도 피드에 계속 쌓여있어 제목의 날짜가 오늘(KST)인 것만, 그중 가장 최근에 올라온 것만 골라야 한다. 두 패턴 모두 `pf.kakao.com/rocket-web/web/v2/profiles/{채널ID}` **하나의 API**로 처리된다(로그인 쿠키 불필요 — 직접 curl로 검증함, 개인 세션 쿠키 만료/계정 플래그 리스크 없음) — 프로필 응답의 `cards[]`에 `type:"post"` 카드가 있으면 그 안 `posts[]`를 먼저 검사해 오늘 날짜 매칭을 시도하고, 없으면 기존 프로필 사진 경로로 자동 폴백한다(`kakao-menu-proxy.worker.js`의 `parseCafeteriaProfile`/`pickTodayCafeteriaPost`). 응답의 `source: 'post'|'profile'` 필드로 프론트엔드가 두 경우를 구분해 다른 안내 문구를 보여준다 — **사용자가 어느 패턴인지 직접 지정할 필요는 없음**, 채널ID 하나만 입력하면 자동 판별된다. `kakao-menu-proxy.worker.js`의 `?cafeteriaChannel={채널ID}` 라우트로 노출되고, 식당↔채널ID 매핑은 네이버 place id와 동일하게 "정보 편집" 패널에서 수동 입력(`cafeteriaChannelId` override)한다. 프로필 사진의 `updated_at`은 사업자정보 등 카드 전체 편집 시각이라 사진 교체와 무관하게 오래된 값일 수 있음이 확인돼(사진은 당일인데 `updated_at`은 1년 전을 가리킨 사례), Worker가 `profile_image_id` 변화를 KV(`REVIEWS` 바인딩 재사용, `cafeteria-track:` 프리픽스)로 직접 추적해 신뢰도 높은 `profileUpdatedAt`을 계산한다(포스트 경로는 `published_at`이 이미 신뢰 가능해 이 추적을 건너뜀). 캐시 TTL도 경로별로 다르다 — 프로필 사진 경로 3시간, 포스트 경로 1시간(포스트가 전날 밤 올라오고 이미지가 다음날 오전에야 확정 편집되는 경우가 확인돼 더 짧게 잡음). Worker의 `scheduled()`가 매일 09:00(KST)에 `CAFETERIA_CHANNELS`(현재 `_gdqxdn`/`_NHxgEn`/`_bXxkxhb`/`_aKxdLs`) 캐시를 미리 데워두며, **Cron Trigger `0 0 * * *`는 Cloudflare 대시보드에 등록 완료됨**(2026-09-17).
- **구내식당 "오늘의 메뉴" 수동 사진 붙여넣기** (2026-09-17 추가): 인스타그램에만 올리는 식당(예: 윤쉐프, `@yoon_chef_enc2`)은 로그인 없이 자동 수집이 거의 불가능함을 직접 확인함(공개 프로필 API `web_profile_info`는 429, 공식 `oEmbed`는 앱 미승인 시 폐쇄, 로그인 없는 프로필 페이지는 빈 앱 셸만 내려옴) — 로그인 세션 쿠키로 뚫는 방법은 계정 정지/차단 위험이 너무 커서 배제하고, 대신 사람이 매일 사진 하나를 직접 붙여넣는 방식을 택함. `kakao-menu-proxy.worker.js`의 `/cafeteria/manual-upload`(POST)·`/cafeteria/manual`(GET)이 `REVIEWS` KV를 재사용해 식당당 최신 사진 1장만 저장하고(`cafeteria-manual:{placeId}` 키), 조회 시점에 저장된 날짜가 오늘(KST)이 아니면 `found:false`로 응답해 어제 사진이 오늘자처럼 잘못 보이는 걸 막음. 프론트엔드 "정보 편집" 패널에 파일 선택 없이 **Ctrl+V로 바로 붙여넣는 영역**을 추가해서, 카톡/인스타그램 화면을 캡처한 뒤 그대로 붙여넣기만 하면 리사이즈(`resizeImageFile`, 리뷰 사진 업로드와 동일 함수 재사용) 후 업로드됨. 이 수동 사진이 있으면 채널ID 기반 자동조회보다 항상 우선(`source: 'manual'`).
- 필터 없이 열어도 첫 진입 시 자동으로 추천 1건을 뽑아서 보여줌 (빈 화면 방지)

## 4. 카카오 관련 정보

- **JavaScript 키** (지도/Geocoder/Places용, 이게 필요한 키): `9394ac1268768ad4accfdf8623a92f16`
- (참고) REST API 키로 처음 받았던 값은 `5ced5c3b8cae24925d8adeceae548300` — 이건 지도 SDK에는 안 쓰임, 필요 없으면 무시
- `lunch-recommender.html` 상단 `CONFIG.KAKAO_JS_KEY`에 위 JavaScript 키가 이미 채워져 있음 (배포본 기준)
- **카카오 디벨로퍼스 콘솔 → 앱 설정 → 플랫폼 → Web**에 실제로 페이지를 서빙하는 도메인을 정확히 등록해야 함 (예: `http://localhost:포트`, `https://doxoba.github.io`). 등록 안 하면 조용히 예시 데이터 모드로 폴백되니 헷갈리지 않도록 주의 — 화면 상단 빨간 배너("예시 데이터로 표시 중") 유무로 확인

## 5. 남은 할 일 (TODO)

- [x] `doxoba/vibecoding`에 `lunch-recommender.html` 커밋 & push
- [x] `CONFIG.KAKAO_JS_KEY`에 실제 키 채워넣기
- [x] GitHub Pages 활성화
- [x] 카카오 디벨로퍼스에 GitHub Pages 도메인(`https://doxoba.github.io`) 등록 — 라이브 데이터로 확인됨(2026-09-16)
- [x] 반경 선택 기능 (100~500m, 100m 단위)
- [x] 반경을 넓혀도 카카오 45건 캡 때문에 상점이 누락되던 문제 수정 (적응형 분할 탐색)
- [x] 종류(cuisine) 8분류 재편
- [ ] 처음 뜨는 실제 식당 목록을 보면서 "주변 식당 목록·정보 편집" 패널에서 태그/추천메뉴/다른메뉴를 실제 값으로 채워넣기 (자동 추정은 카테고리명/메뉴명 기반 추측일 뿐이라 부정확할 수 있음 — 지금까지 발견된 것: 곱창/막창 매운맛 오분류는 수정됨, 비슷한 오분류가 더 있을 수 있음)
- [ ] 1호선 좌/우 자동 판정이 경계 부근 식당을 잘못 분류하면 목록에서 포함/제외 토글로 수동 보정
- [ ] 네이버지도와 대조해서 반경 내 상점이 실제로 하나도 안 빠졌는지 육안 검증 (앱 내 진단 배너·카운트만으로는 100% 보장 아님 — 이 세션은 브라우저로 네이버맵을 직접 열어 대조할 수 없어서 사용자가 직접 확인해야 함)
- [ ] (선택) `qoxopa` 계정 복구되면 동일 파일을 `qoxopa/notion`에도 반영
- [x] Cloudflare 대시보드에서 Worker(`kakao-menu-proxy`)에 Cron Trigger `0 0 * * *`(UTC 0시=KST 9시) 등록 (2026-09-17 완료)
- [ ] 씽씽푸드/더소울푸드/바른식탁/윤스푸드 외에 구내식당/한식뷔페로 분류된 식당들도 "정보 편집" 패널에서 카카오톡 채널ID를 찾아 입력해주기 (자동 매칭 불가 — 수동 입력만 지원. 프로필 사진형/포스트형 둘 다 채널ID만 넣으면 자동 판별됨)

## 6. 알려진 제약사항

- (2026-09-16 업데이트) 이번엔 `dapi.kakao.com` 아웃바운드가 막혀있지 않아서 REST API로 직접 검증할 수 있었음 — 카카오 JS 키/REST 키 모두 유효, 사무실 좌표(37.4778743, 126.8838773) 기준 실측함
- 카카오 `categorySearch`는 여전히 최대 45건 캡이 있지만, 이제 `deepCategorySearch`가 캡에 걸릴 때마다 자동으로 더 잘게 쪼개 재검색하므로 500m까지는 실측 그라운드트루스와 일치함을 확인함. 더 밀집한 지역/반경이 추가되면 `state.searchIncomplete` 플래그와 UI 경고로 드러남
- Places API가 폐업/변경 정보를 실시간 반영 안 할 수 있음 — "지도에서 보기" 링크로 최종 확인 권장
- Claude Artifact 버전은 항상 예시 데이터만 보여줌 (구조적 한계, 배포된 저장소 버전을 실사용 링크로 안내하는 게 맞음)

## 7. 참고

- 기획안 원본: `/root/.claude/plans/1-136-snazzy-shamir.md` (이 세션 한정 경로, VSCode에서는 접근 불가 — 필요하면 내용 요청)
- Artifact 링크: https://claude.ai/code/artifact/31bc9d8b-acbd-44e1-92fc-1c3a5220b6d5
- 카카오 디벨로퍼스: https://developers.kakao.com
