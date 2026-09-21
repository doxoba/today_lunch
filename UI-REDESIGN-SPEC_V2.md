# 점심 메뉴 추천기 — UI/UX 리디자인 스펙

Claude Code에게 이 파일을 주고 `lunch-recommender.html`을 리디자인하도록 요청하기 위한 문서.
대상 파일: `lunch-recommender.html` (단일 HTML, 외부 빌드 없음)

> **작업 원칙**: 추천 로직(카카오 SDK 연동, 필터링, 랜덤 선택, localStorage 오버라이드)은 **한 줄도 건드리지 않는다**. `<style>` 블록과 `<body>` 마크업만 교체하고, JS는 아래 §8의 셀렉터 목록대로 id만 유지되면 그대로 동작한다.
>
> 함께 읽을 문서: `HANDOFF.md` (프로젝트 배경, 카카오 키, 남은 TODO)

---

## 1. 컨셉 요약

- **이름/톤**: "오늘 뭐 먹지 고민 끝" — 장난스럽고 가벼운 카피, 하지만 UI는 정돈된 프로덕트 톤.
- **기기**: 데스크톱 우선 (1180px 기준 3단 레이아웃), 1024px 미만에서 세로 스택으로 반응형.
- **핵심 구조**: 조건 선택 · 추천 결과 · 지도를 **한 화면에 나란히** 배치. 스크롤 없이 한눈에.
- **"다시 뽑기"**: 보조 기능. 결과 카드 하단에 작은 아웃라인 버튼.

---

## 2. 디자인 토큰

```css
:root {
  /* Color — 딥 틸 on 화이트 */
  --bg:            #ffffff;
  --surface:       #fbfbfc;   /* 카드/패널 배경 */
  --border:        #e6e6ea;   /* 기본 테두리 */
  --border-soft:   #eef0f1;   /* 패널 테두리 */
  --accent:        #1f8a70;   /* 딥 틸 — 주요 액션, 선택 상태 */
  --accent-dark:   #136a53;   /* 액센트 위 텍스트, hover */
  --accent-tint:   #e0f2ec;   /* 추천메뉴 배지 배경 */
  --text:          #161826;   /* 제목 */
  --text-body:     #4a4d59;   /* 본문 */
  --text-muted:    #8a8d9a;   /* 보조 설명 */
  --text-faint:    #9a9da8;   /* 라벨, 비활성 */

  /* Radius */
  --r-sm: 8px;   /* 버튼, 소형 요소 */
  --r-md: 10px;  /* CTA, 배지, 지도 */
  --r-lg: 12px;  /* 패널 */
  --r-xl: 14px;  /* 최외곽 컨테이너 */
  --r-pill: 999px; /* 조건 칩 */

  /* Shadow */
  --shadow-page: 0 0 0 1px #e6e6ea, 0 8px 32px rgba(20,30,28,0.06);
  --ring-accent: 0 0 0 2px var(--accent); /* 결과 카드 강조 */
}
```

**금지**: 그라디언트 배경(지도 영역의 미세한 radial 제외), 순수 검정, 액센트 대면적 채우기, 이모지.

---

## 3. 타이포그래피 — Pretendard

`<head>`에 추가:

```html
<link rel="stylesheet" as="style" crossorigin
  href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css">
```

```css
body { font-family: Pretendard, -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
```

| 역할 | 크기 / 굵기 / 색 |
| --- | --- |
| 페이지 타이틀 | 26px / 600 / `--text` |
| 페이지 서브 | 13px / 400 / `--text-muted` |
| 섹션 라벨 (조건, 지도) | 12px / 600 / `--text-muted` / `letter-spacing:.04em` / uppercase |
| 그룹 라벨 (형태, 맛, 종류) | 11px / 500 / `--text-faint` |
| 키커 ("추천메뉴") | 10px / 700 / `--accent` / `letter-spacing:.08em` / uppercase |
| 식당명 (결과) | 30px / 600 / `--text` |
| 식당 메타 | 12px / 400 / `--text-muted` |
| 추천메뉴 배지 | 16px / 600 / `--accent-dark` |
| 다른메뉴 리스트 | 13px / 400 / line-height 1.7 / `--text-body` |
| 버튼 | 12–14px / 500–600 |
| 칩 | 13px / 400(비활성) · 500(활성) |

---

## 4. 레이아웃

```
┌─ 컨테이너 (max-width 1180px, padding 32px, radius 14px, --shadow-page) ─┐
│  헤더:  좌 [타이틀 + 서브]              우 [🚈 1호선 서쪽 구역 pill]      │
│                                                                        │
│  ┌── grid-template-columns: 1fr 1.3fr 1fr; gap: 20px ──────────────┐   │
│  │  [조건 패널]      │  [결과 카드]        │  [지도 패널]           │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  [주변 식당 목록 · 정보 편집  ▾]   ← 접힘 상태 아코디언 (전체폭)         │
└────────────────────────────────────────────────────────────────────────┘
```

**반응형**: `@media (max-width: 1023px)` → `grid-template-columns: 1fr`, 순서는 조건 → 결과 → 지도. 지도 패널 `min-height: 260px` 유지.

### 4.1 헤더
- 타이틀: "오늘 뭐 먹지 고민 끝"
- 서브: "가산디지털1로 136 기준 반경 250m · 1호선 철길 서쪽만 추천해요"
- 우측 pill: 테두리 `--border`, radius pill, padding `6px 12px`, 12px `--text-muted`, 앞에 기차 아이콘.

### 4.2 조건 패널 (좌)
- 배경 `--surface`, 테두리 `--border-soft`, radius `--r-lg`, padding 20px, `flex-column; gap:16px`.
- 섹션 라벨 "조건" → 그룹 3개:
  - **형태**: 면 / 밥 / 국물 / 구이 / 튀김 / 분식 / 기타
  - **맛**: 매운맛 / 순한맛 / 보통
  - **종류**: 한식 / 중식 / 일식 / 양식 / 카페-디저트 / 기타
- 칩은 **멀티 셀렉트, 전부 선택사항**. 아무것도 안 고르면 전체 후보 대상.
- 칩 스타일:
  - 비활성: `background:#fff; color:var(--text-body); border:1px solid var(--border); padding:7px 14px; border-radius:var(--r-pill);`
  - 활성: `background:var(--accent); color:#fff; border-color:var(--accent); font-weight:500;`
  - hover(비활성): `border-color:var(--accent); color:var(--accent);`
- 하단: "조건 초기화" 텍스트 링크(11px, `--text-faint`, underline) → 그 아래 `margin-top:auto`로 밀어낸 CTA.
- **CTA**: 전체폭, padding 13px, radius `--r-md`, `background:var(--accent); color:#fff; font:600 14px`. 라벨 "오늘 뭐 먹지?". hover → `--accent-dark`.

### 4.3 결과 카드 (중앙, 주인공)
- 배경 `--surface`, radius `--r-lg`, padding 28px, `box-shadow: var(--ring-accent)` — 유일하게 액센트 링을 가진 요소.
- 순서: 키커 "추천메뉴" → 식당명 → 메타(`중식 · 면요리 · 90m · 도보 약 2분`) → 추천메뉴 배지 → "다른메뉴" 라벨 + `<ul>` → 버튼 3개.
- 배지: `background:var(--accent-tint); color:var(--accent-dark); padding:9px 16px; radius:var(--r-md);`
- 버튼 행 (`display:flex; gap:8px`):
  1. **다시 뽑기** — 아웃라인 액센트 (`border:1px solid var(--accent); color:var(--accent); background:transparent`)
  2. **길찾기** — 중립 아웃라인 (`border:1px solid var(--border); color:var(--text-body)`)
  3. **지도에서 보기** — 중립 아웃라인
- 빈 상태(첫 진입): 카드 자리에 같은 크기 유지 + 중앙 정렬로 "조건을 고르고 버튼을 눌러보세요" (`--text-muted`, 14px). 링은 미표시(`box-shadow: 0 0 0 1px var(--border-soft)`).

### 4.4 지도 패널 (우)
- 배경 `--surface`, 테두리 `--border-soft`, radius `--r-lg`, padding 16px.
- 섹션 라벨 "지도" → 지도 컨테이너: `flex:1; min-height:220px; radius:var(--r-md); background:#f4f6f5`.
- 선택된 식당 마커는 액센트 핀 + 250m 반경 원 (`1.5px dashed rgba(31,138,112,.35)`).
- 추천 결과가 바뀌면 해당 마커로 pan + 강조 (다른 마커는 중립 회색 핀, 선택된 것만 액센트 + 살짝 확대).

### 4.5 하단 아코디언
- 전체폭, `padding:14px 16px`, 테두리 `--border-soft`, radius `--r-md`.
- 좌: "주변 식당 목록 · 정보 편집" (13px/600), 우: caret 아이콘. 클릭 시 펼침.
- 펼친 내용: 식당 리스트 테이블 (이름 / 분류 / 거리 / 대표메뉴 / 편집).

---

## 5. 상태 & 인터랙션

| 요소 | 상태 규칙 |
| --- | --- |
| 칩 | default / hover(액센트 테두리) / selected(액센트 채움) / focus-visible(`outline:2px solid var(--accent); outline-offset:2px`) |
| CTA | hover `--accent-dark`, active 살짝 눌림(`transform:translateY(1px)`) |
| 아웃라인 버튼 | hover `background:var(--accent-tint)` (액센트형) / `background:#f4f5f6` (중립형) |
| 결과 카드 갱신 | 150ms fade-in + 4px 상승. 새 결과가 나올 때만. |
| 지도 마커 | 결과 갱신 시 마커 강조 애니메이션 (scale 1 → 1.15 → 1) |

**모든 인터랙티브 요소에 `:focus-visible` 액센트 링 필수.** 브라우저 기본 파란 포커스 금지.
`a`, `a:hover` 색상은 `--accent` / `--accent-dark`로 명시.

---

## 6. 아이콘

Phosphor Icons 사용:

```html
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css">
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css">
```

- 헤더 pill: `ph-train`
- 다시 뽑기: `ph-shuffle`
- 길찾기: `ph-navigation-arrow`
- 지도 핀: `ph-fill ph-map-pin`
- 아코디언: `ph-caret-down`

---

## 7. 카카오 데이터 표시 (이미 연동돼 있음 — 표시 자리 확보)

카카오 Places SDK는 이미 붙어 있다(`fetchLiveRestaurants`). 다만 **별점·리뷰 요약은 Places API가 주지 않으므로** 지금은 자리만 만들고 값이 없으면 숨긴다. 결과 카드가 다루는 데이터 형태:

```js
// 결과 카드가 렌더링할 최종 형태
{
  name: '매운짬뽕 전문점',
  category: '중식',
  type: '면요리',
  distance: 90,           // m — 카카오 좌표로 계산
  walkMinutes: 2,         // 도보 시간
  recommendedMenu: '불짬뽕',
  otherMenus: ['짜장면', '탕수육', '군만두'],
  kakao: {
    placeId: '...',       // Places 결과 id — 있음
    placeUrl: '...',      // "지도에서 보기" 링크 — 있음
    rating: null,         // 별점 — Places API 미제공, 추후 확보 시 표시
    reviewSummary: null,  // 리뷰 요약 — 미제공, 추후
    directionsUrl: '...'  // 길찾기 — placeId로 생성 가능
  },
  coords: { lat: null, lng: null }
}
```

- **별점**: 식당명 우측 인라인, 13px, `--text-body`, 채운 별은 `--accent`.
- **리뷰 요약**: 결과 카드 하단, 12px/1.6 `--text-muted`, `-webkit-line-clamp:2`.
- **도보 시간**: 메타 줄에 이미 자리 있음 (`· 도보 약 2분`).
- **길찾기**: `resultDirectionsLink`가 `hidden`으로 토글됨 — 숨김 시 버튼 행이 2개로 자연스럽게 줄어들도록 flex로 구성.
- **값이 없는 필드는 렌더하지 않는다** (빈 별점 자리, 빈 리뷰 박스 금지).

---

## 8. JS가 잡는 DOM — id 전부 유지 필수

리디자인 시 아래 id는 **이름·개수 그대로** 유지한다. 태그·클래스·위치는 바꿔도 되지만 id가 사라지면 JS가 깨진다.

| id | 새 레이아웃에서의 위치 | 비고 |
| --- | --- | --- |
| `fallbackBanner` / `retryLiveBtn` | 컨테이너 최상단, 헤더 위 전체폭 | 예시 데이터 모드 경고 배너. 경고 톤: `background:#fff4f2; border:1px solid #f3c7bd; color:#8a3520;` radius `--r-md`, 12px |
| `chips-type` / `chips-taste` / `chips-cuisine` | 조건 패널 §4.2의 3개 그룹 컨테이너 | JS가 안에 칩 버튼을 생성 → **칩 스타일은 클래스 기반**으로 작성 (`renderChipGroup`이 붙이는 클래스 확인 후 그 클래스에 §4.2 스타일 적용) |
| `resetFilters` | 조건 패널 하단 텍스트 링크 | |
| `recommendBtn` | 조건 패널 CTA | |
| `ctaHelp` | CTA 바로 아래 | 11px `--text-faint` |
| `resultCard` | 중앙 결과 카드 (§4.3) | `hidden` 속성으로 토글됨 → 빈 상태 UI는 형제 요소로 따로 두고 반대로 토글 |
| `resultName` / `resultMeta` / `resultSignature` / `resultOther` | 결과 카드 내부 | 각각 식당명 / 메타 / 추천메뉴 배지 / 다른메뉴 `<ul>` |
| `rerollBtn` / `resultDirectionsLink` / `resultMapLink` | 결과 카드 버튼 행 | 뒤 둘은 `<a>` — 버튼처럼 보이게 스타일 |
| `mapCard` / `map` | 지도 패널 (§4.4) | `#map`은 카카오 지도가 렌더 → 고정 높이 필요 (`min-height:220px`, 반응형 시 260px) |
| `listBody` | 하단 아코디언 펼침 영역 | 식당 목록 + 편집 폼을 JS가 생성 |
| `researchBtn` / `lastSearchAt` | 아코디언 하단 푸터 | "재검색" 버튼 + 마지막 검색 시각 |

**주의**: `buildRow` / `buildEditForm`이 만드는 목록·편집 폼 마크업은 JS 안에 문자열로 들어 있다. 이 부분은 클래스명을 유지한 채 **CSS만 새 토큰으로 다시 쓰는 것**이 안전하다. JS 내 마크업을 바꿔야 한다면 클래스명과 이벤트 바인딩을 같이 확인할 것.

**지도 마커**: `getHighlightMarkerImage()` / `highlightResult()`가 마커 색을 정한다. 강조 마커 색을 `#1f8a70`으로 맞춰줄 것 (이 함수 내부의 색상값만 수정 허용).

**마커 스타일 3가지 후보** (택1, 디자인 목업 참고: `Lunch Recommender Concepts.dc.html` §4 / `4a`·`4b`·`4c`):
- **4a 솔리드 핀**: 물방울 모양 핀, 채움 `#1f8a70`, 선택된 마커는 `#136a53` + 흰 테두리 3px.
- **4b 아웃라인 핀**: 흰 배경 + `#1f8a70` 테두리(비선택 2px / 선택 3px), 카카오 기본 핀 형태와 가장 유사해 교체 난이도 최소.
- **4c 미니멀 닷**: 원형 마커. 비선택 14px 흰 배경+틸 테두리, 선택 22px 틸 채움+흰 테두리. 지도가 복잡할 때 가장 깔끔.
- 기본 추천: **4b** (기존 핀 이미지 자산 형태를 유지한 채 색만 교체 가능해 구현 비용이 가장 낮음). 다른 스타일 원하면 `getHighlightMarkerImage()`가 리턴하는 마커 이미지(SVG/PNG)를 해당 스타일로 다시 그려야 함.

---

## 9. 유지할 것 / 바꾸지 말 것

- 위치 기준: **서울 금천구 가산디지털1로 136, 반경 250m, 1호선 철길 서쪽 구역만**.
- 조건은 전부 **선택사항**이며 멀티 셀렉트. 미선택 = 전체 후보.
- 결과는 **식당 + 추천메뉴 + 다른메뉴** 세 가지가 항상 함께 나온다.
- 기존 필터/랜덤 로직(`matchesTags`, `candidatePool`, `pickRandom`)과 카카오 연동(`fetchLiveRestaurants`, `categorySearchAll`, `crossSign` 철길 판정) 그대로 재사용.
- `localStorage` 오버라이드 구조(`loadOverrides`/`saveOverride`/`mergeRecord`) 유지 — 사용자가 편집한 메뉴 데이터가 날아가면 안 됨.
- 카카오 SDK 로드 실패 시 seed 데이터 폴백 + `fallbackBanner` 표시 동작 유지.
- 첫 진입 시 자동 추천 1건 노출 유지.
- 단일 HTML 파일 유지. 빌드 스텝·프레임워크·외부 CSS 파일 도입 금지 (폰트/아이콘 CDN `<link>`만 허용).

---

## 10. Claude Code에 전달할 요청 예시

> `lunch-recommender.html`을 `UI-REDESIGN-SPEC.md`에 맞춰 리디자인해줘.
> 추천 로직·카카오 연동·localStorage는 절대 건드리지 말고, `<style>`과 `<body>` 마크업만 교체해줘. §8의 id는 전부 유지해줘.
> 3단 그리드(조건 · 결과 · 지도) 레이아웃, Pretendard 폰트, 딥 틸(#1f8a70) 액센트에 흰 배경.
> 1024px 미만에서는 세로 스택으로 반응형 처리하고, 모든 인터랙티브 요소에 focus-visible 액센트 링을 넣어줘.
