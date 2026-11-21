#!/usr/bin/env bash
set -u
adb shell cmd overlay enable --user 0 com.android.internal.display.cutout.emulation.tall
adb shell cmd overlay list --user 0 | rg 'display.cutout.emulation'
test_exit=0
gradle --no-daemon --console=plain connectedDebugAndroidTest || test_exit=$?
mkdir -p app/build/reports/androidTests
adb logcat -d -s HUCaptionProbe:I HUCaptionExtractor:W HUBabelProbe:I > app/build/reports/androidTests/network-probe.txt
cat app/build/reports/androidTests/network-probe.txt
adb pull /sdcard/Pictures/HUCaptionTests app/build/reports/androidTests/screenshots || true
exit "$test_exit"
