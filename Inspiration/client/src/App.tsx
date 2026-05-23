import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react"
import { motion, type PanInfo } from "framer-motion"
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react"

import {
  createImageCard,
  createTextCard,
  deleteCard,
  listCards,
  patchCard,
  resolveAssetUrl,
  retryAnalyze,
} from "./lib/api"
import { addWeeks, formatWeekRange, getIsoWeekInfo, getIsoWeekStart, getWeekKey } from "./lib/dates"
import { hashSeed } from "./lib/utils"
import type { AiStatus, InspirationCard } from "./types"
import { Button } from "./components/ui/button"
import { Textarea } from "./components/ui/textarea"

type Point = {
  x: number
  y: number
}

type TextComposer = Point & {
  text: string
}

type PanState = {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
}

type ImagePreview = {
  card: InspirationCard
  scale: number
  x: number
  y: number
}

const STATUS_LABEL: Record<AiStatus, string> = {
  pending: "待生成",
  generating: "生成中",
  done: "已提炼",
  failed: "待重试",
}

function App() {
  const [weekStart, setWeekStart] = useState(() => getIsoWeekStart(new Date()))
  const [cards, setCards] = useState<InspirationCard[]>([])
  const [textComposer, setTextComposer] = useState<TextComposer | null>(null)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const panRef = useRef<PanState | null>(null)
  const lastCanvasPointRef = useRef<Point | null>(null)

  const weekKey = useMemo(() => getWeekKey(weekStart), [weekStart])
  const weekInfo = useMemo(() => getIsoWeekInfo(weekStart), [weekStart])
  const weekRange = useMemo(() => formatWeekRange(weekStart), [weekStart])

  const loadWeek = useCallback(async () => {
    try {
      setIsLoading(true)
      setCards(await listCards(weekKey))
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载失败")
    } finally {
      setIsLoading(false)
    }
  }, [weekKey])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadWeek()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadWeek])

  useEffect(() => {
    if (!cards.some((card) => card.aiStatus === "pending" || card.aiStatus === "generating")) {
      return
    }
    const timer = window.setInterval(() => {
      void loadWeek()
    }, 2200)
    return () => window.clearInterval(timer)
  }, [cards, loadWeek])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 1800)
    return () => window.clearTimeout(timer)
  }, [toast])

  const clientToCanvasPoint = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = viewportRef.current?.getBoundingClientRect()
      return {
        x: Math.max(24, clientX - (rect?.left ?? 0) - pan.x),
        y: Math.max(24, clientY - (rect?.top ?? 0) - pan.y),
      }
    },
    [pan.x, pan.y],
  )

  const getDropPoint = useCallback((preferred?: Point | null): Point => {
    if (preferred) return preferred
    const rect = viewportRef.current?.getBoundingClientRect()
    const offset = (cards.length % 8) * 26
    return {
      x: Math.max(48, (rect?.width ?? 1200) / 2 - pan.x - 160 + offset),
      y: Math.max(84, (rect?.height ?? 720) / 2 - pan.y - 130 + offset / 2),
    }
  }, [cards.length, pan.x, pan.y])

  const mergeCard = useCallback((updated: InspirationCard) => {
    setCards((current) => current.map((card) => (card.id === updated.id ? updated : card)))
  }, [])

  const handleCreateText = useCallback(
    async (text: string, point?: Point | null) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const dropPoint = getDropPoint(point)
      try {
        const created = await createTextCard({ weekKey, textContent: trimmed, ...dropPoint })
        setCards((current) => [...current, created])
        setTextComposer(null)
        setError(null)
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : "新增文本失败")
      }
    },
    [getDropPoint, weekKey],
  )

  const handleCreateImage = useCallback(
    async (file: File, point?: Point | null) => {
      const dropPoint = getDropPoint(point)
      try {
        const created = await createImageCard({ weekKey, file, ...dropPoint })
        setCards((current) => [...current, created])
        setError(null)
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : "新增图片失败")
      }
    },
    [getDropPoint, weekKey],
  )

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      const point = textComposer ? { x: textComposer.x, y: textComposer.y } : lastCanvasPointRef.current

      const items = Array.from(event.clipboardData?.items ?? [])
      const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"))
      const imageFile = imageItem?.getAsFile()
      if (imageFile) {
        event.preventDefault()
        void handleCreateImage(imageFile, point)
        return
      }

      if (target?.closest("textarea,input,[contenteditable='true']")) return

      const text = event.clipboardData?.getData("text/plain")
      if (text?.trim()) {
        event.preventDefault()
        void handleCreateText(text, point)
      }
    }

    window.addEventListener("paste", handlePaste)
    return () => window.removeEventListener("paste", handlePaste)
  }, [handleCreateImage, handleCreateText, textComposer])

  const handleComposerSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!textComposer) return
    void handleCreateText(textComposer.text, { x: textComposer.x, y: textComposer.y })
  }

  const handleMove = useCallback(
    (card: InspirationCard, x: number, y: number) => {
      setCards((current) => current.map((item) => (item.id === card.id ? { ...item, x, y } : item)))
      patchCard(card.id, { x, y }).then(mergeCard).catch(() => {
        setError("位置保存失败")
        void loadWeek()
      })
    },
    [loadWeek, mergeCard],
  )

  const handleDelete = useCallback(
    async (card: InspirationCard) => {
      try {
        await deleteCard(card.id)
        setCards((current) => current.filter((item) => item.id !== card.id))
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : "删除失败")
      }
    },
    [],
  )

  const handleRetry = useCallback(
    async (card: InspirationCard) => {
      setCards((current) =>
        current.map((item) => (item.id === card.id ? { ...item, aiStatus: "pending", aiError: null } : item)),
      )
      try {
        mergeCard(await retryAnalyze(card.id))
      } catch (retryError) {
        setError(retryError instanceof Error ? retryError.message : "重试失败")
      }
    },
    [mergeCard],
  )

  const handleDeleteKeyword = useCallback(
    async (card: InspirationCard, keyword: string) => {
      const keywords = card.keywords.filter((item) => item !== keyword)
      setCards((current) => current.map((item) => (item.id === card.id ? { ...item, keywords } : item)))
      try {
        mergeCard(await patchCard(card.id, { keywords }))
      } catch (keywordError) {
        setError(keywordError instanceof Error ? keywordError.message : "关键词保存失败")
        void loadWeek()
      }
    },
    [loadWeek, mergeCard],
  )

  const handleCopyKeyword = useCallback(async (keyword: string) => {
    try {
      await navigator.clipboard.writeText(keyword)
      setToast(`已复制：${keyword}`)
    } catch {
      setToast("复制失败")
    }
  }, [])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    lastCanvasPointRef.current = clientToCanvasPoint(event.clientX, event.clientY)
    if (target.closest(".inspiration-card,.inline-composer,button,textarea,input")) return
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsPanning(true)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = panRef.current
    if (!state || state.pointerId !== event.pointerId) return
    setPan({
      x: state.originX + event.clientX - state.startX,
      y: state.originY + event.clientY - state.startY,
    })
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return
    panRef.current = null
    setIsPanning(false)
  }

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest(".inspiration-card,.inline-composer,button,textarea,input")) return
    const point = clientToCanvasPoint(event.clientX, event.clientY)
    lastCanvasPointRef.current = point
    setTextComposer({ ...point, text: "" })
  }

  const openImagePreview = useCallback((card: InspirationCard) => {
    setImagePreview({ card, scale: 1, x: 0, y: 0 })
  }, [])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span>随心一记</span>
        </div>

        <div className="week-controls" aria-label="周导航">
          <Button type="button" variant="ghost" size="icon" title="上一周" onClick={() => setWeekStart(addWeeks(weekStart, -1))}>
            <ChevronLeft size={18} />
          </Button>
          <div className="week-label">
            <strong>
              {weekInfo.year} 第 {weekInfo.week} 周
            </strong>
            <span>{weekRange}</span>
          </div>
          <Button type="button" variant="ghost" size="icon" title="下一周" onClick={() => setWeekStart(addWeeks(weekStart, 1))}>
            <ChevronRight size={18} />
          </Button>
        </div>

        <div className="topbar-actions">
          <Button type="button" variant="secondary" size="sm" onClick={() => setWeekStart(getIsoWeekStart(new Date()))}>
            <CalendarDays size={16} />
            今天
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void loadWeek()}>
            <RefreshCw size={16} className={isLoading ? "spin" : undefined} />
            刷新
          </Button>
        </div>
      </header>

      <main className="board-wrap">
        {cards.length === 0 && !isLoading ? <div className="empty-week">本周还空着</div> : null}

        <div
          ref={viewportRef}
          className={`canvas-viewport${isPanning ? " is-panning" : ""}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
        >
          <div className="canvas-plane" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            {textComposer ? (
              <form
                className="inline-composer"
                onSubmit={handleComposerSubmit}
                style={{ transform: `translate(${textComposer.x}px, ${textComposer.y}px)` }}
              >
                <Textarea
                  autoFocus
                  value={textComposer.text}
                  onChange={(event) => setTextComposer((current) => (current ? { ...current, text: event.target.value } : current))}
                  placeholder="写下灵感、片段或网址"
                  aria-label="文本灵感"
                />
                <div className="inline-composer-actions">
                  <Button type="button" variant="ghost" size="icon" title="关闭" onClick={() => setTextComposer(null)}>
                    <X size={15} />
                  </Button>
                  <Button type="submit" variant="primary" size="sm" disabled={!textComposer.text.trim()}>
                    <Plus size={15} />
                    添加
                  </Button>
                </div>
              </form>
            ) : null}
            {cards.map((card) => (
              <BoardCard
                key={card.id}
                card={card}
                onMove={handleMove}
                onDelete={handleDelete}
                onRetry={handleRetry}
                onCopyKeyword={handleCopyKeyword}
                onDeleteKeyword={handleDeleteKeyword}
                onOpenImage={openImagePreview}
              />
            ))}
          </div>
        </div>

        {imagePreview ? (
          <ImagePreviewOverlay
            preview={imagePreview}
            onChange={setImagePreview}
            onClose={() => setImagePreview(null)}
          />
        ) : null}
        {error ? <div className="error-banner">{error}</div> : null}
        {toast ? <div className="toast">{toast}</div> : null}
      </main>
    </div>
  )
}

function BoardCard({
  card,
  onMove,
  onDelete,
  onRetry,
  onCopyKeyword,
  onDeleteKeyword,
  onOpenImage,
}: {
  card: InspirationCard
  onMove: (card: InspirationCard, x: number, y: number) => void
  onDelete: (card: InspirationCard) => void
  onRetry: (card: InspirationCard) => void
  onCopyKeyword: (keyword: string) => void
  onDeleteKeyword: (card: InspirationCard, keyword: string) => void
  onOpenImage: (card: InspirationCard) => void
}) {
  const seed = hashSeed(card.styleSeed)
  const palette = seed % 4
  const decoration = seed % 4
  const className = card.type === "text" ? `inspiration-card text-card palette-${palette}` : "inspiration-card image-card"

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    onMove(card, Math.round(card.x + info.offset.x), Math.round(card.y + info.offset.y))
  }

  return (
    <motion.article
      className={className}
      drag
      dragMomentum={false}
      style={{ x: card.x, y: card.y, rotate: `${card.rotation}deg`, width: card.width }}
      onDragEnd={handleDragEnd}
      tabIndex={0}
    >
      <span className={`decor decor-${decoration}`} />
      <div className="card-inner">
        <div className="card-actions">
          {card.aiStatus === "failed" ? (
            <Button type="button" variant="ghost" size="icon" title="重试 AI" onClick={() => onRetry(card)}>
              <RefreshCw size={15} />
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="icon" title="删除卡片" onClick={() => onDelete(card)}>
            <Trash2 size={15} />
          </Button>
        </div>

        {card.type === "image" ? (
          <div className="image-frame">
            <img
              src={resolveAssetUrl(card.imageUrl)}
              alt={card.summary || "灵感截图"}
              draggable={false}
              onDoubleClick={(event) => {
                event.stopPropagation()
                onOpenImage(card)
              }}
            />
          </div>
        ) : (
          <p className="text-content">{card.textContent}</p>
        )}

        {card.summary ? <p className="card-summary">{card.summary}</p> : null}

        <KeywordArea
          card={card}
          onCopyKeyword={onCopyKeyword}
          onDeleteKeyword={(keyword) => onDeleteKeyword(card, keyword)}
        />
      </div>
    </motion.article>
  )
}

function ImagePreviewOverlay({
  preview,
  onChange,
  onClose,
}: {
  preview: ImagePreview
  onChange: (preview: ImagePreview) => void
  onClose: () => void
}) {
  const dragStartRef = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null)

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const nextScale = Math.min(2.4, Math.max(0.55, preview.scale - event.deltaY * 0.0012))
    onChange({ ...preview, scale: Number(nextScale.toFixed(2)) })
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      x: preview.x,
      y: preview.y,
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current
    if (!start) return
    onChange({
      ...preview,
      x: start.x + event.clientX - start.clientX,
      y: start.y + event.clientY - start.clientY,
    })
  }

  const handlePointerUp = () => {
    dragStartRef.current = null
  }

  return (
    <div className="image-preview-backdrop" onClick={onClose}>
      <div
        className="image-preview-stage"
        onClick={(event) => event.stopPropagation()}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <img
          src={resolveAssetUrl(preview.card.imageUrl)}
          alt={preview.card.summary || "放大的灵感截图"}
          draggable={false}
          style={{
            transform: `translate(${preview.x}px, ${preview.y}px) scale(${preview.scale})`,
          }}
        />
      </div>
    </div>
  )
}

function KeywordArea({
  card,
  onCopyKeyword,
  onDeleteKeyword,
}: {
  card: InspirationCard
  onCopyKeyword: (keyword: string) => void
  onDeleteKeyword: (keyword: string) => void
}) {
  if (card.keywords.length === 0) {
    return (
      <div className="keyword-area">
        <span className={`status-pill ${card.aiStatus}`}>
          {card.aiStatus === "pending" || card.aiStatus === "generating" ? <LoaderCircle size={13} className="spin" /> : null}
          {card.aiStatus === "failed" ? <Clipboard size={13} /> : null}
          {STATUS_LABEL[card.aiStatus]}
        </span>
      </div>
    )
  }

  const firstKeyword = card.keywords[0]
  const extraCount = Math.max(0, card.keywords.length - 1)

  return (
    <div className="keyword-area">
      <button type="button" className="keyword-compact" title="复制关键词" onClick={() => onCopyKeyword(firstKeyword)}>
        <Copy size={13} />
        <span>{firstKeyword}</span>
        {extraCount > 0 ? <strong className="keyword-count">+{extraCount}</strong> : null}
      </button>
      <div className="keyword-expanded">
        {card.keywords.map((keyword) => (
          <span className="keyword-token" key={keyword}>
            <button type="button" className="keyword-copy" title="复制关键词" onClick={() => onCopyKeyword(keyword)}>
              <span>{keyword}</span>
            </button>
            <button type="button" className="delete-keyword" title="删除关键词" onClick={() => onDeleteKeyword(keyword)}>
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}

export default App
