// Host-JVM tests for the pure Kotlin publish core (native/android-src/kotlin).
// Runs with only a JDK — no Android SDK. The same sources are compiled into the
// APK by native/patch-android.mjs; rust-nostr's -jvm artifact stands in for the
// Android AAR here (identical Kotlin API, desktop native libs).
plugins { kotlin("jvm") version "2.1.0" }
repositories { mavenCentral() }
kotlin { jvmToolchain(21) }
sourceSets { main { kotlin.srcDir("../android-src/kotlin") } }
dependencies {
    implementation("org.rust-nostr:nostr-sdk-jvm:0.44.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.json:json:20240303")
    testImplementation(kotlin("test"))
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
tasks.test { useJUnitPlatform() }
