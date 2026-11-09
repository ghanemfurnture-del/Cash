import type { PersistenceStatus } from './types';

/**
 * Checks if the current environment is iOS (iPhone/iPad/iPod).
 */
export function isIosDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua);
  const isMacTouch =
    navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isIos || isMacTouch;
}

/**
 * Checks if the application is running in standalone PWA mode (added to home screen).
 */
export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const isStandaloneMatch = window.matchMedia('(display-mode: standalone)').matches;
  const isNavigatorStandalone = (navigator as any).standalone === true;
  return isStandaloneMatch || isNavigatorStandalone;
}

/**
 * Checks storage persistence and quota/usage estimates.
 */
export async function getPersistenceStatus(): Promise<PersistenceStatus> {
  let isPersisted = false;
  let usageBytes = 0;
  let quotaBytes = 0;

  if (typeof navigator !== 'undefined' && navigator.storage) {
    if (navigator.storage.persisted) {
      try {
        isPersisted = await navigator.storage.persisted();
      } catch {
        isPersisted = false;
      }
    }

    if (navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        usageBytes = estimate.usage || 0;
        quotaBytes = estimate.quota || 0;
      } catch {
        // Fallback
      }
    }
  }

  const isStandalone = isStandalonePwa();
  const isIos = isIosDevice();

  let warningMessage: string | null = null;
  if (isIos && !isStandalone) {
    warningMessage =
      'التخزين المحلي مؤقت؛ قد يقوم متصفح Safari بمسح البيانات بعد 7 أيام من عدم الاستخدام. يرجى تثبيت التطبيق على الشاشة الرئيسية (Add to Home Screen) لحماية البيانات.';
  } else if (!isPersisted && !isStandalone) {
    warningMessage =
      'التخزين المحلي غير دائم؛ نوصي بتثبيت التطبيق كـ PWA أو منح صلاحية التخزين الدائم لضمان استدامة البيانات.';
  }

  return {
    isPersisted: isPersisted || isStandalone,
    isStandalone,
    isIosSafari: isIos && !isStandalone,
    usageBytes,
    quotaBytes,
    warningMessage,
  };
}

/**
 * Requests persistent storage from the browser.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

