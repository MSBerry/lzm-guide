// 插件版本与仓库顺序照抄 metaXring/android/settings.gradle：同一组坐标 + 同一组仓库，
// ~/.gradle 里的缓存才能命中，--offline 才编得过。去掉的只有 jitpack 和内网 Nexus；
// 唯一新增的库 onnxruntime 走下面单独的阿里云仓库。
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("com.android.application") version "8.13.2"
        id("org.jetbrains.kotlin.android") version "2.2.0"
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // onnxruntime 只从阿里云镜像拉：metaXring 的缓存里没有它，首次构建要联网，直连 repo1 太慢。
        // 用 exclusiveContent 而不是加在末尾：加在末尾时 google() / mavenCentral() 会先各问一遍、各超时一遍；
        // 也不把镜像放成第一个全量仓库：那样其它库的缓存记在 mavenCentral 名下，--offline 时对不上号。
        exclusiveContent {
            forRepository { maven("https://maven.aliyun.com/repository/public") }
            filter { includeGroup("com.microsoft.onnxruntime") }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "lzm-guide"
include(":app")
