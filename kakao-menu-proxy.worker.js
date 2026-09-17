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

// ============ 구내식당/한식뷔페 "오늘의 메뉴" 이미지 (카카오톡 채널 프로필 사진) ============
// 많은 구내식당/한식뷔페는 그날그날 메뉴를 텍스트가 아니라 카카오톡 채널(플러스친구) 프로필
// 사진으로 올린다. pf.kakao.com/rocket-web/web/v2/profiles/{채널ID}는 실제로는 로그인 쿠키
// 없이도(직접 curl로 검증함, 2026-09-17) 200으로 프로필 이미지 URL을 내려주는 사실상 공개
// 엔드포인트라, 개인 로그인 세션에 의존하지 않고 이 Worker에서 안전하게 정기 호출할 수 있다.
// 문서화 안 된 내부 API라는 점은 panel3(메뉴)와 동일 — 구조가 바뀌면 조용히 실패할 수 있음.
const KAKAO_CHANNEL_PROFILE_API = 'https://pf.kakao.com/rocket-web/web/v2/profiles/';
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
const CAFETERIA_CHANNELS = ['_gdqxdn', '_NHxgEn', '_bXxkxhb', '_aKxdLs'];

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

    const placeId = url.searchParams.get('placeId');

    if (!placeId || !/^\d+$/.test(placeId)) {
      return json({ error: 'placeId 쿼리 파라미터가 필요합니다 (숫자만).' }, 400);
    }

    // Cloudflare Cache API로 응답 캐싱 (같은 placeId 반복 요청 시 카카오 재호출 방지)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
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

// _aKxdLs의 오늘자 포스트를 직접 열어보니 media[0]만 다른 포맷(.png, 다른 해상도)이고 나머지
// 6장은 동일 포맷 사진들(매장/음식 스냅샷으로 추정)이라, media[0]이 의도적으로 만든 메뉴판
// 이미지일 가능성이 높다 — 다만 한 채널·하루치 샘플로 확인한 가정이라 확정적 근거는 아니다.
// 다른 채널에서 이 가정이 깨지는 게 확인되면 이 함수만 고치면 된다.
function pickCafeteriaPostMedia(post) {
  const first = (post && post.media || [])[0];
  return (first && first.xlarge_url) ? first : null;
}

// 카카오 채널 프로필 응답에서 오늘의 메뉴 이미지를 뽑아낸다. 포스트형 패턴을 먼저 시도하고
// (제목에 오늘 날짜가 있는 게 확인되면 신뢰도가 가장 높음), 매칭되는 포스트가 없으면 기존
// 프로필 사진 경로로 그대로 폴백한다. profileCard.updated_at(카드 자체의 마지막 편집 시각 —
// 사업자 정보 등도 포함)은 "사진이 실제로 바뀐 시각"과 무관할 수 있다는 걸 실사용 중 확인함
// (2026-09-17: 사진은 당일 것인데 updated_at은 1년 전 날짜를 가리킨 사례). 그래서 이 필드는
// 참고용으로만 남겨두고, 실제 "언제 사진이 바뀌었는지" 판단은 applyCafeteriaChangeTracking()이
// profile_image_id 비교로 직접 추적한 값을 쓴다(포스트 경로는 published_at이 이미 신뢰
// 가능해서 이 추적이 필요 없다 — 호출부에서 source로 분기).
function parseCafeteriaProfile(data, channelId) {
  const cards = (data && data.cards) || [];
  const profileCard = cards.find((c) => c && c.type === 'profile');
  const profile = profileCard && profileCard.profile;
  const name = (profile && profile.name) || null;

  const postsCard = cards.find((c) => c && c.type === 'post');
  const matchedPost = pickTodayCafeteriaPost((postsCard && postsCard.posts) || [], getKstTodayMonthDay());
  if (matchedPost) {
    const media = pickCafeteriaPostMedia(matchedPost);
    if (media) {
      return {
        channelId,
        name,
        imageUrl: media.xlarge_url,
        source: 'post',
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
  return parseCafeteriaProfile(data, channelId);
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
  const tracked = result.source === 'post' ? result : await applyCafeteriaChangeTracking(env, result);
  const maxAge = tracked.source === 'post' ? CAFETERIA_POST_IMAGE_CACHE_SECONDS : CAFETERIA_IMAGE_CACHE_SECONDS;

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
      const tracked = result.source === 'post' ? result : await applyCafeteriaChangeTracking(env, result);
      const maxAge = tracked.source === 'post' ? CAFETERIA_POST_IMAGE_CACHE_SECONDS : CAFETERIA_IMAGE_CACHE_SECONDS;
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
  return { type: [], taste: [], cuisine: [] };
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
    createdAt: Date.now(),
  };
  await env.REVIEWS.put(reviewKey(record.placeId, id), JSON.stringify(record));
  return json({ ok: true, id });
}

async function handleListReviews(url, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);
  const placeId = (url.searchParams.get('placeId') || '').trim();
  if (!placeId) return json({ error: 'placeId 쿼리 파라미터가 필요합니다.' }, 400);

  // KV list()는 기본적으로 한 번에 최대 1000개 키까지만 반환한다(개인용 앱에서 가게 하나에
  // 댓글이 그만큼 쌓일 일은 없어서 페이지네이션은 생략).
  const listed = await env.REVIEWS.list({ prefix: reviewPrefix(placeId) });
  const reviews = await Promise.all(
    listed.keys.map((k) => env.REVIEWS.get(k.name).then((raw) => (raw ? JSON.parse(raw) : null)))
  );
  return json(
    { placeId, reviews: reviews.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt) },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

async function handleDeleteReview(request, env) {
  if (!env.REVIEWS) return json({ error: 'REVIEWS KV 바인딩이 설정되지 않았습니다.' }, 500);
  const body = await request.json().catch(() => null);
  if (!body || !body.placeId || !body.id) return json({ error: '잘못된 요청입니다.' }, 400);
  await env.REVIEWS.delete(reviewKey(String(body.placeId), String(body.id)));
  return json({ ok: true });
}

// 네이버 place 메뉴 페이지(SSR)를 가져와 __APOLLO_STATE__에서 Menu 타입 항목만 추출한다.
async function handleNaverMenu(naverPlaceId) {
  if (!/^\d+$/.test(naverPlaceId)) {
    return json({ error: 'naverPlaceId는 숫자만 가능합니다.' }, 400);
  }

  const cache = caches.default;
  const cacheUrl = 'https://kakao-menu-proxy.internal/naver-menu?id=' + naverPlaceId;
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

  const menuItems = Object.keys(apollo)
    .map((k) => apollo[k])
    .filter((v) => v && v.__typename === 'Menu')
    .sort((a, b) => (a.index || 0) - (b.index || 0));

  const result = {
    placeId: naverPlaceId,
    items: menuItems.map((it) => ({
      name: it.name,
      price: it.price != null && it.price !== '' ? Number(it.price) : null,
      isRecommend: !!it.recommend,
      recommendReasons: [],
      description: it.description || null,
      photoUrl: (it.images && it.images[0]) || null,
    })),
  };

  const response = json(result, 200, {
    'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
  });
  await cache.put(cacheKey, response.clone());
  return response;
}
