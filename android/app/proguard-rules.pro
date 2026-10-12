# @JavascriptInterface 메서드는 기본 규칙(proguard-android-optimize.txt)이 이미 지킨다.

# 오류 기록에 줄 번호가 남게 한다. 이름은 R8이 바꾸므로 빌드마다 mapping.txt를 함께 보관한다.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
