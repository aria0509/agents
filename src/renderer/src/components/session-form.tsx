import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { FilePlus2, FolderOpen, FolderPlus } from 'lucide-react'
import type { Account, LimitRule, Session } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { LaunchArgsInput } from '@/components/launch-args-input'
import { hasUsage, usageLines } from '@/lib/usage'
import { useApp } from '@/stores/app'

const LIMIT_RULES: LimitRule[] = ['auto-switch', 'manual', 'wait-and-continue']
/** display-name → model id; "default" keeps whatever the CLI decides */
const MODELS = [
  ['Fable 5', 'claude-fable-5'],
  ['Opus 5', 'claude-opus-5'],
  ['Sonnet 5', 'claude-sonnet-5'],
  ['Haiku 4.5', 'claude-haiku-4-5']
] as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
const MODES = ['manual', 'auto', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const
// Select can't take '' as an item value — '' in SessionFormValues maps to these
const DEFAULT = '__default__'
const AUTO = '__auto__'

/** One state shape shared by the create and edit dialogs, so both render the
 *  exact same form. Multi-value fields stay as raw textarea text ('' = none,
 *  one path per line) until submit. */
export interface SessionFormValues {
  cwd: string
  title: string
  /** '' = auto-pick (create only) */
  accountDir: string
  limitRule: LimitRule
  /** '' = CLI default */
  modelId: string
  effort: string
  mode: string
  launchArgs: string
  systemPromptFiles: string
  addDirs: string
  settingsJson: string
}

export const emptySessionForm: SessionFormValues = {
  cwd: '',
  title: '',
  accountDir: '',
  limitRule: 'auto-switch',
  modelId: '',
  effort: '',
  mode: '',
  launchArgs: '',
  systemPromptFiles: '',
  addDirs: '',
  settingsJson: ''
}

export const sessionFormValues = (s: Session): SessionFormValues => ({
  cwd: s.cwd,
  title: s.title ?? '',
  accountDir: s.accountDir,
  limitRule: s.limitRule,
  modelId: s.modelId ?? '',
  effort: s.effort ?? '',
  mode: s.mode ?? '',
  launchArgs: s.launchArgs.join(' '),
  systemPromptFiles: (s.systemPromptFiles ?? []).join('\n'),
  addDirs: (s.addDirs ?? []).join('\n'),
  settingsJson: s.settingsJson ?? ''
})

export const splitLines = (v: string): string[] =>
  v
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

/** '' is fine; anything else must parse to a JSON object */
export const settingsJsonValid = (v: string): boolean => {
  if (!v.trim()) return true
  try {
    const o: unknown = JSON.parse(v)
    return !!o && typeof o === 'object' && !Array.isArray(o)
  } catch {
    return false
  }
}

/** compact one-liner for the closed select trigger */
const accountSummary = (a: Account, t: TFunction): string => {
  if (a.loginStatus !== 'logged_in') return `${a.name} · ${t(`account.status.${a.loginStatus}`)}`
  return a.usage.fiveHour != null ? `${a.name} · ${t('usage.current')} ${Math.round(a.usage.fiveHour)}%` : a.name
}

/** full account info for a dropdown option: name/email/plan + usage or status */
function AccountInfo({ a }: { a: Account }) {
  const { t } = useTranslation()
  const detail =
    a.loginStatus === 'logged_in' && hasUsage(a.usage)
      ? usageLines(a.usage, { current: t('usage.current'), weekly: t('usage.weekly'), reset: t('account.reset') }).join(' · ')
      : t(`account.status.${a.loginStatus}`)
  return (
    <div className="grid gap-0.5 py-0.5 text-left">
      <span className="flex items-center gap-2">
        <span className="font-medium">{a.name}</span>
        {a.email && <span className="text-muted-foreground text-xs">{a.email}</span>}
        {a.subscriptionType && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase">
            {a.subscriptionType}
          </Badge>
        )}
      </span>
      <span className="text-muted-foreground text-xs">{detail}</span>
    </div>
  )
}

export function SessionForm({
  values,
  onChange,
  variant,
  running = false
}: {
  values: SessionFormValues
  onChange: (patch: Partial<SessionFormValues>) => void
  variant: 'create' | 'edit'
  /** edit only: account switching needs an idle session */
  running?: boolean
}) {
  const { t } = useTranslation()
  const accounts = useApp((s) => s.accounts)
  const selected = accounts.find((a) => a.configDir === values.accountDir)
  const appendLines = (field: 'systemPromptFiles' | 'addDirs', paths: string[]): void => {
    if (!paths.length) return
    onChange({ [field]: [values[field].trimEnd(), ...paths].filter(Boolean).join('\n') })
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="f-cwd">{t('session.cwd')} *</Label>
        <div className="flex gap-2">
          <Input
            id="f-cwd"
            value={values.cwd}
            disabled={variant === 'edit'} // the transcript layout is keyed by cwd
            onChange={(e) => onChange({ cwd: e.target.value })}
            placeholder="/path/to/project"
          />
          {variant === 'create' && (
            <Button
              variant="outline"
              size="icon"
              aria-label={t('common.browse')}
              onClick={() => void window.api.pickDirectory().then((p) => p && onChange({ cwd: p }))}
            >
              <FolderOpen />
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="f-title">{t('session.titleField')}</Label>
        <Input
          id="f-title"
          value={values.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder={t('session.titlePlaceholder')}
        />
      </div>
      <div className="grid gap-2">
        <Label>
          {t('session.account')}
          {variant === 'edit' && running && (
            <span className="text-muted-foreground ml-2 text-xs">{t('session.switchWhenIdle')}</span>
          )}
        </Label>
        <Select
          value={values.accountDir || AUTO}
          onValueChange={(v) => onChange({ accountDir: v === AUTO ? '' : v })}
          disabled={variant === 'edit' && running}
        >
          <SelectTrigger className="w-full">
            {/* options carry the full two-line info; keep the closed trigger one line */}
            {selected ? accountSummary(selected, t) : <SelectValue placeholder={t('session.accountAuto')} />}
          </SelectTrigger>
          <SelectContent>
            {variant === 'create' && <SelectItem value={AUTO}>{t('session.accountAuto')}</SelectItem>}
            {/* all accounts, incl. not-logged-in (marked) — you can open a session
                on an unlogged account and log in from its terminal */}
            {accounts.map((a) => (
              <SelectItem key={a.configDir} value={a.configDir}>
                <AccountInfo a={a} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="grid gap-2">
          <Label>{t('session.model')}</Label>
          <Select value={values.modelId || DEFAULT} onValueChange={(v) => onChange({ modelId: v === DEFAULT ? '' : v })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{t('session.optionDefault')}</SelectItem>
              {MODELS.map(([name, id]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>{t('session.effort')}</Label>
          <Select value={values.effort || DEFAULT} onValueChange={(v) => onChange({ effort: v === DEFAULT ? '' : v })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{t('session.optionDefault')}</SelectItem>
              {EFFORTS.map((e) => (
                <SelectItem key={e} value={e}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>{t('session.mode')}</Label>
          <Select value={values.mode || DEFAULT} onValueChange={(v) => onChange({ mode: v === DEFAULT ? '' : v })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{t('session.optionDefault')}</SelectItem>
              {MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {t(`session.modes.${m}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">{t('session.modelEffortHint')}</p>
      <div className="grid gap-2">
        <Label>{t('session.limitRule')}</Label>
        <Select value={values.limitRule} onValueChange={(v) => onChange({ limitRule: v as LimitRule })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIMIT_RULES.map((r) => (
              <SelectItem key={r} value={r}>
                {t(`limitRule.${r}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="f-prompt-files">{t('session.systemPromptFiles')}</Label>
        <div className="flex gap-2">
          <Textarea
            id="f-prompt-files"
            rows={2}
            value={values.systemPromptFiles}
            onChange={(e) => onChange({ systemPromptFiles: e.target.value })}
            placeholder={'~/work/contexts/CLAUDE.md'}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label={t('common.browse')}
            onClick={() => void window.api.pickFiles().then((p) => appendLines('systemPromptFiles', p))}
          >
            <FilePlus2 />
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t('session.systemPromptFilesHint')}</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="f-add-dirs">{t('session.addDirs')}</Label>
        <div className="flex gap-2">
          <Textarea
            id="f-add-dirs"
            rows={2}
            value={values.addDirs}
            onChange={(e) => onChange({ addDirs: e.target.value })}
            placeholder={'~/work/contexts'}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label={t('common.browse')}
            onClick={() => void window.api.pickDirectory().then((p) => appendLines('addDirs', p ? [p] : []))}
          >
            <FolderPlus />
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t('session.addDirsHint')}</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="f-settings">{t('session.settingsJson')}</Label>
        <Textarea
          id="f-settings"
          rows={2}
          value={values.settingsJson}
          aria-invalid={!settingsJsonValid(values.settingsJson)}
          onChange={(e) => onChange({ settingsJson: e.target.value })}
          placeholder={'{"includeCoAuthoredBy": false}'}
        />
        <p className={settingsJsonValid(values.settingsJson) ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}>
          {settingsJsonValid(values.settingsJson) ? t('session.settingsJsonHint') : t('session.settingsJsonInvalid')}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="f-args">{t('session.launchArgs')}</Label>
        <LaunchArgsInput id="f-args" value={values.launchArgs} onChange={(v) => onChange({ launchArgs: v })} />
        <p className="text-muted-foreground text-xs">{t('session.launchArgsHint')}</p>
      </div>
    </div>
  )
}
