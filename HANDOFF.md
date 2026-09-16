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
| Claude Artifact | 발행 완료: https://claude.ai/code/artifact/31bc9d8b-acbd-44e1-92fc-1c3a5220b6d5 (카카오는 CSP로 막혀 항상 예시 데이터 모드) |
| `qoxopa/notion` 저장소 | 로컬 커밋(`f5bda65`)만 존재, **push 안 됨**. Claude의 GitHub App 접근이 막혀 있고, 사용자 본인 계정 로그인도 미확인 상태 (이메일 인증 계정 이슈로 접근 불확실) |
| `doxoba/vibecoding` 저장소 | 빈 공개 저장소 확인함(커밋 0개). **여기로 옮기기로 결정**, git 작업은 사용자가 직접 진행 |

## 3. 핵심 설계 결정 사항

- **카카오맵 JS SDK**로 런타임에 데이터를 가져옴 (좌표를 코드에 하드코딩하지 않음):
  - `kakao.maps.services.Geocoder.addressSearch()`로 사무실 주소 → 좌표 변환
  - `kakao.maps.services.Places.categorySearch('FD6', {location, radius, sort:DISTANCE})`로 사용자가 고른 반경 내 음식점 검색
  - **적응형 분할 탐색(`deepCategorySearch`)**: 카카오 Local API는 한 번의 검색(원 하나)당 최대 45건 캡이 있다. 가산디지털단지는 REST API로 직접 대조해본 결과 200m 반경만 돼도 이 캡에 걸리는 밀집 지역이라, 이전의 "고정 5점 그리드" 방식은 400m에서 44%, 500m에서 59%가 누락됐다(2026-09-16 감사 결과, `scratchpad/kakao_audit2.py` 참고 — 세션별 스크래치패드라 재현하려면 다시 작성 필요). 지금은 캡에 걸린 원을 4등분해서 다시 검색하고, 이걸 캡에 안 걸릴 때까지(또는 `CONFIG.SEARCH_MAX_DEPTH`/`SEARCH_MIN_SUBRADIUS_M` 한도까지) 재귀적으로 반복한다. 500m까지는 실측으로 그라운드트루스와 일치함을 확인했다. 그래도 한도에 걸린 채 캡이 남아있으면 `state.searchIncomplete=true`가 되어 목록 패널에 "누락 가능성" 경고가 뜬다.
  - `Places.keywordSearch('가산디지털단지역')` / `keywordSearch('독산역')`로 철길 위 두 지점을 실시간 조회 → 외적(cross product) 부호로 사무실과 같은 쪽에 있는 식당만 필터링 (좌표 하드코딩 없이 자동 계산)
- **경계 오차 안전장치**: 식당별로 수동 포함/제외 토글 제공 (자동 판정이 틀렸을 때 직접 보정 가능), `localStorage`에 저장돼 재검색해도 유지됨
- **메뉴 데이터 문제**: 카카오 API는 메뉴 정보를 안 줌 → 카테고리명 키워드 기반 자동 추정(`TAG_RULES`, ~20개 규칙) + 사용자가 직접 편집하는 UI 제공, `localStorage`에 영구 저장 (식당 id 기준 병합이라 재검색해도 편집 내용 안 사라짐)
- **Claude Artifact 대응**: Artifact의 CSP가 `dapi.kakao.com` 스크립트 로드를 막기 때문에, 같은 파일이 자동으로 로드 실패를 감지(script `onerror` + 4초 타임아웃 + API 상태 체크)해서 **내장된 예시(seed) 데이터로 자동 폴백**함. 저장소에서 정상 배포된 페이지는 라이브 카카오 연동, Artifact에서는 예시 데이터 — 파일 하나로 듀얼 모드 동작
- 필터 없이 열어도 첫 진입 시 자동으로 추천 1건을 뽑아서 보여줌 (빈 화면 방지)

## 4. 카카오 관련 정보

- **JavaScript 키** (지도/Geocoder/Places용, 이게 필요한 키): `9394ac1268768ad4accfdf8623a92f16`
- (참고) REST API 키로 처음 받았던 값은 `5ced5c3b8cae24925d8adeceae548300` — 이건 지도 SDK에는 안 쓰임, 필요 없으면 무시
- `lunch-recommender.html` 상단 `CONFIG.KAKAO_JS_KEY`에 위 JavaScript 키를 채워 넣어야 라이브 연동 동작 (현재 보내드린 파일은 플레이스홀더 `'YOUR_KAKAO_JAVASCRIPT_KEY'` 상태)
- **카카오 디벨로퍼스 콘솔 → 앱 설정 → 플랫폼 → Web**에 실제로 페이지를 서빙하는 도메인을 정확히 등록해야 함 (예: `http://localhost:포트`, `https://doxoba.github.io`). 등록 안 하면 조용히 예시 데이터 모드로 폴백되니 헷갈리지 않도록 주의 — 화면 상단 빨간 배너("예시 데이터로 표시 중") 유무로 확인

## 5. 남은 할 일 (TODO)

- [ ] `doxoba/vibecoding`에 `lunch-recommender.html` 커밋 & push (git은 사용자 직접 진행하기로 함)
- [ ] `CONFIG.KAKAO_JS_KEY`에 실제 키 채워넣기
- [ ] GitHub Pages 활성화 (Settings → Pages → Deploy from branch → main → / root)
- [ ] 카카오 디벨로퍼스에 GitHub Pages 도메인(`https://doxoba.github.io`) + 로컬 테스트용 도메인 등록
- [ ] 실제 배포 후 브라우저에서 열어 라이브 데이터 확인 (빨간 배너 없이 지도/식당 목록이 뜨는지)
- [ ] 처음 뜨는 실제 식당 목록을 보면서 "주변 식당 목록·정보 편집" 패널에서 태그/추천메뉴/다른메뉴를 실제 값으로 채워넣기 (자동 추정은 카테고리명 기반 추측일 뿐이라 부정확할 수 있음)
- [ ] 1호선 좌/우 자동 판정이 경계 부근 식당을 잘못 분류하면 목록에서 포함/제외 토글로 수동 보정
- [ ] (선택) `qoxopa` 계정 복구되면 동일 파일을 `qoxopa/notion`에도 반영

## 6. 알려진 제약사항

- (2026-09-16 업데이트) 이번엔 `dapi.kakao.com` 아웃바운드가 막혀있지 않아서 REST API로 직접 검증할 수 있었음 — 카카오 JS 키/REST 키 모두 유효, 사무실 좌표(37.4778743, 126.8838773) 기준 실측함
- 카카오 `categorySearch`는 여전히 최대 45건 캡이 있지만, 이제 `deepCategorySearch`가 캡에 걸릴 때마다 자동으로 더 잘게 쪼개 재검색하므로 500m까지는 실측 그라운드트루스와 일치함을 확인함. 더 밀집한 지역/반경이 추가되면 `state.searchIncomplete` 플래그와 UI 경고로 드러남
- Places API가 폐업/변경 정보를 실시간 반영 안 할 수 있음 — "지도에서 보기" 링크로 최종 확인 권장
- Claude Artifact 버전은 항상 예시 데이터만 보여줌 (구조적 한계, 배포된 저장소 버전을 실사용 링크로 안내하는 게 맞음)

## 7. 참고

- 기획안 원본: `/root/.claude/plans/1-136-snazzy-shamir.md` (이 세션 한정 경로, VSCode에서는 접근 불가 — 필요하면 내용 요청)
- Artifact 링크: https://claude.ai/code/artifact/31bc9d8b-acbd-44e1-92fc-1c3a5220b6d5
- 카카오 디벨로퍼스: https://developers.kakao.com
