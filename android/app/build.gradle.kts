import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.lzm.guide"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.lzm.guide"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        // onnxruntime 的 aar 带四个 ABI，每个十几 MB；只留 arm64，不然 APK 撑过 30 MB。
        // 代价是 32 位机装不上（这台 App 只给自己的 vivo 用，它是 arm64）。
        ndk { abiFilters += "arm64-v8a" }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // ⚠️ 别删：minSdk ≥ 23 时 AGP 默认把 .so 不压缩、页对齐地放进 APK，libonnxruntime.so 原样 19 MB 全算进 APK。
    // 压缩存放（安装时解出来）只占三分之一多，代价只是装机后多占一份解压的空间。
    packaging { jniLibs { useLegacyPackaging = true } }

    // 页面源码就是 ../../web，直接当 assets 目录用，不拷贝：改完页面重新打包即可，不会有两份对不上。
    // OCR 模型同理直接用 ../../models（与 tools/ocr_fixture.py 跑基准的是同一批文件），落在 assets 根上。
    sourceSets["main"].assets.srcDirs("../../web", "../../models")
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // Java API，免 NDK。⚠️ 别顺手升级到 Python 基准用的 1.32.0（2026-11-26 逐版拆 aar 核对）：
    // - 1.29.0 起 aar 的清单自带 INTERNET 权限 + 开机即加载 36 MB .so 的遥测 ContentProvider，
    //   会悄悄给这个「不联网」的 App 加上联网权限；
    // - 1.24 起 arm64 的 libonnxruntime.so 从 19 MB 涨到 26–36 MB，1.32.0 实测 APK 30.02 MiB，超出 30 MB 预算。
    // 端上跑的是 ARM 内核，本来就不可能和 x86 上的 Python 逐位一致，版本对齐换不来什么。
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.23.2")
}
