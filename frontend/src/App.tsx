import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import Board from './components/Board'
import type { Arrow, BoardTheme } from './components/Board'
import AnalysisPanel, { MoveAnnotationsTable } from './components/AnalysisPanel'
import AnalysisText from './components/AnalysisText'
import TipExamples from './components/TipExamples'
import GameControls, { type PlayerSide } from './components/GameControls'
import MoveList from './components/MoveList'
import ExercisePanel from './components/ExercisePanel'
import ExerciseLibraryPage from './components/ExerciseLibraryPage'
import LearningPathPage from './components/LearningPathPage'
import LessonPanel from './components/LessonPanel'
import ImportGamePanel from './components/ImportGamePanel'
import OpeningCacheBuilder from './components/OpeningCacheBuilder'
import MyGamesPanel from './components/MyGamesPanel'
import ExerciseVerificationPanel from './components/ExerciseVerificationPanel'
import OpeningExplorer from './components/OpeningExplorer'
import LearnFromMistakes from './components/LearnFromMistakes'
import PedagogyPanel from './components/PedagogyPanel'
import LivePlayPanel from './components/LivePlayPanel'
import LiveGameScreen from './components/LiveGameScreen'
import ChallengeToast from './components/ChallengeToast'
import StrategyPanel from './components/StrategyPanel'
import ManuelInteractifPage from './manuels/ManuelInteractifPage'
import type { LiveGameSessionState } from './api/client'
import { useLiveWS } from './hooks/useLiveWS'
import MotifDetailPage from './components/MotifDetailPage'
import EvalBar from './components/EvalBar'
import UserStatsCard from './components/UserStatsCard'
import Toast from './components/Toast'
import LanguageSelector from './components/LanguageSelector'
import logoBothSrc from './assets/logo-both.svg'
import logoWordmarkSrc from './assets/logo-wordmark.svg'
import iconPlayAiSrc from './assets/icon-play-ai.svg'
import iconLiveSrc from './assets/icon-live.svg'
import iconLearnSrc from './assets/icon-learn.svg'
import iconAnalyzeSrc from './assets/icon-analyze.svg'
import iconImportSrc from './assets/icon-import.svg'
import iconProfileSrc from './assets/icon-profile.svg'
import BottomSheet from './components/BottomSheet'
import LoginPage from './components/LoginPage'
import { useAuth } from './contexts/AuthContext'
import {
  newGame,
  makeMove,
  analyzePosition,
  checkExercise,
  getExercise,
  getExerciseLegalMovesAtStep,
  undoMove,
  resignGame,
  getAiMove,
  getReadLessons,
  saveGameAnnotations,
  analyzeGamePedagogy,
} from './api/client'
import type { PdnPosition, PedagogyAnalysis } from './api/client'
import { getScanEngine, matchHubMove } from './lib/scanEngine'
import {
  annotateGame, computeStats,
  type MoveAnnotation, type GameStats,
  VERDICT_SYMBOL, VERDICT_COLOR,
} from './lib/gameAnnotations'
import {
  EMPTY, WHITE_MAN, WHITE_KING, BLACK_MAN, BLACK_KING,
  sqToRowCol, rcToSq,
} from './types'
import type {
  GameStateResponse,
  MoveData,
  AnalysisResponse,
  ExerciseCheckResponse,
  GameDetailResponse,
} from './types'
import { useLanguage } from './i18n/LanguageContext'
import { playMoveSound } from './utils/sound'

function getInitialBoard(): number[] {
  const board = new Array(51).fill(0) // EMPTY = 0
  for (let sq = 1; sq <= 20; sq++) board[sq] = 3  // BLACK_MAN
  for (let sq = 31; sq <= 50; sq++) board[sq] = 1  // WHITE_MAN
  return board
}

function applyMoveLocally(board: number[], move: MoveData): number[] {
  const newBoard = [...board]
  const piece = newBoard[move.path[0]]
  newBoard[move.path[0]] = EMPTY
  for (const cap of move.captures) newBoard[cap] = EMPTY
  const dest = move.path[move.path.length - 1]
  newBoard[dest] = piece
  if (piece === WHITE_MAN && dest <= 5) newBoard[dest] = WHITE_KING
  if (piece === BLACK_MAN && dest >= 46) newBoard[dest] = BLACK_KING
  return newBoard
}

// Builds intermediate board states for a multi-hop capture sequence.
// Returns one board per hop (path.length-1 entries); empty if single hop.
function buildCaptureSteps(initialBoard: number[], move: MoveData): number[][] {
  if (move.path.length < 3) return []
  const steps: number[][] = []
  const piece = initialBoard[move.path[0]]
  let board = [...initialBoard]
  board[move.path[0]] = EMPTY
  for (let i = 0; i < move.path.length - 1; i++) {
    const from = move.path[i]
    const to   = move.path[i + 1]
    const step = [...board]
    step[to] = piece
    const [r1, c1] = sqToRowCol(from)
    const [r2, c2] = sqToRowCol(to)
    const dr = Math.sign(r2 - r1)
    const dc = Math.sign(c2 - c1)
    let r = r1 + dr, c = c1 + dc
    while (r !== r2 || c !== c2) {
      const sq = rcToSq(r, c)
      if (sq !== null && step[sq] !== EMPTY) { step[sq] = EMPTY; break }
      r += dr; c += dc
    }
    steps.push(step)
    board = step
  }
  const dest = move.path[move.path.length - 1]
  const last = steps[steps.length - 1]
  if (last[dest] === WHITE_MAN && dest <= 5) last[dest] = WHITE_KING
  if (last[dest] === BLACK_MAN && dest >= 46) last[dest] = BLACK_KING
  return steps
}

function pdnToMoveData(pdn: string, board: number[]): MoveData | null {
  if (pdn.includes('x')) {
    const path = pdn.split('x').map(Number)
    if (path.some(isNaN)) return null
    const captures: number[] = []
    for (let i = 0; i < path.length - 1; i++) {
      const [r1, c1] = sqToRowCol(path[i])
      const [r2, c2] = sqToRowCol(path[i + 1])
      const dr = Math.sign(r2 - r1)
      const dc = Math.sign(c2 - c1)
      let r = r1 + dr, c = c1 + dc
      while (r !== r2 || c !== c2) {
        const sq = rcToSq(r, c)
        if (sq !== null && board[sq] !== EMPTY) {
          captures.push(sq)
          break
        }
        r += dr
        c += dc
      }
    }
    return { path, captures }
  } else if (pdn.includes('-')) {
    const parts = pdn.split('-').map(Number)
    if (parts.length !== 2 || parts.some(isNaN)) return null
    return { path: parts, captures: [] }
  }
  return null
}

function fenToBoard(fen: string): number[] {
  const board = new Array(51).fill(EMPTY)
  const parts = fen.split(':')
  for (const section of parts.slice(1)) {
    if (!section) continue
    const color = section[0]
    const tokens = section.slice(1).split(',')
    for (const token of tokens) {
      if (!token) continue
      const isKing = token.startsWith('K')
      const num = parseInt(isKing ? token.slice(1) : token, 10)
      if (isNaN(num) || num < 1 || num > 50) continue
      if (color === 'W') board[num] = isKing ? WHITE_KING : WHITE_MAN
      else board[num] = isKing ? BLACK_KING : BLACK_MAN
    }
  }
  return board
}

type Tab = 'home' | 'play' | 'live' | 'learning-path' | 'exercise-library' | 'exercises' | 'import-game' | 'opening-builder' | 'game-history' | 'analyze-menu' | 'my-games' | 'strategy' | 'strategy-manual' | 'manuel-interactif'

export default function App() {
  const { t, language } = useLanguage()
  const { user, logout } = useAuth()
  const [tab, setTab] = useState<Tab>('home')
  // Source code (SIJBRANDS / SPRINGER / ROOZENBURG / KELLER) when
  // ``tab === 'strategy-manual'`` — the new long-form manual view in
  // Apprendre.  One manual per source, structured into chapters by
  // topic.
  const [strategyManualSource, setStrategyManualSource] = useState<string>('SIJBRANDS')
  // Where to return when the manual view closes (e.g. the learning path when
  // opened from a strategy reading lesson, else the exercise library).
  const [strategyManualOrigin, setStrategyManualOrigin] = useState<Tab>('exercise-library')
  // The strategy panel's "jump to source" deep-link entry point; the library
  // now opens Goedemoed in the manual reader, so nothing sets this at present.
  const [strategyJumpSource] = useState<string | undefined>(undefined)
  // Deep-link target for the diagram annotator: set by the manual reader's
  // "✎ Corriger la position" button so the strategy panel opens straight on
  // that diagram's crop + editable board (crop + annotate → copy JSON entry).
  // The in-reader "✎ Corriger la position" jump was removed with the old manual
  // reader; the strategy panel still accepts an initial jump target if one is
  // ever set again. Kept read-only for now.
  const [strategyJumpTarget] = useState<
    { source: string; page: number; number: number } | undefined
  >(undefined)
  const [preloadedPdn, setPreloadedPdn] = useState<string | null>(null)
  const [preloadedGameId, setPreloadedGameId] = useState<string | null>(null)
  const [preloadedUserSide, setPreloadedUserSide] = useState<'white' | 'black' | null>(null)
  // Live PvP — populated when a game_started push arrives from the WS.
  // Nulling it drops the user back to the lobby tab.
  const [liveSession, setLiveSession] = useState<LiveGameSessionState | null>(null)

  // Global handler for game_started: when the opponent accepts our
  // challenge, the WS push lands HERE rather than only in LivePlayPanel
  // (which would have to be mounted to fire onEnterGame). Without this,
  // the challenger — who probably bounced back to the lobby/home after
  // sending the defi — never learns the game started. Mounting the
  // listener at App level so it works from every tab.
  useLiveWS({
    on: {
      game_started: (m) => {
        const sess = (m as unknown as { session: LiveGameSessionState }).session
        setLiveSession(sess)
        setTab('live')
      },
    },
  })
  // Bumped whenever the user resets their analyses — forces
  // <GameHistory> to refetch so the dilf badges flip back to – and
  // the bulk-analyze button becomes clickable again.
  const [historyRefresh, setHistoryRefresh] = useState(0)

  const [gameState, setGameState] = useState<GameStateResponse | null>(null)
  const [selectedSquare, setSelectedSquare] = useState<number | null>(null)
  const [moveHistory, setMoveHistory] = useState<MoveData[]>([])
  const [aiDepth, setAiDepth] = useState(6)
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [bestMoveArrow, setBestMoveArrow] = useState<Arrow | null>(null)
  const [explorerArrows, setExplorerArrows] = useState<Arrow[]>([])
  const [showExplorer, setShowExplorer] = useState<boolean>(() => {
    try { return localStorage.getItem('showExplorer') !== 'false' } catch { return true }
  })
  const [explorerMaxMoves, setExplorerMaxMoves] = useState<number>(() => {
    try { return Number(localStorage.getItem('explorerMaxMoves') ?? '12') || 12 } catch { return 12 }
  })
  const [isAiThinking, setIsAiThinking] = useState(false)
  const [bothSides, setBothSides] = useState(false)
  const [playerSide, setPlayerSide] = useState<PlayerSide>(() => {
    try { return (localStorage.getItem('playerSide') as PlayerSide) ?? 'white' } catch { return 'white' }
  })
  // Resolved color for the current game (random is resolved at game start)
  const [humanColor, setHumanColor] = useState<'white' | 'black'>('white')
  const [spokenSquares, setSpokenSquares] = useState<number[]>([])
  const [showControls, setShowControls] = useState(false)
  const [boardTheme, setBoardTheme] = useState<BoardTheme>(() => {
    try { return (localStorage.getItem('boardTheme') as BoardTheme) ?? 'classic' } catch { return 'classic' }
  })
  const [analysisExpanded, setAnalysisExpanded] = useState(false)
  const [fullSpeaking, setFullSpeaking] = useState(false)
  const [replayingPosition, setReplayingPosition] = useState<{ board: number[], label: string } | null>(null)
  const [captureAnimBoard, setCaptureAnimBoard] = useState<number[] | null>(null)
  const captureAnimTimers = useRef<ReturnType<typeof setTimeout>[]>([])

  const [exerciseGameState, setExerciseGameState] = useState<{
    board: number[]
    fen: string
    exerciseId: number | null
  } | null>(null)
  // When an exercise is opened by deep-link (e.g. from the Parcours screen),
  // remember where to return so the back arrow goes there instead of the
  // default chapter list.
  const [exerciseOrigin, setExerciseOrigin] = useState<Tab | null>(null)
  const [exerciseLegalMoves, setExerciseLegalMoves] = useState<MoveData[]>([])
  const [exerciseSelectedSquare, setExerciseSelectedSquare] = useState<number | null>(null)
  const [exerciseFeedback, setExerciseFeedback] = useState<ExerciseCheckResponse | null>(null)
  const [exerciseSolved, setExerciseSolved] = useState(false)
  const [showSolvedOverlay, setShowSolvedOverlay] = useState(false)
  const [exerciseStep, setExerciseStep] = useState(0)
  const [exerciseMovesLoading, setExerciseMovesLoading] = useState(false)
  const [exerciseLastMove, setExerciseLastMove] = useState<MoveData | null>(null)
  const exerciseLoadGenRef = useRef(0)
  const exerciseAutoMoveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // When server doesn't provide legal moves, let the user click any piece of the
  // current side and any dark square as destination (server validates on submit).
  // Always use the initial FEN turn indicator — the user always plays the same side.
  const exerciseFreeSelectSquares = useMemo((): Set<number> | undefined => {
    if (!exerciseGameState || exerciseSolved || exerciseLegalMoves.length > 0) return undefined
    const isUserWhite = exerciseGameState.fen.startsWith('W:')
    const board = exerciseGameState.board
    const sels = new Set<number>()
    for (let sq = 1; sq <= 50; sq++) {
      const p = board[sq]
      if (isUserWhite && (p === WHITE_MAN || p === WHITE_KING)) sels.add(sq)
      if (!isUserWhite && (p === BLACK_MAN || p === BLACK_KING)) sels.add(sq)
    }
    return sels.size > 0 ? sels : undefined
  }, [exerciseGameState, exerciseSolved, exerciseLegalMoves])

  const [selectedBookId, setSelectedBookId] = useState<string>('')
  const [lessonOpen, setLessonOpen] = useState<{ chapter: number; fen: string } | null>(null)
  const [readChapters, setReadChapters] = useState<Set<number>>(new Set())
  const [resultFlash, setResultFlash] = useState<string | null>(null)

  // ── Game annotation (coup par coup) ──────────────────────────
  const [fenHistory, setFenHistory] = useState<string[]>([])
  const [playAnnotations, setPlayAnnotations] = useState<MoveAnnotation[]>([])
  const [playGameStats, setPlayGameStats] = useState<GameStats | null>(null)
  const [playAnnotating, setPlayAnnotating] = useState(false)
  const [playAnnotationProgress, setPlayAnnotationProgress] = useState(0)
  const [playAnnotationTotal, setPlayAnnotationTotal] = useState(0)
  const playAnnotationAbortRef = useRef<AbortController | null>(null)
  const [playLastCacheHits, setPlayLastCacheHits] = useState<{ hits: number; total: number } | null>(null)
  const [playPanelMode, setPlayPanelMode] = useState<'game' | 'learn'>('game')

  // Pedagogy (dilf) post-game analysis
  const [pedagogyAnalysis, setPedagogyAnalysis] = useState<PedagogyAnalysis | null>(null)
  const [pedagogyLoading, setPedagogyLoading] = useState(false)
  const [pedagogyError, setPedagogyError] = useState<string | null>(null)
  // Motif drill — slug of the motif currently displayed, null = closed
  const [motifDetailSlug, setMotifDetailSlug] = useState<string | null>(null)
  // Lesson opened from the narrative cards (GameNarrativeSummary).
  // Renders as a full-area overlay over whichever tab is active so the
  // user doesn't lose ImportGamePanel state when consulting a chapter.
  const [narrativeLessonChapter, setNarrativeLessonChapter] = useState<number | null>(null)

  // Pre-load WASM engine on startup so it's ready before the user requests analysis
  useEffect(() => { getScanEngine() }, [])

  useEffect(() => {
    if (!user) { setReadChapters(new Set()); return }
    getReadLessons().then(chapters => setReadChapters(new Set(chapters))).catch(() => {})
  }, [user])

  const handleLessonRead = useCallback((chapter: number) => {
    setReadChapters(prev => new Set([...prev, chapter]))
  }, [])

  const [replayBoard, setReplayBoard] = useState<number[] | null>(null)
  const [replayFenIndex, setReplayFenIndex] = useState(0)
  const [replayDetail, setReplayDetail] = useState<GameDetailResponse | null>(null)

  const showToast = (msg: string) => setToastMsg(msg)

  function buildPdnPositions(fens: string[], moves: MoveData[]): PdnPosition[] {
    if (!fens.length) return []
    const positions: PdnPosition[] = [{ fen: fens[0], notation: '', move_number: 0, color: 'white' }]
    for (let i = 0; i < moves.length && i + 1 < fens.length; i++) {
      const m = moves[i]
      const notation = m.captures.length > 0
        ? m.path.join('x')
        : `${m.path[0]}-${m.path[m.path.length - 1]}`
      positions.push({
        fen: fens[i + 1],
        notation,
        move_number: Math.floor(i / 2) + 1,
        color: i % 2 === 0 ? 'white' : 'black',
      })
    }
    return positions
  }

  const resetExerciseState = useCallback(() => {
    setExerciseGameState(null)
    setExerciseSolved(false)
    setExerciseFeedback(null)
    setExerciseLegalMoves([])
    setExerciseSelectedSquare(null)
    setExerciseStep(0)
    setExerciseMovesLoading(false)
    setExerciseLastMove(null)
    setExerciseOrigin(null)
    if (exerciseAutoMoveTimerRef.current) clearTimeout(exerciseAutoMoveTimerRef.current)
  }, [])

  const startNewGame = useCallback(async () => {
    try {
      setIsAiThinking(true)
      const state = await newGame({ white_player: 'Joueur', black_player: 'IA', ai_depth: aiDepth })
      setGameState(state)
      setSelectedSquare(null)
      setMoveHistory([])
      setAnalysis(null)
      setAnalysisExpanded(false)
      setReplayingPosition(null)
      setFenHistory([state.fen])
      setPlayAnnotations([])
      setPlayGameStats(null)
      setPlayLastCacheHits(null)
      setPlayPanelMode('game')
      setExplorerArrows([])
      setPedagogyAnalysis(null)
      setPedagogyLoading(false)
      setPedagogyError(null)
    } catch {
      showToast(t('errorCreatingGame'))
    } finally {
      setIsAiThinking(false)
    }
  }, [aiDepth, t])

  const changePlayerSide = useCallback((side: PlayerSide) => {
    setPlayerSide(side)
    try { localStorage.setItem('playerSide', side) } catch {}
    const resolved = side === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : side
    setHumanColor(resolved)
    startNewGame()
  }, [startNewGame])

  const handleGoToPlay = useCallback((bothSidesMode = false) => {
    setBothSides(bothSidesMode)
    const resolved = bothSidesMode ? 'white'
      : playerSide === 'random' ? (Math.random() < 0.5 ? 'white' : 'black')
      : playerSide
    setHumanColor(resolved)
    setTab('play')
    startNewGame()
  }, [startNewGame, playerSide])

  const handleSelectSquare = useCallback((sq: number | null) => {
    if (!gameState || gameState.result) return
    if (gameState.turn !== humanColor && !bothSides) return
    setSelectedSquare(sq)
  }, [gameState, bothSides, humanColor])

  // Animate a multi-hop capture: steps through intermediate boards at delayMs per hop.
  // Resolves when the last board is cleared (captureAnimBoard → null).
  const animateCaptures = useCallback((board: number[], move: MoveData, delayMs = 380): Promise<void> => {
    captureAnimTimers.current.forEach(clearTimeout)
    captureAnimTimers.current = []
    const steps = buildCaptureSteps(board, move)
    if (steps.length === 0) return Promise.resolve()
    return new Promise(resolve => {
      setCaptureAnimBoard(steps[0])
      playMoveSound()
      for (let i = 1; i < steps.length; i++) {
        const t = setTimeout(() => {
          setCaptureAnimBoard(steps[i])
          playMoveSound()
        }, i * delayMs)
        captureAnimTimers.current.push(t)
      }
      captureAnimTimers.current.push(setTimeout(() => {
        setCaptureAnimBoard(null)
        resolve()
      }, steps.length * delayMs))
    })
  }, [])

  const toggleExplorer = (v: boolean) => {
    setShowExplorer(v)
    try { localStorage.setItem('showExplorer', String(v)) } catch { /* ignore */ }
    if (!v) setExplorerArrows([])
  }

  const changeExplorerMaxMoves = (n: number) => {
    setExplorerMaxMoves(n)
    try { localStorage.setItem('explorerMaxMoves', String(n)) } catch { /* ignore */ }
  }

  // fen passed to OpeningExplorer: null if disabled, no moves yet, or past max depth
  const explorerFen = showExplorer && moveHistory.length > 0 && moveHistory.length <= explorerMaxMoves
    ? (gameState?.fen ?? null)
    : null

  const handleMove = useCallback(async (move: MoveData) => {
    if (!gameState || gameState.result || isAiThinking) return
    setSelectedSquare(null)
    setBestMoveArrow(null)
    setIsAiThinking(true)

    // For multi-hop captures animate each jump; otherwise play sound immediately.
    // The API call runs in parallel so total wait = max(animation, network).
    const isMultiCapture = move.path.length > 2
    const playerAnimPromise = isMultiCapture
      ? animateCaptures(gameState.board, move)
      : null
    if (!isMultiCapture) playMoveSound()

    // Optimistic update so displayBoard shows the final state once animation ends
    const optimisticBoard = applyMoveLocally(gameState.board, move)
    const nextTurn = gameState.turn === 'white' ? 'black' : 'white'
    setGameState(prev => prev ? { ...prev, board: optimisticBoard, turn: nextTurn, last_move: move, legal_moves: [] } : prev)

    try {
      if (bothSides) {
        // Both-sides mode: just apply the move, no AI
        const response = await makeMove(gameState.game_id, move, aiDepth, true)
        if (playerAnimPromise) await playerAnimPromise
        setGameState({
          game_id: response.game_id,
          board: response.board,
          turn: response.turn,
          half_move_clock: response.half_move_clock,
          move_count: response.move_count,
          result: response.result,
          fen: response.fen,
          last_move: response.player_move,
          legal_moves: response.legal_moves ?? [],
        })
        setMoveHistory(prev => [...prev, response.player_move])
        setFenHistory(prev => [...prev, response.fen])
      } else {
        // Play-alone mode: fire API call in parallel with player animation
        const playerApiPromise = makeMove(gameState.game_id, move, aiDepth, true)
        if (playerAnimPromise) await playerAnimPromise
        const playerResp = await playerApiPromise
        setMoveHistory(prev => [...prev, playerResp.player_move])
        setFenHistory(prev => [...prev, playerResp.fen])

        if (playerResp.result) {
          // Game already ended after player's move
          setGameState({
            game_id: playerResp.game_id,
            board: playerResp.board,
            turn: playerResp.turn,
            half_move_clock: playerResp.half_move_clock,
            move_count: playerResp.move_count,
            result: playerResp.result,
            fen: playerResp.fen,
            last_move: playerResp.player_move,
            legal_moves: [],
          })
        } else {
          // AI's turn — use WASM engine
          const wasmMs = Math.max(200, aiDepth * 250)
          const engine = getScanEngine()
          const hubMove = await engine.getMove(playerResp.fen, wasmMs)

          let aiMoveData: MoveData | null = null
          if (hubMove) aiMoveData = matchHubMove(hubMove, playerResp.legal_moves)

          // Animate AI multi-capture from the board state before AI moved (playerResp.board)
          const applyAiResp = async (resp: typeof playerResp, aiMove: MoveData) => {
            if (aiMove.path.length > 2) {
              await animateCaptures(playerResp.board, aiMove)
            } else {
              playMoveSound()
            }
            setGameState({
              game_id: resp.game_id,
              board: resp.board,
              turn: resp.turn,
              half_move_clock: resp.half_move_clock,
              move_count: resp.move_count,
              result: resp.result,
              fen: resp.fen,
              last_move: aiMove,
              legal_moves: resp.legal_moves ?? [],
            })
            setMoveHistory(prev => [...prev, aiMove])
            setFenHistory(prev => [...prev, resp.fen])
          }

          if (aiMoveData) {
            const aiResp = await makeMove(gameState.game_id, aiMoveData, aiDepth, true)
            await applyAiResp(aiResp, aiMoveData)
          } else {
            // WASM not ready — ask server Scan
            const serverAiMove = await getAiMove(gameState.game_id, aiDepth)
            if (serverAiMove) {
              const aiResp = await makeMove(gameState.game_id, serverAiMove, aiDepth, true)
              await applyAiResp(aiResp, serverAiMove)
            } else {
              setGameState({
                game_id: playerResp.game_id,
                board: playerResp.board,
                turn: playerResp.turn,
                half_move_clock: playerResp.half_move_clock,
                move_count: playerResp.move_count,
                result: playerResp.result,
                fen: playerResp.fen,
                last_move: playerResp.player_move,
                legal_moves: playerResp.legal_moves ?? [],
              })
            }
          }
        }
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } } }
      showToast(err?.response?.data?.detail || 'Coup illégal ou erreur serveur.')
      setCaptureAnimBoard(null)
      captureAnimTimers.current.forEach(clearTimeout)
      captureAnimTimers.current = []
      setGameState(prev => prev ? { ...prev, board: gameState.board, turn: 'white', last_move: gameState.last_move, legal_moves: gameState.legal_moves } : prev)
    } finally {
      setIsAiThinking(false)
    }
  }, [gameState, aiDepth, isAiThinking, bothSides, animateCaptures])

  // When human plays black, trigger AI's first move (white) at game start
  const aiFirstMoveTriggered = React.useRef(false)
  React.useEffect(() => {
    if (bothSides || humanColor !== 'black') return
    if (!gameState || gameState.result || isAiThinking) return
    if (gameState.move_count !== 0) { aiFirstMoveTriggered.current = false; return }
    if (aiFirstMoveTriggered.current) return
    aiFirstMoveTriggered.current = true

    const runAi = async () => {
      setIsAiThinking(true)
      try {
        const wasmMs = Math.max(200, aiDepth * 250)
        const engine = getScanEngine()
        const hubMove = await engine.getMove(gameState.fen, wasmMs)
        let aiMoveData: MoveData | null = null
        if (hubMove) aiMoveData = matchHubMove(hubMove, gameState.legal_moves)
        if (!aiMoveData) {
          const serverMove = await getAiMove(gameState.game_id, aiDepth)
          if (serverMove) aiMoveData = serverMove
        }
        if (aiMoveData) {
          const aiResp = await makeMove(gameState.game_id, aiMoveData, aiDepth, true)
          if (aiMoveData.path.length > 2) await animateCaptures(gameState.board, aiMoveData)
          else playMoveSound()
          setGameState({
            game_id: aiResp.game_id, board: aiResp.board, turn: aiResp.turn,
            half_move_clock: aiResp.half_move_clock, move_count: aiResp.move_count,
            result: aiResp.result, fen: aiResp.fen,
            last_move: aiMoveData, legal_moves: aiResp.legal_moves ?? [],
          })
          setMoveHistory(prev => [...prev, aiMoveData!])
          setFenHistory(prev => [...prev, aiResp.fen])
        }
      } catch { /* silent */ }
      finally { setIsAiThinking(false) }
    }
    runAi()
  }, [gameState, humanColor, bothSides, isAiThinking, aiDepth, animateCaptures])


  const handleResign = useCallback(async () => {
    if (!gameState || isAiThinking || gameState.result) return
    if (!window.confirm(t('resignConfirm'))) return
    try {
      const resp = await resignGame(gameState.game_id, humanColor)
      setGameState(prev => prev ? { ...prev, result: resp.result } : prev)
    } catch {
      showToast('Erreur lors de l\'abandon.')
    }
  }, [gameState, isAiThinking, humanColor, t])

  const handleUndo = useCallback(async () => {
    if (!gameState || isAiThinking) return
    try {
      setIsAiThinking(true)
      const state = await undoMove(gameState.game_id)
      setGameState(state)
      setMoveHistory(prev => prev.slice(0, state.move_count))
      setSelectedSquare(null)
      setAnalysis(null)
      setAnalysisExpanded(false)
    } catch {
      showToast('Impossible d\'annuler le coup.')
    } finally {
      setIsAiThinking(false)
    }
  }, [gameState, isAiThinking])

  const handleBestMoveQuick = useCallback(async (): Promise<string[] | null> => {
    if (!gameState) return null
    setBestMoveArrow(null)
    try {
      const engine = getScanEngine()
      let hubMove: string | null = await engine.getMove(gameState.fen, 1500)
      if (!hubMove) {
        // Fallback: server Scan
        const move = await getAiMove(gameState.game_id, aiDepth)
        if (!move) return []
        hubMove = move.captures.length > 0
          ? move.path.join('x')
          : `${move.path[0]}-${move.path[move.path.length - 1]}`
      }
      if (!hubMove) return []
      // Set arrow on board
      const sep = hubMove.includes('x') ? 'x' : '-'
      const parts = hubMove.split(sep).map(Number)
      if (parts.length >= 2) setBestMoveArrow({ from: parts[0], to: parts[parts.length - 1] })
      return [hubMove]
    } catch {
      return null
    }
  }, [gameState, aiDepth])

  const handleFullTextSpeak = useCallback(() => {
    if (!analysis) return
    if (fullSpeaking) {
      window.speechSynthesis?.cancel()
      setFullSpeaking(false)
      return
    }
    window.speechSynthesis?.cancel()
    const utt = new SpeechSynthesisUtterance(analysis.analysis)
    utt.lang = language === 'en' ? 'en-GB' : 'fr-FR'
    utt.rate = 0.9
    utt.onend = () => setFullSpeaking(false)
    utt.onerror = () => setFullSpeaking(false)
    setFullSpeaking(true)
    window.speechSynthesis?.speak(utt)
  }, [analysis, language, fullSpeaking])

  const handleAnalyze = useCallback(async (question?: string, mode?: string): Promise<AnalysisResponse | null> => {
    if (!gameState) return null
    setAnalysisLoading(true)
    try {
      const result = await analyzePosition(gameState.game_id, question, language, mode || 'position', aiDepth)
      setAnalysis(result)
      setAnalysisExpanded(true)
      setReplayingPosition(null)
      if (mode === 'full_game' && result.move_annotations?.length && user) {
        saveGameAnnotations(gameState.game_id, result.move_annotations).catch(() => {})
      }
      return result
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } } }
      showToast(`${t('errorAnalysis')}${err?.response?.data?.detail || 'Erreur inconnue'}`)
      return null
    } finally {
      setAnalysisLoading(false)
    }
  }, [gameState, language, aiDepth, t, user])

  const handleAnnotatePlayedGame = useCallback(async () => {
    if (!fenHistory.length || !moveHistory.length) return
    const positions = buildPdnPositions(fenHistory, moveHistory)
    if (positions.length < 2) return

    playAnnotationAbortRef.current?.abort()
    const ctrl = new AbortController()
    playAnnotationAbortRef.current = ctrl

    setPlayAnnotating(true)
    setPlayAnnotations([])
    setPlayGameStats(null)
    setPlayAnnotationProgress(0)
    setPlayAnnotationTotal(positions.length)

    try {
      const { annotations: anns, cacheHits } = await annotateGame(
        positions,
        500,
        (done, total) => {
          setPlayAnnotationProgress(done)
          setPlayAnnotationTotal(total)
        },
        ctrl.signal,
      )
      if (!ctrl.signal.aborted) {
        setPlayAnnotations(anns)
        setPlayGameStats(computeStats(anns))
        setPlayLastCacheHits({ hits: cacheHits, total: positions.length })
      }
    } finally {
      setPlayAnnotating(false)
    }
  }, [fenHistory, moveHistory])

  const handleLearnPlayedGame = useCallback(() => {
    if (playGameStats !== null) {
      setPlayPanelMode('learn')
    } else {
      handleAnnotatePlayedGame()
    }
  }, [playGameStats, handleAnnotatePlayedGame])

  const [lastExerciseId, setLastExerciseId] = useState<number | null>(null)

  const handleExerciseLoad = useCallback(async (fen: string, exerciseId: number) => {
    const gen = ++exerciseLoadGenRef.current
    setLastExerciseId(exerciseId)
    setExerciseGameState({ board: fenToBoard(fen), fen, exerciseId })
    setExerciseLegalMoves([])
    setExerciseSelectedSquare(null)
    setExerciseFeedback(null)
    setExerciseSolved(false)
    setExerciseStep(0)
    setExerciseMovesLoading(true)
    try {
      const ex = await getExercise(exerciseId)
      if (exerciseLoadGenRef.current !== gen) return
      setExerciseLegalMoves(ex.legal_moves ?? [])
    } catch (e: unknown) {
      if (exerciseLoadGenRef.current !== gen) return
      const err = e as { message?: string }
      setToastMsg(`Erreur chargement des coups: ${err?.message || 'inconnue'}`)
    } finally {
      if (exerciseLoadGenRef.current === gen) setExerciseMovesLoading(false)
    }
  }, [])

  const handleExerciseMove = useCallback(async (move: MoveData) => {
    if (!exerciseGameState?.exerciseId || exerciseSolved) return
    setExerciseSelectedSquare(null)

    let pdn: string
    let fullMove: MoveData = move

    if (move.captures.length > 0) {
      pdn = move.path.join('x')
      fullMove = move
    } else if (move.path.length === 2) {
      const [from, to] = move.path
      const [r1, c1] = sqToRowCol(from)
      const [r2, c2] = sqToRowCol(to)
      const dr = r2 - r1
      const dc = c2 - c1
      const board = exerciseGameState.board
      const fen = exerciseGameState.fen
      const isUserWhite = fen.startsWith('W:')

      // Not on the same diagonal → must be a complex capture (short PDN form)
      if (Math.abs(dr) !== Math.abs(dc)) {
        pdn = `${from}x${to}`
        fullMove = move
      } else if (Math.abs(dr) === 1) {
        // Single diagonal step → simple non-capture move
        pdn = `${from}-${to}`
        fullMove = move
      } else if (Math.abs(dr) === 2) {
        // Man single-capture check
        const midSq = rcToSq(r1 + dr / 2, c1 + dc / 2)
        let capturedSq: number | null = null
        if (midSq !== null) {
          const mid = board[midSq]
          const isEnemy = isUserWhite
            ? (mid === BLACK_MAN || mid === BLACK_KING)
            : (mid === WHITE_MAN || mid === WHITE_KING)
          if (isEnemy) capturedSq = midSq
        }
        if (capturedSq !== null) {
          pdn = `${from}x${to}`
          fullMove = { path: move.path, captures: [capturedSq] }
        } else {
          pdn = `${from}-${to}`
          fullMove = move
        }
      } else {
        // King long-range: check if any enemy lies along the diagonal
        const dirR = Math.sign(dr), dirC = Math.sign(dc)
        let r = r1 + dirR, c = c1 + dirC
        let hasEnemy = false
        while (r !== r2 || c !== c2) {
          const sq = rcToSq(r, c)
          if (sq !== null && board[sq] !== EMPTY) {
            const p = board[sq]
            const isEnemy = isUserWhite
              ? (p === BLACK_MAN || p === BLACK_KING)
              : (p === WHITE_MAN || p === WHITE_KING)
            if (isEnemy) { hasEnemy = true; break }
          }
          r += dirR; c += dirC
        }
        pdn = hasEnemy ? `${from}x${to}` : `${from}-${to}`
        fullMove = move
      }
    } else {
      pdn = move.path.join('x')
    }

    try {
      const result = await checkExercise(exerciseGameState.exerciseId, [pdn], exerciseStep)

      if (result.correct) {
        // Apply user's move to board
        const boardAfterUser = applyMoveLocally(exerciseGameState.board, fullMove)

        // Resolve auto-move data (opponent's response) if provided
        let autoMoveData: MoveData | null = null
        if (result.auto_move_path && result.auto_move_path.length > 0) {
          autoMoveData = { path: result.auto_move_path, captures: result.auto_move_captures ?? [] }
        } else if (result.auto_move) {
          autoMoveData = pdnToMoveData(result.auto_move, boardAfterUser) ?? null
        }
        const finalBoard = autoMoveData ? applyMoveLocally(boardAfterUser, autoMoveData) : boardAfterUser

        // Animate user's move first
        if (exerciseAutoMoveTimerRef.current) clearTimeout(exerciseAutoMoveTimerRef.current)
        setExerciseGameState(prev => prev ? { ...prev, board: boardAfterUser } : prev)
        setExerciseLastMove(fullMove)

        // After user animation completes, apply & animate opponent's response
        const userSegMs = (fullMove.path.length - 1) === 1 ? 280 : 180
        const userAnimMs = (fullMove.path.length - 1) * userSegMs + 120
        exerciseAutoMoveTimerRef.current = setTimeout(() => {
          if (autoMoveData) {
            setExerciseGameState(prev => prev ? { ...prev, board: finalBoard } : prev)
            setExerciseLastMove(autoMoveData)
          }
        }, autoMoveData ? userAnimMs : 0)

        if (result.in_progress) {
          const nextStep = exerciseStep + 1
          setExerciseStep(nextStep)
          setExerciseFeedback(null)
          // Seed with what the server already computed; then fetch authoritative moves
          setExerciseLegalMoves(result.next_legal_moves ?? [])
          if (exerciseGameState?.exerciseId) {
            const currentGen = exerciseLoadGenRef.current
            getExerciseLegalMovesAtStep(exerciseGameState.exerciseId, nextStep)
              .then(({ moves }) => {
                if (exerciseLoadGenRef.current === currentGen) setExerciseLegalMoves(moves)
              })
              .catch(() => {})
          }
        } else {
          // Exercise complete
          setExerciseSolved(true)
          setExerciseLegalMoves([])
          setExerciseFeedback(result)
        }
      } else {
        setExerciseFeedback(result)
      }
    } catch {
      showToast(t('errorVerification'))
    }
  }, [exerciseGameState, exerciseSolved, exerciseStep, t])

  useEffect(() => {
    if (!exerciseSolved) { setShowSolvedOverlay(false); return }
    setShowSolvedOverlay(true)
    const t = setTimeout(() => setShowSolvedOverlay(false), 1000)
    return () => clearTimeout(t)
  }, [exerciseSolved])

  const handleExerciseSelectSquare = useCallback((sq: number | null) => {
    if (exerciseSolved) return
    setExerciseSelectedSquare(sq)
  }, [exerciseSolved])


  const handleReplay = useCallback((detail: GameDetailResponse) => {
    setReplayDetail(detail)
    setReplayFenIndex(0)
    if (detail.fen_positions.length > 0) setReplayBoard(fenToBoard(detail.fen_positions[0]))
  }, [])

  const replayStep = (delta: number) => {
    if (!replayDetail) return
    const newIdx = Math.max(0, Math.min(replayDetail.fen_positions.length - 1, replayFenIndex + delta))
    setReplayFenIndex(newIdx)
    setReplayBoard(fenToBoard(replayDetail.fen_positions[newIdx]))
  }

  const getResultLabel = (result: string | null) => {
    if (result === 'white') return t('resultWhiteWins')
    if (result === 'black') return t('resultBlackWins')
    if (result === 'draw') return t('resultDraw')
    return ''
  }

  useEffect(() => {
    if (!gameState?.result) return
    setResultFlash(getResultLabel(gameState.result))
    const id = setTimeout(() => setResultFlash(null), 1500)
    return () => clearTimeout(id)
  }, [gameState?.result])

  const handleAnalyzePedagogy = useCallback(async () => {
    if (!gameState?.game_id || pedagogyLoading) return
    setPedagogyLoading(true)
    setPedagogyError(null)
    try {
      const result = await analyzeGamePedagogy(gameState.game_id, humanColor, language)
      setPedagogyAnalysis(result)
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { detail?: string }; status?: number } }
      const detail = axiosErr?.response?.data?.detail
      const msg = err instanceof Error ? err.message : String(err)
      setPedagogyError(detail ? `Erreur ${axiosErr?.response?.status}: ${detail}` : msg)
    } finally {
      setPedagogyLoading(false)
    }
  }, [gameState?.game_id, humanColor, language, pedagogyLoading])

  // Reconstruct all board positions from move history for replay
  const boardPositions = useMemo(() => {
    const positions: number[][] = [getInitialBoard()]
    for (const move of moveHistory) {
      positions.push(applyMoveLocally(positions[positions.length - 1], move))
    }
    return positions
  }, [moveHistory])

  const moveMap = useMemo(() => {
    const map = new Map<string, number>()
    moveHistory.forEach((move, i) => {
      const isCapture = move.captures.length > 0
      const fullPdn = isCapture ? move.path.join('x') : `${move.path[0]}-${move.path[move.path.length - 1]}`
      const shortPdn = `${move.path[0]}${isCapture ? 'x' : '-'}${move.path[move.path.length - 1]}`
      if (!map.has(fullPdn)) map.set(fullPdn, i)
      if (!map.has(shortPdn)) map.set(shortPdn, i)
    })
    return map
  }, [moveHistory])

  const handleAnalysisMoveClick = useCallback((pdn: string) => {
    const idx = moveMap.get(pdn)
    if (idx !== undefined) {
      setReplayingPosition({ board: boardPositions[idx + 1], label: pdn })
    }
  }, [moveMap, boardPositions])

  const currentBoard = gameState?.board || new Array(51).fill(EMPTY)
  const displayBoard = captureAnimBoard ?? replayingPosition?.board ?? currentBoard
  const boardDisabled = !!replayingPosition || !gameState || !!gameState.result || isAiThinking || (gameState?.turn !== humanColor && !bothSides)
  const legalMoves = boardDisabled ? [] : (gameState?.legal_moves ?? [])

  const pieceDiff = (() => {
    if (!gameState) return 0
    let w = 0, b = 0
    for (let sq = 1; sq <= 50; sq++) {
      const p = gameState.board[sq]
      if (p === WHITE_MAN || p === WHITE_KING) w++
      else if (p === BLACK_MAN || p === BLACK_KING) b++
    }
    // Show advantage from the human player's perspective
    return (!bothSides && humanColor === 'black') ? b - w : w - b
  })()



  const playAnnotationPanel = (playAnnotating || playGameStats || playLastCacheHits) ? (
    <div className="flex flex-col gap-2">
      {playAnnotating && (
        <div className="bg-gray-800 rounded-lg px-3 py-2 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-blue-400">
              {playAnnotationProgress === 0 && playAnnotationTotal > 0 ? '⚡ Analyse serveur…' : 'Analyse en cours…'}
            </span>
            <span className="text-gray-400">{playAnnotationProgress}/{playAnnotationTotal}</span>
          </div>
          {playAnnotationTotal > 0 && (
            <div className="w-full bg-gray-700 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full transition-all"
                style={{ width: `${(playAnnotationProgress / playAnnotationTotal) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}
      {playLastCacheHits && !playAnnotating && (
        <div className="text-xs text-center text-gray-500">
          {playLastCacheHits.hits > 0
            ? `⚡ ${playLastCacheHits.hits}/${playLastCacheHits.total} positions depuis le cache`
            : `Cache : 0/${playLastCacheHits.total}`}
        </div>
      )}
      {playGameStats && !playAnnotating && (
        <div className="grid grid-cols-2 gap-px bg-gray-800 rounded-lg overflow-hidden text-xs">
          {(['white', 'black'] as const).map(color => {
            const acpl = color === 'white' ? playGameStats.whiteAcpl : playGameStats.blackAcpl
            const counts = color === 'white' ? playGameStats.whiteCounts : playGameStats.blackCounts
            return (
              <div key={color} className="bg-gray-950 px-3 py-2 flex flex-col gap-1">
                <span>{color === 'white' ? '⬜ Blancs' : '⬛ Noirs'}</span>
                <div className="flex items-center gap-1">
                  <span className="text-gray-500">Moy.</span>
                  <span className="font-mono font-bold text-gray-200">{acpl} cp</span>
                </div>
                <div className="flex gap-2">
                  {counts.blunder > 0 && <span className="font-bold" style={{ color: VERDICT_COLOR.blunder }}>{counts.blunder}??</span>}
                  {counts.mistake > 0 && <span className="font-bold" style={{ color: VERDICT_COLOR.mistake }}>{counts.mistake}?</span>}
                  {counts.inaccuracy > 0 && <span className="font-bold" style={{ color: VERDICT_COLOR.inaccuracy }}>{counts.inaccuracy}?!</span>}
                  {counts.blunder + counts.mistake + counts.inaccuracy === 0 && <span className="text-green-500">Parfait ✓</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  ) : null

  const pedagogyPanel = gameState?.result ? (
    <PedagogyPanel
      gameId={gameState.game_id}
      analysis={pedagogyAnalysis}
      loading={pedagogyLoading}
      userSide={humanColor}
      lang={language}
      onAnalyze={handleAnalyzePedagogy}
      error={pedagogyError}
      onMotifClick={setMotifDetailSlug}
    />
  ) : null

  return (
    <div className="bg-gray-900 text-gray-100 flex flex-col h-full">
      {toastMsg && <Toast message={toastMsg} onClose={() => setToastMsg(null)} />}

      {/* Global live-PvP notifications. Mounted at App level so a
          `challenge_received` push surfaces regardless of which tab the
          user is on. The accept callback routes them to the live tab
          where <LivePlayPanel>'s own WS subscription handles the
          subsequent game_started broadcast. */}
      {user && (
        <ChallengeToast onGoToLive={() => setTab('live')} />
      )}

      {/* Header — compact on mobile */}
      <header className="bg-gray-800 border-b border-gray-700 px-4 py-3 flex-shrink-0">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="whitespace-nowrap flex items-center">
              <button
                onClick={() => setTab('home')}
                className="flex items-center rounded-lg hover:opacity-80 transition-opacity cursor-pointer"
                title={t('home')}
                aria-label={t('home')}
              >
                <img src={logoWordmarkSrc} alt="Draught Master" style={{ height: 40, width: 'auto' }} />
              </button>
            </h1>
            {isAiThinking && (
              <span className="flex items-center gap-1 text-yellow-400 text-xs">
                <div className="spinner" style={{ width: 12, height: 12 }} />
                <span className="hidden sm:inline">{t('aiThinking')}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <LanguageSelector />
            <button
              onClick={logout}
              className="text-gray-400 hover:text-red-400 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-700 transition-colors"
              title={`${t('logout')} (${user.email})`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="18" height="18">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
            {/* Profil button — moved out of the home-screen tile per
                UX refactor. Keeps the same iconProfileSrc so the user
                recognises the affordance; lives between Logout and
                Settings in the header so it's reachable from any tab. */}
            {user && (
              <button
                onClick={() => setTab('game-history')}
                className="text-gray-400 hover:text-white w-10 h-10 flex items-center justify-center rounded-lg hover:bg-gray-700 transition-colors cursor-pointer"
                title={t('tabHistory')}
                aria-label={t('tabHistory')}
              >
                <img
                  src={iconProfileSrc}
                  alt=""
                  style={{ width: 22, height: 22, objectFit: 'contain' }}
                />
              </button>
            )}
            <button
              onClick={() => setShowControls(true)}
              className="text-gray-400 hover:text-white text-xl w-10 h-10 flex items-center justify-center rounded-lg hover:bg-gray-700"
              title={t('controls')}
            >
              ⚙️
            </button>
          </div>
        </div>
      </header>


      {/* Main content — mobile: no page scroll (each section scrolls itself); desktop: page scrolls */}
      <main className="flex-1 overflow-hidden lg:overflow-y-auto relative">

        {/* Narrative-driven lesson overlay — opened from
            <GameNarrativeSummary> chips (motifs / weaknesses / drills).
            Floats over the active tab so closing returns the user
            exactly where they were in their analysis. */}
        {narrativeLessonChapter !== null && (
          <div className="absolute inset-0 z-40 bg-gray-900">
            <LessonPanel
              chapter={narrativeLessonChapter}
              exampleFen=""
              onClose={() => setNarrativeLessonChapter(null)}
              onLessonRead={handleLessonRead}
              isRead={readChapters.has(narrativeLessonChapter)}
            />
          </div>
        )}

        {/* HOME SCREEN */}
        {tab === 'home' && (
          <div className="h-full flex flex-col items-center justify-center px-4 py-4 overflow-y-auto">
            <div className="flex flex-col gap-3 w-full max-w-lg">
              {/* Profil tile removed — moved to the header next to
                  the settings gear. Same icon, same target tab. */}
              {/* Play */}
              <button
                onClick={() => handleGoToPlay(false)}
                className="group flex flex-row items-center gap-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-amber-600 rounded-xl px-4 py-3 transition-all duration-200 cursor-pointer"
              >
                <img src={iconPlayAiSrc} alt="" className="flex-shrink-0 group-hover:scale-110 transition-transform duration-200" style={{ width: 64, height: 64, objectFit: 'contain' }} />
                <span className="flex-1 text-lg font-bold text-white text-right">{t('tabPlay')}</span>
              </button>
              {/* Live PvP — challenge a friend over WebSocket. Hidden for
                  guests since live play requires a user_id binding. */}
              {user && (
                <button
                  onClick={() => setTab('live')}
                  className="group flex flex-row items-center gap-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-amber-600 rounded-xl px-4 py-3 transition-all duration-200 cursor-pointer"
                >
                  <img src={iconLiveSrc} alt="" className="flex-shrink-0 group-hover:scale-110 transition-transform duration-200" style={{ width: 64, height: 64, objectFit: 'contain' }} />
                  <span className="flex-1 text-lg font-bold text-white text-right">Jouer en ligne</span>
                </button>
              )}
              {/* Learning path (guided curriculum) */}
              <button
                onClick={() => setTab('learning-path')}
                className="group flex flex-row items-center gap-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-amber-600 rounded-xl px-4 py-3 transition-all duration-200 cursor-pointer"
              >
                <img src={iconLearnSrc} alt="" className="flex-shrink-0 group-hover:scale-110 transition-transform duration-200" style={{ width: 64, height: 64, objectFit: 'contain' }} />
                <span className="flex-1 text-lg font-bold text-white text-right">{language === 'fr' ? 'Parcours' : 'Learning path'}</span>
              </button>
              {/* Interactive theoretical manuals (Sijbrands, Springer, … as
                  self-contained readers: prose + playable diagrams). */}
              <button
                onClick={() => setTab('manuel-interactif')}
                className="group flex flex-row items-center gap-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-amber-600 rounded-xl px-4 py-3 transition-all duration-200 cursor-pointer"
              >
                <img src={iconLearnSrc} alt="" className="flex-shrink-0 group-hover:scale-110 transition-transform duration-200" style={{ width: 64, height: 64, objectFit: 'contain' }} />
                <span className="flex-1 text-lg font-bold text-white text-right">{language === 'fr' ? 'Manuels théoriques' : 'Theory manuals'}</span>
              </button>
              {/* The exercise library is no longer a separate home entry:
                  the Parcours is the single educational doorway and links
                  into the library from inside. */}
              {/* Analyze menu (Import PDN + Play both sides) */}
              <button
                onClick={() => setTab('analyze-menu')}
                className="group flex flex-row items-center gap-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-amber-600 rounded-xl px-4 py-3 transition-all duration-200 cursor-pointer"
              >
                <img src={iconAnalyzeSrc} alt="" className="flex-shrink-0 group-hover:scale-110 transition-transform duration-200" style={{ width: 64, height: 64, objectFit: 'contain' }} />
                <span className="flex-1 text-lg font-bold text-white text-right">{t('tabImport')}</span>
              </button>
            </div>
          </div>
        )}

        {/* ANALYZE MENU — submenu launched from the home-screen "Analyser" button */}
        {tab === 'analyze-menu' && (
          <div className="h-full flex flex-col items-center justify-center px-4 py-4 overflow-y-auto">
            <div className="flex flex-col gap-3 w-full max-w-lg">
              {/* Analyse mes parties — list + Lidraughts import + weakness/motif panels */}
              {user && (
                <button
                  onClick={() => setTab('my-games')}
                  className="group flex flex-row items-center gap-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-amber-600 rounded-xl px-4 py-3 transition-all duration-200 cursor-pointer"
                >
                  <img src={iconAnalyzeSrc} alt="" className="flex-shrink-0 group-hover:scale-110 transition-transform duration-200" style={{ width: 64, height: 64, objectFit: 'contain' }} />
                  <span className="flex-1 text-lg font-bold text-white text-right">Analyser mes parties</span>
                </button>
              )}
              {/* Import a PDN */}
              <button
                onClick={() => setTab('import-game')}
                className="group flex flex-row items-center gap-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-amber-600 rounded-xl px-4 py-3 transition-all duration-200 cursor-pointer"
              >
                <img src={iconImportSrc} alt="" className="flex-shrink-0 group-hover:scale-110 transition-transform duration-200" style={{ width: 64, height: 64, objectFit: 'contain' }} />
                <span className="flex-1 text-lg font-bold text-white text-right">{t('importPdn')}</span>
              </button>
              {/* Play both sides */}
              <button
                onClick={() => handleGoToPlay(true)}
                className="group flex flex-row items-center gap-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-amber-600 rounded-xl px-4 py-3 transition-all duration-200 cursor-pointer"
              >
                <img src={logoBothSrc} alt="" className="flex-shrink-0 group-hover:scale-110 transition-transform duration-200" style={{ width: 64, height: 64, objectFit: 'contain' }} />
                <span className="flex-1 text-lg font-bold text-white text-right">{t('playBothSides')}</span>
              </button>
            </div>
          </div>
        )}

        {/* MY GAMES TAB — moved out of the profile per UX refactor.
            Same content the profile screen used to host BELOW the
            stats card: bulk import + history + weakness/motif panels. */}
        {tab === 'my-games' && (
          <MyGamesPanel
            refreshKey={historyRefresh}
            onChanged={() => setHistoryRefresh(v => v + 1)}
            onMotifClick={setMotifDetailSlug}
            onOpenLesson={(chapter) => setNarrativeLessonChapter(chapter)}
            onReplay={(detail) => {
              setPreloadedPdn(detail.pdn || '')
              setPreloadedGameId(detail.id)
              const side = (detail as { user_side?: string }).user_side
              setPreloadedUserSide(side === 'black' ? 'black' : 'white')
              setTab('import-game')
            }}
          />
        )}

        {/* STRATEGY TAB — curated topic buttons + sourced passages from
            dilf's prose corpus (Sijbrands / Roozenburg / Keller /
            Springer). Backed by /api/strategy/*. */}
        {tab === 'strategy' && (
          <StrategyPanel
            onClose={() => setTab('exercise-library')}
            lang={language}
            initialJumpSource={strategyJumpSource}
            initialJump={strategyJumpTarget}
          />
        )}

        {/* LIVE PvP TAB — lobby OR active game screen */}
        {tab === 'live' && (
          liveSession === null ? (
            <LivePlayPanel onEnterGame={(s) => setLiveSession(s)} />
          ) : (
            <LiveGameScreen
              session={liveSession}
              onLeave={() => { setLiveSession(null); setTab('home') }}
              onAnalyzeFinishedGame={(gid) => {
                setLiveSession(null)
                setPreloadedGameId(gid)
                setPreloadedUserSide(null)
                setPreloadedPdn(null)
                setTab('import-game')
              }}
            />
          )
        )}

        {/* PLAY TAB */}
        {tab === 'play' && (
          <>
            {/* Motif detail overlay — launched from PedagogyPanel or WeaknessPanel */}
            {motifDetailSlug && (
              <MotifDetailPage
                slug={motifDetailSlug}
                lang={language}
                onClose={() => setMotifDetailSlug(null)}
                onStartExercise={(id) => {
                  setMotifDetailSlug(null)
                  // Switch to exercises tab and open the exercise
                  setTab('exercises')
                  setLastExerciseId(id)
                }}
              />
            )}
            {/* Learn from mistakes full-screen overlay */}
            {!motifDetailSlug && playPanelMode === 'learn' && playAnnotations.length > 0 && (
              <LearnFromMistakes
                positions={buildPdnPositions(fenHistory, moveHistory)}
                annotations={playAnnotations}
                playerColor={bothSides ? null : 'white'}
                onClose={() => setPlayPanelMode('game')}
              />
            )}
            {playPanelMode === 'game' && (
              <>
            {/* Result flash overlay */}
            {resultFlash && (
              <div style={{
                position: 'absolute', inset: 0, zIndex: 50,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
              }}>
                <div style={{
                  background: 'rgba(0,0,0,0.72)',
                  color: '#fde68a',
                  fontSize: '1.6rem',
                  fontWeight: 700,
                  padding: '18px 36px',
                  borderRadius: '14px',
                  boxShadow: '0 4px 32px rgba(0,0,0,0.6)',
                  letterSpacing: '0.01em',
                  animation: 'fadeInOut 1.5s ease forwards',
                }}>
                  {resultFlash}
                </div>
              </div>
            )}
            {/* ── MOBILE (hidden on lg+) ── */}
            <div className="lg:hidden h-full flex flex-col">
              {analysisExpanded ? (
                <>
                  {/* Top (fixed): small board right + compact panel left */}
                  <div
                    className="flex-shrink-0 grid gap-2 px-2 pt-2"
                    style={{ gridTemplateColumns: 'minmax(0,1fr) min(42vw, 200px)' }}
                  >
                    <div style={{ gridColumn: '1', gridRow: '1' }} className="min-w-0">
                      <AnalysisPanel
                        gameId={gameState?.game_id || null}
                        onAnalyze={handleAnalyze}
                        onBestMove={handleBestMoveQuick}
                        analysis={analysis}
                        loading={analysisLoading}
                        onHighlightSquare={setSpokenSquares}
                        expanded={true}
                        onCollapse={() => setAnalysisExpanded(false)}
                        aiThinking={isAiThinking}
                        onMoveClick={handleAnalysisMoveClick}
                        onAnnotate={handleAnnotatePlayedGame}
                        onLearn={handleLearnPlayedGame}
                        annotating={playAnnotating}
                      />
                    </div>
                    <div
                      style={{ gridColumn: '2', gridRow: '1', width: 'min(42vw, 200px)' }}
                      className="flex flex-col items-center"
                    >
                      <div style={{ display: 'flex', gap: 4, width: '100%', alignItems: 'stretch' }}>
                      <Board
                        board={displayBoard}
                        legalMoves={legalMoves}
                        onMove={handleMove}
                        selectedSquare={selectedSquare}
                        onSelectSquare={handleSelectSquare}
                        disabled={boardDisabled}
                        lastMove={gameState?.last_move}
                        spokenSquares={spokenSquares}
                        arrows={bestMoveArrow ? [bestMoveArrow, ...explorerArrows] : explorerArrows}
                        flipped={!bothSides && humanColor === 'black'}
                        theme={boardTheme}
                      />
                      <EvalBar fen={isAiThinking ? null : (gameState?.fen ?? null)} />
                      </div>
                      {gameState && (
                        <div style={{ alignSelf: 'stretch', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <button onClick={handleUndo} disabled={isAiThinking || !moveHistory.length || !!gameState.result}
                            title={t('undoMove')}
                            className="flex-1 font-semibold bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded-lg transition-colors text-base"
                          >←</button>
                          <button onClick={handleResign} disabled={isAiThinking || !!gameState.result}
                            title={t('resign')}
                            className="flex-1 font-semibold bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded-lg transition-colors text-base"
                          >🏳️</button>
                          {moveHistory.length > 0 && (
                            <span style={{ fontWeight: 600, fontSize: '0.8rem' }}
                              className={pieceDiff > 0 ? 'text-green-400' : pieceDiff < 0 ? 'text-red-400' : 'text-gray-400'}>
                              {pieceDiff > 0 ? `+${pieceDiff}` : pieceDiff === 0 ? '=' : `${pieceDiff}`}
                            </span>
                          )}
                        </div>
                      )}
                      {replayingPosition && (
                        <div className="flex items-center gap-2 mt-1 bg-amber-900/40 border border-amber-700/60 rounded px-2 py-1 text-xs">
                          <span className="text-amber-300 font-mono font-semibold">📍 {replayingPosition.label}</span>
                          <button onClick={() => setReplayingPosition(null)} className="ml-auto text-gray-400 hover:text-white">✕</button>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Bottom (scrollable): full analysis text + move list */}
                  <div className="flex-1 overflow-y-auto overscroll-contain pb-4 px-2 pt-2 flex flex-col gap-2">
                    {analysis && (
                      <div className="panel">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs text-gray-400 uppercase font-semibold">{t('fullAnalysis')}</span>
                          <button onClick={handleFullTextSpeak}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${fullSpeaking ? 'bg-red-700 hover:bg-red-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
                            <span>{fullSpeaking ? '⏹' : '🔊'}</span>
                            <span>{fullSpeaking ? t('stopReading') : t('readAloud')}</span>
                          </button>
                        </div>
                        <AnalysisText
                          text={analysis.analysis}
                          onMoveClick={handleAnalysisMoveClick}
                          className="text-gray-200 leading-relaxed text-sm whitespace-pre-wrap"
                        />
                      </div>
                    )}
                    {analysis?.move_annotations && analysis.move_annotations.length > 0 && (
                      <div className="panel">
                        <div className="text-xs text-gray-400 uppercase font-semibold mb-2">
                          {language === 'fr' ? 'Analyse coup par coup' : 'Move-by-move analysis'}
                        </div>
                        <MoveAnnotationsTable annotations={analysis.move_annotations} language={language} />
                      </div>
                    )}
                    <MoveList moves={moveHistory} currentMoveIndex={moveHistory.length - 1} />
                    <OpeningExplorer fen={explorerFen} onArrows={setExplorerArrows} />
                    {playAnnotationPanel}
                    {pedagogyPanel}
                  </div>
                </>
              ) : (
                <>
                  {/* Board full width */}
                  <div className="flex-shrink-0 flex flex-col items-center px-2 pt-2" style={{ width: '100%', maxWidth: '560px', alignSelf: 'center' }}>
                    <div style={{ display: 'flex', gap: 4, width: '100%', alignItems: 'stretch' }}>
                    <Board
                      board={displayBoard}
                      legalMoves={legalMoves}
                      onMove={handleMove}
                      selectedSquare={selectedSquare}
                      onSelectSquare={handleSelectSquare}
                      disabled={boardDisabled}
                      lastMove={gameState?.last_move}
                      spokenSquares={spokenSquares}
                      arrows={bestMoveArrow ? [bestMoveArrow, ...explorerArrows] : explorerArrows}
                      flipped={!bothSides && humanColor === 'black'}
                      theme={boardTheme}
                    />
                    <EvalBar fen={isAiThinking ? null : (gameState?.fen ?? null)} />
                    </div>
                    {gameState && (
                      <div style={{ alignSelf: 'stretch', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button onClick={handleUndo} disabled={isAiThinking || !moveHistory.length || !!gameState.result}
                          title={t('undoMove')} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                          className="text-sm font-semibold bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-30 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg transition-colors">
                          <span>←</span><span>{t('undoMove')}</span>
                        </button>
                        <button onClick={handleResign} disabled={isAiThinking || !!gameState.result}
                          title={t('resign')} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                          className="text-sm font-semibold bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-30 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg transition-colors">
                          <span>🏳️</span><span>{t('resign')}</span>
                        </button>
                        {moveHistory.length > 0 && (
                          <span style={{ marginLeft: 'auto', fontWeight: 600, fontSize: '0.9rem' }}
                            className={pieceDiff > 0 ? 'text-green-400' : pieceDiff < 0 ? 'text-red-400' : 'text-gray-400'}>
                            {pieceDiff > 0 ? `+${pieceDiff}` : pieceDiff === 0 ? '=' : `${pieceDiff}`}
                          </span>
                        )}
                      </div>
                    )}
                    {gameState && <p style={{ alignSelf: 'flex-start' }} className="mt-1 text-xs text-gray-500">{t('whitePerspective')}</p>}
                    {replayingPosition && (
                      <div className="flex items-center gap-2 mt-1 w-full bg-amber-900/40 border border-amber-700/60 rounded px-2 py-1 text-xs">
                        <span className="text-amber-300 font-mono font-semibold">📍 {replayingPosition.label}</span>
                        <button onClick={() => setReplayingPosition(null)} className="ml-auto text-gray-400 hover:text-white">✕</button>
                      </div>
                    )}
                  </div>
                  {/* Scrollable right panel */}
                  <div className="flex-1 overflow-y-auto overscroll-contain pb-4 min-w-0">
                    <div className="flex flex-col gap-3 px-2 py-3">
                      <AnalysisPanel
                        gameId={gameState?.game_id || null}
                        onAnalyze={handleAnalyze}
                        onBestMove={handleBestMoveQuick}
                        analysis={analysis}
                        loading={analysisLoading}
                        onHighlightSquare={setSpokenSquares}
                        expanded={false}
                        onCollapse={() => setAnalysisExpanded(false)}
                        aiThinking={isAiThinking}
                        onMoveClick={handleAnalysisMoveClick}
                        onAnnotate={handleAnnotatePlayedGame}
                        onLearn={handleLearnPlayedGame}
                        annotating={playAnnotating}
                      />
                      <OpeningExplorer fen={explorerFen} onArrows={setExplorerArrows} />
                      <MoveList moves={moveHistory} currentMoveIndex={moveHistory.length - 1} />
                      {playAnnotationPanel}
                      {pedagogyPanel}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* ── DESKTOP (hidden below lg) ── */}
            <div
              className={analysisExpanded
                ? 'hidden lg:grid gap-3 max-w-7xl mx-auto px-4 py-4 pb-6'
                : 'hidden lg:flex lg:flex-row lg:gap-6 lg:max-w-7xl lg:mx-auto lg:px-4 lg:py-4'
              }
              style={analysisExpanded ? { gridTemplateColumns: '1fr min(46%, 280px)' } : {}}
            >
              {/* Board */}
              <div
                className={analysisExpanded ? 'self-start sticky top-0 flex flex-col items-center' : 'flex-shrink-0 flex flex-col items-center'}
                style={analysisExpanded ? { gridColumn: '2', gridRow: '1 / span 10' } : { width: '100%', maxWidth: '560px' }}
              >
                <div style={{ display: 'flex', gap: 4, width: '100%', alignItems: 'stretch' }}>
                <Board
                  board={displayBoard}
                  legalMoves={legalMoves}
                  onMove={handleMove}
                  selectedSquare={selectedSquare}
                  onSelectSquare={handleSelectSquare}
                  disabled={boardDisabled}
                  lastMove={gameState?.last_move}
                  spokenSquares={spokenSquares}
                  flipped={!bothSides && humanColor === 'black'}
                  theme={boardTheme}
                />
                <EvalBar fen={isAiThinking ? null : (gameState?.fen ?? null)} />
                </div>
                {gameState && (
                  <div style={{ alignSelf: 'stretch', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button onClick={handleUndo} disabled={isAiThinking || !moveHistory.length || !!gameState.result}
                      title={t('undoMove')} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                      className="text-sm font-semibold bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-30 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg transition-colors">
                      <span>←</span><span>{t('undoMove')}</span>
                    </button>
                    <button onClick={handleResign} disabled={isAiThinking || !!gameState.result}
                      title={t('resign')} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                      className="text-sm font-semibold bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-30 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg transition-colors">
                      <span>🏳️</span><span>{t('resign')}</span>
                    </button>
                    {moveHistory.length > 0 && (
                      <span style={{ marginLeft: 'auto', fontWeight: 600, fontSize: '0.9rem' }}
                        className={pieceDiff > 0 ? 'text-green-400' : pieceDiff < 0 ? 'text-red-400' : 'text-gray-400'}>
                        {pieceDiff > 0 ? `+${pieceDiff}` : pieceDiff === 0 ? '=' : `${pieceDiff}`}
                      </span>
                    )}
                  </div>
                )}
                {gameState && <p style={{ alignSelf: 'flex-start' }} className="mt-1 text-xs text-gray-500">{t('whitePerspective')}</p>}
                    {replayingPosition && (
                      <div className="flex items-center gap-2 mt-1 w-full bg-amber-900/40 border border-amber-700/60 rounded px-2 py-1 text-xs">
                        <span className="text-amber-300 font-mono font-semibold">📍 {replayingPosition.label}</span>
                        <button onClick={() => setReplayingPosition(null)} className="ml-auto text-gray-400 hover:text-white">✕</button>
                      </div>
                    )}
              </div>

              {/* Analysis panel */}
              {analysisExpanded ? (
                <div style={{ gridColumn: '1', gridRow: '1' }} className="min-w-0">
                  <AnalysisPanel
                    gameId={gameState?.game_id || null}
                    onAnalyze={handleAnalyze}
                    onBestMove={handleBestMoveQuick}
                    analysis={analysis}
                    loading={analysisLoading}
                    onHighlightSquare={setSpokenSquares}
                    expanded={true}
                    onCollapse={() => setAnalysisExpanded(false)}
                    aiThinking={isAiThinking}
                    onMoveClick={handleAnalysisMoveClick}
                    onAnnotate={handleAnnotatePlayedGame}
                    onLearn={handleLearnPlayedGame}
                    annotating={playAnnotating}
                  />
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto overscroll-contain pb-4 min-w-0">
                  <div className="flex flex-col gap-3">
                    <AnalysisPanel
                      gameId={gameState?.game_id || null}
                      onAnalyze={handleAnalyze}
                      onBestMove={handleBestMoveQuick}
                      analysis={analysis}
                      loading={analysisLoading}
                      onHighlightSquare={setSpokenSquares}
                      expanded={false}
                      onCollapse={() => setAnalysisExpanded(false)}
                      aiThinking={isAiThinking}
                      onMoveClick={handleAnalysisMoveClick}
                      onAnnotate={handleAnnotatePlayedGame}
                      onLearn={handleLearnPlayedGame}
                      annotating={playAnnotating}
                    />
                    {/* GameControls lives in the ⚙️ settings sheet only. */}
                    <OpeningExplorer fen={explorerFen} onArrows={setExplorerArrows} />
                    <MoveList moves={moveHistory} currentMoveIndex={moveHistory.length - 1} />
                    {playAnnotationPanel}
                    {pedagogyPanel}
                  </div>
                </div>
              )}

              {/* Full analysis text (expanded only) */}
              {analysisExpanded && analysis && (
                <div style={{ gridColumn: '1', gridRow: '2' }} className="min-w-0">
                  <div className="panel">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-400 uppercase font-semibold">{t('fullAnalysis')}</span>
                      <button onClick={handleFullTextSpeak}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${fullSpeaking ? 'bg-red-700 hover:bg-red-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
                        <span>{fullSpeaking ? '⏹' : '🔊'}</span>
                        <span>{fullSpeaking ? t('stopReading') : t('readAloud')}</span>
                      </button>
                    </div>
                    <AnalysisText text={analysis.analysis} onMoveClick={handleAnalysisMoveClick} className="text-gray-200 leading-relaxed text-sm whitespace-pre-wrap" />
                  </div>
                  {analysis.book_tip && (
                    <div className="panel mt-3">
                      <TipExamples tip={analysis.book_tip} lang={language} />
                    </div>
                  )}
                  {analysis.move_annotations && analysis.move_annotations.length > 0 && (
                    <div className="panel mt-3">
                      <div className="text-xs text-gray-400 uppercase font-semibold mb-2">
                        {language === 'fr' ? 'Analyse coup par coup' : 'Move-by-move analysis'}
                      </div>
                      <MoveAnnotationsTable annotations={analysis.move_annotations} language={language} />
                    </div>
                  )}
                </div>
              )}

              {/* Move list */}
              {analysisExpanded && (
                <div style={{ gridColumn: '1', gridRow: '3' }} className="min-w-0">
                  <OpeningExplorer fen={explorerFen} onArrows={setExplorerArrows} />
                  <MoveList moves={moveHistory} currentMoveIndex={moveHistory.length - 1} />
                  {playAnnotationPanel}
                  {pedagogyPanel}
                </div>
              )}

              {/* GameControls lives in the ⚙️ settings sheet only. */}
            </div>
              </>
            )}
          </>
        )}

        {/* LEARNING PATH TAB — guided curriculum (levels -> modules ->
            lessons) with progression. Modules unlock as prerequisites are
            completed; clicking an exercise deep-links into the solver. */}
        {tab === 'learning-path' && (
          <LearningPathPage
            onClose={() => setTab('home')}
            onOpenLibrary={() => setTab('exercise-library')}
            onOpenLesson={(chapter: number) => setNarrativeLessonChapter(chapter)}
            onOpenManual={(source: string) => {
              setStrategyManualSource(source)
              setStrategyManualOrigin('learning-path')
              setTab('strategy-manual')
            }}
            onOpenExercise={async (exerciseId: number) => {
              try {
                resetExerciseState()
                const ex = await getExercise(exerciseId)
                setExerciseOrigin('learning-path')
                setTab('exercises')
                await handleExerciseLoad(ex.initial_fen, exerciseId)
              } catch { /* ignore load failure */ }
            }}
          />
        )}

        {/* EXERCISE LIBRARY TAB */}
        {tab === 'exercise-library' && (
          <ExerciseLibraryPage
            onBack={() => setTab('learning-path')}
            onSelectBook={(bookId: string) => { resetExerciseState(); setSelectedBookId(bookId); setTab('exercises') }}
            onOpenStrategyManual={(source: string) => {
              // Every corpus source opens the manual reader. Prose books
              // (Sijbrands…) render chapters of text + diagrams; diagram-only
              // exercise books (Goedemoed) render one chapter per study theme.
              setStrategyManualSource(source)
              setStrategyManualOrigin('exercise-library')
              setTab('strategy-manual')
            }}
          />
        )}

        {/* STRATEGY MANUAL TAB — long-form pedagogical manual for one corpus
            source. Rendered with the interactive inline reader: prose flows
            full-width and each diagram board is embedded in the text body,
            scrolling with it (no fixed board). */}
        {tab === 'strategy-manual' && (
          <ManuelInteractifPage
            source={strategyManualSource}
            onClose={() => setTab(strategyManualOrigin)}
          />
        )}

        {/* INTERACTIVE MANUALS TAB — library + self-contained reader for the
            theoretical manuals (prose + playable diagrams), generated by
            backend/strategy/build_manuel_interactif.py. */}
        {tab === 'manuel-interactif' && (
          <ManuelInteractifPage onClose={() => setTab('home')} />
        )}

        {/* EXERCISES TAB — list only when no exercise active, board shown on selection */}
        {tab === 'exercises' && !exerciseGameState && !lessonOpen && (
          <div className="h-full overflow-y-auto">
            <div className="max-w-2xl mx-auto px-4 py-6">
              <ExercisePanel
                onExerciseLoad={handleExerciseLoad}
                onLessonOpen={(chapter, fen) => setLessonOpen({ chapter, fen })}
                currentExerciseId={lastExerciseId}
                feedback={null}
                compact={false}
                readChapters={readChapters}
                bookId={selectedBookId}
              />
            </div>
          </div>
        )}

        {tab === 'exercises' && !exerciseGameState && lessonOpen && (
          <div className="h-full">
            <LessonPanel
              chapter={lessonOpen.chapter}
              exampleFen={lessonOpen.fen}
              onClose={() => setLessonOpen(null)}
              onLessonRead={handleLessonRead}
              isRead={readChapters.has(lessonOpen.chapter)}
            />
          </div>
        )}

        {tab === 'exercises' && exerciseGameState && (
          <div className="h-full flex flex-col items-center px-2 pt-2 lg:px-4 lg:pt-4">
            {/* Board + eval bar row */}
            <div style={{ display: 'flex', gap: 4, width: '100%', maxWidth: '560px', alignItems: 'stretch' }}>
              {/* Board wrapper — overlay shown on success */}
              <div className="relative flex-1">
                <Board
                  board={exerciseGameState.board}
                  legalMoves={exerciseLegalMoves}
                  onMove={handleExerciseMove}
                  selectedSquare={exerciseSelectedSquare}
                  onSelectSquare={handleExerciseSelectSquare}
                  disabled={exerciseSolved}
                  freeSelectSquares={exerciseFreeSelectSquares}
                  flipped={exerciseGameState.fen.startsWith('B:')}
                  lastMove={exerciseLastMove}
                />
                {showSolvedOverlay && (
                  <div
                    className="absolute inset-0 flex flex-col items-center justify-center rounded"
                    style={{ background: 'rgba(0,0,0,0.55)', zIndex: 5 }}
                  >
                    <span style={{ fontSize: '5rem', lineHeight: 1 }} className="text-green-400">✓</span>
                    <span className="text-white text-xl font-bold mt-2">{t('wellDone')}</span>
                  </div>
                )}
              </div>
              <EvalBar fen={exerciseGameState.fen} />
            </div>

            {/* Below-board row: back arrow left, perspective center, loading right */}
            <div className="flex items-center w-full mt-2" style={{ maxWidth: '560px' }}>
              <button
                onClick={() => {
                  resetExerciseState()
                  if (exerciseOrigin) {
                    const origin = exerciseOrigin
                    setExerciseOrigin(null)
                    setTab(origin)
                  }
                }}
                className="text-gray-400 hover:text-amber-500 text-2xl w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-700 transition-colors flex-shrink-0"
                title={t('exercises')}
              >
                ←
              </button>
              <p className="flex-1 text-center text-xs text-gray-500">
                {exerciseGameState.fen.startsWith('B:') ? t('blackPerspective') : t('whitePerspective')}
              </p>
              {exerciseMovesLoading && !exerciseFeedback && (
                <div className="flex items-center gap-1 text-xs text-gray-400 flex-shrink-0">
                  <div className="spinner" style={{ width: 12, height: 12 }} />
                </div>
              )}
              {!exerciseMovesLoading && <div className="w-9 flex-shrink-0" />}
            </div>

            {/* Error feedback banner */}
            {exerciseFeedback && !exerciseFeedback.correct && (
              <div className="w-full mt-3 rounded-xl px-4 py-3 text-center bg-red-900 border border-red-600 text-red-200" style={{ maxWidth: '560px' }}>
                <p className="text-lg font-bold">{`✗ ${t('tryAgain')}`}</p>
                <button
                  onClick={() => {
                    setExerciseFeedback(null)
                    setExerciseSolved(false)
                    setExerciseStep(0)
                    setExerciseSelectedSquare(null)
                    setExerciseGameState(prev =>
                      prev ? { ...prev, board: fenToBoard(prev.fen) } : prev
                    )
                  }}
                  className="mt-2 px-4 py-1 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
                >
                  {t('tryAgain')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* IMPORT & ANALYZE TAB */}
        {tab === 'import-game' && (
          <div className="h-full">
            <ImportGamePanel
              onClose={() => {
                // If the panel was opened from "Analyser mes parties"
                // (preloadedGameId set), return there; otherwise back to
                // home. Pre-refactor the destination was 'game-history'
                // (the slim stats screen) — that route still exists but
                // is no longer where the user came from.
                const cameFromMyGames = preloadedGameId !== null
                setPreloadedPdn(null)
                setPreloadedGameId(null)
                setPreloadedUserSide(null)
                setTab(cameFromMyGames ? 'my-games' : 'home')
              }}
              initialPdn={preloadedPdn}
              initialGameId={preloadedGameId}
              initialUserSide={preloadedUserSide}
              onMotifClick={setMotifDetailSlug}
              onOpenLesson={(chapter) => setNarrativeLessonChapter(chapter)}
              onOpenManual={(source) => {
                setStrategyManualSource(source)
                setStrategyManualOrigin('import-game')
                setTab('strategy-manual')
              }}
            />
          </div>
        )}

        {/* GAME HISTORY TAB */}
        {tab === 'game-history' && (
          <div className="h-full overflow-y-auto px-4 py-4 max-w-3xl mx-auto flex flex-col gap-3">
            {/* Profile screen, slim version: only identity (pseudo +
                delete, in ProfileHeader inside the card) + stats
                numbers. Everything else moved to the "Analyser mes
                parties" view — see MyGamesPanel.tsx. */}
            <UserStatsCard defaultOpen />
          </div>
        )}

        {/* OPENING CACHE BUILDER TAB */}
        {tab === 'opening-builder' && (
          <div className="h-full">
            <OpeningCacheBuilder onClose={() => setTab('home')} />
          </div>
        )}
      </main>

      {/* Settings bottom sheet — mobile only */}
      <BottomSheet
        open={showControls}
        onClose={() => setShowControls(false)}
        title={t('settings')}
      >
        {/* Profil moved to the dedicated 👤 Profil tab on the home page. */}
        {/* ── Contrôles ── */}
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-1">{t('controls')}</h4>
          <GameControls
            result={gameState?.result || null}
            turn={gameState?.turn || 'white'}
            moveCount={gameState?.move_count || 0}
            aiDepth={aiDepth}
            onNewGame={() => { startNewGame(); setShowControls(false) }}
            onAiDepthChange={setAiDepth}
            disabled={isAiThinking}
            showExplorer={showExplorer}
            onShowExplorerChange={toggleExplorer}
            explorerMaxMoves={explorerMaxMoves}
            onExplorerMaxMovesChange={changeExplorerMaxMoves}
            playerSide={playerSide}
            onPlayerSideChange={(side) => { changePlayerSide(side); setShowControls(false) }}
          />
        </div>
        {/* ── Base ouvertures ── */}
        <div className="mt-4">
          {/* ── Personnalisation ── */}
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-1 mt-4">Personnalisation</h4>
          <div className="mb-4">
            <p className="text-xs text-gray-400 mb-3 px-1">Damier</p>
            <div className="flex gap-3 px-1 flex-wrap">
              {([
                { id: 'classic', label: 'Classique', light: '#F0CFA0',  dark: '#9B6B4A',  border: '#5C3317' },
                { id: 'wood',    label: 'Bois',       light: '#f3e1b8',  dark: '#c89868',  border: '#74471f' },
                { id: 'wood2',   label: 'Noyer',      light: '#fae8c2',  dark: '#8e5a30',  border: '#3e1f08',
                  lightGrad: ['#fff3d6','#fae8c2','#f0dcaa'], darkGrad: ['#a87148','#8e5a30','#74471f'] },
              ] as const).map(({ id, label, light, dark, border, ...extra }) => {
                const lg = (extra as { lightGrad?: readonly string[] }).lightGrad
                const dg = (extra as { darkGrad?: readonly string[] }).darkGrad
                return (
                <button
                  key={id}
                  onClick={() => {
                    setBoardTheme(id)
                    try { localStorage.setItem('boardTheme', id) } catch {}
                  }}
                  className="flex flex-col items-center gap-1.5"
                >
                  <div style={{
                    padding: 3,
                    borderRadius: 8,
                    border: `2px solid ${boardTheme === id ? '#A89770' : '#374151'}`,
                    transition: 'border-color 0.15s',
                  }}>
                    <svg width="56" height="56" viewBox="0 0 10 10" style={{ display: 'block', borderRadius: 4, overflow: 'hidden' }}>
                      {lg && dg && (
                        <defs>
                          <linearGradient id={`plg-${id}`} x1="0" y1="0" x2="1" y2="1">
                            <stop offset="0" stopColor={lg[0]}/>
                            <stop offset=".5" stopColor={lg[1]}/>
                            <stop offset="1" stopColor={lg[2]}/>
                          </linearGradient>
                          <linearGradient id={`pdg-${id}`} x1="0" y1="0" x2="1" y2="1">
                            <stop offset="0" stopColor={dg[0]}/>
                            <stop offset=".5" stopColor={dg[1]}/>
                            <stop offset="1" stopColor={dg[2]}/>
                          </linearGradient>
                        </defs>
                      )}
                      <rect width="10" height="10" fill={lg ? `url(#plg-${id})` : light}/>
                      {[0,1,2,3,4].flatMap(r =>
                        [0,1,2,3,4].map(c => ((r + c) % 2 === 1) ? (
                          <rect key={`${r}-${c}`} x={c*2} y={r*2} width={2} height={2} fill={dg ? `url(#pdg-${id})` : dark}/>
                        ) : null)
                      )}
                      <rect width="10" height="10" fill="none" stroke={border} strokeWidth="0.5"/>
                    </svg>
                  </div>
                  <span className="text-xs" style={{ color: boardTheme === id ? '#D9C89F' : '#6b7280' }}>{label}</span>
                </button>
                )
              })}
            </div>
          </div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-1">Base ouvertures</h4>
          <button
            onClick={() => { setShowControls(false); setTab('opening-builder') }}
            className="w-full flex items-center gap-3 bg-gray-700 hover:bg-gray-600 border border-gray-600 hover:border-indigo-500 rounded-xl px-4 py-3 transition-colors"
          >
            <span className="text-2xl">🔬</span>
            <div className="flex flex-col items-start">
              <span className="text-sm font-semibold text-white">Ouvrir la base d'ouvertures</span>
              <span className="text-xs text-gray-400">Pré-calcule les positions depuis Lidraughts</span>
            </div>
            <span className="ml-auto text-gray-400">›</span>
          </button>
        </div>
        {/* ── Vérification des exercices ── */}
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-1">Vérification des exercices</h4>
          <ExerciseVerificationPanel />
        </div>
        {/* ── Crédits ── */}
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-1">{t('credits')}</h4>
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 text-sm text-gray-300 space-y-3">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{t('creditsAuthor')}</p>
              <p className="text-gray-100">Jean-François Collin</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{t('creditsThanks')}</p>
              <p className="text-gray-100">Cham Cham</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{t('creditsSources')}</p>
              <ul className="list-disc pl-5 space-y-0.5 text-gray-200">
                <li>Jean-Pierre Dubois — <span className="italic">Apprentissage Combinaisons</span>, <span className="italic">Apprentissage Sens du jeu</span>, <span className="italic">Apprentissage Fins de partie</span>, <span className="italic">Perfectionnement Combinaisons</span>, <span className="italic">Perfectionnement Sens du jeu (T.1-3)</span>, <span className="italic">Référentiel systèmes de jeu</span></li>
                <li>Couttet — <span className="italic">Étude des ouvertures</span></li>
                <li><span className="italic">Les enchaînements</span></li>
              </ul>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{t('creditsCorpus')}</p>
              <p className="text-gray-100">FMJD — Fédération Mondiale du Jeu de Dames</p>
            </div>
          </div>
        </div>
      </BottomSheet>

    </div>
  )
}
