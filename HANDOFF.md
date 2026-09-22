# 점심 메뉴 추천기 — 작업 이어가기 (Handoff)

VSCode Claude에서 이 프로젝트를 이어서 작업할 때 참고할 문서. 이 파일을 새 저장소(`doxoba/vibecoding`) 루트에 같이 넣어두면 다음에 열었을 때 맥락을 바로 파악할 수 있음.

---

## 1. 프로젝트 목적

매일 점심 메뉴 고르기가 어려워서 만드는 도구. 조건:

- 기준 주소: **서울 금천구 가산디지털1로 136**
- 반경 **100m 단위로 100~500m 중 선택** (기본값 300m, 화면 상단 "반경" 칩에서 바꾸면 즉시 재검색됨, `localStorage`에 저장)
- **1호선 철길 왼쪽(서쪽)** 구역만 후보
- 조건(형태/종류)을 **멀티셀렉트로 선택 가능하되 필수는 아님** (예: 면 선택 → 짬뽕집, 라멘집 등). **맛(매운맛/순한맛/보통) 필터는 2026-09-18에 제거함** — 사람마다 "매운맛" 기준이 달라 필터로서 의미가 없다는 피드백에 따름
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
- **경계 오차 안전장치**: 식당별로 수동 포함/제외 토글 제공 (자동 판정이 틀렸을 때 직접 보정 가능). 아래 "가게별 공유 편집 상태" 참고 — Cloudflare KV에 공유 저장돼 모든 사용자·기기에 반영됨
- **메뉴 데이터 문제**: 카카오 API는 메뉴 정보를 안 줌 → 카테고리명/메뉴명 키워드 기반 자동 추정(`TAG_RULES`, 30여 개 규칙) + 사용자가 직접 편집하는 UI 제공. 아래 "가게별 공유 편집 상태" 참고 — Cloudflare KV에 공유 저장(식당 id 기준 병합이라 재검색해도 편집 내용 안 사라짐). `TAG_RULES`처럼 메뉴 판정 로직 자체를 바꿀 땐 `TAG_RULES_VERSION`을 올려서 이미 캐싱된(24시간 TTL) 메뉴가 옛 판정 그대로 재사용되지 않고 자동으로 재조회·재태깅되게 해야 함. (과거엔 형태와 함께 "맛"도 자동 추정했으나 2026-09-18에 맛 필터 자체를 제거함 — 아래 참고)
- **Worker 엣지 캐시는 colo(거점)별로 따로 캐싱됨 — 버전 안 올리고 응답 모양만 바꾸면 배포해도 안 고쳐진 것처럼 보임** (2026-09-22 발견·수정): 식당 대표 사진(`representativePhotoUrl`/클라이언트의 `menuPhotoUrl`) 기능을 넣었는데, 카카오맵엔 실제로 사진이 있는 식당(한려수도 등)인데도 앱에는 색블록 타일만 뜨는 문제가 보고됨. Playwright로 실배포 사이트를 직접 떠서 같은 placeId를 반복 조회해보니, 같은 식당인데 요청이 어느 Cloudflare colo(엣지 거점)에 도착하느냐에 따라 `representativePhotoUrl` 필드가 있다/없다가 갈렸다 — Cache API(`caches.default`)가 이 필드를 추가하기 전 옛 코드로 이미 캐싱해둔 colo가 아직 남아있어서(최대 24시간), 그 colo가 응답하면 새 필드가 없는 옛 응답을 그대로 돌려준 것. 네이버 라우트는 이미 `NAVER_MENU_SCHEMA_VERSION`으로 이 문제를 막고 있었는데 카카오(panel3) 라우트엔 그 패턴이 없었던 게 원인 — 카카오 라우트에도 같은 패턴(`KAKAO_MENU_SCHEMA_VERSION`, 캐시 키에만 붙이고 카카오로 나가는 실제 요청 URL엔 영향 없음)을 추가해서 옛 colo 캐시를 자동 무효화시킴. 이미 `photoUrl:null`로 캐싱해버린 사용자 브라우저(`localStorage`, 최대 24시간)까지 즉시 고치려고 클라이언트 `TAG_RULES_VERSION`도 v3→v4로 같이 올림. **교훈**: Worker 응답의 "모양"(새 필드 추가 포함)이 바뀌는 배포를 할 땐, 캐시가 걸린 라우트마다 스키마 버전 상수를 같이 올리는 걸 체크리스트로 삼을 것 — 응답 값 자체를 바꾸는 로직 변경뿐 아니라 필드 추가도 캐시 무효화 대상임.
- **가게별 공유 편집 상태(자동/포함/제외, 종류, 실제 메뉴, 네이버 place id, 카카오톡 채널ID, 구내식당 수동/주간 사진 등록 여부)** (원래 manualOverride만 공유하다가 2026-09-21에 확장): "정보 편집"에서 애써 입력한 실제 메뉴/채널ID를 다른 사람은 못 보고 매번 다시 입력해야 하는 문제가 있어, manualOverride와 같은 원칙(로그인 없음 → 작성자 구분 없이 누구나 덮어씀)으로 나머지 편집 필드도 `kakao-menu-proxy.worker.js`의 `/overrides`(GET)·`/overrides/set`(POST, `{placeId, patch:{...}}`)를 통해 `REVIEWS` KV에 공유 저장하도록 확장했다(`override:{placeId}` 키, 필드별 병합 — `OVERRIDE_SHARED_FIELDS` 참고, patch에 필드를 `null`로 보내면 그 필드만 삭제되고 레코드가 완전히 비면 키 자체를 지움). 프론트엔드는 `state.sharedOverrides`에 담아 `mergeRecord`가 필드 단위로 로컬 `overrides`(localStorage)보다 우선하고(공유 저장소가 그 필드를 아직 모를 때만 로컬 값으로 폴백 — `pickField`), `saveSharedOverridePatch()`가 저장 지점마다(자동/포함/제외 토글, "저장" 버튼, 네이버/채널ID 저장, 구내식당 사진 등록, "편집 내용 초기화") 서버에도 반영한다. 2026-09-21 이전부터 로컬에만 있던 편집분은 `migrateLocalOverridesToShared()`가 최초 접속 시(기기당 1회, 실패하면 다음 접속에서 재시도) 공유 저장소로 자동 업로드한다. `localStorage`는 오프라인 폴백/이전 버전 호환용으로 계속 같이 씀.
- **종류(cuisine) 8분류**: 처음엔 한식/중식/일식/양식/카페-디저트/기타였는데, 실제 점심 고를 때 궁금한 건 "국밥집인지 백반집인지 구내식당인지"라 국가 기준 분류가 안 맞는다는 피드백을 받아 재편함(2026-09-16, 사용자가 8개 카테고리와 대표 메뉴 예시를 직접 정의): **구내식당/한식뷔페 · 국밥/탕/찌개 · 제육/백반/정식 · 중식 · 면류/분식 · 돈까스/일식/양식 · 아시안/세계요리 · 간편식/식단관리**. 카카오 category_name 기반 규칙(`CUISINE_CATEGORY_KEYWORDS`)이 최우선, 못 찾으면 메뉴명 키워드(`TAG_RULES.cuisine`) 폴백, 그래도 없으면 `제육/백반/정식`이 최종 기본값. category_name이 가끔 4번째 단에 프랜차이즈 브랜드명을 그대로 붙여주는 경우가 있어(예: "…찌개,전골 > 박가부대") 앞 3단(대/중/소분류)까지만 잘라서 매칭함. 개편 이전 `overrides`에 저장된 옛 분류값은 `CUISINE_OPTIONS`에 없으면 무시하고 자동 재추정하도록 방어 코드가 있음(`mergeRecord`)
- **Claude Artifact 대응**: Artifact의 CSP가 `dapi.kakao.com` 스크립트 로드를 막기 때문에, 같은 파일이 자동으로 로드 실패를 감지(script `onerror` + 4초 타임아웃 + API 상태 체크)해서 **내장된 예시(seed) 데이터로 자동 폴백**함. 저장소에서 정상 배포된 페이지는 라이브 카카오 연동, Artifact에서는 예시 데이터 — 파일 하나로 듀얼 모드 동작
- **구내식당/한식뷔페 "오늘의 메뉴" 사진** (2026-09-17 추가, 같은 날 포스트형 패턴 확장, 2026-09-21 키워드 점수 폴백 + 별도 posts API 폴백 추가): 많은 구내식당은 메뉴를 텍스트가 아니라 카카오톡 채널로 올리는데, 세 가지 실제 패턴이 확인됐다 — ① **프로필 사진**을 그날 메뉴로 바꾸는 곳(씽씽푸드/더소울푸드/바른식탁), ② **채널 "소식"(포스트)**에 "9월 17일 목요일 메뉴안내" 식으로 날짜 제목을 달아 매일 올리는 곳(윤스푸드, `_aKxdLs`) — 옛 날짜 포스트도 피드에 계속 쌓여있어 제목의 날짜가 오늘(KST)인 것만, 그중 가장 최근에 올라온 것만 골라야 한다, ③ **"소식" 최상단이 메뉴 사진이 아니거나 날짜 표기가 "9.21(월)"처럼 다른 포맷인 곳**(굿푸드가산, `_tNIgn` — 실측 결과 "오늘의 샐러드"가 "오늘의 메뉴 9.21(월)"보다 나중에 올라와 피드 맨 위에 뜸, 게다가 프로필 응답의 `cards[]`에 `type:"post"` 카드 자체가 없음). 프로필 API(`pf.kakao.com/rocket-web/web/v2/profiles/{채널ID}`)의 `cards[]`에 `post` 카드가 있으면 그 안 `posts[]`를 쓰고, 없으면 별도 posts API(`pf.kakao.com/rocket-web/web/profiles/{채널ID}/posts?includePinnedPost=true`, 이것도 로그인 쿠키 불필요 — 직접 curl로 검증함)로 목록을 가져온다(`fetchCafeteriaPostsList`). 이 posts 목록에 대해 먼저 제목의 정확한 "N월 N일" 날짜가 오늘과 일치하는 것을 찾고(`pickTodayCafeteriaPost`), 없으면 제목에 '오늘'/'메뉴'/날짜 숫자가 가장 많이 포함된 것을 점수로 골라 폴백한다(`pickCafeteriaPostByKeywordScore` — "오늘의 메뉴 9.21(월)"은 오늘+메뉴+숫자묶음2개=4점, "오늘의 샐러드"는 1점이라 자연히 밀림, 최근 3일 이내 글만 후보로 삼음), 그마저 없으면 기존 프로필 사진 경로로 자동 폴백한다(`parseCafeteriaProfile`). 응답의 `source: 'post'|'post-guess'|'profile'` 필드로 프론트엔드가 세 경우를 구분해 다른 안내 문구를 보여준다(`'post'`는 날짜 정확 일치 확인됨 ✅, `'post-guess'`는 키워드 점수 추정 🔎) — **사용자가 어느 패턴인지 직접 지정할 필요는 없음**, 채널ID 하나만 입력하면 자동 판별된다. `kakao-menu-proxy.worker.js`의 `?cafeteriaChannel={채널ID}` 라우트로 노출되고, 식당↔채널ID 매핑은 네이버 place id와 동일하게 "정보 편집" 패널에서 수동 입력(`cafeteriaChannelId` override)한다. 프로필 사진의 `updated_at`은 사업자정보 등 카드 전체 편집 시각이라 사진 교체와 무관하게 오래된 값일 수 있음이 확인돼(사진은 당일인데 `updated_at`은 1년 전을 가리킨 사례), Worker가 `profile_image_id` 변화를 KV(`REVIEWS` 바인딩 재사용, `cafeteria-track:` 프리픽스)로 직접 추적해 신뢰도 높은 `profileUpdatedAt`을 계산한다(포스트 경로인 `'post'`/`'post-guess'`는 `published_at`이 이미 신뢰 가능해 이 추적을 건너뜀 — `isCafeteriaPostSource` 참고). 캐시 TTL도 경로별로 다르다 — 프로필 사진 경로 3시간, 포스트 경로(`'post'`/`'post-guess'` 둘 다) 1시간(포스트가 전날 밤 올라오고 이미지가 다음날 오전에야 확정 편집되는 경우가 확인돼 더 짧게 잡음). Worker의 `scheduled()`가 매일 09:00(KST)에 `CAFETERIA_CHANNELS`(현재 `_gdqxdn`/`_NHxgEn`/`_bXxkxhb`/`_aKxdLs`) 캐시를 미리 데워두며, **Cron Trigger `0 0 * * *`는 Cloudflare 대시보드에 등록 완료됨**(2026-09-17).
- **구내식당 "오늘의 메뉴" 수동 사진 붙여넣기** (2026-09-17 추가): 인스타그램에만 올리는 식당(예: 윤쉐프, `@yoon_chef_enc2`)은 로그인 없이 자동 수집이 거의 불가능함을 직접 확인함(공개 프로필 API `web_profile_info`는 429, 공식 `oEmbed`는 앱 미승인 시 폐쇄, 로그인 없는 프로필 페이지는 빈 앱 셸만 내려옴) — 로그인 세션 쿠키로 뚫는 방법은 계정 정지/차단 위험이 너무 커서 배제하고, 대신 사람이 매일 사진 하나를 직접 붙여넣는 방식을 택함. `kakao-menu-proxy.worker.js`의 `/cafeteria/manual-upload`(POST)·`/cafeteria/manual`(GET)이 `REVIEWS` KV를 재사용해 식당당 최신 사진 1장만 저장하고(`cafeteria-manual:{placeId}` 키), 조회 시점에 저장된 날짜가 오늘(KST)이 아니면 `found:false`로 응답해 어제 사진이 오늘자처럼 잘못 보이는 걸 막음. 프론트엔드 "정보 편집" 패널에 파일 선택 없이 **Ctrl+V로 바로 붙여넣는 영역**을 추가해서, 카톡/인스타그램 화면을 캡처한 뒤 그대로 붙여넣기만 하면 리사이즈(`resizeImageFile`, 리뷰 사진 업로드와 동일 함수 재사용) 후 업로드됨. 이 수동 사진이 있으면 채널ID 기반 자동조회보다 항상 우선(`source: 'manual'`).
- **구내식당 "오늘의 메뉴" 주간 식단표(요일별 5칸)** (2026-09-17 추가): 인스타그램에만 올리는 식당이 2곳으로 늘었는데, 둘 다 하루 한 장이 아니라 월~금 메뉴가 한 장에 다 들어있는 "주간 식단표"를 올리는 걸 확인함. AI 비전으로 자동 5분할하는 방법과 사람이 요일별로 미리 잘라 5칸에 나눠 붙여넣는 방법을 놓고 사용자에게 물어본 결과 **후자(수동 5칸)로 결정** — 새 유료 API 키/Worker 시크릿이 필요 없고 OCR 오인식으로 팀원들에게 잘못된 메뉴가 뜰 위험이 없어서. `kakao-menu-proxy.worker.js`의 `/cafeteria/weekly-upload`(POST, `{placeId, weekday, photo}`)·`/cafeteria/weekly`(GET)가 `REVIEWS` KV에 요일별 독립 키(`cafeteria-weekly:{placeId}:{mon|tue|wed|thu|fri}`)로 저장하고, 업로드 시점의 "그 주 월요일 날짜"(`weekOf`, `getKstMondayDateString()`)가 조회 시점의 이번 주 월요일과 정확히 일치할 때만 유효로 취급한다(지난주 걸 이번 주로 착각해서 보여주는 사고 방지 — 하루짜리 수동사진과 동일한 철학을 주 단위로 확장). 프론트엔드 "정보 편집" 패널에 기존 "오늘의 메뉴 사진" 아래 요일별 5칸(월~금) paste zone을 추가로 뒀다(토글 아니고 항상 같이 노출 — 식당 유형에 맞는 쪽을 쓰면 됨). 우선순위는 "오늘 콕 집어 올린 사진(`cafeteriaManualEnabled`) > 주간 식단표 오늘 요일 칸(`cafeteriaWeeklyEnabled`) > 카카오톡 채널 자동조회" 3단(`enrichMenus`의 `cafeteriaTask`). 사용자가 "월요일은 업데이트 다소 늦어도 됨"이라고 했는데, `weekOf`가 날짜만 비교하고 시각은 안 보므로 별도 유예 로직 없이 이미 충족됨(월요일 몇 시에 붙여넣든 그 즉시 유효해짐).
- 필터 없이 열어도 첫 진입 시 자동으로 추천 1건을 뽑아서 보여줌 (빈 화면 방지)
- **메뉴 검색** (2026-09-22 추가): "가산디지털단지 7번출구 알밥"처럼 포털에 검색하는 대신, 이미 반경 내에서 로드해둔 `state.restaurants[].menuItems[].name`(실제 카카오/네이버 메뉴) + 상호명을 대상으로 바로 검색하는 기능. 새 API/Worker 엔드포인트는 필요 없었음(메뉴 데이터가 이미 `enrichAndRefresh`로 다 로드돼 있음). 두 가지 설계 고민에 사용자가 직접 답함(2026-09-22): ① **검색 범위**는 현재 선택된 반경 칩만큼만 찾고, 결과 0건이면 "500m까지 넓혀서 다시 찾기" 버튼을 보여줌(반경 칩 클릭과 동일한 `setRadiusM()`을 공유) — 검색 때문에 매번 최대 반경까지 미리 다 가져오면 카카오/네이버 메뉴 프록시 호출이 항상 늘어나므로. ② **필터와의 관계**는 검색 중엔 형태/종류/목록 카테고리 필터를 전부 무시하고 반경 내 전체에서 찾음 — 필터가 켜진 채로 검색하면 정작 찾는 가게가 필터에 가려 안 보이는 걸 방지. `TAG_RULES`에 없는 구체적 메뉴명(예: "알밥")은 실메뉴를 성공적으로 가져온 식당만 매칭되는 게 자연스러운 한계로 남음(추정 폴백 메뉴는 일반 명사라 우연히 겹치지 않는 한 안 걸림) — README "메뉴 검색"/"알려진 제한사항" 6번 참고. 구현 중 기존 버그 하나를 같이 고침: `updateLoadingUi()`는 로딩 시작 때만 버튼들을 비활성화하고 로딩이 끝나면 `renderAll()`이 개별적으로 재활성화하는 구조였는데, 검색창(`menuSearchInput`)의 재활성화 코드가 `renderAll()`에 없어서 원래대로라면 첫 로딩 이후 검색창이 계속 비활성 상태로 남을 뻔했음 — `renderAll()`의 기존 재활성화 목록(`rerollBtn`/`skipRestaurantBtn`/`researchBtn`)에 같이 추가함.

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
- [ ] 처음 뜨는 실제 식당 목록을 보면서 "주변 식당 목록·정보 편집" 패널에서 태그/추천메뉴/다른메뉴를 실제 값으로 채워넣기 (자동 추정은 카테고리명/메뉴명 기반 추측일 뿐이라 부정확할 수 있음)
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
