// Cloudflare Worker: 카카오맵 비공식 place-api(panel3) 메뉴 데이터 프록시
//
// 용도: place-api.map.kakao.com은 CORS가 카카오 자체 도메인으로만 제한돼 있어
//       lunch-recommender.html(GitHub Pages)에서 직접 fetch가 불가능함.
//       이 Worker가 대신 카카오에 요청(Origin을 place.map.kakao.com으로 위장)하고,
//       필요한 필드만 추려서 CORS 허용 응답으로 돌려준다.
//
// 호출 예: https://<your-worker>.workers.dev/?placeId=1454070757
//
// 주의: place-api.map.kakao.com은 카카오맵 웹의 비공식 내부 API이며 문서화되어 있지
//       않다. 응답 구조가 예고 없이 바뀌거나 접근이 막힐 수 있으므로, 실패 시
//       호출하는 쪽(lunch-recommender.html)에서 기존 수동입력/키워드 추정 방식으로
//       폴백하도록 설계돼 있다. 개인용 소규모 도구 용도로만 사용할 것.

const KAKAO_API = 'https://place-api.map.kakao.com/places/panel3/';
const CACHE_SECONDS = 60 * 60 * 24; // 1일 — 같은 식당 반복 조회 시 카카오 재호출 방지
// Cloudflare의 Cache API는 colo(엣지 거점)별로 따로 캐싱된다 — 이 응답 모양을 바꾸는 배포를 해도
// 이미 예전 코드로 캐싱해둔 colo는 최대 24시간 동안 그 옛 응답을 계속 돌려준다(같은 placeId로
// 요청해도 요청이 어느 colo에 도착하느냐에 따라 결과가 달라 보임 — 2026-09-22, representativePhotoUrl
// 필드를 추가했을 때 실사용 중 발견됨: 같은 식당인데 새로 값이 있다가/없다가 했음). 네이버 라우트의
// NAVER_MENU_SCHEMA_VERSION과 같은 패턴으로, 캐시에 반영되는 응답 모양이 바뀔 때마다 이 값을 올려서
// 옛 colo 캐시를 새 캐시 키로 무효화시킨다(카카오로 나가는 실제 요청 URL과는 무관 — 캐시 키에만 씀).
const KAKAO_MENU_SCHEMA_VERSION = 'v2';

// ============ 구내식당/한식뷔페 "오늘의 메뉴" 이미지 (카카오톡 채널 프로필 사진) ============
// 많은 구내식당/한식뷔페는 그날그날 메뉴를 텍스트가 아니라 카카오톡 채널(플러스친구) 프로필
// 사진으로 올린다. pf.kakao.com/rocket-web/web/v2/profiles/{채널ID}는 실제로는 로그인 쿠키
// 없이도(직접 curl로 검증함, 2026-09-17) 200으로 프로필 이미지 URL을 내려주는 사실상 공개
// 엔드포인트라, 개인 로그인 세션에 의존하지 않고 이 Worker에서 안전하게 정기 호출할 수 있다.
// 문서화 안 된 내부 API라는 점은 panel3(메뉴)와 동일 — 구조가 바뀌면 조용히 실패할 수 있음.
const KAKAO_CHANNEL_PROFILE_API = 'https://pf.kakao.com/rocket-web/web/v2/profiles/';
// 굿푸드가산(_tNIgn) 실측(2026-09-21): has_post:true인데도 프로필 응답의 cards[]에 type:'post'
// 카드 자체가 없는 채널이 있다(cards가 profile/review/menu/friend/info뿐). 이런 채널은 "소식"
// 포스트 목록을 이 별도 엔드포인트로 가져와야 한다 — 위 프로필 API와 마찬가지로 로그인 쿠키
// 없이도 200으로 응답하는 걸 직접 curl로 확인함(문서화 안 된 내부 API인 점은 동일).
const KAKAO_CHANNEL_POSTS_API = 'https://pf.kakao.com/rocket-web/web/profiles/';
const CAFETERIA_IMAGE_CACHE_SECONDS = 60 * 60 * 3; // 3시간 — cron이 실패해도 하루 안에 몇 번은 스스로 갱신되게
// 윤스푸드(_aKxdLs) 실측: 포스트가 전날 23:29에 먼저 올라오고 이미지가 확정되는 편집은 다음날
// 11:15에 일어났다(약 11.75시간 격차). profile 사진 경로(하루 종일 잘 안 바뀜)보다 훨씬 자주
// 바뀔 수 있는 경로라 캐시를 짧게 잡아, 편집 전 이미지가 오전 내내 캐싱되는 걸 줄인다.
const CAFETERIA_POST_IMAGE_CACHE_SECONDS = 60 * 60; // 1시간

// 09:00(KST) 스케줄 프리패치 대상. 프론트엔드는 식당마다 이 채널ID를 "정보 편집"에서 직접
// 입력해두고(네이버 place id와 동일한 수동 매핑 방식 — 자동 매칭 API가 없음), 이 목록은 그중
// cron이 매일 아침 미리 캐시를 데워둘 채널들이다. 여기 없는 채널도 on-demand 요청 시엔 정상
// 동작한다(그냥 그날 첫 요청이 카카오를 직접 호출할 뿐). 새 구내식당을 추가하면 이 배열에도
// 채널ID를 추가해줘야 매일 9시에 미리 데워진다.
const CAFETERIA_CHANNELS = ['_gdqxdn', '_NHxgEn', '_bXxkxhb', '_aKxdLs', '_tNIgn'];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*', // 필요시 배포 도메인으로 좁혀도 됨
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // 팀 모드(/room 등)가 POST를 쓰므로 추가
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

// panel3 응답의 open_hours는 "오늘부터 7일치" 요일별 영업시간을 문자열 설명("09:00 ~ 21:30")
// 형태로 준다. 점심 추천 앱은 "오늘 몇 시에 여는가"만 필요하므로, 오늘 항목(is_highlight)의
// 시작 시각만 분 단위로 뽑아 돌려준다. 휴무일 등이라 오늘 항목에 영업시간이 없으면(온라인에서
// 구조가 바뀌었을 가능성 포함) null을 돌려주고, 호출하는 쪽에서 "판단 불가"로 취급해 필터링하지
// 않도록 한다(잘못 제외시키는 것보다 안전한 쪽).
function parseOpenHours(openHours) {
  if (!openHours) return null;
  const days = openHours?.week_from_today?.week_periods?.[0]?.days || [];
  const today = days.find((d) => d.is_highlight) || days[0];
  const desc = today?.on_days?.start_end_time_desc;
  if (!desc) return null;
  const m = desc.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return {
    startMinutes: Number(m[1]) * 60 + Number(m[2]),
    startEndDesc: desc,
    headlineCode: openHours?.headline?.code || null,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // "우리 오늘 뭐먹지" 팀 모드: 방 생성/참여/조회/갱신/결과공유 (Cloudflare KV, ROOMS 바인딩 필요)
    if (url.pathname === '/room') {
      if (request.method === 'POST') return handleCreateRoom(env);
      if (request.method === 'GET') return handleGetRoom(url, env);
    }
    if (url.pathname === '/room/join' && request.method === 'POST') return handleJoinRoom(request, env);
    if (url.pathname === '/room/update' && request.method === 'POST') return handleUpdateMember(request, env);
    if (url.pathname === '/room/result' && request.method === 'POST') return handleSetResult(request, env);

    // 가게별 자동/포함/제외(manualOverride) 상태 — 폐업했는데 카카오에 안 지워진 가게처럼
    // 한 사람이 "제외"하면 전원에게 똑같이 보여야 유용한 판정이라, localStorage 대신 여기
    // KV(REVIEWS 바인딩 재사용)에 공유 저장한다. 누구나 되돌릴 수 있게 권한 구분은 두지 않는다.
    if (url.pathname === '/overrides' && request.method === 'GET') return handleListOverrides(env);
    if (url.pathname === '/overrides/set' && request.method === 'POST') return handleSetOverride(request, env);

    // 가게별 댓글(사진+텍스트) 등록/조회/삭제 (Cloudflare KV, REVIEWS 바인딩 필요). 팀 모드와
    // 달리 개인 기록이라 TTL 없이 영구 보관한다.
    if (url.pathname === '/review/add' && request.method === 'POST') return handleAddReview(request, env);
    if (url.pathname === '/review/list' && request.method === 'GET') return handleListReviews(url, env);
    if (url.pathname === '/review/delete' && request.method === 'POST') return handleDeleteReview(request, env);

    // 네이버 플레이스 메뉴 조회. 네이버 지역검색 API는 place id를 안 주기 때문에(공식 API의
    // 근본적 한계로 확인됨) 자동 매칭은 포기하고, 사용자가 앱에서 직접 입력해둔 네이버 place id로만
    // 호출한다. place.naver.com/restaurant/{id}/menu/list 페이지는 SSR이라 카카오처럼 CORS로
    // 막혀있지 않고, window.__APOLLO_STATE__ 안에 메뉴 데이터(이름/가격/대표메뉴 여부)가 그대로
    // 박혀서 온다 — 그걸 파싱해서 카카오 메뉴 응답과 동일한 스키마로 맞춰 반환한다.
    const naverPlaceId = url.searchParams.get('naverPlaceId');
    if (naverPlaceId) {
      return handleNaverMenu(naverPlaceId);
    }

    // 구내식당/한식뷔페 "오늘의 메뉴" 이미지 (카카오톡 채널 프로필 사진)
    const cafeteriaChannel = url.searchParams.get('cafeteriaChannel');
    if (cafeteriaChannel) {
      return handleCafeteriaMenu(cafeteriaChannel, env);
    }

    // 카카오톡 채널이 없는(예: 인스타그램에만 올리는) 구내식당용 — 사람이 직접 오늘자 메뉴
    // 사진을 붙여넣어 등록/조회 (Cloudflare KV, REVIEWS 바인딩 재사용)
    if (url.pathname === '/cafeteria/manual-upload' && request.method === 'POST') {
      return handleUploadCafeteriaManualPhoto(request, env);
    }
    if (url.pathname === '/cafeteria/manual' && request.method === 'GET') {
      return handleGetCafeteriaManualPhoto(url, env);
    }

    // 하루 단위가 아니라 "주간 식단표" 한 장을 요일별로 나눠서 올리는 식당용(인스타그램 등에
    // 매주 월~금 메뉴를 표 하나로 올리는 경우). 요일별로 독립된 키에 저장해두고, 그 주
    // 월요일 날짜(weekOf)가 이번 주와 일치할 때만 유효로 취급한다.
    if (url.pathname === '/cafeteria/weekly-upload' && request.method === 'POST') {
      return handleUploadCafeteriaWeeklyPhoto(request, env);
    }
    if (url.pathname === '/cafeteria/weekly' && request.method === 'GET') {
      return handleGetCafeteriaWeeklyPhoto(url, env);
    }
    // "정보 편집" 패널에서 요일 5칸의 등록 여부를 한 번에 보여주기 위한 조회. 위 /cafeteria/weekly는
    // "오늘 요일"만 확인하는 용도라, 오늘이 아닌 날짜에 편집 패널을 다시 열면 이미 등록해둔 칸도
    // 빈 것처럼 보여 등록 여부를 확인할 수 없는 문제가 있었다(실사용 중 발견) — 이 라우트는 요일
    // 전체를 한 번에 반환한다.
    if (url.pathname === '/cafeteria/weekly-status' && request.method === 'GET') {
      return handleGetCafeteriaWeeklyStatus(url, env);
    }

    const placeId = url.searchParams.get('placeId');

    if (!placeId || !/^\d+$/.test(placeId)) {
      return json({ error: 'placeId 쿼리 파라미터가 필요합니다 (숫자만).' }, 400);
    }

    // Cloudflare Cache API로 응답 캐싱 (같은 placeId 반복 요청 시 카카오 재호출 방지)
    const cache = caches.default;
    const cacheUrl = url.toString() + (url.search ? '&' : '?') + '_cv=' + KAKAO_MENU_SCHEMA_VERSION;
    const cacheKey = new Request(cacheUrl, request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let kakaoResp;
    try {
      kakaoResp = await fetch(KAKAO_API + placeId, {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'appversion': '6.6.0',
          'cache-control': 'no-cache',
          'pragma': 'no-cache',
          'dnt': '1',
          'origin': 'https://place.map.kakao.com',
          'referer': 'https://place.map.kakao.com/',
          'pf': 'PC',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-site',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        },
      });
    } catch (e) {
      return json({ error: 'kakao 요청 실패', detail: String(e) }, 502);
    }

    if (!kakaoResp.ok) {
      return json({ error: `kakao api status ${kakaoResp.status}` }, 502);
    }

    let data;
    try {
      data = await kakaoResp.json();
    } catch (e) {
      return json({ error: 'kakao 응답 파싱 실패', detail: String(e) }, 502);
    }

    const rawItems = data?.menu?.menus?.items || [];
    // 개별 메뉴 항목의 photo_url(rawItems[].photo_url)은 실측 결과 "AI메이트" 카드가 붙은
    // 일부 항목에만 있고 대부분 비어있다(2026-09-22, "돈토"/placeId=11598876으로 직접 확인 —
    // 항목 4개 전부 photo_url 없음). 반면 panel3는 블로그 리뷰 사진을 카테고리별로 이미 분류해
    // 두는데, menu.menus.photos가 그중 "메뉴"로 분류된 사진들이라(개수가 photos.counts.menu와
    // 정확히 일치함을 확인) 식당 자체의 대표 메뉴/음식 사진으로 쓰기에 photos.photos(구분 없는
    // 전체 방문자 사진, 간판/내부 사진도 섞여있어 음식과 무관할 수 있음)보다 훨씬 신뢰할 만하다.
    // "메뉴" 사진이 아예 없는 식당만 photos.photos 첫 장으로 최후 폴백한다.
    const menuPhotos = data?.menu?.menus?.photos || [];
    const generalPhotos = data?.photos?.photos || [];
    const representativePhotoUrl = menuPhotos[0]?.url || generalPhotos[0]?.url || null;
    const result = {
      placeId,
      menuType: data?.menu?.menus?.menu_type || null,
      updatedAt: data?.menu?.menus?.items_updated_at || null,
      items: rawItems.map((it) => ({
        name: it.name,
        price: it.price ?? null,
        isRecommend: !!it.is_recommend,
        recommendReasons: it.recommend_reasons || [],
        description: it.ai_mate_desc || null,
        photoUrl: it.photo_url || null,
      })),
      representativePhotoUrl,
      openHours: parseOpenHours(data?.open_hours),
    };

    const response = json(result, 200, {
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
    });
    await cache.put(cacheKey, response.clone());
    return response;
  },

  // Cloudflare 대시보드(Workers & Pages > 이 Worker > Settings > Triggers > Cron Triggers)에
  // "0 0 * * *"(UTC 0시 = KST 9시)를 등록해두면 이 함수가 매일 그 시각에 자동 실행된다.
  // 코드만으로는 cron 자체를 등록할 수 없어 대시보드(또는 wrangler.toml) 설정이 별도로 필요함.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(prefetchCafeteriaMenus(env));
  },
};

// ============ 구내식당/한식뷔페 메뉴 이미지 핸들러 ============
// 'post'(정확한 날짜 일치)와 'post-guess'(키워드 점수 추정) 둘 다 포스트 경로 결과라
// published_at 기준 신뢰 가능한 타임스탬프를 갖고 있으므로 이미지-변경 추적/캐시 TTL을
// 같은 방식으로 다룬다.
function isCafeteriaPostSource(source) {
  return source === 'post' || source === 'post-guess';
}

function cafeteriaCacheRequest(channelId) {
  return new Request('https://kakao-menu-proxy.internal/cafeteria-menu?channel=' + encodeURIComponent(channelId));
}

// ---- 채널 "소식"(포스트)으로 매일 메뉴를 올리는 패턴 ----
// 씽씽푸드 등은 프로필 사진 자체를 그날 메뉴로 바꾸지만, 윤스푸드(_aKxdLs) 같은 채널은
// 프로필 사진은 그대로 두고 "9월 17일 목요일 메뉴안내" 식으로 제목을 단 포스트를 매일
// 올린다(profile API의 cards[].type==='post' 카드 안 posts[]에 이미 들어있음 — 별도 API
// 호출 불필요, 2026-09-17 curl로 확인). 예전 날짜 포스트도 계속 쌓여있으므로 제목의 날짜가
// 정확히 오늘(KST)인 것만, 그중에서도 가장 최근에 올라온 것만 골라야 한다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
function getKstTodayMonthDay() {
  const kst = new Date(Date.now() + KST_OFFSET_MS);
  return { month: kst.getUTCMonth() + 1, day: kst.getUTCDate() };
}
// "KST 벽시계 값"을 UTC 필드에 그대로 담은 가상 Date. 요일별 주간 식단표 기능에서 "이번 주
// 월요일 날짜"·"오늘 요일"까지 필요해져서, 날짜 계산 공통부를 여기 하나로 모았다.
function getKstNow() { return new Date(Date.now() + KST_OFFSET_MS); }
function formatKstDate(kst) {
  const pad = (n) => String(n).padStart(2, '0');
  return kst.getUTCFullYear() + '-' + pad(kst.getUTCMonth() + 1) + '-' + pad(kst.getUTCDate());
}
// 수동 업로드 사진의 "오늘 것인지" 판단용 — 연도까지 포함해 완전한 날짜 문자열로 비교한다
// (getKstTodayMonthDay는 월/일만 다뤄서 연말/연초 경계에선 부정확할 수 있음).
function getKstDateString(ts) {
  return formatKstDate(ts ? new Date(ts + KST_OFFSET_MS) : getKstNow());
}
const KST_WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // Date.getUTCDay() 인덱스와 동일
function getKstWeekdayKey() { return KST_WEEKDAY_KEYS[getKstNow().getUTCDay()]; }
// 이번 주 월요일 날짜(YYYY-MM-DD, KST). 일요일(dow=0)은 -6일, 그 외엔 1-dow일만큼 이동해서 구한다.
function getKstMondayDateString() {
  const now = getKstNow();
  const dow = now.getUTCDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  return formatKstDate(new Date(now.getTime() + diffToMonday * 24 * 60 * 60 * 1000));
}

// 요일 텍스트("목요일")는 검증하지 않는다 — 요구되는 조건은 "날짜 일치 + 최신순" 두 가지뿐이라
// 요일까지 대조하면 표기 편차에 더 취약해질 뿐 얻는 게 없다.
function parseCafeteriaPostTitleDate(title) {
  if (typeof title !== 'string') return null;
  const m = title.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  return m ? { month: Number(m[1]), day: Number(m[2]) } : null;
}

// 제목이 오늘 날짜와 일치하는 포스트 중 가장 최근에 "올라온"(published_at 기준 — updated_at
// 기준으로 하면 오늘 아침에 편집된 옛 포스트가 방금 올라온 진짜 오늘자 포스트를 이길 수 있어
// 틀린다) 것을 고른다. posts 배열이 최신순으로 온다고 가정하지 않고 매번 filter+sort 한다
// (pinned된 포스트가 순서를 흔들 수 있어, pinned 여부는 신호로 쓰지 않는다).
function pickTodayCafeteriaPost(posts, todayMonthDay) {
  const candidates = (posts || [])
    .filter((p) => p && p.status === 'published' && !p.is_private && !p.unlisted)
    .map((p) => ({ post: p, date: parseCafeteriaPostTitleDate(p.title) }))
    .filter((c) => c.date && c.date.month === todayMonthDay.month && c.date.day === todayMonthDay.day);
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    (b.post.published_at || b.post.created_at || 0) - (a.post.published_at || a.post.created_at || 0)
  );
  return candidates[0].post;
}

// 제목에 "N월 N일" 형태의 정확한 날짜가 없는 채널을 위한 2차 선별. 굿푸드가산(_tNIgn) 실측
// 결과, "소식"의 맨 위 글이 메뉴 사진이 아닐 수 있고(오늘의 샐러드가 오늘의 메뉴보다 나중에
// 올라와 위에 뜸), 날짜 표기도 "N월 N일"이 아니라 "9.21(월)" 같은 다른 포맷이라 정확 매칭이
// 통하지 않는다. 대신 제목에 '오늘'/'메뉴'/날짜로 보이는 숫자가 얼마나 많이 들어있는지를
// 점수로 매겨 가장 높은 글을 고른다 — 실측 예시로 "오늘의 메뉴 9.21(월)"은 오늘(1)+메뉴(1)+
// 숫자묶음(9, 21 → 2) = 4점인 반면 "오늘의 샐러드"는 오늘(1)뿐이라 자연히 밀린다. 정확한
// 날짜 매칭(pickTodayCafeteriaPost)이 성공하면 그쪽이 항상 더 신뢰도가 높으므로 이 함수는
// 그게 실패했을 때만 호출된다. 몇 주 전 포스트가 우연히 점수가 높아 잘못 뽑히는 걸 막기
// 위해 최근 글만 후보로 삼는다.
const KEYWORD_SCORE_LOOKBACK_MS = 60 * 60 * 1000 * 24 * 3; // 최근 3일
function scoreCafeteriaPostTitle(title) {
  if (typeof title !== 'string') return 0;
  const todayCount = (title.match(/오늘/g) || []).length;
  const menuCount = (title.match(/메뉴/g) || []).length;
  const dateNumberCount = (title.match(/\d+/g) || []).length;
  return todayCount + menuCount + dateNumberCount;
}
function pickCafeteriaPostByKeywordScore(posts) {
  const now = Date.now();
  const candidates = (posts || [])
    .filter((p) => p && p.status === 'published' && !p.is_private && !p.unlisted)
    .filter((p) => now - (p.published_at || p.created_at || 0) <= KEYWORD_SCORE_LOOKBACK_MS)
    .map((p) => ({ post: p, score: scoreCafeteriaPostTitle(p.title) }))
    .filter((c) => c.score > 0);
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.post.published_at || b.post.created_at || 0) - (a.post.published_at || a.post.created_at || 0);
  });
  return candidates[0].post;
}

// _aKxdLs의 오늘자 포스트를 직접 열어보니 media[0]만 다른 포맷(.png, 다른 해상도)이고 나머지
// 6장은 동일 포맷 사진들(매장/음식 스냅샷으로 추정)이라, media[0]이 의도적으로 만든 메뉴판
// 이미지일 가능성이 높다 — 다만 한 채널·하루치 샘플로 확인한 가정이라 확정적 근거는 아니다.
// 다른 채널에서 이 가정이 깨지는 게 확인되면 이 함수만 고치면 된다.
function pickCafeteriaPostMedia(post) {
  const first = (post && post.media || [])[0];
  return (first && first.xlarge_url) ? first : null;
}

// 카카오 채널 프로필 응답에서 오늘의 메뉴 이미지를 뽑아낸다. 포스트형 패턴을 먼저 시도하고
// (제목에 오늘 날짜가 있는 게 확인되면 신뢰도가 가장 높음), 정확한 날짜 매칭이 안 되면 키워드
// 점수 폴백을(pickCafeteriaPostByKeywordScore), 그마저도 없으면 기존 프로필 사진 경로로
// 그대로 폴백한다. posts는 호출하는 쪽(fetchCafeteriaProfile)에서 채널별로 이미 찾아서
// 넘겨준다 — profile 응답 자체의 cards[]에 'post' 카드가 없는 채널(예: 굿푸드가산)은 별도
// 엔드포인트로 가져온 목록이 대신 들어올 수 있다. profileCard.updated_at(카드 자체의 마지막
// 편집 시각 — 사업자 정보 등도 포함)은 "사진이 실제로 바뀐 시각"과 무관할 수 있다는 걸
// 실사용 중 확인함(2026-09-17: 사진은 당일 것인데 updated_at은 1년 전 날짜를 가리킨 사례).
// 그래서 이 필드는 참고용으로만 남겨두고, 실제 "언제 사진이 바뀌었는지" 판단은
// applyCafeteriaChangeTracking()이 profile_image_id 비교로 직접 추적한 값을 쓴다(포스트
// 경로는 published_at이 이미 신뢰 가능해서 이 추적이 필요 없다 — 호출부에서 source로 분기).
function parseCafeteriaProfile(data, channelId, posts) {
  const cards = (data && data.cards) || [];
  const profileCard = cards.find((c) => c && c.type === 'profile');
  const profile = profileCard && profileCard.profile;
  const name = (profile && profile.name) || null;

  const exactMatch = pickTodayCafeteriaPost(posts || [], getKstTodayMonthDay());
  const keywordMatch = !exactMatch ? pickCafeteriaPostByKeywordScore(posts || []) : null;
  const matchedPost = exactMatch || keywordMatch;
  if (matchedPost) {
    const media = pickCafeteriaPostMedia(matchedPost);
    if (media) {
      return {
        channelId,
        name,
        imageUrl: media.xlarge_url,
        // 'post'는 제목의 날짜가 오늘과 정확히 일치해 확인된 것, 'post-guess'는 정확한 날짜
        // 표기가 없어 '오늘'/'메뉴'/숫자 키워드 점수로 추정한 것 — 프론트엔드가 표시 문구를
        // 다르게(추정임을 밝히도록) 구분할 수 있도록 나눈다.
        source: exactMatch ? 'post' : 'post-guess',
        postTitle: matchedPost.title,
        postPublishedAt: matchedPost.published_at || matchedPost.created_at || null,
        fetchedAt: Date.now(),
      };
    }
    // 매칭은 됐는데 쓸만한 이미지가 없으면(media 비었거나 xlarge_url 없음) 아래 프로필
    // 사진 경로로 계속 진행한다(throw 없이 "매칭 없음"과 동일하게 취급).
  }

  const image = profile && profile.profile_image;
  if (!image || !image.xlarge_url) return null;
  return {
    channelId,
    name,
    imageUrl: image.xlarge_url,
    source: 'profile',
    imageId: profile.profile_image_id || null,
    kakaoCardUpdatedAt: profileCard.updated_at || null,
    fetchedAt: Date.now(),
  };
}

// profileCard.updated_at을 못 믿는 대신, 우리가 매번 조회할 때 profile_image_id가 지난번과
// 같은지 직접 비교해서 "우리가 마지막으로 이 사진이 바뀐 걸 확인한 시각"을 기록해 그 값을
// profileUpdatedAt으로 돌려준다. 별도 KV 네임스페이스를 새로 만들게 하지 않으려고, 가게 댓글용
// REVIEWS 바인딩(범용 durable key-value 저장소일 뿐이라 재사용 가능)을 review:와 겹치지 않는
// 키 prefix로 나눠서 같이 쓴다. REVIEWS 바인딩이 없으면(구버전 배포 등) 추적을 건너뛰고 카카오
// 원본 필드를 그대로 profileUpdatedAt에 채워 기존 동작으로 폴백한다.
function cafeteriaTrackKey(channelId) { return 'cafeteria-track:' + channelId; }

async function applyCafeteriaChangeTracking(env, profile) {
  if (!env.REVIEWS || !profile.imageId) {
    return Object.assign({}, profile, { profileUpdatedAt: profile.kakaoCardUpdatedAt });
  }

  const key = cafeteriaTrackKey(profile.channelId);
  let tracked = null;
  try {
    const raw = await env.REVIEWS.get(key);
    tracked = raw ? JSON.parse(raw) : null;
  } catch (e) {
    tracked = null;
  }

  let firstSeenAt;
  if (tracked && tracked.imageId === profile.imageId) {
    firstSeenAt = tracked.firstSeenAt;
  } else {
    firstSeenAt = Date.now();
    await env.REVIEWS.put(key, JSON.stringify({ imageId: profile.imageId, firstSeenAt }));
  }
  return Object.assign({}, profile, { profileUpdatedAt: firstSeenAt });
}

async function fetchCafeteriaProfile(channelId) {
  let resp;
  try {
    resp = await fetch(KAKAO_CHANNEL_PROFILE_API + channelId, {
      headers: {
        'accept': '*/*',
        'accept-language': 'ko-KR,ko;q=0.9',
        'referer': 'https://pf.kakao.com/' + channelId,
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      },
    });
  } catch (e) {
    return null;
  }
  if (!resp.ok) return null;
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return null;
  }

  const cards = (data && data.cards) || [];
  const postsCard = cards.find((c) => c && c.type === 'post');
  let posts = (postsCard && postsCard.posts) || null;
  // 굿푸드가산(_tNIgn) 실측(2026-09-21): has_post:true인데도 cards[]에 'post' 카드가 아예
  // 없다. 이런 채널은 "소식" 목록을 별도 엔드포인트로 따로 가져온다.
  if (!posts) {
    posts = await fetchCafeteriaPostsList(channelId);
  }

  return parseCafeteriaProfile(data, channelId, posts || []);
}

// KAKAO_CHANNEL_PROFILE_API 응답의 cards[]에 'post' 카드가 없는 채널을 위한 "소식" 목록
// 폴백 조회. 프로필 API와 마찬가지로 로그인 쿠키 없이도 200으로 응답하는 걸 curl로 확인함
// (2026-09-21). 실패해도 null만 돌려주고 위 fetchCafeteriaProfile이 posts:[] 취급하며
// 계속 진행하게 한다(이 조회 실패가 전체 요청을 막아선 안 됨).
async function fetchCafeteriaPostsList(channelId) {
  let resp;
  try {
    resp = await fetch(KAKAO_CHANNEL_POSTS_API + channelId + '/posts?includePinnedPost=true', {
      headers: {
        'accept': '*/*',
        'accept-language': 'ko-KR,ko;q=0.9',
        'referer': 'https://pf.kakao.com/' + channelId + '/posts',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      },
    });
  } catch (e) {
    return null;
  }
  if (!resp.ok) return null;
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return null;
  }
  return (data && data.items) || null;
}

async function handleCafeteriaMenu(channelId, env) {
  if (!/^_[A-Za-z0-9_-]+$/.test(channelId)) {
    return json({ error: 'channel 파라미터 형식이 올바르지 않습니다 (예: _gdqxdn).' }, 400);
  }

  const cache = caches.default;
  const cacheKey = cafeteriaCacheRequest(channelId);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const result = await fetchCafeteriaProfile(channelId);
  if (!result) {
    return json({ error: '채널 프로필 이미지를 가져오지 못했습니다.', channelId }, 502);
  }
  // 포스트 경로는 published_at이 이미 신뢰 가능한 타임스탬프라 profile_image_id 추적이
  // 불필요하다(추적은 카카오의 못 믿을 profileCard.updated_at을 보정하기 위한 것뿐).
  const tracked = isCafeteriaPostSource(result.source) ? result : await applyCafeteriaChangeTracking(env, result);
  const maxAge = isCafeteriaPostSource(tracked.source) ? CAFETERIA_POST_IMAGE_CACHE_SECONDS : CAFETERIA_IMAGE_CACHE_SECONDS;

  const response = json(tracked, 200, {
    'Cache-Control': `public, max-age=${maxAge}`,
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

// cron(scheduled)이 매일 09:00(KST)에 이 함수를 호출해 CAFETERIA_CHANNELS의 캐시를 미리
// 데워둔다. 한 채널이 실패해도(폐업/구조변경 등) 나머지는 계속 진행하도록 allSettled를 쓴다.
async function prefetchCafeteriaMenus(env) {
  const cache = caches.default;
  await Promise.allSettled(
    CAFETERIA_CHANNELS.map(async (channelId) => {
      const result = await fetchCafeteriaProfile(channelId);
      if (!result) return;
      const tracked = isCafeteriaPostSource(result.source) ? result : await applyCafeteriaChangeTracking(env, result);
      const maxAge = isCafeteriaPostSource(tracked.source) ? CAFETERIA_POST_IMAGE_CACHE_SECONDS : CAFETERIA_IMAGE_CACHE_SECONDS;
      const response = json(tracked, 200, {
        'Cache-Control': `public, max-age=${maxAge}`,
      });
      await cache.put(cafeteriaCacheRequest(channelId), response);
    })
  );
}

// ============ "우리 오늘 뭐먹지" 팀 모드 (Cloudflare KV) ============
// Worker Settings > Bindings에서 KV Namespace를 만들어 변수명 ROOMS로 바인딩해야 동작한다.
// 6시간 뒤 자동 만료(KV expirationTtl)되며, 별도의 방 삭제 API는 두지 않는다.
//
// 멤버 데이터를 방(room) 하나의 값에 배열로 합쳐 넣지 않고, 멤버마다 별도의 키로 나눠서
// 저장한다: room:{code}:meta (방 메타 + 결과), room:{code}:m:{memberId} (멤버 개별 상태).
// 여러 멤버가 거의 동시에 "준비" 버튼을 누르는 게 이 기능의 핵심 사용 패턴인데, 만약 방
// 전체를 하나의 키로 관리하면 read-modify-write 방식이라 나중에 쓰는 사람이 앞사람의
// 변경사항을 통째로 덮어써서 유실시킬 수 있다(실제로 테스트 중 발견함). 키를 멤버별로
// 쪼개면 서로 다른 키에 쓰는 것이라 이 경쟁 상태가 원천적으로 발생하지 않는다.
const ROOM_TTL_SECONDS = 6 * 60 * 60;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I/L 등 혼동되는 문자는 제외
const DEFAULT_TEAM_RADIUS_M = 300; // lunch-recommender.html의 CONFIG.DEFAULT_RADIUS_M과 동일하게 맞춰둠

function generateRoomCode() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  let code = '';
  for (let i = 0; i < 6; i++) code += ROOM_CODE_CHARS[arr[i] % ROOM_CODE_CHARS.length];
  return code;
}

function emptyExcluded() {
  return { type: [], cuisine: [] };
}

function metaKey(code) { return 'room:' + code + ':meta'; }
function memberKey(code, memberId) { return 'room:' + code + ':m:' + memberId; }
function memberPrefix(code) { return 'room:' + code + ':m:'; }

async function loadMeta(env, code) {
  const raw = await env.ROOMS.get(metaKey(code));
  return raw ? JSON.parse(raw) : null;
}
async function saveMeta(env, meta) {
  await env.ROOMS.put(metaKey(meta.code), JSON.stringify(meta), { expirationTtl: ROOM_TTL_SECONDS });
}
async function loadMember(env, code, memberId) {
  const raw = await env.ROOMS.get(memberKey(code, memberId));
  return raw ? JSON.parse(raw) : null;
}
async function saveMember(env, code, member) {
  await env.ROOMS.put(memberKey(code, member.id), JSON.stringify(member), { expirationTtl: ROOM_TTL_SECONDS });
}
async function loadAllMembers(env, code) {
  const listed = await env.ROOMS.list({ prefix: memberPrefix(code) });
  const members = await Promise.all(
    listed.keys.map((k) => env.ROOMS.get(k.name).then((raw) => (raw ? JSON.parse(raw) : null)))
  );
  return members.filter(Boolean).sort((a, b) => a.joinedAt - b.joinedAt);
}

async function handleCreateRoom(env) {
  if (!env.ROOMS) return json({ error: 'ROOMS KV 바인딩이 설정되지 않았습니다. Worker Settings에서 추가해주세요.' }, 500);

  let code;
  do {
    code = generateRoomCode();
  } while (await env.ROOMS.get(metaKey(code)));

  const memberId = crypto.randomUUID();
  const now = Date.now();
  await saveMeta(env, { code, createdAt: now, memberCount: 1, result: null });
  await saveMember(env, code, { id: memberId, name: '멤버1', joinedAt: now, ready: false, excluded: emptyExcluded(), radius: DEFAULT_TEAM_RADIUS_M });
  return json({ code, memberId, name: '멤버1' });
}

async function handleJoinRoom(request, env) {
  if (!env.ROOMS) return json({ error: 'ROOMS KV 바인딩이 설정되지 않았습니다.' }, 500);

  const body = await request.json().catch(() => null);
  const code = ((body && body.code) || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return json({ error: '초대 코드는 영문 대문자+숫자 6자리여야 합니다.' }, 400);
  }

  const meta = await loadMeta(env, code);
  if (!meta) return json({ error: '해당 코드의 방을 찾을 수 없어요. 코드를 다시 확인해주세요.' }, 404);

  // 참여가 완전히 동시에 몰리면 이 카운터 증가도 이론상 경쟁 상태가 있을 수 있지만(멤버 번호가
  // 한 번쯤 겹치는 정도), 준비 상태 갱신처럼 데이터가 유실되는 건 아니라 감수할 만하다.
  meta.memberCount = (meta.memberCount || 0) + 1;
  const name = '멤버' + meta.memberCount;
  const memberId = crypto.randomUUID();
  await saveMeta(env, meta);
  await saveMember(env, code, { id: memberId, name, joinedAt: Date.now(), ready: false, excluded: emptyExcluded(), radius: DEFAULT_TEAM_RADIUS_M });
  return json({ code, memberId, name });
}

async function handleGetRoom(url, env) {
  if (!env.ROOMS) return json({ error: 'ROOMS KV 바인딩이 설정되지 않았습니다.' }, 500);
  const code = (url.searchParams.get('code') || '').toUpperCase().trim();
  const meta = await loadMeta(env, code);
  if (!meta) return json({ error: '방을 찾을 수 없습니다 (만료됐을 수 있어요).' }, 404);
  const members = await loadAllMembers(env, code);
  return json({ code: meta.code, createdAt: meta.createdAt, members, result: meta.result }, 200, { 'Cache-Control': 'no-store' });
}

async function handleUpdateMember(request, env) {
  if (!env.ROOMS) return json({ error: 'ROOMS KV 바인딩이 설정되지 않았습니다.' }, 500);

  const body = await request.json().catch(() => null);
  if (!body || !body.code || !body.memberId) return json({ error: '잘못된 요청입니다.' }, 400);
  const code = body.code.toUpperCase().trim();

  const member = await loadMember(env, code, body.memberId);
  if (!member) return json({ error: '방에서 이 멤버를 찾을 수 없습니다.' }, 404);

  if (body.excluded) member.excluded = body.excluded;
  // 100~500 범위의 유한한 양수만 받는다 — 클라이언트 RADIUS_OPTIONS와 정확히 같은 값 집합을
  // 강제하진 않는다(향후 옵션이 바뀔 수 있어서), 대신 말이 안 되는 값만 걸러낸다.
  if (typeof body.radius === 'number' && isFinite(body.radius) && body.radius >= 100 && body.radius <= 500) {
    member.radius = body.radius;
  }
  if (typeof body.ready === 'boolean') member.ready = body.ready;
  await saveMember(env, code, member);
  return json({ ok: true });
}

async function handleSetResult(request, env) {
  if (!env.ROOMS) return json({ error: 'ROOMS KV 바인딩이 설정되지 않았습니다.' }, 500);

  const body = await request.json().catch(() => null);
  if (!body || !body.code) return json({ error: '잘못된 요청입니다.' }, 400);
  const code = body.code.toUpperCase().trim();

  const meta = await loadMeta(env, code);
  if (!meta) return json({ error: '방을 찾을 수 없습니다.' }, 404);
  meta.result = body.result || null;
  await saveMeta(env, meta);
  return json({ ok: true });
}

// ============ 가게별 공유 편집 상태 (자동/포함/제외 + 종류/메뉴/채널ID 등) (Cloudflare KV) ============
// review:와 같은 REVIEWS KV를 재사용한다(추가 바인딩 불필요). 만료 없이 영구 저장 — 폐업 등
// 사실 정보라 TTL로 자동 소멸시키면 안 된다.
// 2026-09-21: 원래 manualOverride(자동/포함/제외)만 공유했는데, 한 사람이 "정보 편집"에서
// 애써 입력한 실제 메뉴/카카오톡 채널ID/네이버 place id를 다른 사람은 전혀 못 보고 매번 처음부터
// 다시 입력해야 하는 문제가 있어 같은 저장소·같은 원칙(로그인 없음 → 작성자 구분 없이 누구나
// 덮어쓸 수 있음)으로 나머지 편집 필드도 함께 공유하도록 확장했다. 필드 하나를 지우고 싶으면
// patch에 그 필드를 null로 보낸다(다른 필드는 그대로 유지) — 레코드에 남은 필드가 하나도
// 없어지면 키 자체를 지운다(진짜 아무도 안 건드린 상태와 같아지는 쪽이 더 단순함).
const OVERRIDE_SHARED_FIELDS = [
  'manualOverride', 'cuisine', 'menuItems', 'menuSource', 'edited',
  'cafeteriaChannelId', 'naverPlaceId', 'cafeteriaManualEnabled', 'cafeteriaWeeklyEnabled',
];
function overrideKey(placeId) { return 'override:' + placeId; }
function overridePrefix() { return 'override:'; }

function isValidOverrideFieldValue(field, value) {
  switch (field) {
    case 'manualOverride':
    case 'edited':
    case 'cafeteriaManualEnabled':
    case 'cafeteriaWeeklyEnabled':
      return typeof value === 'boolean';
    case 'cuisine':
    case 'menuSource':
    case 'cafeteriaChannelId':
    case 'naverPlaceId':
      return typeof value === 'string';
    case 'menuItems':
      return Array.isArray(value);
    default:
      return false;
  }
}

async function handleListOverrides(env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);

  const listed = await env.REVIEWS.list({ prefix: overridePrefix() });
  const entries = await Promise.all(
    listed.keys.map((k) => env.REVIEWS.get(k.name).then((raw) => (raw ? JSON.parse(raw) : null)))
  );
  const overrides = {};
  entries.filter(Boolean).forEach((e) => {
    overrides[e.placeId] = e;
  });
  return json({ overrides }, 200, { 'Cache-Control': 'no-store' });
}

// 옛 클라이언트 호환: 예전엔 {placeId, manualOverride}만 보냈다. 새 클라이언트는
// {placeId, patch:{...}} 형태로 여러 필드를 한 번에 보낼 수 있다.
async function handleSetOverride(request, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);

  const body = await request.json().catch(() => null);
  if (!body || !body.placeId) {
    return json({ error: '잘못된 요청입니다 (placeId 필요).' }, 400);
  }
  const placeId = String(body.placeId);
  const patch = (body.patch && typeof body.patch === 'object') ? body.patch : { manualOverride: body.manualOverride };

  // 요청 하나가 편집 데이터를 무한정 담아 KV를 낭비하는 걸 막는 최소한의 안전장치(리뷰 사진
  // 3MB 상한에 비하면 이 편집 데이터는 훨씬 작아야 정상이라 20KB로 넉넉히 잡음).
  if (JSON.stringify(patch).length > 20000) {
    return json({ error: '편집 데이터가 너무 큽니다.' }, 413);
  }

  for (const field of OVERRIDE_SHARED_FIELDS) {
    if (!(field in patch)) continue;
    if (patch[field] === null) continue; // 필드 삭제 요청 — 값 검증 불필요
    if (!isValidOverrideFieldValue(field, patch[field])) {
      return json({ error: field + ' 값 형식이 올바르지 않습니다.' }, 400);
    }
  }

  const key = overrideKey(placeId);
  const raw = await env.REVIEWS.get(key);
  const existing = raw ? JSON.parse(raw) : {};

  OVERRIDE_SHARED_FIELDS.forEach((field) => {
    if (!(field in patch)) return;
    if (patch[field] === null) delete existing[field];
    else existing[field] = patch[field];
  });

  const hasContent = OVERRIDE_SHARED_FIELDS.some((field) => field in existing);
  if (!hasContent) {
    await env.REVIEWS.delete(key);
    return json({ ok: true });
  }

  existing.placeId = placeId;
  existing.updatedAt = Date.now();
  await env.REVIEWS.put(key, JSON.stringify(existing));
  return json({ ok: true });
}

// ============ 가게별 댓글(사진+텍스트) (Cloudflare KV) ============
// Worker Settings > Bindings에서 KV Namespace를 만들어 변수명 REVIEWS로 바인딩해야 동작한다.
// 팀 모드(ROOMS)와 달리 개인 식사 기록이라 만료(expirationTtl) 없이 영구 보관한다.
//
// 키 스킴은 팀 모드와 동일한 아이디어(가게 하나에 여러 댓글이 달릴 수 있으므로, 가게마다
// 별도 prefix 아래 댓글별로 키를 쪼갠다): review:{placeId}:{timestamp}-{random}
const REVIEW_MAX_BODY_BYTES = 3 * 1024 * 1024; // ~3MB — 휴대폰에서 리사이즈된 사진(대략 150~400KB) 대비 넉넉한 상한
const REVIEW_PHOTO_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,/;

function reviewKey(placeId, id) { return 'review:' + placeId + ':' + id; }
function reviewPrefix(placeId) { return 'review:' + placeId + ':'; }
function newReviewId() {
  return Date.now() + '-' + crypto.randomUUID().slice(0, 8);
}

async function handleAddReview(request, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다. Worker Settings에서 추가해주세요.' }, 500);

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength && contentLength > REVIEW_MAX_BODY_BYTES) {
    return json({ error: '사진이 너무 커요 (최대 3MB).' }, 413);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.placeId) {
    return json({ error: '잘못된 요청입니다 (placeId 필요).' }, 400);
  }

  // 사진은 선택 항목 — 텍스트 댓글만 남기는 것도 허용한다. 다만 사진/텍스트가 둘 다 없는
  // 완전히 빈 등록은 막는다.
  const review = typeof body.review === 'string' ? body.review.trim().slice(0, 300) : '';
  let photo = null;
  if (body.photo != null) {
    if (typeof body.photo !== 'string' || !REVIEW_PHOTO_DATA_URL_RE.test(body.photo)) {
      return json({ error: '지원하지 않는 이미지 형식입니다.' }, 400);
    }
    if (body.photo.length > REVIEW_MAX_BODY_BYTES) {
      return json({ error: '사진이 너무 커요 (최대 3MB).' }, 413);
    }
    photo = body.photo;
  }
  if (!photo && !review) {
    return json({ error: '사진 또는 댓글 중 하나는 입력해야 합니다.' }, 400);
  }

  const id = newReviewId();
  const record = {
    id,
    placeId: String(body.placeId),
    name: typeof body.name === 'string' ? body.name.slice(0, 100) : '',
    review,
    photo,
    // 로그인이 없는 앱이라 이 기기(브라우저)를 식별하는 익명 토큰만으로 "본인 글" 여부를
    // 판단한다(handleDeleteReview 참고) — CBT에서 "누구나 남의 댓글을 지울 수 있다"는 문제가
    // 발견돼 추가함.
    authorToken: typeof body.authorToken === 'string' ? body.authorToken.slice(0, 100) : '',
    createdAt: Date.now(),
  };
  await env.REVIEWS.put(reviewKey(record.placeId, id), JSON.stringify(record));
  return json({ ok: true, id });
}

async function handleListReviews(url, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);
  const placeId = (url.searchParams.get('placeId') || '').trim();
  if (!placeId) return json({ error: 'placeId 쿼리 파라미터가 필요합니다.' }, 400);
  const viewerToken = (url.searchParams.get('viewerToken') || '').trim();

  // KV list()는 기본적으로 한 번에 최대 1000개 키까지만 반환한다(개인용 앱에서 가게 하나에
  // 댓글이 그만큼 쌓일 일은 없어서 페이지네이션은 생략).
  const listed = await env.REVIEWS.list({ prefix: reviewPrefix(placeId) });
  const reviews = await Promise.all(
    listed.keys.map((k) => env.REVIEWS.get(k.name).then((raw) => (raw ? JSON.parse(raw) : null)))
  );
  // authorToken 원본은 남에게 그대로 보여줄 필요가 없는 값이라(다른 사람이 그대로 베껴서
  // 자기 것처럼 흉내낼 수 있음), "이 댓글이 지금 보는 사람(viewerToken) 것인지" boolean만
  // 내려주고 원본 토큰은 응답에서 뺀다.
  const shaped = reviews
    .filter(Boolean)
    .map(({ authorToken, ...rest }) => ({ ...rest, isOwn: !!viewerToken && authorToken === viewerToken }));
  return json(
    { placeId, reviews: shaped.sort((a, b) => b.createdAt - a.createdAt) },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

async function handleDeleteReview(request, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);
  const body = await request.json().catch(() => null);
  if (!body || !body.placeId || !body.id) return json({ error: '잘못된 요청입니다.' }, 400);
  const key = reviewKey(String(body.placeId), String(body.id));
  const raw = await env.REVIEWS.get(key);
  if (!raw) return json({ ok: true }); // 이미 삭제된 경우도 성공으로 취급(멱등)
  const record = JSON.parse(raw);
  const authorToken = typeof body.authorToken === 'string' ? body.authorToken : '';
  // 이 기능 추가 이전에 저장된(authorToken이 없는) 옛 댓글은 작성자를 확인할 방법이 없어
  // 아무도 지울 수 없게 된다 — "누구나 삭제 가능"보다는 안전한 쪽으로의 트레이드오프.
  if (!record.authorToken || record.authorToken !== authorToken) {
    return json({ error: '본인이 남긴 댓글만 삭제할 수 있어요.' }, 403);
  }
  await env.REVIEWS.delete(key);
  return json({ ok: true });
}

// ============ 채널이 없는 구내식당(예: 인스타그램에만 올리는 곳)용 수동 메뉴 사진 ============
// 카카오톡 채널/공개 API가 없는 식당은 자동 수집이 불가능해서, 사람이 그날 아침 사진 하나를
// 직접 붙여넣어 등록한다. 식당(placeId)당 항상 "가장 최근에 올린 사진 하나"만 의미가 있어서
// review:처럼 여러 개를 쌓아두지 않고 매번 덮어쓴다. date는 KST 기준으로 저장해두고, 조회
// 시점에 오늘 날짜와 다르면 "없음"으로 취급한다 — 사용자가 깜빡하고 안 올린 날 어제 사진이
// 오늘자인 것처럼 잘못 표시되는 걸 막기 위함(수동 등록은 자동추정과 달리 애매하게 보여주는
// 것보다 아예 안 보여주는 쪽이 낫다 — 사람이 매일 직접 확인해서 올리는 기능이라서).
function cafeteriaManualKey(placeId) { return 'cafeteria-manual:' + placeId; }

async function handleUploadCafeteriaManualPhoto(request, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength && contentLength > REVIEW_MAX_BODY_BYTES) {
    return json({ error: '사진이 너무 커요 (최대 3MB).' }, 413);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.placeId) {
    return json({ error: '잘못된 요청입니다 (placeId 필요).' }, 400);
  }
  if (typeof body.photo !== 'string' || !REVIEW_PHOTO_DATA_URL_RE.test(body.photo)) {
    return json({ error: '지원하지 않는 이미지 형식입니다.' }, 400);
  }
  if (body.photo.length > REVIEW_MAX_BODY_BYTES) {
    return json({ error: '사진이 너무 커요 (최대 3MB).' }, 413);
  }

  const record = {
    placeId: String(body.placeId),
    photo: body.photo,
    date: getKstDateString(),
    uploadedAt: Date.now(),
  };
  await env.REVIEWS.put(cafeteriaManualKey(record.placeId), JSON.stringify(record));
  return json({ ok: true, date: record.date });
}

async function handleGetCafeteriaManualPhoto(url, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);
  const placeId = (url.searchParams.get('placeId') || '').trim();
  if (!placeId) return json({ error: 'placeId 쿼리 파라미터가 필요합니다.' }, 400);

  const raw = await env.REVIEWS.get(cafeteriaManualKey(placeId));
  const record = raw ? JSON.parse(raw) : null;
  if (!record || record.date !== getKstDateString()) {
    return json({ found: false }, 200, { 'Cache-Control': 'no-store' });
  }
  return json(
    { found: true, imageUrl: record.photo, source: 'manual', uploadedAt: record.uploadedAt },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

// ============ 주간 식단표(요일별 5칸) — 인스타그램처럼 하루 한 장이 아니라 주 단위로만 ============
// ============ 올리는 구내식당용 ============
// cafeteria-manual:과 같은 REVIEWS KV를 재사용하되, 요일별로 독립된 키를 쓴다(한 주 안에서
// 며칠은 지금 올리고 나머지는 나중에 채워도 서로 덮어쓰지 않도록). weekOf(그 주 월요일 날짜)가
// 이번 주와 정확히 일치할 때만 유효로 취급해서, 업데이트를 깜빡한 주엔 지난주 걸 잘못 보여주지
// 않고 "없음"으로 처리한다(cafeteria-manual:의 "오늘 날짜 아니면 안 보여줌" 철학을 주 단위로
// 그대로 확장한 것).
function cafeteriaWeeklyKey(placeId, weekday) { return 'cafeteria-weekly:' + placeId + ':' + weekday; }
const CAFETERIA_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

async function handleUploadCafeteriaWeeklyPhoto(request, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength && contentLength > REVIEW_MAX_BODY_BYTES) {
    return json({ error: '사진이 너무 커요 (최대 3MB).' }, 413);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.placeId) {
    return json({ error: '잘못된 요청입니다 (placeId 필요).' }, 400);
  }
  if (CAFETERIA_WEEKDAYS.indexOf(body.weekday) === -1) {
    return json({ error: 'weekday는 mon/tue/wed/thu/fri 중 하나여야 합니다.' }, 400);
  }
  if (typeof body.photo !== 'string' || !REVIEW_PHOTO_DATA_URL_RE.test(body.photo)) {
    return json({ error: '지원하지 않는 이미지 형식입니다.' }, 400);
  }
  if (body.photo.length > REVIEW_MAX_BODY_BYTES) {
    return json({ error: '사진이 너무 커요 (최대 3MB).' }, 413);
  }

  const record = {
    placeId: String(body.placeId),
    weekday: body.weekday,
    photo: body.photo,
    weekOf: getKstMondayDateString(),
    uploadedAt: Date.now(),
  };
  await env.REVIEWS.put(cafeteriaWeeklyKey(record.placeId, record.weekday), JSON.stringify(record));
  return json({ ok: true, weekOf: record.weekOf });
}

async function handleGetCafeteriaWeeklyPhoto(url, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);
  const placeId = (url.searchParams.get('placeId') || '').trim();
  if (!placeId) return json({ error: 'placeId 쿼리 파라미터가 필요합니다.' }, 400);

  const weekday = getKstWeekdayKey();
  if (CAFETERIA_WEEKDAYS.indexOf(weekday) === -1) {
    // 주말 — 애초에 저장된 적도 없는 요일이라 조회할 필요도 없이 "없음"
    return json({ found: false }, 200, { 'Cache-Control': 'no-store' });
  }

  const raw = await env.REVIEWS.get(cafeteriaWeeklyKey(placeId, weekday));
  const record = raw ? JSON.parse(raw) : null;
  if (!record || record.weekOf !== getKstMondayDateString()) {
    return json({ found: false }, 200, { 'Cache-Control': 'no-store' });
  }
  return json(
    { found: true, imageUrl: record.photo, source: 'weekly', weekday, weekOf: record.weekOf, uploadedAt: record.uploadedAt },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

// 요일 5칸 전체의 "이번 주에 등록됐는지" 여부만 가볍게 반환한다(사진 자체는 안 내려줌 — 이건
// 등록 여부 표시용이라 이미지 데이터까지 옮길 필요가 없다).
async function handleGetCafeteriaWeeklyStatus(url, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);
  const placeId = (url.searchParams.get('placeId') || '').trim();
  if (!placeId) return json({ error: 'placeId 쿼리 파라미터가 필요합니다.' }, 400);

  const weekOf = getKstMondayDateString();
  const days = {};
  await Promise.all(
    CAFETERIA_WEEKDAYS.map(async (weekday) => {
      const raw = await env.REVIEWS.get(cafeteriaWeeklyKey(placeId, weekday));
      const record = raw ? JSON.parse(raw) : null;
      days[weekday] = !!(record && record.weekOf === weekOf);
    })
  );
  return json({ weekOf, days }, 200, { 'Cache-Control': 'no-store' });
}

// 네이버 place 메뉴 페이지(SSR)를 가져와 __APOLLO_STATE__에서 메뉴 항목을 추출한다.
// 캐시 키에 파싱 스키마 버전을 넣어둔다 — 안 넣으면 네이버 페이지 구조가 바뀌어 파싱
// 로직을 고쳐도, 예전 로직으로 캐싱된 응답(최대 24시간)이 새 코드에 도달하기도 전에
// 그대로 반환되어 배포해도 안 고쳐진 것처럼 보이는 문제가 생긴다.
// v3: 대표 사진(representativePhotoUrl) 필드 추가 (2026-09-22, 텐진라멘 등에서 naverPlaceId가
// 등록된 식당은 대표사진이 항상 없던 문제 수정 — 이 라우트에 그 필드가 아예 없었던 게 원인).
const NAVER_MENU_SCHEMA_VERSION = 'v3';
async function handleNaverMenu(naverPlaceId) {
  if (!/^\d+$/.test(naverPlaceId)) {
    return json({ error: 'naverPlaceId는 숫자만 가능합니다.' }, 400);
  }

  const cache = caches.default;
  const cacheUrl = 'https://kakao-menu-proxy.internal/naver-menu?id=' + naverPlaceId + '&schema=' + NAVER_MENU_SCHEMA_VERSION;
  const cacheKey = new Request(cacheUrl);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const pageUrl = 'https://pcmap.place.naver.com/restaurant/' + naverPlaceId + '/menu/list';
  let resp;
  try {
    resp = await fetch(pageUrl, {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ko-KR,ko;q=0.9',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      },
    });
  } catch (e) {
    return json({ error: '네이버 페이지 요청 실패', detail: String(e) }, 502);
  }
  if (!resp.ok) {
    return json({ error: `naver page status ${resp.status}` }, 502);
  }

  const html = await resp.text();
  const m = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (!m) {
    return json({ error: 'APOLLO_STATE not found (페이지 구조가 바뀌었을 수 있음)' }, 502);
  }

  let apollo;
  try {
    apollo = JSON.parse(m[1]);
  } catch (e) {
    return json({ error: 'APOLLO_STATE 파싱 실패', detail: String(e) }, 502);
  }

  // 2026-09 기준 네이버 place 페이지는 메뉴 항목의 __typename을 'Menu'에서
  // 'PlaceMenuItem'으로 바꿨고(가격도 'PlaceMenuPrice'로 분리, 표시용 문자열만 제공),
  // 항목 나열 순서/추천 여부는 'PlaceMenuCategory'(kind: 'uncategorized'/'recommend')의
  // itemIds를 통해서만 알 수 있다.
  const values = Object.keys(apollo).map((k) => apollo[k]);
  const itemsById = {};
  values
    .filter((v) => v && v.__typename === 'PlaceMenuItem')
    .forEach((it) => { itemsById[it.id] = it; });

  const categories = values.filter((v) => v && v.__typename === 'PlaceMenuCategory');
  const orderCategory = categories.find((c) => c.kind === 'uncategorized') || categories[0];
  const orderedIds = orderCategory ? orderCategory.itemIds : Object.keys(itemsById);
  const recommendCategory = categories.find((c) => c.kind === 'recommend');
  const recommendIds = new Set(recommendCategory ? recommendCategory.itemIds : []);

  const menuItems = orderedIds.map((id) => itemsById[id]).filter(Boolean);

  // 대표 사진: 'PlaceDetailTopPhotoItem'이 상단 사진탭 항목이다(2026-09-22, 텐진라멘/1503592037로
  // 직접 확인 — naverPlaceId가 등록된 식당은 이 라우트가 우선돼 카카오 대표사진 폴백을 아예 안 타서,
  // 여기에도 같은 기능이 없으면 실제로 사진이 있는 식당도 항상 색블록으로만 보이는 문제가 있었음).
  // mediaSource가 'business'(사장님이 직접 등록)면 리뷰 사진보다 신뢰도가 높아 최우선하고, 없으면
  // 방문자 리뷰 사진(aiView/placeReview 등) 중 첫 장으로 폴백한다. video(클립)는 사진이 아니므로 제외.
  const topPhotos = values.filter((v) => v && v.__typename === 'PlaceDetailTopPhotoItem' && v.mediaFormat === 'image');
  const businessPhoto = topPhotos.find((v) => v.mediaSource === 'business');
  const representativePhotoUrl = (businessPhoto || topPhotos[0])?.originalUrl
    || (businessPhoto || topPhotos[0])?.thumbnailUrl
    || null;

  const result = {
    placeId: naverPlaceId,
    items: menuItems.map((it) => {
      const priceDigits = it.price && it.price.displayText
        ? it.price.displayText.replace(/[^0-9]/g, '')
        : '';
      return {
        name: it.name,
        price: priceDigits ? Number(priceDigits) : null,
        isRecommend: (Array.isArray(it.badges) && it.badges.indexOf('repr') !== -1) || recommendIds.has(it.id),
        recommendReasons: [],
        description: it.description || null,
        photoUrl: it.thumbnailUrl || (it.images && it.images[0] && it.images[0].url) || null,
      };
    }),
    representativePhotoUrl,
  };

  const response = json(result, 200, {
    'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
  });
  await cache.put(cacheKey, response.clone());
  return response;
}
