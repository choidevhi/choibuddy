/// <reference types="vite/client" />

// Methods the Android shell exposes on window.ChoiBuddyNative.
interface ChoiBuddyNativeApi {
  getConfig(): string
  platform(): string
  scanPairing(): void
  setPairing(link: string): boolean
  unpair(): void
  setKeepScreenOn(on: boolean): void
  notificationsAllowed(): boolean
  requestNotifications(): void
  setDoneAlerts(on: boolean): void
  doneAlerts(): boolean
  // Added in 0.2.0: notifications follow the language picked in the app.
  setLanguage?(tag: string): void
  // Added in 0.3.0: several PCs.
  getConfigs?(): string
  removePairing?(baseUrl: string): void
  // Added in 0.5.0: the clipboard's picture as JSON {name, mime, data} or "null",
  // and saving a picture (base64) to Photos.
  clipboardImage?(): string
  saveImage?(base64: string, name: string, mime: string): boolean
  // Added in 0.5.5: asks the launcher to place the home-screen widget. False
  // when the launcher cannot, so the person adds it from the widget list.
  pinWidget?(): boolean
}

interface Window {
  ChoiBuddyNative?: ChoiBuddyNativeApi
  // Called by the Android shell on the back button. True when the app went
  // back itself (closed something, or went to the previous tab); false lets
  // the system leave the app.
  choibuddyBack?: () => boolean
}
