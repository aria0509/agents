import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Language } from '@shared/types'
import en from '@/locales/en.json'
import zhHant from '@/locales/zh-Hant.json'
import zhHans from '@/locales/zh-Hans.json'

const STORAGE_KEY = 'agents-language'

function detectLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'en' || stored === 'zh-Hant' || stored === 'zh-Hans') return stored

  const nav = navigator.language
  if (/^zh\b/.test(nav)) {
    return /TW|HK|MO|Hant/i.test(nav) ? 'zh-Hant' : 'zh-Hans'
  }
  return 'en'
}

export function setLanguage(lang: Language): void {
  localStorage.setItem(STORAGE_KEY, lang)
  void i18n.changeLanguage(lang)
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-Hant': { translation: zhHant },
    'zh-Hans': { translation: zhHans }
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }
})

export default i18n
