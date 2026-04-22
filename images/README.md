# 이미지 에셋

브라우저·소셜 공유용 브랜드 자산입니다. 모두 자동 생성되었으며 추가 업로드는 필요 없습니다.

| 파일 | 용도 | 참조 위치 |
| --- | --- | --- |
| `favicon.svg` | 브라우저 탭 아이콘 (벡터) | `<link rel="icon">` |
| `apple-touch-icon.png` | iOS 홈화면 추가 시 아이콘 (360×360) | `<link rel="apple-touch-icon">` |
| `og-image.png` (1200×630) | 카카오톡·페이스북·트위터 공유 썸네일 | `<meta property="og:image">` |
| `og-image.jpg` | 동일 규격 JPG (용량 대안) | 필요 시 og:image 경로 교체 |

## 재생성하려면

브랜드 카피나 색상이 바뀌면 OG 이미지를 다시 만들어야 합니다. Playwright가 설치된 환경에서 HTML 템플릿을 1200×630으로 스크린샷해 `og-image.png`를 교체하는 방식이 가장 간단합니다.

향후 관장·시설 사진을 게시하게 되면 이 폴더에 파일을 추가하고 `index.html`의 해당 섹션에 `<img>` 태그를 삽입하면 됩니다.
