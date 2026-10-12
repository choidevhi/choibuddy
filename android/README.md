# ChoiBuddy Android

PC에서 돌아가는 Claude Code가 지금 무엇을 하는지(캐릭터, 진행 단계, 코드 미리보기) 폰에서 보고,
권한 요청을 폰에서 허용·거부하는 ChoiBuddy의 안드로이드 앱이다.

화면은 `../ui`의 웹 앱(Vite 빌드)을 그대로 WebView에 띄우고, 앱은 얇은 네이티브 껍데기만 맡는다.

- **화면**: `https://appassets.androidplatform.net/assets/ui/index.html` (APK 안의 `assets/ui/`를 `WebViewAssetLoader`로 연다)
- **JS 인터페이스** `window.ChoiBuddyNative`: PC 목록(`getConfigs`, `setPairing`, `removePairing`, `unpair`), QR 스캔,
  화면 켜 둠, 알림 권한·설정, 알림 언어(`setLanguage`), 클립보드 사진(`clipboardImage`), 사진 저장(`saveImage`)
- **연결 서비스** `BridgeService`: 짝지은 PC마다 `/api/events`(SSE)를 하나씩 붙잡고, 앱이 꺼져 있을 때 승인 요청·작업 끝을 알림으로 띄운다.
  권한 요청 알림에는 [허용] [거부] 버튼이 있고, 결정은 그 요청을 보낸 PC로 간다.
- **첨부**: 화면의 `<input type="file">`은 시스템 문서 선택기나 카메라(사진 찍기)로 채운다. 카메라 권한은 쓰지 않는다.
- **사진**: `clipboardImage()`는 클립보드의 사진(20MB까지)을 `{"name","mime","data"(base64)}` JSON으로, 없으면 `null`을 준다.
  `saveImage(base64, name, mime)`은 `Pictures/ChoiBuddy`에 저장하고 토스트로 알린다. Android 10 이상은 권한이 필요 없고,
  9 이하만 처음 저장할 때 저장소 권한을 묻는다(묻는 동안은 `false`, 허락하면 이어서 저장한다).

## 언어

알림·토스트 같은 네이티브 문구는 영어(기본), 한국어, 일본어, 프랑스어로 나온다(`res/values*/strings.xml`).
UI가 `setLanguage("ko" | "en" | "ja" | "fr")`를 부르기 전에는 시스템 언어를 따르고, 바꾸면 상시 알림과 채널 이름도 그 언어로 다시 올린다.
브리지가 보내는 알림 `text`는 내용(명령, Claude의 답, 오류)뿐이라 문구는 앱이 붙인다(`Notices.kt`).

## 빌드

먼저 UI를 빌드한다. 안드로이드 빌드는 `../ui/dist`를 APK의 `assets/ui/`로 복사하고, 없으면 멈춘다.

```powershell
corepack pnpm --dir .. build
.\gradlew.bat --no-daemon testReleaseUnitTest assembleRelease lintRelease
```

- 결과: `app\build\outputs\apk\release\app-release.apk` (배포용 사본은 `dist\ChoiBuddy-<버전>.apk`)
- 릴리스 서명 키는 저장소 밖 `~/.gradle/gradle.properties`의
  `CHOIDEV_RELEASE_STORE_FILE`, `_STORE_PASSWORD`, `_KEY_ALIAS`, `_KEY_PASSWORD`로 넣는다. 없으면 서명 없는 APK가 나온다.
- JDK 21이 필요하다. `JAVA_HOME`을 JDK 21로 두고 빌드한다.

## 연결(페어링)

1. PC와 폰을 같은 Tailscale 네트워크(tailnet)에 넣는다.
2. PC에서 브리지와 ChoiBuddy PC 앱을 켜면 연결 QR이 보인다.
   QR 내용은 `choibuddy://pair?u=<브리지 주소>&t=<토큰>`이다.
3. 폰 앱에서 **QR로 연결**을 눌러 찍는다(카메라 권한 없이 Play 서비스 스캐너를 쓴다).
   QR 대신 링크를 붙여 넣어도 된다. 다른 앱·웹 페이지에서 링크로 앱을 열면 "이 PC를 연결할까요?"를 먼저 묻는다.
4. 연결되면 알림 줄에 `PC와 연결됨 · 세션 N개`(여러 대면 `PC 2대 연결됨 · 세션 N개`)가 상시로 뜬다.
   Android 13 이상에서는 앱이 알림 권한을 물으면 허용해야 승인 요청 알림이 뜬다.

PC는 여러 대 연결할 수 있다. 같은 주소로 다시 연결하면 그 PC의 기기 코드만 바뀐다.
PC에서 기기 코드를 취소하면 그 주소는 401을 받고, 상시 알림에 "<호스트> 연결 코드가 맞지 않아요"가 뜬다.
두 주소가 같은 `pcId`를 알려 오면 같은 PC로 보고 요청 하나에 알림 하나만 띄운다.

받는 링크 조건: `u`는 경로 없는 `http(s)://호스트:포트`, `t`는 16자 이상(공백·제어 문자 없음).

## 구조

| 파일 | 하는 일 |
| --- | --- |
| `MainActivity.kt` | WebView, 딥 링크(확인 창), QR 스캔, 화면 켜 둠, 알림 권한 |
| `FileChooser.kt` | `<input type="file">`: 문서 선택기, 사진 찍기(FileProvider) |
| `Photos.kt` | 클립보드 사진 읽기, `Pictures/ChoiBuddy`에 사진 저장(MediaStore) |
| `NativeBridge.kt` | `window.ChoiBuddyNative` 메서드 |
| `BridgeService.kt` | 포그라운드 서비스, PC마다 연결 하나, 상태 알림, 이벤트 → 알림 |
| `BridgeConnection.kt` | SSE 연결과 재연결(1초→30초) |
| `Bridge.kt` | HTTP 클라이언트, `/api/decide` |
| `Notifications.kt` | 알림 채널(연결 상태·승인 요청·작업 알림)과 알림 만들기 |
| `DecisionReceiver.kt` | 알림의 [허용]/[거부] |
| `BootReceiver.kt` | 부팅·앱 업데이트 뒤 서비스 다시 시작 |
| `Localized.kt` | 고른 언어의 Context와 strings.xml 문구 |
| `Pairing.kt`, `Sse.kt`, `Wire.kt`, `Notices.kt`, `Fleet.kt`, `FileAccept.kt`, `ImageFiles.kt`, `Language.kt` | 안드로이드 없이 JVM 테스트하는 로직 |
