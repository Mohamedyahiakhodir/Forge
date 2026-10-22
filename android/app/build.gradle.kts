plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.forge.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.forge.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    // A fixed, committed debug key (public by design, password "android") so every CI build is signed with
    // the same key and a new APK installs over the old one without losing app data.
    signingConfigs {
        create("forgeDebug") {
            storeFile = file("forge-debug.jks")
            storePassword = "android"
            keyAlias = "forgedebug"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("forgeDebug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // The web app is built by `node web/build.mjs --out android/app/src/main/assets/web`.
    sourceSets["main"].assets.srcDirs("src/main/assets")
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.documentfile:documentfile:1.0.1")
}
