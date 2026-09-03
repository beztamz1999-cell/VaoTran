import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
const key = 'vaotran.session-token';
let webSessionToken: string | null = null;

// SecureStore is the only persistence path on physical mobile devices. Web has
// no compatible SecureStore implementation in this Expo runtime, so its token
// stays in memory and is discarded on refresh rather than written to plaintext.
export const session = {
  get: () => Platform.OS === 'web' ? Promise.resolve(webSessionToken) : SecureStore.getItemAsync(key),
  set: (token: string) => Platform.OS === 'web' ? Promise.resolve(webSessionToken = token) : SecureStore.setItemAsync(key, token),
  clear: () => Platform.OS === 'web' ? Promise.resolve(webSessionToken = null) : SecureStore.deleteItemAsync(key),
};
