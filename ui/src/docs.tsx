import { type KeyboardEvent, useEffect, useState } from 'react'
import type { DocFile, DocGroup } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import type { Tone } from './buddy.tsx'
import { type Feed, feedFor, type PcSession } from './feeds.ts'
import { useI18n } from './i18n.ts'
import { fetchDocs, readDoc, writeDoc } from './live.ts'
import { Markdown } from './markdown.tsx'
import { Picker } from './picker.tsx'
import { PcChips, pcName, PcRail } from './sessions.tsx'

type PcGroup = DocGroup & { pcKey: string; pcName: string }

type Opened = {
  key: string
  pcKey: string
  file: DocFile
  // What the file held when it was opened or last saved.
  saved: string
}

type Status = 'saved' | 'failed' | 'conflict' | null

function keyOf(pcKey: string, id: string): string {
  return `${pcKey}|${id}`
}

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

// CLAUDE.md, AGENTS.md and agent definitions, PC by PC: the PCs as buddies,
// the chosen PC's files by project, then the file to edit or preview.
// Unsaved edits stay per file while moving between them.
export function Docs({ feeds, sessions, tone }: { feeds: Feed[]; sessions: PcSession[]; tone: Tone }) {
  const { lang, t } = useI18n()
  const [groups, setGroups] = useState<PcGroup[]>([])
  const [pcKey, setPcKey] = useState<string | null>(null)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map())
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [status, setStatus] = useState<Status>(null)
  const [saving, setSaving] = useState(false)
  const [reloadAt, setReloadAt] = useState(0)
  const feedIds = feeds.map(feed => `${feed.key}#${feed.connection.token}`).join('|')

  useEffect(() => {
    void Promise.all(
      feeds.map(feed =>
        fetchDocs(feed.connection).then(list => list.map((group): PcGroup => ({ ...group, pcKey: feed.key, pcName: feed.snapshot?.server.hostName ?? '' }))),
      ),
    ).then(lists => setGroups(lists.flat()))
    // feedIds stands for the feeds that matter here.
  }, [feedIds, reloadAt])

  const draft = opened === null ? '' : (drafts.get(opened.key) ?? opened.saved)
  const dirty = opened !== null && draft !== opened.saved

  // Back closes the file; unsaved edits stay in drafts for when it opens again.
  useBackLayer(
    opened !== null,
    () => {
      setOpened(null)
      setStatus(null)
    },
    false,
  )

  const setDraft = (key: string, text: string): void => setDrafts(current => new Map(current).set(key, text))

  const dropDraft = (key: string): void =>
    setDrafts(current => {
      const next = new Map(current)

      next.delete(key)

      return next
    })

  const open = async (pcKey: string, id: string): Promise<void> => {
    const feed = feedFor(feeds, pcKey)

    if (feed === null) return

    const found = await readDoc(feed.connection, id)

    setStatus(found === null ? 'failed' : null)

    if (found !== null) setOpened({ key: keyOf(pcKey, id), pcKey, file: found.file, saved: found.text })
  }

  const save = async (): Promise<void> => {
    const feed = opened === null ? null : feedFor(feeds, opened.pcKey)

    if (opened === null || feed === null || saving) return

    setSaving(true)

    const result = await writeDoc(feed.connection, opened.file.id, draft, opened.file.mtime)

    setSaving(false)

    if (result.ok) {
      setOpened({ ...opened, file: result.file, saved: draft })
      dropDraft(opened.key)
      setStatus('saved')
      setReloadAt(Date.now())

      return
    }

    if (result.conflict === null) {
      setStatus('failed')

      return
    }

    // Someone else saved first: show their version and start over from it.
    const latest = await readDoc(feed.connection, opened.file.id)

    dropDraft(opened.key)
    setStatus('conflict')

    if (latest !== null) setOpened({ ...opened, file: latest.file, saved: latest.text })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }

  const groupTitle = (group: PcGroup): string => (group.key === 'user' ? t('docs.user') : group.title)

  // The PC of the open file, until another is picked.
  const shownPc = pcKey !== null && feeds.some(feed => feed.key === pcKey) ? pcKey : (opened?.pcKey ?? groups[0]?.pcKey ?? feeds[0]?.key ?? null)
  const shownFeed = feeds.find(feed => feed.key === shownPc) ?? null
  const pcGroups = groups.filter(group => group.pcKey === shownPc)

  const fileMeta = (file: DocFile): string =>
    file.exists ? `${sizeText(file.size)} · ${new Date(file.mtime).toLocaleDateString(lang)}` : t('docs.create')

  return (
    <div className="convo convo--chat docs">
      <PcRail feeds={feeds} sessions={sessions} shown={shownPc} tone={tone} onPick={setPcKey} />

      <aside className="convo-list">
        <div className="section-label convo-list-head">
          <span className="convo-list-pc">{shownFeed === null ? t('tab.docs') : pcName(shownFeed)}</span>
        </div>
        <div className="docs-hint">{t('docs.hint')}</div>
        {pcGroups.map(group => (
          <div className="docs-group" key={`${group.pcKey}-${group.key}`}>
            <div className="section-label docs-group-title" title={group.cwd ?? undefined}>
              {groupTitle(group)}
            </div>
            {group.files.map(file => {
              const key = keyOf(group.pcKey, file.id)

              return (
                <button
                  type="button"
                  key={file.id}
                  className={`convo-item docs-item ${opened?.key === key ? 'on' : ''} ${file.exists ? '' : 'docs-item--missing'}`}
                  onClick={() => void open(group.pcKey, file.id)}
                >
                  <span className="convo-item-text">
                    <span className="convo-title">
                      {file.label}
                      {drafts.has(key) && <span className="docs-dirty"> ●</span>}
                    </span>
                    <span className="convo-meta">{fileMeta(file)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </aside>

      <section className="convo-main">
        <div className="convo-select-row">
          <PcChips feeds={feeds} sessions={sessions} shown={shownPc} tone={tone} onPick={setPcKey} />
          <Picker
            className="convo-select"
            value={opened?.key ?? null}
            title={shownFeed === null ? t('tab.docs') : pcName(shownFeed)}
            placeholder={t('docs.pick')}
            options={pcGroups.flatMap(group =>
              group.files.map(file => ({ value: keyOf(group.pcKey, file.id), label: file.label, hint: fileMeta(file), group: groupTitle(group) })),
            )}
            onChange={key => {
              const [pcKey, id] = key.split('|')

              if (pcKey !== undefined && id !== undefined) void open(pcKey, id)
            }}
          />
        </div>

        {opened === null ? (
          <div className="empty">
            <div className="empty-title">{t('docs.pick')}</div>
            <div className="empty-sub">{t('docs.hint')}</div>
          </div>
        ) : (
          <>
            <div className="docs-head">
              <span className="docs-path" title={opened.file.path}>
                {opened.file.path}
              </span>
              {dirty && <span className="docs-unsaved">{t('docs.unsaved')}</span>}
              <span className="seg">
                <button type="button" className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>
                  {t('docs.edit')}
                </button>
                <button type="button" className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>
                  {t('docs.preview')}
                </button>
              </span>
              <button type="button" className="btn btn--allow small" disabled={!dirty || saving} onClick={() => void save()}>
                {opened.file.exists ? t('docs.save') : t('docs.create')}
              </button>
            </div>

            {status !== null && (
              <div className={`docs-status docs-status--${status}`}>
                {status === 'saved' ? t('docs.saved') : status === 'conflict' ? t('docs.conflict') : t('docs.saveFailed')}
              </div>
            )}

            {mode === 'edit' ? (
              <textarea
                className="docs-editor"
                value={draft}
                spellCheck={false}
                onChange={event => {
                  const text = event.target.value

                  if (text === opened.saved) dropDraft(opened.key)
                  else setDraft(opened.key, text)
                  setStatus(null)
                }}
                onKeyDown={onKeyDown}
              />
            ) : (
              <div className="docs-preview prose">
                <Markdown text={draft} />
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
