import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  SafeAreaView,
  ActivityIndicator,
  StyleSheet,
  BackHandler,
  Text,
  Platform,
  Linking,
  TouchableOpacity,
  Image,
  Modal,
  Pressable,
  ScrollView,
  useColorScheme,
  Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CookieManager from '@react-native-cookies/cookies';
import CONFIG, { AppConfigEntry, RedirectRule } from './Config';

/** Fixed layout so the configure modal does not resize when switching apps. */
const CONFIGURE_FEATURE_ROW_HEIGHT = 52;
const CONFIGURE_FEATURE_VISIBLE_ROWS = 6;
const CONFIGURE_FEATURES_SCROLL_HEIGHT =
  CONFIGURE_FEATURE_ROW_HEIGHT * CONFIGURE_FEATURE_VISIBLE_ROWS;
/** Padding + title + instruction + dropdown + feature list + Done (see configureModal + children). */
const CONFIGURE_MODAL_FIXED_HEIGHT = 520;

const joinConfigUrl = (base: string, path: string) => {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path.slice(1) : path;
  return `${b}/${p}`;
};

function isValidRedirectsPayload(data: unknown): data is { [key: string]: RedirectRule[] } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {return false;}
  if (Object.keys(data as Record<string, unknown>).length === 0) {return false;}
  for (const v of Object.values(data as Record<string, unknown>)) {
    if (!Array.isArray(v)) {return false;}
    for (const r of v) {
      if (!r || typeof r !== 'object') {return false;}
      const o = r as Record<string, unknown>;
      if (o.when !== 'blocked' && o.when !== 'unblocked') {return false;}
      if (typeof o.fromUrl !== 'string' || typeof o.toUrl !== 'string') {return false;}
    }
  }
  return true;
}

function cloneDefaultRedirects(app: AppConfigEntry): { [key: string]: RedirectRule[] } {
  return JSON.parse(JSON.stringify(app.defaultRedirects));
}

async function fetchResolvedRedirects(app: AppConfigEntry): Promise<{ [key: string]: RedirectRule[] }> {
  try {
    const url = `${joinConfigUrl(app.configUrl, 'redirects.json')}?cache_bust=true`;
    const res = await fetch(url);
    if (!res.ok) {throw new Error('bad status');}
    const data = await res.json();
    if (!isValidRedirectsPayload(data)) {throw new Error('invalid shape');}
    return data;
  } catch {
    return cloneDefaultRedirects(app);
  }
}

async function fetchFiltersRaw(app: AppConfigEntry): Promise<unknown | null> {
  try {
    const url = `${joinConfigUrl(app.configUrl, 'filters.json')}?cache_bust=true`;
    const res = await fetch(url);
    if (!res.ok) {throw new Error('bad status');}
    return await res.json();
  } catch {
    return null;
  }
}

function buildSelectorsForInjection(
  remoteData: unknown,
  defaultFilters: { [key: string]: string[] },
  canUnblock: { [key: string]: boolean },
  unblocks: Record<string, boolean>
): string[] {
  if (Array.isArray(remoteData) && remoteData.length > 0 && remoteData.every((x) => typeof x === 'string')) {
    return remoteData as string[];
  }
  if (remoteData && typeof remoteData === 'object' && !Array.isArray(remoteData)) {
    const remoteObj = remoteData as { [key: string]: string[] };
    const features = new Set([...Object.keys(defaultFilters), ...Object.keys(remoteObj)]);
    const out: string[] = [];
    for (const feat of features) {
      if (canUnblock[feat] && unblocks[feat]) {continue;}
      const remoteList = remoteObj[feat];
      const defList = defaultFilters[feat] || [];
      const sels = remoteList !== undefined ? remoteList : defList;
      if (Array.isArray(sels)) {out.push(...sels);}
    }
    return out;
  }
  const out: string[] = [];
  for (const [feat, sels] of Object.entries(defaultFilters)) {
    if (canUnblock[feat] && unblocks[feat]) {continue;}
    out.push(...sels);
  }
  return out;
}

function getActiveRedirectRules(
  resolved: { [key: string]: RedirectRule[] },
  canUnblock: { [key: string]: boolean },
  unblocks: Record<string, boolean>
): { rule: RedirectRule; feature: string }[] {
  const out: { rule: RedirectRule; feature: string }[] = [];
  const features = new Set([...Object.keys(canUnblock), ...Object.keys(resolved)]);
  for (const feature of features) {
    const list = resolved[feature] || [];
    const userUnblocked = !!canUnblock[feature] && !!unblocks[feature];
    for (const rule of list) {
      const activeWhen = userUnblocked ? 'unblocked' : 'blocked';
      if (rule.when === activeWhen) {
        out.push({ rule, feature });
      }
    }
  }
  out.sort((a, b) => {
    const la = a.rule.fromUrl.length;
    const lb = b.rule.fromUrl.length;
    if (lb !== la) {return lb - la;}
    const wa = a.rule.withSelector ? 1 : 0;
    const wb = b.rule.withSelector ? 1 : 0;
    return wa - wb;
  });
  return out;
}

function urlMatchesRule(navUrl: string, rule: RedirectRule): boolean {
  if (rule.exactMatch) {
    return navUrl === rule.fromUrl;
  }
  return navUrl.startsWith(rule.fromUrl);
}

function previousUrlMatches(rule: RedirectRule, prevUrl: string): boolean {
  if (rule.ifPreviousUrl !== undefined && prevUrl !== rule.ifPreviousUrl) {
    return false;
  }
  if (rule.ifNotPreviousUrl !== undefined && prevUrl === rule.ifNotPreviousUrl) {
    return false;
  }
  return true;
}

const featureUnblocksStorageKey = (webAppId: string) => `featureUnblocks:${webAppId}`;

async function loadFeatureUnblocks(webAppId: string): Promise<Record<string, boolean>> {
  try {
    const raw = await AsyncStorage.getItem(featureUnblocksStorageKey(webAppId));
    if (!raw) {return {};}
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

async function saveFeatureUnblocks(webAppId: string, unblocks: Record<string, boolean>) {
  await AsyncStorage.setItem(featureUnblocksStorageKey(webAppId), JSON.stringify(unblocks));
}

const Hyperlink = ({ url, children }: { url: string; children: React.ReactNode }) => (
  <Text style={styles.hyperlink} onPress={() => Linking.openURL(url)}>
    {children}
  </Text>
);

const APP_GRID = [
  {
    name: 'Instagram',
    id: 'instagram',
    icon: require('./assets/instagram.png'),
    active: true,
  },
  {
    name: 'Facebook',
    id: 'facebook',
    icon: require('./assets/facebook.png'),
    active: true,
  },
  {
    name: 'YouTube',
    id: 'youtube',
    icon: require('./assets/youtube.png'),
    active: true,
  },
  {
    name: 'Reddit',
    id: 'reddit',
    icon: require('./assets/reddit.png'),
    active: false,
  },
];
const GRID_ROWS = 2;
const GRID_COLS = 3;

const firstConfigurableAppId = () =>
  APP_GRID.find((a) => a.active && CONFIG[a.id])?.id ?? 'instagram';

const App = () => {
  const webViewRef = useRef<WebView>(null);
  const defaultWebAppId = 'instagram';
  const cellRefs = useRef<{ [id: string]: View | null }>({});
  const activeConfigRef = useRef<AppConfigEntry>(CONFIG[defaultWebAppId]);
  const resolvedRedirectsRef = useRef<{ [key: string]: RedirectRule[] }>(cloneDefaultRedirects(CONFIG[defaultWebAppId]));
  const featureUnblocksRef = useRef<Record<string, boolean>>({});
  const remoteFiltersRef = useRef<unknown | null>(null);

  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const appBackgroundColor = colorScheme === 'dark' ? 'black' : 'white';

  const [config, setConfig] = useState<AppConfigEntry>(CONFIG[defaultWebAppId]);
  const [injectedJavaScript, setInjectedJavaScript] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loggedIn, setLoggedIn] = useState(true);
  const [infoVisible, setInfoVisible] = useState(false);
  const [dropdownVisible, setDropdownVisible] = useState(false);
  const [showNotificationsInstructions, setShowNotificationsInstructions] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [wentBack, setWentBack] = useState(false);
  const [hasLoadError, setHasLoadError] = useState(false);

  const [appIconMenu, setAppIconMenu] = useState<{ appId: string; x: number; y: number; w: number; h: number } | null>(
    null
  );
  const [configureModalVisible, setConfigureModalVisible] = useState(false);
  const [configureContextAppId, setConfigureContextAppId] = useState(firstConfigurableAppId);
  const [configureUnblocks, setConfigureUnblocks] = useState<Record<string, boolean>>({});
  const [configureAppPickerOpen, setConfigureAppPickerOpen] = useState(false);

  const redirectToUrl = useCallback((url: string) => {
    if (!webViewRef.current) {return;}
    const safe = JSON.stringify(url);
    webViewRef.current.injectJavaScript(`window.location.href = ${safe};`);
  }, []);

  const constructInjectedJavaScript = useCallback((selectorsJson: string) => {
    const newInjectedJavaScript = `
      hideElements = () => {
        const elementsToHide = ${selectorsJson};
        elementsToHide.forEach(selector => {
          try {
            const elements = document.querySelectorAll(selector);
            elements.forEach(element => {
              element.style.display = "none";
            });
          } catch (error) {}
        });
      };

      muteElements = () => {
        const elementsToMute = ["div[aria-label='YouTube Video Player'][class*='ad-showing'] > div > video"];
        elementsToMute.forEach(selector => {
          try {
            const element = document.querySelector(selector);
            if (element) {
              element.volume = 0;
            }
          } catch (error) {}
        });
      };

      unmuteElements = () => {
        const elementsToUnmute = ["div[aria-label='YouTube Video Player']:not([class*='ad-showing']) > div > video"];
        elementsToUnmute.forEach(selector => {
          try {
            const element = document.querySelector(selector);
            if (element) {
              element.volume = 1;
              element.muted = false;
              element.style.display = "";
            }
          } catch (error) {}
        });
      };

      processSelectors = () => {
        hideElements();
        muteElements();
        unmuteElements();
      };

      const observer = new MutationObserver(processSelectors);
      observer.observe(document.body, { childList: true, subtree: true });
      setInterval(() => {
        processSelectors();
      }, 100);
      true;
    `;
    setInjectedJavaScript(newInjectedJavaScript);
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(newInjectedJavaScript);
    }
  }, []);

  const applyFiltersForApp = useCallback(
    (app: AppConfigEntry, unblocks: Record<string, boolean>, remoteFilters: unknown | null) => {
      const selectors = buildSelectorsForInjection(
        remoteFilters,
        app.defaultFilters,
        app.canUnblockFeatures,
        unblocks
      );
      constructInjectedJavaScript(JSON.stringify(selectors));
    },
    [constructInjectedJavaScript]
  );

  const updateConfig = useCallback(
    async (appId: string) => {
      const appConfig = CONFIG[appId];
      activeConfigRef.current = appConfig;
      setConfig(appConfig);
      const unblocks = await loadFeatureUnblocks(appId);
      featureUnblocksRef.current = unblocks;
      const [remoteFilters, resolvedRedirects] = await Promise.all([
        fetchFiltersRaw(appConfig),
        fetchResolvedRedirects(appConfig),
      ]);
      remoteFiltersRef.current = remoteFilters;
      resolvedRedirectsRef.current = resolvedRedirects;
      applyFiltersForApp(appConfig, unblocks, remoteFilters);
    },
    [applyFiltersForApp]
  );

  const redirectToSafety = useCallback(
    (navState: { url: string }, prevUrl: string) => {
      const cfg = activeConfigRef.current;
      if (!webViewRef.current) {return;}
      if (!loggedIn && loggingIn && cfg.signInUrl && (navState.url === cfg.sourceUrl || navState.url === cfg.baseUrl)) {
        redirectToUrl(cfg.signInUrl);
        return;
      }
      const active = getActiveRedirectRules(
        resolvedRedirectsRef.current,
        cfg.canUnblockFeatures,
        featureUnblocksRef.current
      );
      const selectorMatches: { rule: RedirectRule }[] = [];
      for (const { rule } of active) {
        if (!urlMatchesRule(navState.url, rule) || !previousUrlMatches(rule, prevUrl)) {continue;}
        if (rule.withSelector) {
          selectorMatches.push({ rule });
        } else {
          redirectToUrl(rule.toUrl);
          return;
        }
      }
      if (selectorMatches.length > 0) {
        const { rule } = selectorMatches[0];
        const selectorJson = JSON.stringify(rule.withSelector!);
        const messageJson = JSON.stringify({ type: 'redirect', toUrl: rule.toUrl });
        const javaScript = `
          (function(){
            try {
              var el = document.querySelector(${selectorJson});
              if (el) {
                window.ReactNativeWebView.postMessage(${JSON.stringify(messageJson)});
              }
            } catch (e) {}
          })();
          true;
        `;
        webViewRef.current.injectJavaScript(javaScript);
      }
    },
    [loggedIn, loggingIn, redirectToUrl]
  );

  const saveLoggedInWebAppId = async (appId: string) => {
    try {
      await AsyncStorage.setItem('webAppId', appId);
    } catch (error) {
      console.error('Failed to save web app ID:', error);
    }
  };

  const checkForLoggedInAppSession = async () => {
    try {
      const appIds: string[] = [
        activeConfigRef.current.webAppId,
        ...Object.keys(CONFIG).filter((id) => id !== activeConfigRef.current.webAppId),
      ];
      for (const id of appIds) {
        const appConfig = CONFIG[id];
        const cookies = await CookieManager.get(appConfig.baseUrl, true);
        const isLoggedIn = appConfig.webAppSessionCookies.every(
          (cookieName) => cookies[cookieName] && cookies[cookieName].value
        );
        if (isLoggedIn) {
          setLoggingIn(false);
          setLoggedIn(true);
          await saveLoggedInWebAppId(appConfig.webAppId);
          return;
        }
      }
    } catch (error) {
      console.error('Failed to check login state:', error);
    }
    setLoggedIn(false);
  };

  const loadInfoVisible = async () => {
    try {
      const value = await AsyncStorage.getItem('infoVisible');
      if (value !== null) {
        setInfoVisible(value === 'true');
        return;
      }
    } catch (error) {
      console.error('Failed to load infoVisible state:', error);
    }
    setInfoVisible(true);
  };

  const saveInfoVisible = async (visible: boolean) => {
    setInfoVisible(visible);
    try {
      await AsyncStorage.setItem('infoVisible', visible ? 'true' : 'false');
    } catch (error) {
      console.error('Failed to save infoVisible state:', error);
    }
  };

  const trackNavState = (nativeEvent: { url: string; canGoBack?: boolean }) => {
    setCurrentUrl(nativeEvent.url);
    if (nativeEvent.canGoBack !== undefined) {
      setCanGoBack(nativeEvent.canGoBack);
    }
    if (wentBack) {
      setWentBack(false);
    }
  };

  const openLinkInWebView = (nativeEvent: { targetUrl: string }) => {
    if (!webViewRef.current) {return;}
    if (nativeEvent.targetUrl.startsWith(activeConfigRef.current.baseUrl)) {
      webViewRef.current.injectJavaScript(`window.location.href = ${JSON.stringify(nativeEvent.targetUrl)};`);
    }
  };

  const handleMessage = (nativeEvent: { data: string }) => {
    if (!webViewRef.current) {return;}
    try {
      const data = JSON.parse(nativeEvent.data) as { type?: string; toUrl?: string };
      if (data.type === 'redirect' && typeof data.toUrl === 'string') {
        redirectToUrl(data.toUrl);
      }
    } catch {
      if (nativeEvent.data === 'redirect') {
        redirectToUrl(activeConfigRef.current.sourceUrl);
      }
    }
  };

  const cancelLoginAndReturnHome = useCallback(() => {
    setLoggingIn(false);
    setLoggedIn(false);
    setCanGoBack(false);
    setCurrentUrl('');
    setWentBack(false);
    setHasLoadError(false);
  }, []);

  const handleBackPress = useCallback(() => {
    if (loggingIn) {
      cancelLoginAndReturnHome();
      return true;
    }
    if (!webViewRef.current) {
      return false;
    }
    if (canGoBack) {
      webViewRef.current.goBack();
      setWentBack(true);
    } else {
      BackHandler.exitApp();
    }
    return true;
  }, [loggingIn, cancelLoginAndReturnHome, canGoBack]);

  const handleLoadError = () => {
    setHasLoadError(true);
    setTimeout(() => {
      if (webViewRef.current) {
        webViewRef.current.reload();
      }
    }, 1000);
  };

  const handleLoadSuccess = () => {
    setHasLoadError(false);
  };

  const handleShouldStartLoadWithRequest = (request: { url: string }) => {
    const cfg = activeConfigRef.current;
    if (!request.url.includes(cfg.baseUrlShort) && !cfg.openableExternalUrls.some((url) => request.url.startsWith(url))) {
      Linking.openURL(request.url);
      return false;
    }
    return true;
  };

  const handleNavigationStateChange = (navState: { url: string }) => {
    if (!webViewRef.current) {return;}
    const prevUrl = currentUrl;
    checkForLoggedInAppSession();
    redirectToSafety(navState, prevUrl);
    setCurrentUrl(navState.url);
  };

  const handleProcessTermination = () => {
    if (webViewRef.current) {
      webViewRef.current.reload();
    }
  };

  const openAppIconMenu = (app: (typeof APP_GRID)[0]) => {
    const el = cellRefs.current[app.id];
    if (el) {
      el.measureInWindow((x, y, w, h) => {
        setAppIconMenu({ appId: app.id, x, y, w, h });
      });
    } else {
      setAppIconMenu({ appId: app.id, x: 0, y: 120, w: 72, h: 88 });
    }
  };

  const loadConfigureUnblocksFor = async (appId: string) => {
    const u = await loadFeatureUnblocks(appId);
    setConfigureUnblocks(u);
  };

  const closeConfigureModal = () => {
    setConfigureAppPickerOpen(false);
    setConfigureModalVisible(false);
  };

  const openConfigureModal = (initialAppId?: string) => {
    const id = initialAppId && CONFIG[initialAppId] ? initialAppId : firstConfigurableAppId();
    setConfigureContextAppId(id);
    setConfigureAppPickerOpen(false);
    loadConfigureUnblocksFor(id).catch(() => {});
    setConfigureModalVisible(true);
  };

  const onConfigureFeatureToggle = async (feature: string, value: boolean) => {
    const appId = configureContextAppId;
    const app = CONFIG[appId];
    if (!app.canUnblockFeatures[feature]) {return;}
    const next = { ...configureUnblocks, [feature]: value };
    setConfigureUnblocks(next);
    await saveFeatureUnblocks(appId, next);
    if (appId === activeConfigRef.current.webAppId) {
      featureUnblocksRef.current = next;
      applyFiltersForApp(app, next, remoteFiltersRef.current);
      if (webViewRef.current && loggedIn) {
        webViewRef.current.reload();
      }
    }
  };

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const appId = await AsyncStorage.getItem('webAppId');
        if (appId && CONFIG[appId]) {
          await updateConfig(appId);
        }
      } catch (error) {
        console.error('Failed to load web app ID from AsyncStorage:', error);
      }
      await loadInfoVisible();
    };
    bootstrap().catch(() => {});
  }, [updateConfig]);

  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => backHandler.remove();
  }, [handleBackPress]);

  const webShellStyle = useMemo(
    () => ({
      flex: 1 as const,
      backgroundColor: appBackgroundColor,
      paddingTop: insets.top,
    }),
    [appBackgroundColor, insets.top],
  );

  const webViewFillStyle = useMemo(
    () => ({
      flex: 1 as const,
      backgroundColor: appBackgroundColor,
    }),
    [appBackgroundColor],
  );

  const loginHeaderColors = useMemo(
    () => ({
      backgroundColor: colorScheme === 'dark' ? '#181818' : '#f5f5f5',
      textColor: colorScheme === 'dark' ? '#eee' : '#111',
      borderColor: colorScheme === 'dark' ? '#222' : '#ddd',
    }),
    [colorScheme],
  );

  const appIconDropdownOffset = useMemo(() => {
    if (!appIconMenu) {
      return { top: 0, left: 0 };
    }
    return {
      top: Math.min(appIconMenu.y + appIconMenu.h + 4, 520),
      left: Math.max(8, appIconMenu.x + appIconMenu.w - 148),
    };
  }, [appIconMenu]);

  if (!loggedIn && !loggingIn) {
    const gridItems: React.ReactNode[] = [];
    let appIdx = 0;
    for (let i = 0; i < GRID_ROWS * GRID_COLS; i++) {
      if (appIdx < APP_GRID.length) {
        const app = APP_GRID[appIdx];
        gridItems.push(
          <View
            key={app.name}
            ref={(el) => {
              cellRefs.current[app.id] = el;
            }}
            collapsable={false}
            style={[
              styles.appIconContainer,
              !app.active && styles.appIconInactive,
            ]}
          >
            <TouchableOpacity
              style={styles.appIconTouchable}
              activeOpacity={app.active ? 0.7 : 1}
              onPress={() => {
                if (app.active && CONFIG[app.id]) {
                  openAppIconMenu(app);
                }
              }}
              disabled={!app.active}
            >
              <Image
                source={app.icon}
                style={[styles.appIcon, !app.active && styles.appIconImageInactive]}
                resizeMode="contain"
              />
              <Text style={[styles.appLabel, !app.active && styles.appLabelInactive]}>{app.name}</Text>
            </TouchableOpacity>
          </View>
        );
        appIdx++;
      } else {
        gridItems.push(<View key={`empty-${i}`} style={styles.gridContainer} />);
      }
    }

    const notificationsInstructions = (
      <ScrollView contentContainerStyle={styles.notificationsContainer}>
        <Text style={styles.notificationsTitle}>Notifications</Text>
        <Text style={styles.notificationsText}>
          To ensure you get notifications from your social apps:
        </Text>
        {Platform.OS === 'ios' ? (
          <Text style={styles.notificationsText}>
            1. Make sure to keep the official mobile app (e.g., Instagram) installed on your device with push notifications
            enabled for actions that you care about, like new chat messages.{'\n\n'}
            2. Open the built-in{' '}
            <Hyperlink url="https://apps.apple.com/us/app/shortcuts/id915249334">Shortcuts</Hyperlink> iOS app on your
            device and navigate to the <Text style={styles.boldEmphasis}>"Automation"</Text> section.{'\n\n'}
            3. Tap the + button to create a new <Text style={styles.boldEmphasis}>"Personal Automation"</Text>.
            {'\n\n'}
            4. Select <Text style={styles.boldEmphasis}>"App"</Text> as the trigger, then choose the official app (e.g.,
            Instagram) and set it to trigger when the app <Text style={styles.boldEmphasis}>"Is Opened"</Text>.
            {'\n\n'}
            5. Add an <Text style={styles.boldEmphasis}>"Open App"</Text> action and select the{' '}
            <Text style={styles.boldEmphasis}>OpenSocials</Text> app.{'\n\n'}
            6. Save the automation and ensure it is enabled.
          </Text>
        ) : (
          <Text style={styles.notificationsText}>
            1. Make sure to keep the official mobile app (e.g., Instagram) installed on your device with push notifications
            enabled for actions that you care about, like new chat messages.{'\n\n'}
            2. On a Samsung device, open the built-in{' '}
            <Hyperlink url="https://galaxystore.samsung.com/prepost/000006561093">Modes and Routines</Hyperlink> app (or
            use a third-party automation app such as{' '}
            <Hyperlink url="https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm">Tasker</Hyperlink>{' '}
            instead).{'\n\n'}
            3. Navigate to the <Text style={styles.boldEmphasis}>"Routines"</Text> section and tap the + button to
            create a new routine.{'\n\n'}
            4. Select <Text style={styles.boldEmphasis}>"App opened"</Text> as the "If" condition and choose the official
            app (e.g., Instagram).{'\n\n'}
            5. Select <Text style={styles.boldEmphasis}>"Apps &gt; Open an app or do an app action"</Text> as the
            "Then" action and select the <Text style={styles.boldEmphasis}>OpenSocials</Text> app.{'\n\n'}
            6. Save the routine and ensure it is enabled.
          </Text>
        )}
        <Text style={styles.notificationsText}>
          Now, whenever you receive a push notification from the official app, opening it will automatically redirect to
          OpenSocials instead!{'\n'}
        </Text>
        <Pressable
          style={styles.infoCloseButton}
          onPress={() => setShowNotificationsInstructions(false)}
          accessibilityLabel="Close notifications instructions"
        >
          <Text style={styles.infoCloseButtonText}>Done</Text>
        </Pressable>
      </ScrollView>
    );

    const configureAppIds = APP_GRID.filter((a) => a.active && CONFIG[a.id]).map((a) => a.id);

    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.titleBar}>
          <Text style={styles.titleText}>OpenSocials</Text>
          <TouchableOpacity
            style={styles.menuButton}
            onPress={() => setDropdownVisible((v) => !v)}
            accessibilityLabel="Open settings menu"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <View style={styles.kebabMenu}>
              <View style={styles.kebabDot} />
              <View style={styles.kebabDot} />
              <View style={styles.kebabDot} />
            </View>
          </TouchableOpacity>
          {dropdownVisible && (
            <>
              <Pressable style={styles.dropdownDismiss} onPress={() => setDropdownVisible(false)} />
              <View style={styles.dropdownMenu}>
                <TouchableOpacity
                  style={styles.dropdownItem}
                  onPress={() => {
                    setDropdownVisible(false);
                    setShowNotificationsInstructions(true);
                  }}
                >
                  <Text style={styles.dropdownItemText}>Notifications</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
        <View style={styles.gridContainer}>{gridItems}</View>

        <Modal visible={!!appIconMenu} transparent animationType="fade" onRequestClose={() => setAppIconMenu(null)}>
          <View style={styles.menuOverlay}>
            <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setAppIconMenu(null)} />
            {appIconMenu && CONFIG[appIconMenu.appId] && (
              <View style={[styles.appIconDropdown, styles.positionAbsolute, appIconDropdownOffset]}>
                <TouchableOpacity
                  style={styles.dropdownItem}
                  onPress={() => {
                    const id = appIconMenu.appId;
                    setAppIconMenu(null);
                    updateConfig(id)
                      .then(() => {
                        setLoggingIn(true);
                      })
                      .catch(() => {
                        setLoggingIn(true);
                      });
                  }}
                >
                  <Text style={[styles.dropdownItemText, styles.dropdownItemTextOpen]}>Open</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dropdownItem}
                  onPress={() => {
                    const id = appIconMenu.appId;
                    setAppIconMenu(null);
                    openConfigureModal(id);
                  }}
                >
                  <Text style={styles.dropdownItemText}>Configure</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </Modal>

        <Modal
          visible={configureModalVisible}
          transparent
          animationType="fade"
          onRequestClose={closeConfigureModal}
        >
          <View style={styles.infoModalOverlay}>
            <View style={[styles.infoModal, styles.configureModal]}>
              <Text style={styles.infoTitle}>Configure</Text>
              <Text style={styles.configureInstruction}>
                Toggle the features you want to unblock
              </Text>
              <View style={styles.configureAppPickerWrap}>
                <Pressable
                  style={styles.configureAppPicker}
                  onPress={() => setConfigureAppPickerOpen((v) => !v)}
                  accessibilityLabel="Select app to configure"
                >
                  <Text style={styles.configureAppPickerLabel}>
                    {APP_GRID.find((a) => a.id === configureContextAppId)?.name ?? configureContextAppId}
                  </Text>
                  <Text style={styles.configureAppPickerChevron}>{configureAppPickerOpen ? '▲' : '▼'}</Text>
                </Pressable>
                {configureAppPickerOpen && (
                  <View style={styles.configureAppPickerList}>
                    {configureAppIds.map((id) => {
                      const label = APP_GRID.find((a) => a.id === id)?.name ?? id;
                      const selected = id === configureContextAppId;
                      return (
                        <TouchableOpacity
                          key={id}
                          style={[
                            styles.configureAppPickerOption,
                            selected && styles.configureAppPickerOptionSelected,
                          ]}
                          onPress={() => {
                            setConfigureContextAppId(id);
                            loadConfigureUnblocksFor(id).catch(() => {});
                            setConfigureAppPickerOpen(false);
                          }}
                        >
                          <Text
                            style={[
                              styles.configureAppPickerOptionText,
                              selected && styles.configureAppPickerOptionTextSelected,
                            ]}
                          >
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </View>
              <ScrollView
                style={styles.configureFeaturesScroll}
                contentContainerStyle={styles.configureFeaturesContent}
                showsVerticalScrollIndicator={true}
              >
                {CONFIG[configureContextAppId] &&
                  Object.keys(CONFIG[configureContextAppId].canUnblockFeatures).map((feat) => {
                    const can = CONFIG[configureContextAppId].canUnblockFeatures[feat];
                    return (
                      <View key={feat} style={styles.featureRowFixed}>
                        <Text
                          style={[styles.featureLabel, !can && styles.featureLabelDisabled]}
                          numberOfLines={1}
                          ellipsizeMode="tail"
                        >
                          {feat.charAt(0).toUpperCase() + feat.slice(1).replace(/_/g, ' ')}
                        </Text>
                        <View style={styles.switchCompactWrap}>
                          <Switch
                            style={styles.featureSwitchScaled}
                            value={can ? !!configureUnblocks[feat] : false}
                            onValueChange={(v) => {
                              onConfigureFeatureToggle(feat, v).catch(() => {});
                            }}
                            disabled={!can}
                            trackColor={{ false: '#444', true: '#2a6' }}
                          />
                        </View>
                      </View>
                    );
                  })}
              </ScrollView>
              <Pressable
                style={styles.infoCloseButton}
                onPress={closeConfigureModal}
                accessibilityLabel="Close configure"
              >
                <Text style={styles.infoCloseButtonText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <Modal visible={infoVisible} transparent animationType="fade">
          <View style={styles.infoModalOverlay}>
            <View style={styles.infoModal}>
              <Text style={styles.infoTitle}>Welcome!</Text>
              <Text style={styles.infoText}>
                Welcome to OpenSocials, the open web app browser that puts you back in control of your social media
                usage, keeping you connected without all the distractions and time-wasting scrolling.{'\n\n'}
                Tap a social web app to log in. You can return to this home page at any time by logging out again.
              </Text>
              <Pressable
                style={styles.infoCloseButton}
                onPress={() => {
                    saveInfoVisible(false);
                    setShowNotificationsInstructions(true);
                }}
                accessibilityLabel="Close info popup"
              >
                <Text style={styles.infoCloseButtonText}>Continue</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
        <Modal
          visible={showNotificationsInstructions}
          transparent
          animationType="slide"
          onRequestClose={() => setShowNotificationsInstructions(false)}
        >
          <SafeAreaView style={styles.infoModalOverlay}>
            <View style={styles.infoModal}>
              {notificationsInstructions}
            </View>
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    );
  }

  return (
    <View style={webShellStyle}>
      {loggingIn && (
        <View
          style={[
            styles.loginHeader,
            {
              backgroundColor: loginHeaderColors.backgroundColor,
              borderBottomColor: loginHeaderColors.borderColor,
            },
          ]}
        >
          <Pressable
            onPress={cancelLoginAndReturnHome}
            style={styles.loginBackButton}
            accessibilityLabel="Back to home"
          >
            <Text style={[styles.loginBackChevron, { color: loginHeaderColors.textColor }]}>‹</Text>
            <Text style={[styles.loginBackLabel, { color: loginHeaderColors.textColor }]}>Back</Text>
          </Pressable>
        </View>
      )}
      <WebView
        style={webViewFillStyle}
        ref={webViewRef}
        source={{ uri: config.sourceUrl }}
        injectedJavaScript={injectedJavaScript}
        javaScriptEnabled={true}
        javaScriptCanOpenWindowsAutomatically={true}
        onMessage={(syntheticEvent) => {
          handleMessage(syntheticEvent.nativeEvent);
        }}
        domStorageEnabled={true}
        startInLoadingState={true}
        renderLoading={() => <View />}
        onError={() => {
          handleLoadError();
        }}
        onLoad={() => {
          handleLoadSuccess();
        }}
        onLoadStart={(syntheticEvent) => {
          trackNavState(syntheticEvent.nativeEvent);
        }}
        onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
        onNavigationStateChange={handleNavigationStateChange}
        onOpenWindow={(syntheticEvent) => {
          openLinkInWebView(syntheticEvent.nativeEvent);
        }}
        onContentProcessDidTerminate={handleProcessTermination}
        onRenderProcessGone={handleProcessTermination}
        allowsBackForwardNavigationGestures={!loggingIn}
        pullToRefreshEnabled={true}
        mediaPlaybackRequiresUserAction={true}
        allowsInlineMediaPlayback={true}
        allowsPictureInPictureMediaPlayback={true}
        allowsFullscreenVideo={true}
        contentMode={'mobile'}
      />
      {hasLoadError && (
        <View style={styles.errorOverlay}>
          <Text style={styles.errorTitle}>Unable to load page</Text>
          <Text style={styles.errorSubtitle}>Please check your internet connection.</Text>
          <ActivityIndicator size="large" color="white" />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },
  titleBar: {
    height: 56,
    backgroundColor: '#181818',
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    borderBottomColor: '#222',
    borderBottomWidth: 1,
  },
  loginHeader: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 8,
  },
  loginBackButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  loginBackChevron: {
    fontSize: 28,
    lineHeight: 28,
    marginRight: 2,
    marginTop: -2,
  },
  loginBackLabel: {
    fontSize: 17,
  },
  titleText: {
    color: 'white',
    fontSize: 22,
    fontWeight: '600',
    flex: 1,
    textAlign: 'left',
    paddingLeft: 16,
    paddingRight: 56,
  },
  gridContainer: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'black',
  },
  appIconContainer: {
    width: '30%',
    aspectRatio: 1,
    margin: '1.66%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 18,
    backgroundColor: '#232323',
  },
  appIconTouchable: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    width: '100%',
  },
  appIcon: {
    width: 48,
    height: 48,
    marginBottom: 8,
  },
  appLabel: {
    color: 'white',
    fontSize: 14,
    textAlign: 'center',
  },
  appIconInactive: {
    opacity: 0.4,
  },
  appIconImageInactive: {
    tintColor: '#888',
  },
  appLabelInactive: {
    color: '#888',
  },
  infoModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  infoModal: {
    backgroundColor: '#232323',
    borderRadius: 16,
    padding: 24,
    marginHorizontal: 32,
    alignItems: 'center',
    maxWidth: 340,
  },
  configureModal: {
    maxWidth: 360,
    width: '92%',
    height: CONFIGURE_MODAL_FIXED_HEIGHT,
    maxHeight: CONFIGURE_MODAL_FIXED_HEIGHT,
    marginHorizontal: 16,
    alignItems: 'stretch',
    overflow: 'hidden',
  },
  infoTitle: {
    color: 'white',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  infoText: {
    color: '#ccc',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 20,
  },
  infoCloseButton: {
    backgroundColor: '#444',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 24,
    alignSelf: 'center',
    marginTop: 8,
  },
  infoCloseButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  menuButton: {
    position: 'absolute',
    right: 8,
    top: 0,
    height: 56,
    width: 32,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  kebabMenu: {
    height: 14,
    width: 14,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'column',
  },
  kebabDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#aaa',
    marginVertical: 1.5,
  },
  dropdownDismiss: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 15,
  },
  dropdownMenu: {
    position: 'absolute',
    top: 56,
    right: 12,
    backgroundColor: '#232323',
    borderRadius: 8,
    paddingVertical: 4,
    minWidth: 160,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
    zIndex: 20,
  },
  appIconDropdown: {
    backgroundColor: '#232323',
    borderRadius: 8,
    paddingVertical: 4,
    minWidth: 148,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  positionAbsolute: {
    position: 'absolute',
  },
  boldEmphasis: {
    fontWeight: '700',
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  dropdownItem: {
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  dropdownItemText: {
    color: '#fff',
    fontSize: 16,
  },
  dropdownItemTextOpen: {
    fontWeight: '700',
  },
  configureInstruction: {
    color: '#ccc',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 12,
    alignSelf: 'stretch',
  },
  configureAppPickerWrap: {
    alignSelf: 'stretch',
    marginBottom: 12,
    zIndex: 10,
    position: 'relative',
  },
  configureAppPicker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#333',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#555',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  configureAppPickerLabel: {
    color: '#eee',
    fontSize: 15,
  },
  configureAppPickerChevron: {
    color: '#aaa',
    fontSize: 10,
    marginLeft: 8,
  },
  configureAppPickerList: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    backgroundColor: '#232323',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#444',
    overflow: 'hidden',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  configureAppPickerOption: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  configureAppPickerOptionSelected: {
    backgroundColor: '#333',
  },
  configureAppPickerOptionText: {
    color: '#aaa',
    fontSize: 15,
  },
  configureAppPickerOptionTextSelected: {
    color: '#eee',
  },
  configureFeaturesScroll: {
    alignSelf: 'stretch',
    width: '100%',
    height: CONFIGURE_FEATURES_SCROLL_HEIGHT,
    maxHeight: CONFIGURE_FEATURES_SCROLL_HEIGHT,
    overflow: 'hidden',
  },
  configureFeaturesContent: {
    paddingBottom: 8,
    paddingHorizontal: 6,
  },
  featureRowFixed: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: CONFIGURE_FEATURE_ROW_HEIGHT,
    minHeight: CONFIGURE_FEATURE_ROW_HEIGHT,
    maxHeight: CONFIGURE_FEATURE_ROW_HEIGHT,
    paddingRight: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#444',
    alignSelf: 'stretch',
    width: '100%',
    maxWidth: '100%',
    gap: 6,
  },
  featureLabel: {
    color: '#eee',
    fontSize: 15,
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    marginRight: 4,
    paddingRight: 2,
  },
  switchCompactWrap: {
    flexShrink: 0,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'visible',
    marginLeft: 2,
    paddingLeft: 2,
  },
  featureSwitchScaled: {
    transform: [{ scaleX: 0.68 }, { scaleY: 0.68 }],
  },
  featureLabelDisabled: {
    color: '#666',
  },
  notificationsContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    minWidth: 260,
  },
  notificationsTitle: {
    color: 'white',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  notificationsText: {
    color: '#ccc',
    fontSize: 15,
    textAlign: 'left',
    marginBottom: 12,
    alignSelf: 'stretch',
  },
  hyperlink: {
    color: '#4da3ff',
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'black',
  },
  errorTitle: {
    color: 'white',
    fontSize: 20,
    textAlign: 'center',
    marginHorizontal: 20,
    marginBottom: 5,
  },
  errorSubtitle: {
    color: 'gray',
    fontSize: 15,
    textAlign: 'center',
    marginHorizontal: 20,
    marginBottom: 10,
  },
});

export default App;
