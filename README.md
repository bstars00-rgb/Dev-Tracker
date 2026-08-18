# OHMY Dev Tracker

한 페이지짜리 **읽기 전용** Dev Tracker 화면. 엑셀이 원본이고, 이 화면은 그걸 보기 좋게 보여줄 뿐입니다.

- 로그인 없음, 데이터베이스 없음, 서버 없음
- `index.html` 더블클릭하면 바로 열림 (인터넷 연결도 불필요)
- GitHub Pages로 자동 배포 — 팀은 링크 하나만 있으면 됩니다

**링크:** https://bstars00-rgb.github.io/Dev-Tracker/

---

## 업데이트 (엑셀이 원본)

### 방법 A — 엑셀만 바꿔서 푸시 (권장)

1. `data/Dev_Schedule.xlsx` 를 최신 파일로 교체 — **파일명은 그대로**
2. 커밋 & 푸시

GitHub Actions가 변환하고 배포합니다. **Node.js 설치 필요 없습니다.**
1~2분 뒤 링크에 반영됩니다. 진행 상황은 저장소 **Actions** 탭에서 볼 수 있습니다.

### 방법 B — 올리기 전에 로컬에서 확인

1. `data/Dev_Schedule.xlsx` 교체
2. **`update.bat` 더블클릭** → 변환되고 화면이 자동으로 열림
3. 확인되면 커밋 & 푸시

이 방법은 Node.js가 필요합니다 ([nodejs.org](https://nodejs.org) LTS). `update.bat` 이 첫 실행 때 안내합니다.

> **엑셀 규칙:** 파일명 `Dev_Schedule.xlsx`, 시트명 `Dev Tracker`, 헤더 3행.
> 컬럼명이 바뀌면 [`scripts/build.mjs`](scripts/build.mjs) 맨 위 목록만 고치면 됩니다.
> 시트가 깨지면 Actions가 배포를 막고 에러로 알려줍니다.

---

## 최초 1회 설정

저장소 **Settings → Pages → Source: GitHub Actions** 로 지정.
그 다음부터는 푸시할 때마다 자동입니다.

원본 엑셀은 배포 산출물에서 제외되므로 사이트에서 직접 다운로드되지는 않습니다.
다만 저장소가 Public이면 저장소 자체를 통해 접근할 수 있습니다.

사내에서만 쓰고 싶으면 이 폴더를 공유드라이브에 복사해도 똑같이 동작합니다.
화면에 필요한 파일은 `index.html`, `styles.css`, `app.js`, `data/tracker.js` 네 개뿐입니다.

---

## 화면에서 할 수 있는 것

| | |
|---|---|
| 상단 타일 | 클릭하면 그 조건으로 필터 (Live / 개발중 / 주의 필요 / 90일+ 방치 등) |
| 검색 | 파트너·PIC·카테고리·단계 검색. `/` 키로 포커스, `Esc` 로 해제 |
| 필터 | Status · Category · PIC · 활동상태 조합 가능 |
| 정렬 | 컬럼 헤더 클릭 |
| Stage track | 11단계를 칸으로 표시 — 채워진 칸이 날짜가 기록된 단계, 마우스 올리면 날짜 |
| 행 클릭 | 11단계 날짜 전체 펼쳐보기 |
| Export CSV | 지금 화면에 보이는 것만 CSV로 (엑셀에서 바로 열림) |

**기본 정렬은 "손이 필요한 순"입니다.** 90일+ 방치 → 30일+ → 14일+ → 기록없음 → 정상 → Live 순으로,
같은 그룹 안에서는 진행률이 높은 것부터. 이미 Live인 건은 오래됐어도 맨 아래로 갑니다 — 멈춘 게 아니라 끝난 것이니까요.

**경과일은 엑셀 값을 쓰지 않고 오늘 기준으로 다시 계산합니다.** 시트의 `Days Elapsed` 가 낡아도 화면은 항상 정확합니다.

색: 14일 이내 회색 · 15~30일 주황 · 31~90일 진한 주황 · 90일 초과 빨강 · 활동기록 없음 빨강 `never` · Live 초록.
다크모드는 OS 설정을 따라갑니다.

---

## 파일 구성

```
index.html            화면 구조
styles.css            스타일
app.js                필터 · 정렬 · 검색 · CSV
data/
  Dev_Schedule.xlsx   ← 원본. 이것만 교체하면 됨
  tracker.js          자동 생성 — 화면이 읽는 파일
  tracker.json        자동 생성 — 다른 도구에서 쓸 원본 데이터
scripts/build.mjs     엑셀 → JSON 변환기
scripts/serve.mjs     로컬 미리보기 (npm run preview)
update.bat            더블클릭용
```

`tracker.js` / `tracker.json` 은 자동 생성물이지만 **커밋해 두세요.** 그래야 clone 하거나
폴더를 복사한 사람이 아무것도 실행하지 않고 바로 볼 수 있습니다.
