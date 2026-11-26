# 构建 debug APK -> dist\lzm-guide.apk，完整日志在 f:\tmp\lzm-guide\build.log。
# 用法：powershell -ExecutionPolicy Bypass -File F:\workspace\lzm-guide\build.ps1
#
# 先 --offline：插件 / 依赖照抄 metaXring 的版本，~/.gradle 缓存里都有，不碰网络。
# 只有缓存不全（首次拉 onnxruntime，见 android/settings.gradle.kts 的阿里云仓库）时才联网重来一次；
# 判据是日志里 Gradle 报「离线模式下缺缓存」的那几句，编译错误不会触发联网重试。
# gradlew 经 cmd 调用、由 cmd 做重定向：PowerShell 5.1 自己重定向原生命令的 stderr 时，
# Gradle 往 stderr 打的任何一行警告都会被包成 NativeCommandError。

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$androidDir = Join-Path $root 'android'
$logDir = 'f:\tmp\lzm-guide'
$log = Join-Path $logDir 'build.log'
$apk = Join-Path $androidDir 'app\build\outputs\apk\debug\app-debug.apk'
$distDir = Join-Path $root 'dist'
$dist = Join-Path $distDir 'lzm-guide.apk'

if (-not $env:JAVA_HOME) {
    $jbr = 'C:\Users\admin\.jdks\jbr-17.0.14'
    if (Test-Path $jbr) { $env:JAVA_HOME = $jbr }
}

New-Item -ItemType Directory -Force $logDir | Out-Null
New-Item -ItemType Directory -Force $distDir | Out-Null
# 先删旧包：AGP 的增量打包在旧文件上原地改，删掉的条目不回收空间，包会虚胖
#（2026-11-26 换 onnxruntime 版本后不删旧包实测 31.5 MB，删了重打 24.3 MB）
if (Test-Path $apk) { Remove-Item $apk -Force }

# 写全路径：设了 NoDefaultCurrentDirectoryInExePath 的机器上 cmd 不在当前目录找 gradlew.bat
$gradlew = Join-Path $androidDir 'gradlew.bat'
$gradleCmd = "cd /d `"$androidDir`" && `"$gradlew`" {0} --console=plain :app:assembleDebug > `"$log`" 2>&1"

# ⚠️ 两处 cmd 都别包进函数、别赋值给变量：那样 PowerShell 要经管道读 cmd 的输出，
# 而构建中新拉起的 Gradle daemon 会继承这根管道的句柄、一直不关，脚本就卡在构建成功之后（2026-11-26 实测）。
Write-Host "构建中（离线），日志：$log"
cmd /c ($gradleCmd -f '--offline')
$code = $LASTEXITCODE
if ($code -ne 0 -and (Select-String -Path $log -Quiet -Pattern 'No cached version', 'available for offline mode')) {
    Write-Host '缓存里缺依赖，联网重试一次（onnxruntime 走阿里云镜像）'
    cmd /c ($gradleCmd -f '')
    $code = $LASTEXITCODE
}

if ($code -ne 0 -or -not (Test-Path $apk)) {
    Write-Host "构建失败 exit=$code，日志末尾："
    Get-Content $log -Tail 40
    exit 1
}

Copy-Item $apk $dist -Force
$bytes = (Get-Item $dist).Length
$sizeMb = [math]::Round($bytes / 1MB, 2)
Write-Host "构建成功：$dist（$sizeMb MiB，$bytes 字节）"
