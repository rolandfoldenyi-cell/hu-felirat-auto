#!/usr/bin/env bash
set -u
test_exit=0
gradle --no-daemon --console=plain connectedDebugAndroidTest || test_exit=$?
mkdir -p app/build/reports/androidTests
adb logcat -d -s HUCaptionProbe:I HUCaptionExtractor:W > app/build/reports/androidTests/network-probe.txt
cat app/build/reports/androidTests/network-probe.txt
exit "$test_exit"
