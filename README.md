# 🍽️ Lunch Menu Recommender

**"오늘 뭐 먹지 고민 끝"** — A smart lunch recommendation tool for the Gasan Digital office complex area in Seoul.

## Overview

This tool helps you decide what to eat for lunch by recommending nearby restaurants based on your mood and preferences. It features:

- **Smart filtering**: Multi-select by food type (면/밥/국물), taste level (매운맛/순한맛), and cuisine (한식/중식/일식/양식)
- **Adjustable radius**: Pick a search radius from 100m to 500m in 100m steps (default 300m); changing it re-searches immediately
- **Live restaurant data**: Real-time search using Kakao Maps API, adaptively subdividing the search area so dense areas (like Gasan) don't silently lose restaurants to Kakao's 45-result cap
- **Intelligent filtering**: Automatically filters to restaurants on the west side of Seoul Metro Line 1 only
- **Rich menus**: Shows recommended menu + alternative menu items for each restaurant
- **Interactive map**: Visualize selected restaurants and walking distance estimates
- **Manual curation**: Override automatic categorization with customizable tags and menu data
- **Persistent preferences**: All user edits saved to browser local storage

## Quick Start

### Basic Usage
1. Open `lunch-recommender.html` in a web browser
2. (Optional) Select filter criteria using the condition panel on the left
3. Click "오늘 뭐 먹지?" (What should I eat today?) to get a recommendation
4. View the map, menu details, and recommended dish
5. Use "다시 뽑기" to get another recommendation

### Configuration

You need to add your Kakao Maps JavaScript API key:

1. Get a key from [Kakao Developers Console](https://developers.kakao.com)
2. Open `lunch-recommender.html` and find the `CONFIG` section near the top
3. Replace `'YOUR_KAKAO_JAVASCRIPT_KEY'` with your actual key:
   ```javascript
   CONFIG.KAKAO_JS_KEY = 'your-actual-key-here'
   ```

4. **Important**: Register your deployment domain(s) in Kakao Developers Console:
   - For local testing: `http://localhost:8000` (or your port)
   - For GitHub Pages: `https://yourusername.github.io`
   - For custom domain: `https://yourdomain.com`
   
   If domains aren't registered, the app falls back to demo data mode (red banner at top).

## Technical Details

### Architecture

```
lunch-recommender.html (single file, no build step)
├── HTML structure (filterable conditions, result card, map panel)
├── CSS styling (3-column responsive grid layout)
└── JavaScript logic
    ├── Kakao SDK integration (live API calls)
    ├── Restaurant filtering & randomization
    ├── Menu data management (localStorage)
    └── Map rendering & interaction
```

### Key Components

**Kakao Maps Integration**
- `Geocoder`: Converts office address to coordinates
- `Places.categorySearch()`: Finds restaurants within the user-selected radius (100–500m), via `deepCategorySearch` — recursively subdividing any circle that hits Kakao's 45-result cap until it doesn't (or a depth/min-radius limit is reached)
- `Places.keywordSearch()`: Detects Line 1 boundary points for west-side filtering
- Cross-product algorithm: Mathematically determines which side of Line 1 each restaurant is on

**Data Flow**
- Live restaurants from Kakao API
- Menu categorization via keyword rules (~20 heuristics)
- User overrides stored in `localStorage` by restaurant ID
- Edits persist across re-searches

**Fallback Mode**
- If Kakao SDK fails to load (e.g., CSP restrictions on Claude Artifact), automatically switches to demo data
- Red banner warns when in demo mode
- No user interaction needed — seamless fallback

### Reference Coordinates

- **Office location**: 서울 금천구 가산디지털1로 136
- **Search radius**: user-selectable, 100–500m in 100m steps (default 300m; saved to `localStorage`)
- **Filter boundary**: Seoul Metro Line 1 (automatic via cross-product calculation)

### Data Structure

Result card displays:
```javascript
{
  name: 'Restaurant Name',
  category: '중식',           // e.g., Chinese
  type: '면요리',             // e.g., noodles
  distance: 90,              // meters
  walkMinutes: 2,            // estimated walking time
  recommendedMenu: 'Dish',   // primary recommendation
  otherMenus: ['Menu1', 'Menu2', ...],
  kakao: {
    placeId: '...',
    placeUrl: '...',         // "지도에서 보기"
    directionsUrl: '...'     // "길찾기"
  }
}
```

## Deployment

### Local Testing
```bash
# Python 3
python -m http.server 8000

# Node.js
npx http-server .
```
Then visit `http://localhost:8000/lunch-recommender.html`

### GitHub Pages

1. Push to your repository
2. Enable GitHub Pages in Settings → Pages → Deploy from branch
3. Select `main` branch and `/root`
4. Register `https://yourusername.github.io` in Kakao Developers

### Custom Domain
Register your domain in Kakao Developers Console and deploy as needed.

## Features & Editing

### Restaurant List Management

The accordion panel at the bottom shows all nearby restaurants:
- View restaurant details (name, category, distance, menus)
- Edit tags, recommended dish, and other menu items
- Toggle inclusion/exclusion for boundary corrections
- All changes saved to local storage

### Filter Categories

**Food Type (형태)**: 면 · 밥 · 국물 · 구이 · 튀김 · 분식 · 기타

**Taste Level (맛)**: 매운맛 · 순한맛 · 보통

**Cuisine (종류)**: 한식 · 중식 · 일식 · 양식 · 카페-디저트 · 기타

All filters are optional (multi-select). Leave empty to see all restaurants.

## Design & Styling

- **Layout**: 3-column grid (1180px default) → responsive single-column (< 1024px)
- **Typography**: Pretendard font family
- **Accent color**: Deep teal (#1f8a70)
- **Tokens**: See `UI-REDESIGN-SPEC.md` for complete design system

## Known Limitations

1. **Kakao 45-item cap**: The Places API returns max 45 results per 3 pages for any single search circle. Gasan Digital Complex is dense enough to hit this even at 200m radius — verified directly against the Kakao REST API, the old fixed 5-point grid missed 44% of in-radius restaurants at 400m and 59% at 500m. The app now recursively subdivides any capped circle (`deepCategorySearch`) until it isn't, which matched the ground truth in testing up to 500m. If an extremely dense area still hits the depth/min-radius limit while capped, the UI shows a "누락 가능성" warning in the restaurant list panel and reports the total count found so you can sanity-check against Naver/Kakao Maps yourself.
   - Workaround: Use filters, manually add via the list panel, or reduce the radius

2. **No menu data from API**: Kakao Places API doesn't provide menu information.
   - Solution: App uses keyword-based heuristics + user edits (localStorage)

3. **Data freshness**: Restaurant closures/reopenings may not reflect immediately.
   - Recommendation: Verify on the map link before visiting

4. **Demo mode on Claude Artifact**: Due to CSP restrictions, the Claude Artifact version always shows demo data.
   - Real data: Deploy from GitHub Pages or own domain

5. **Email verification issue**: The original `qoxoba/notion` repo sync is blocked by email authentication.
   - Status: Currently using `doxoba/vibecoding` as the canonical repository

## API Keys & Secrets

**Kakao JavaScript Key**: `9394ac1268768ad4accfdf8623a92f16`
- Used for: Geocoder, Places API, Map rendering
- Location: Set in `CONFIG.KAKAO_JS_KEY` inside HTML

*Note: REST API key is not needed for this app*

## TODO

- [ ] Fill in actual Kakao key in `CONFIG.KAKAO_JS_KEY`
- [ ] Test locally after key setup
- [ ] Push to GitHub (`doxoba/vibecoding`)
- [ ] Enable GitHub Pages deployment
- [ ] Register GitHub Pages domain in Kakao Developers Console
- [ ] Verify live data appears (no red banner)
- [ ] Manually edit restaurant tags/menus based on real restaurant data
- [ ] Mark boundary restaurants with manual include/exclude toggles
- [ ] (Optional) Deploy to custom domain if needed

## Project Files

```
vibecoding/
├── README.md                    (this file)
├── lunch-recommender.html       (main app - single file)
├── UI-REDESIGN-SPEC.md         (design specification & token reference)
├── HANDOFF.md                  (project context for handoff)
└── .git/                        (git repository)
```

## Related Resources

- **Claude Artifact Preview**: https://claude.ai/code/artifact/31bc9d8b-acbd-44e1-92fc-1c3a5220b6d5 (demo data only due to CSP)
- **Kakao Developers**: https://developers.kakao.com
- **Deployed app** (once configured): `https://doxoba.github.io/lunch-recommender.html`

## Support & Questions

For issues or improvements:
1. Check if it's in the [Known Limitations](#known-limitations) section
2. Review `UI-REDESIGN-SPEC.md` for design & interaction details
3. See `HANDOFF.md` for additional technical context
4. Check browser console (F12) for debug logs during development

---

**Status**: ✅ Feature complete | ⏳ Awaiting deployment & Kakao key setup | 📝 Ready for menu curation

Made with ❤️ for the Gasan Digital office team.
