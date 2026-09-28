# OpenSocials Safe

A hardened fork of [liamperritt/opensocials](https://github.com/liamperritt/opensocials) (v0.3.6). Same app, with these safety guardrails:

- **Never leaves the app's own site.** Every redirect, whether from the remote config, a page message or the app itself, must be an `https://` URL on the active app's domain (e.g. `instagram.com`), or it is ignored.
- **Remote config can't point elsewhere.** A downloaded `redirects.json` whose targets leave the domain is rejected and the built-in rules are used instead.
- **Real host matching.** The "is this still Instagram?" check compares the actual host instead of asking whether the URL *contains* `instagram.com` (which `instagram.com.evil.com` would pass). Userinfo and backslash tricks are rejected.
- **No odd link schemes.** Off-site `http(s)`, `mailto:` and `tel:` links open in the normal browser/app; `intent:`, `file:` and custom app schemes are dropped.
- **Two fewer permissions.** `RECEIVE_BOOT_COMPLETED` and `WAKE_LOCK` are removed; the app never runs in the background.
- **Locked-down WebView.** No file access, no mixed content, no geolocation, no remote debugging (pinned explicitly).
- **Quieter logs.** Release builds don't write page URLs to the phone's system log.
- **Separate app ID** (`com.opensocials.safe`), so it installs alongside, not over, the original.

Built by `.github/workflows/build-apk.yml` in GitHub Actions and signed with the fork owner's own key.

---

# OpenSocials

**OpenSocials** is an open web app browser for Android and iOS that aims to put users back in control of their social media usage, helping people stay connected without all the distractions and time-wasting scrolling. Use OpenSocials to access the useful features your social media apps (including Instagram, Facebook and YouTube) while blocking any distracting or addictive features (such as the Feed, Reels or Shorts). Configure which features you want to block and which features you want to remain accessible.

**OpenSocials' most popular use case is its ability to block all Instagram features except DMs**, allowing you to message your Instagram followers while avoiding the Feed, Reels, Explore page and other addictive or distracting features.

# Installation

For **Android users**, download and install the latest `app-release.apk` from GitHub: **https://github.com/liamperritt/opensocials/releases**.

For **iOS users**, join the open Beta and install via TestFlight: **https://testflight.apple.com/join/mqGMYrer**.

# Building the Project

This is a [**React Native**](https://reactnative.dev) project, bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run the app

With Metro running, open a new terminal window/pane from the root of the React Native project, and use one of the following commands to build and run the Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you build the project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see the app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run the app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, the app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of the app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified the React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

## Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

## Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
