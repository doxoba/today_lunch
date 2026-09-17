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

    // 네이버 플레이스 메뉴 조회. 네이버 지역검색 API는 place id를 안 주기 때문에(공식 API의
    // 근본적 한계로 확인됨) 자동 매칭은 포기하고, 사용자가 앱에서 직접 입력해둔 네이버 place id로만
    // 호출한다. place.naver.com/restaurant/{id}/menu/list 페이지는 SSR이라 카카오처럼 CORS로
    // 막혀있지 않고, window.__APOLLO_STATE__ 안에 메뉴 데이터(이름/가격/대표메뉴 여부)가 그대로
    // 박혀서 온다 — 그걸 파싱해서 카카오 메뉴 응답과 동일한 스키마로 맞춰 반환한다.
    const naverPlaceId = url.searchParams.get('naverPlaceId');
    if (naverPlaceId) {
      return handleNaverMenu(naverPlaceId);
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
};

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
