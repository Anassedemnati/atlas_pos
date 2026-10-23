import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TableDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { LocalizedName } from '@shared/names'
import { useApi } from '../../app/api'
import { Button, ConfirmDialog, Icon, Modal, Tabs, TextField, useToast } from '../../ui'
import { cx } from '../../ui/metrics'
import { useFormat } from '../till/format'
import { useTill } from '../till/store'
import { useFit } from './useFit'

interface DraftRoom {
  id: string
  name: LocalizedName
}
type DraftTable = Omit<TableDto, 'active'>
type Shape = DraftTable['shape']
type Box = Pick<DraftTable, 'x' | 'y' | 'w' | 'h'>

/** What the grid snaps to, and the smallest a table can be, in design pixels (the unit of the stored plan). */
const GRID = 10
const MIN_SIZE = 80
const DEFAULT_SIZE = 120
const MIN_CANVAS = { w: 1000, h: 640 }
/** The height of what sits above the drawing in the editor (title row, room row, margins), in screen pixels. */
const EDITOR_CHROME = 210
const snap = (value: number): number => Math.round(value / GRID) * GRID
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max))

type Corner = { sx: -1 | 1; sy: -1 | 1; name: 'nw' | 'ne' | 'sw' | 'se' }
const CORNERS: Corner[] = [
  { sx: -1, sy: -1, name: 'nw' },
  { sx: 1, sy: -1, name: 'ne' },
  { sx: -1, sy: 1, name: 'sw' },
  { sx: 1, sy: 1, name: 'se' }
]

/** The pointer gesture in progress on a table: moving it, or pulling one of its corners. */
interface Gesture {
  id: string
  corner: Corner | null
  startX: number
  startY: number
  from: Box
}

/** Moves a box by (dx, dy) design pixels, inside the canvas. */
function moved(from: Box, dx: number, dy: number, canvas: { w: number; h: number }): Box {
  return { ...from, x: clamp(snap(from.x + dx), 0, canvas.w - from.w), y: clamp(snap(from.y + dy), 0, canvas.h - from.h) }
}

/** Pulls a corner by (dx, dy): the opposite corner stays where it is. `dx` is along the reading direction (towards the end side). */
function resized(from: Box, corner: Corner, dx: number, dy: number, canvas: { w: number; h: number }): Box {
  const right = from.x + from.w
  const bottom = from.y + from.h
  let { x, y, w, h } = from
  if (corner.sx === 1) w = clamp(snap(from.w + dx), MIN_SIZE, canvas.w - from.x)
  else {
    x = clamp(snap(from.x + dx), 0, right - MIN_SIZE)
    w = right - x
  }
  if (corner.sy === 1) h = clamp(snap(from.h + dy), MIN_SIZE, canvas.h - from.y)
  else {
    y = clamp(snap(from.y + dy), 0, bottom - MIN_SIZE)
    h = bottom - y
  }
  return { x, y, w, h }
}

/** The first spot of the room where a new table does not sit on another. */
function freeSpot(tables: DraftTable[], canvas: { w: number; h: number }): Pick<DraftTable, 'x' | 'y'> {
  const step = DEFAULT_SIZE + 30
  for (let y = 30; y + DEFAULT_SIZE <= canvas.h; y += step) {
    for (let x = 30; x + DEFAULT_SIZE <= canvas.w; x += step) {
      const taken = tables.some((t) => x < t.x + t.w && t.x < x + DEFAULT_SIZE && y < t.y + t.h && t.y < y + DEFAULT_SIZE)
      if (!taken) return { x, y }
    }
  }
  return { x: 30, y: 30 }
}

export interface FloorEditorProps {
  /** Tables that have an open order: they cannot be removed (the main process refuses it too). */
  busyTableIds: ReadonlySet<string>
  onClose: () => void
}

/**
 * The floor plan editor (managers): drag a table to move it, pull a corner to resize it, add and remove tables and
 * rooms, then save the whole plan at once (`floor.save`). Nothing is stored until "Enregistrer".
 */
export function FloorEditor({ busyTableIds, onClose }: FloorEditorProps) {
  const { t } = useTranslation()
  const api = useApi()
  const toast = useToast()
  const { floor } = useTill()
  const { name, tableName } = useFormat()
  const initialRooms = useMemo<DraftRoom[]>(() => [...floor.rooms].sort((a, b) => a.sort - b.sort).map((r) => ({ id: r.id, name: r.name })), [floor.rooms])
  const initialTables = useMemo<DraftTable[]>(() => floor.tables.filter((tbl) => tbl.active).map(({ active: _active, ...tbl }) => tbl), [floor.tables])
  const [rooms, setRooms] = useState(initialRooms)
  const [tables, setTables] = useState(initialTables)
  const [roomId, setRoomId] = useState(initialRooms[0]?.id ?? '')
  const [selected, setSelected] = useState<string | null>(null)
  const [dialog, setDialog] = useState<null | { kind: 'room'; roomId: string | null } | { kind: 'removeRoom' } | { kind: 'discard' }>(null)
  const [roomText, setRoomText] = useState('')
  const [busy, setBusy] = useState(false)
  const gesture = useRef<Gesture | null>(null)

  const current = rooms.find((r) => r.id === roomId) ?? rooms[0]
  const inRoom = tables.filter((tbl) => tbl.roomId === current?.id)
  const dirty = JSON.stringify([rooms, tables]) !== JSON.stringify([initialRooms, initialTables])

  // The drawing keeps its size while a table is dragged (a size that followed the tables would move the scale under the finger).
  const canvas = useMemo(
    () => ({
      w: Math.max(MIN_CANVAS.w, ...inRoom.map((tbl) => tbl.x + tbl.w + 80)),
      h: Math.max(MIN_CANVAS.h, ...inRoom.map((tbl) => tbl.y + tbl.h + 80))
    }),
    // Only when the person changes room: not on every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current?.id]
  )
  // The title, the toolbar and the room tabs sit above the drawing.
  const { ref, scale } = useFit(canvas.w, canvas.h, EDITOR_CHROME)

  const selectedTable = tables.find((tbl) => tbl.id === selected)
  const labelError = (tbl: DraftTable): string | undefined => {
    const label = tbl.label.trim()
    if (label === '') return t('floor.editor.emptyLabel')
    const twin = tables.some((other) => other.id !== tbl.id && other.roomId === tbl.roomId && other.label.trim().toLowerCase() === label.toLowerCase())
    return twin ? t('floor.editor.duplicateLabel') : undefined
  }
  const invalid = tables.some((tbl) => labelError(tbl) !== undefined)

  const patch = (id: string, change: Partial<DraftTable>) => setTables((now) => now.map((tbl) => (tbl.id === id ? { ...tbl, ...change } : tbl)))

  const addTable = () => {
    if (!current) return
    const numbers = tables.map((tbl) => Number(tbl.label)).filter((n) => Number.isInteger(n) && n > 0)
    const table: DraftTable = {
      id: newId(),
      roomId: current.id,
      label: String(Math.max(0, ...numbers) + 1),
      shape: 'square',
      ...freeSpot(inRoom, canvas),
      w: DEFAULT_SIZE,
      h: DEFAULT_SIZE,
      seats: 4
    }
    setTables((now) => [...now, table])
    setSelected(table.id)
  }

  const removeTable = (id: string) => {
    setTables((now) => now.filter((tbl) => tbl.id !== id))
    setSelected(null)
  }

  const saveRoom = () => {
    const fr = roomText.trim()
    if (fr === '' || dialog?.kind !== 'room') return
    if (dialog.roomId === null) {
      const room: DraftRoom = { id: newId(), name: { fr } }
      setRooms((now) => [...now, room])
      setRoomId(room.id)
    } else {
      setRooms((now) => now.map((r) => (r.id === dialog.roomId ? { ...r, name: { ...r.name, fr } } : r)))
    }
    setSelected(null)
    setDialog(null)
  }

  const removeRoom = () => {
    if (!current) return
    const left = rooms.filter((r) => r.id !== current.id)
    setRooms(left)
    setTables((now) => now.filter((tbl) => tbl.roomId !== current.id))
    setRoomId(left[0]?.id ?? '')
    setSelected(null)
    setDialog(null)
  }

  const save = async () => {
    if (invalid || busy) return
    setBusy(true)
    const result = await api.call('floor.save', {
      rooms: rooms.map((r) => ({ id: r.id, name: r.name })),
      tables: tables.map((tbl) => ({ ...tbl, label: tbl.label.trim() }))
    })
    setBusy(false)
    if (!result.ok) return
    toast.success(t('floor.editor.saved'))
    onClose()
  }

  // Pointer gestures. The tile or the handle that was pressed keeps the pointer until it is released.
  const begin = (event: PointerEvent<HTMLElement>, tbl: DraftTable, corner: Corner | null) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelected(tbl.id)
    gesture.current = { id: tbl.id, corner, startX: event.clientX, startY: event.clientY, from: { x: tbl.x, y: tbl.y, w: tbl.w, h: tbl.h } }
  }
  const drag = (event: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g) return
    // Screen pixels to design pixels; in a right-to-left language the plan is mirrored, so left is the end side there.
    const direction = document.documentElement.dir === 'rtl' ? -1 : 1
    const dx = ((event.clientX - g.startX) / scale) * direction
    const dy = (event.clientY - g.startY) / scale
    patch(g.id, g.corner ? resized(g.from, g.corner, dx, dy, canvas) : moved(g.from, dx, dy, canvas))
  }
  const end = (event: PointerEvent<HTMLElement>) => {
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const roomBusy = inRoom.some((tbl) => busyTableIds.has(tbl.id))

  return (
    <div className="floor floor--editor" data-testid="floor-editor">
      <div className="floor__main">
        <div className="floor__room" ref={ref}>
          <div className="floor__head">
            <h1 className="floor__title">{t('floor.editor.title')}</h1>
            <div className="cluster">
              <Button size="md" variant="secondary" icon="plus" onClick={addTable} disabled={!current} data-testid="editor-add-table">
                {t('floor.editor.addTable')}
              </Button>
            </div>
          </div>
          {rooms.length > 0 && (
            <Tabs className="floor__editor-rooms" tabs={rooms.map((r) => ({ id: r.id, label: name(r.name) }))} value={current?.id ?? ''} onChange={(id) => { setRoomId(id); setSelected(null) }} aria-label={t('floor.title')} />
          )}
          {current ? (
            <div
              className="floor__canvas floor__canvas--editor"
              style={{ inlineSize: canvas.w * scale, blockSize: canvas.h * scale }}
              onPointerDown={() => setSelected(null)}
              data-testid="editor-canvas"
            >
              {inRoom.map((tbl) => {
                const style: CSSProperties = { insetInlineStart: tbl.x * scale, insetBlockStart: tbl.y * scale, inlineSize: tbl.w * scale, blockSize: tbl.h * scale }
                const on = tbl.id === selected
                return (
                  <div
                    key={tbl.id}
                    className={cx('table-tile', 'table-tile--free', 'table-tile--edit', `table-tile--${tbl.shape}`, on && 'table-tile--selected')}
                    style={style}
                    data-testid={`edit-table-${tbl.label}`}
                    data-selected={on}
                    onPointerDown={(event) => begin(event, tbl, null)}
                    onPointerMove={drag}
                    onPointerUp={end}
                    onPointerCancel={end}
                  >
                    <span className="table-tile__label">{tableName(tbl.label)}</span>
                    <span className="table-tile__meta">
                      <Icon name="user" size={16} /> {tbl.seats}
                    </span>
                    {on &&
                      CORNERS.map((corner) => (
                        <span
                          key={corner.name}
                          className={`table-handle table-handle--${corner.name}`}
                          data-testid={`handle-${corner.name}`}
                          onPointerDown={(event) => begin(event, tbl, corner)}
                          onPointerMove={drag}
                          onPointerUp={end}
                          onPointerCancel={end}
                        />
                      ))}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="muted">{t('floor.editor.noRoom')}</p>
          )}
          {current && inRoom.length === 0 && <p className="muted">{t('floor.noTables')}</p>}
        </div>
        <nav className="floor__actions">
          <Button size="xl" variant="secondary" onClick={() => (dirty ? setDialog({ kind: 'discard' }) : onClose())} data-testid="editor-cancel">
            {t('common.cancel')}
          </Button>
          <Button size="xl" icon="check" onClick={() => void save()} disabled={!dirty || invalid || busy} data-testid="editor-save">
            {t('floor.editor.save')}
          </Button>
        </nav>
      </div>

      <aside className="floor__side card" data-testid="editor-side">
        {selectedTable ? (
          <div className="stack">
            <h2 className="h2">{tableName(selectedTable.label)}</h2>
            <TextField
              label={t('floor.editor.tableLabel')}
              value={selectedTable.label}
              onChange={(label) => patch(selectedTable.id, { label })}
              maxLength={40}
              error={labelError(selectedTable)}
              data-testid="editor-table-label"
            />
            <div className="field">
              <span className="field__label">{t('floor.editor.seats')}</span>
              <div className="cluster">
                <Button variant="secondary" icon="minus" aria-label={t('floor.editor.fewerSeats')} disabled={selectedTable.seats <= 1} onClick={() => patch(selectedTable.id, { seats: selectedTable.seats - 1 })} data-testid="editor-seats-minus" />
                <strong className="figure" data-testid="editor-seats">
                  {selectedTable.seats}
                </strong>
                <Button variant="secondary" icon="plus" aria-label={t('floor.editor.moreSeats')} disabled={selectedTable.seats >= 99} onClick={() => patch(selectedTable.id, { seats: selectedTable.seats + 1 })} data-testid="editor-seats-plus" />
              </div>
            </div>
            <div className="field">
              <span className="field__label">{t('floor.editor.shape')}</span>
              <Tabs
                tabs={(['square', 'round', 'rect'] as Shape[]).map((shape) => ({ id: shape, label: t(`floor.editor.shapes.${shape}`) }))}
                value={selectedTable.shape}
                onChange={(shape) => patch(selectedTable.id, { shape: shape as Shape })}
                aria-label={t('floor.editor.shape')}
              />
            </div>
            <Button variant="danger" icon="trash" disabled={busyTableIds.has(selectedTable.id)} onClick={() => removeTable(selectedTable.id)} data-testid="editor-delete-table">
              {t('floor.editor.deleteTable')}
            </Button>
            {busyTableIds.has(selectedTable.id) && <p className="warn-text">{t('floor.editor.tableBusy')}</p>}
          </div>
        ) : (
          <div className="floor__hint muted">
            <Icon name="table" size={56} />
            <p>{t('floor.editor.hint')}</p>
          </div>
        )}
        <div className="stack floor__side-room">
          <h3 className="h3">{current ? name(current.name) : t('floor.title')}</h3>
          <Button size="md" variant="secondary" icon="plus" onClick={() => { setRoomText(''); setDialog({ kind: 'room', roomId: null }) }} data-testid="editor-add-room">
            {t('floor.editor.addRoom')}
          </Button>
          {current && (
            <>
              <Button size="md" variant="secondary" onClick={() => { setRoomText(current.name.fr); setDialog({ kind: 'room', roomId: current.id }) }} data-testid="editor-rename-room">
                {t('floor.editor.renameRoom')}
              </Button>
              <Button size="md" variant="secondary" icon="trash" disabled={roomBusy} onClick={() => setDialog({ kind: 'removeRoom' })} data-testid="editor-remove-room">
                {t('floor.editor.removeRoom')}
              </Button>
            </>
          )}
        </div>
      </aside>

      <Modal
        open={dialog?.kind === 'room'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'room' && dialog.roomId !== null ? t('floor.editor.renameRoom') : t('floor.editor.addRoom')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="lg" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" disabled={roomText.trim() === ''} onClick={saveRoom} data-testid="editor-room-confirm">
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <TextField label={t('floor.editor.roomName')} value={roomText} onChange={setRoomText} maxLength={100} autoFocus onEnter={saveRoom} data-testid="editor-room-name" />
      </Modal>
      <ConfirmDialog
        open={dialog?.kind === 'removeRoom'}
        tone="danger"
        message={t('floor.editor.removeRoomConfirm', { name: current ? name(current.name) : '' })}
        confirmLabel={t('floor.editor.removeRoom')}
        onCancel={() => setDialog(null)}
        onConfirm={removeRoom}
      />
      <ConfirmDialog
        open={dialog?.kind === 'discard'}
        tone="danger"
        title={t('floor.editor.discardTitle')}
        message={t('floor.editor.discardMessage')}
        confirmLabel={t('floor.editor.discard')}
        onCancel={() => setDialog(null)}
        onConfirm={onClose}
      />
    </div>
  )
}
