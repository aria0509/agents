import { useTranslation } from 'react-i18next'
import type { Language, Theme } from '@shared/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTheme } from '@/components/theme-provider'
import i18n, { setLanguage } from '@/lib/i18n'
import { useApp } from '@/stores/app'
import { AccountsPanel } from '@/components/accounts-panel'

const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'zh-Hant', label: '繁體中文' },
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'en', label: 'English' }
]
const THEMES: Theme[] = ['light', 'dark', 'system']

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const cardSize = useApp((s) => s.cardSize)
  const setCardSize = useApp((s) => s.setCardSize)
  const lang = LANGUAGES.some((l) => l.value === i18n.language) ? (i18n.language as Language) : 'en'

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('settings.title')}</DialogTitle>
        </DialogHeader>

        <div className="-mr-2 flex flex-col gap-4 overflow-y-auto pr-2">
        <section className="grid gap-4">
          <div className="grid gap-2">
            <Label>{t('settings.language')}</Label>
            <Select value={lang} onValueChange={(v) => setLanguage(v as Language)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>{t('settings.theme')}</Label>
            <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEMES.map((th) => (
                  <SelectItem key={th} value={th}>
                    {t(`settings.theme${th[0].toUpperCase()}${th.slice(1)}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>
              {t('settings.cardSize')} <span className="text-muted-foreground">({cardSize}px)</span>
            </Label>
            <input
              type="range"
              min={340}
              max={680}
              step={20}
              value={cardSize}
              onChange={(e) => setCardSize(Number(e.target.value))}
              className="accent-primary w-full"
            />
          </div>
        </section>

        <section className="grid gap-3 border-t pt-4">
          <h3 className="text-sm font-semibold">{t('account.title')}</h3>
          <AccountsPanel />
        </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
