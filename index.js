/**
 * @format
 */

import {AppRegistry} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import App from './App';

// Safety guardrail: release builds don't write page URLs (e.g. DM thread links) or config
// to the phone's system log, where other debugging tools could read them.
if (!__DEV__) {
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
}
import {name as appName} from './app.json';

function Root() {
  return (
    <SafeAreaProvider>
      <App />
    </SafeAreaProvider>
  );
}

AppRegistry.registerComponent(appName, () => Root);
