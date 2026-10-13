plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 서명 키는 저장소 밖(~/.gradle/gradle.properties)에 둔다. 없으면 서명 없는 릴리스가 만들어진다.
val releaseStoreFile: String? = providers.gradleProperty("CHOIDEV_RELEASE_STORE_FILE").orNull

// 화면은 ui/의 Vite 빌드 결과를 그대로 싣는다. 빌드 때마다 assets/ui/로 복사한다.
abstract class CopyUiAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val uiDist: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        val dist = uiDist.get().asFile
        if (!dist.resolve("index.html").isFile) {
            throw GradleException("UI 빌드가 없습니다: corepack pnpm --dir .. build")
        }

        fs.sync {
            from(dist)
            into(outputDir.dir("ui"))
        }
    }
}

android {
    namespace = "com.choidev.choibuddy"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.choidev.choibuddy"
        minSdk = 26
        targetSdk = 36
        versionCode = 40
        versionName = "0.9.4"
    }

    signingConfigs {
        create("release") {
            if (releaseStoreFile != null) {
                storeFile = file(releaseStoreFile)
                storePassword = providers.gradleProperty("CHOIDEV_RELEASE_STORE_PASSWORD").orNull
                keyAlias = providers.gradleProperty("CHOIDEV_RELEASE_KEY_ALIAS").orNull
                keyPassword = providers.gradleProperty("CHOIDEV_RELEASE_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseStoreFile != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    // 앱이 지원하는 언어(기본 영어, 한국어, 일본어, 프랑스어). 라이브러리의 다른 언어 문자열은 빼서 APK를 줄인다.
    androidResources { localeFilters += listOf("en", "ko", "ja", "fr") }

    // 알림 언어는 기기 언어와 따로 앱 안에서 고른다. AAB로 올려도 네 언어가 모두 설치되게 언어별로 나누지 않는다.
    bundle { language { enableSplit = false } }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
    }

    // 위젯 그리기 테스트(Robolectric)가 레이아웃·문구·그림 리소스를 읽는다.
    testOptions { unitTests { isIncludeAndroidResources = true } }
}

androidComponents {
    onVariants { variant ->
        val copy = tasks.register<CopyUiAssets>("copy${variant.name.replaceFirstChar(Char::uppercase)}UiAssets") {
            uiDist.set(rootProject.layout.projectDirectory.dir("../ui/dist"))
        }
        variant.sources.assets?.addGeneratedSourceDirectory(copy, CopyUiAssets::outputDir)
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // 카메라 권한 없이 Play 서비스의 QR 스캐너 화면을 빌려 쓴다.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    // 스캐너(play-services-base)가 끌어오는 fragment 1.0.0 대신 Activity Result API와 맞는 판.
    implementation("androidx.fragment:fragment:1.8.9")

    testImplementation("junit:junit:4.13.2")
    // 앱은 Android 내장 org.json으로 읽는다. JVM 테스트에는 같은 API의 실제 구현을 붙인다.
    testImplementation("org.json:json:20250517")
    // 홈 화면 위젯을 실제 Android 그리기 코드로 PNG에 그려 확인한다(기기 없이).
    testImplementation("org.robolectric:robolectric:4.14.1")
}
