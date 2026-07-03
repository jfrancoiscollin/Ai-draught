import axios from 'axios'
import type {
  GameStateResponse,
  MoveResponse,
  LegalMovesResponse,
  ExerciseResponse,
  ExerciseCheckResponse,
  AnalysisResponse,
  HistoryResponse,
  GameDetailResponse,
  MoveData,
} from '../types'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

api.interceptors.request.use(config => {
  const token = localStorage.getItem('auth_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

export async function newGame(params: {
  white_player?: string
  black_player?: string
  ai_depth?: number
}): Promise<GameStateResponse> {
  const res = await api.post<GameStateResponse>('/game/new', params)
  return res.data
}

export async function getLegalMoves(
  gameId: string,
  fromSq?: number
): Promise<LegalMovesResponse> {
  const params = fromSq !== undefined ? { from_sq: fromSq } : {}
  const res = await api.get<LegalMovesResponse>(`/game/${gameId}/legal-moves`, { params })
  return res.data
}

export async function makeMove(
  gameId: string,
  move: MoveData,
  aiDepth: number = 6,
  bothSides: boolean = false
): Promise<MoveResponse> {
  const res = await api.post<MoveResponse>(`/game/${gameId}/move`, {
    path: move.path,
    captures: move.captures,
    ai_depth: aiDepth,
    both_sides: bothSides,
  })
  return res.data
}

export async function getAiMove(gameId: string, depth: number = 4): Promise<MoveData | null> {
  const res = await api.get<{ move: MoveData | null }>(`/game/${gameId}/ai-move`, {
    params: { depth },
  })
  return res.data.move
}

export async function analyzePosition(
  gameId: string,
  question?: string,
  language: string = 'fr',
  mode: string = 'position',
  aiDepth: number = 6,
): Promise<AnalysisResponse> {
  const res = await api.post<AnalysisResponse>(`/game/${gameId}/analyze`, {
    question: question || null,
    language,
    mode,
    ai_depth: aiDepth,
  }, { timeout: 90000 })
  return res.data
}

export async function getExercises(params?: {
  category?: string
  difficulty?: number
  book_id?: string
}): Promise<ExerciseResponse[]> {
  const res = await api.get<ExerciseResponse[]>('/exercises', { params })
  return res.data
}

export async function getExerciseCategories(): Promise<string[]> {
  const res = await api.get<string[]>('/exercises-categories')
  return res.data
}

export async function getExercise(id: number): Promise<ExerciseResponse> {
  const res = await api.get<ExerciseResponse>(`/exercises/${id}`)
  return res.data
}

export async function getExerciseLegalMoves(id: number): Promise<{ moves: MoveData[] }> {
  const res = await api.get<{ moves: MoveData[] }>(`/exercises/${id}/legal-moves`)
  return res.data
}

export async function getExerciseLegalMovesAtStep(id: number, step: number): Promise<{ moves: MoveData[] }> {
  const res = await api.get<{ moves: MoveData[] }>(`/exercises/${id}/legal-moves`, { params: { step } })
  return res.data
}

export async function checkExercise(
  id: number,
  moves: string[],
  step: number = 0
): Promise<ExerciseCheckResponse> {
  const res = await api.post<ExerciseCheckResponse>(`/exercises/${id}/check`, { moves, step })
  return res.data
}

export async function resignGame(gameId: string, userSide: 'white' | 'black'): Promise<{ result: string }> {
  const res = await api.post<{ result: string }>(`/game/${gameId}/resign`, { user_side: userSide })
  return res.data
}

export async function undoMove(gameId: string): Promise<GameStateResponse> {
  const res = await api.post<GameStateResponse>(`/game/${gameId}/undo`)
  return res.data
}

export async function getHistory(page: number = 1, pageSize: number = 10): Promise<HistoryResponse> {
  const res = await api.get<HistoryResponse>('/history', {
    params: { page, page_size: pageSize },
  })
  return res.data
}

export async function getGameDetail(gameId: string): Promise<GameDetailResponse> {
  const res = await api.get<GameDetailResponse>(`/history/${gameId}`)
  return res.data
}

export async function getUserProgress(): Promise<number[]> {
  const res = await api.get<{ solved_exercise_ids: number[] }>('/auth/me/progress')
  return res.data.solved_exercise_ids
}

export async function getLessonTitles(book?: string): Promise<Record<string, {
  title: string; category: string; motifs?: string[]; weaknesses?: string[]
}>> {
  // The legacy /api/lessons endpoint returns HTTP 410 Gone since the Dubois
  // material was retired; the manuel pipeline does not yet expose prose
  // chapters. Treat 410 (and any other non-2xx) as "no lessons" so the
  // exercises page keeps rendering.
  try {
    const res = await api.get('/lessons', { params: book ? { book } : undefined })
    return res.data
  } catch {
    return {}
  }
}

export async function getLesson(chapter: number): Promise<{ title: string; text: string; category: string }> {
  const res = await api.get(`/lessons/${chapter}`)
  return res.data
}

// A strategic-manual chapter rendered in the Débutant lesson shape
// ({title, text, diagrams[]}) so LessonPanel can display it identically.
export interface ManualChapterSummary { index: number; title: string; n_passages: number }

export async function getManualChapters(source: string): Promise<ManualChapterSummary[]> {
  const res = await api.get<{ chapters: ManualChapterSummary[] }>(
    '/strategy/manual-chapters', { params: { source } },
  )
  return res.data.chapters
}

export async function getManualLesson(
  source: string, chapter: number,
): Promise<{ title: string; text: string; diagrams: Array<{ ref: string; fen: string; label: string }>; category: string }> {
  const res = await api.get('/strategy/manual-lesson', { params: { source, chapter } })
  return res.data
}

export interface LessonMatch {
  chapter: number
  title: string
}

export async function getLessonsByMotif(slug: string): Promise<LessonMatch[]> {
  const res = await api.get<{ matches: LessonMatch[] }>(`/lessons/by-motif/${slug}`)
  return res.data.matches
}

export async function getLessonsByWeakness(family: string): Promise<LessonMatch[]> {
  const res = await api.get<{ matches: LessonMatch[] }>(`/lessons/by-weakness/${family}`)
  return res.data.matches
}

export async function getReadLessons(): Promise<number[]> {
  const res = await api.get<{ read_chapters: number[] }>('/auth/me/lessons/read')
  return res.data.read_chapters
}

export async function markLessonRead(chapter: number): Promise<void> {
  await api.post(`/auth/me/lessons/${chapter}/read`)
}

export interface UserStats {
  total_games: number
  total_moves: number
  blunders: number
  mistakes: number
  inaccuracies: number
  accuracy_pct: number
  recent_games: Array<{
    id: string
    date: string
    white_player: string
    black_player: string
    result: string | null
    move_count: number
    blunders: number
    mistakes: number
    inaccuracies: number
  }>
  games_from_lidraughts?: number
}

export async function getUserStats(): Promise<UserStats> {
  const res = await api.get<UserStats>('/auth/me/stats')
  return res.data
}

export interface LidraughtsImportResult {
  requested: number
  fetched: number
  imported: number
  skipped: number
  total_lidraughts_games: number
  username: string
}

export async function importLidraughtsGames(
  username: string,
  count: number = 50,
): Promise<LidraughtsImportResult> {
  const res = await api.post<LidraughtsImportResult>(
    '/auth/me/lidraughts/import',
    { username, count },
    { timeout: 120000 },
  )
  return res.data
}

export async function saveGameAnnotations(
  gameId: string,
  annotations: Array<{ move_number: number; color?: string; classification?: string; comment?: string }>,
): Promise<void> {
  await api.post(`/history/${gameId}/annotations`, { annotations })
}

export async function getPositionLegalMoves(fen: string): Promise<MoveData[]> {
  const res = await api.post<{ moves: MoveData[] }>('/position/legal-moves', { fen })
  return res.data.moves
}

export async function applyPositionMove(fen: string, path: number[]): Promise<{ fen: string; moves: MoveData[] }> {
  const res = await api.post<{ fen: string; moves: MoveData[] }>('/position/apply-move', { fen, path })
  return res.data
}

export interface PdnPosition {
  fen: string
  notation: string | null
  move_number: number
  color: string | null
}

export interface PdnImportResult {
  positions: PdnPosition[]
  metadata: Record<string, string>
  total_moves: number
}

export async function importPdn(pdn: string): Promise<PdnImportResult> {
  const res = await api.post<PdnImportResult>('/pdn/import', { pdn })
  return res.data
}

export async function analyzePositionFen(
  fen: string,
  question?: string,
  language: string = 'fr',
  mode: string = 'position',
  moveHistory?: string[],
): Promise<AnalysisResponse> {
  const res = await api.post<AnalysisResponse>(
    '/position/analyze',
    { fen, question: question || null, language, mode, move_history: moveHistory ?? [] },
    { timeout: 90000 },
  )
  return res.data
}

export async function getPositionBestMove(fen: string, depth: number = 6): Promise<string | null> {
  const res = await api.post<{ move: string | null }>('/position/best-move', { fen, depth })
  return res.data.move
}

export interface PositionEval {
  score: number
  bestMove: string | null
}

export async function findPlayersByRating(
  ratingMin: number,
  ratingMax: number,
  count: number,
): Promise<{ players: { username: string; rating: number }[]; found: number }> {
  const res = await api.get('/opening-book/players', {
    params: { rating_min: ratingMin, rating_max: ratingMax, count },
  })
  return res.data
}

export async function startOpeningCacheBuild(params: {
  usernames?: string[]
  pdn_texts?: string[]
  max_games_per_user?: number
  max_moves?: number
  ms_per_position?: number
}): Promise<{ started: boolean; message: string }> {
  const res = await api.post('/opening-book/build', params, { timeout: 120000 })
  return res.data
}

export async function getOpeningCacheBuildStatus(): Promise<{
  status: string
  message: string
  fetched_games: number
  unique_positions: number
  computed: number
  skipped: number
  total_to_compute: number
  errors: number
  cache_size: number
}> {
  const res = await api.get('/opening-book/build/status')
  return res.data
}

export async function ingestPdn(raw: string, maxMoves: number): Promise<{ games: number; fens_added: number; format: string }> {
  const res = await api.post('/opening-book/ingest', { raw, max_moves: maxMoves }, { timeout: 30000 })
  return res.data
}

export async function startEval(msPerPosition: number): Promise<{ started: boolean; message: string }> {
  const res = await api.post('/opening-book/start-eval', { ms_per_position: msPerPosition }, { timeout: 10000 })
  return res.data
}

export async function startReeval(msPerPosition: number): Promise<{ started: boolean; message: string; pending?: number }> {
  const res = await api.post('/opening-book/reeval', { ms_per_position: msPerPosition }, { timeout: 10000 })
  return res.data
}

// Pre-compute deep evaluations for a game's positions and store them in the
// server-side opening eval cache. Subsequent annotation calls will use the cache.
export async function precomputePositions(
  positions: PdnPosition[],
): Promise<{ success: boolean; computed?: number; cache_size?: number; evaluations?: PositionEval[] }> {
  try {
    const res = await api.post(
      '/opening-book/precompute',
      { positions },
      { timeout: 600000 },
    )
    return res.data
  } catch {
    return { success: false }
  }
}

// Batch evaluation using the server's native Scan engine (fast, high depth).
// Returns null if the server doesn't have Scan installed.
export async function analyzePositionsBatch(
  positions: PdnPosition[],
  msPerMove: number = 200,
): Promise<{ evals: PositionEval[]; cacheHits: number } | null> {
  try {
    const res = await api.post<{ evaluations: PositionEval[] | null; available: boolean; cache_hits?: number }>(
      '/pdn/annotate',
      { positions, ms_per_move: msPerMove },
      { timeout: 300000 },
    )
    if (!res.data.available || !res.data.evaluations) return null
    return { evals: res.data.evaluations, cacheHits: res.data.cache_hits ?? 0 }
  } catch {
    return null
  }
}

export interface OpeningContinuation {
  move: string
  frequency: number
  pct: number
  score: number | null
}

export interface OpeningExplorerData {
  fen: string
  total_games: number
  continuations: OpeningContinuation[]
  engine_best: string | null
  engine_score: number
}

export async function getContinuations(fen: string): Promise<OpeningExplorerData | null> {
  try {
    const res = await api.get('/opening-book/continuations', { params: { fen } })
    return res.data as OpeningExplorerData
  } catch {
    return null
  }
}

// ── Exercise verification ─────────────────────────────────────────────────────

export interface ExerciseIssue {
  name: string
  fen: string
  stored_move: string
  status: 'ILLEGAL' | 'SCAN_MISMATCH'
  reason: string
  legal_moves: string[]
  scan_move: string | null
  heuristic_fix: boolean
}

export interface ExerciseResult {
  name: string
  fen: string
  stored_move: string
  scan_move: string | null
  status: 'OK' | 'ILLEGAL' | 'SCAN_MISMATCH'
  heuristic_fix: boolean
}

export interface ExerciseVerificationStatus {
  status: 'idle' | 'running' | 'done'
  total: number
  done: number
  ok: number
  illegal: number
  scan_mismatch: number
  heuristic_count: number
  issues: ExerciseIssue[]
  all_results: ExerciseResult[]
  scan_available: boolean
  error: string | null
}

export async function startExerciseVerification(
  useScan = false,
  movetime = 0.3,
  dataset: 'all' | 'initial' | 'sens_du_jeu' = 'all',
): Promise<{ started: boolean }> {
  const res = await api.post('/admin/verify-exercises', { use_scan: useScan, movetime, dataset })
  return res.data
}

export async function getExerciseVerificationStatus(): Promise<ExerciseVerificationStatus> {
  const res = await api.get('/admin/verify-exercises/status')
  return res.data
}

// ---------------------------------------------------------------------------
// Pedagogy (dilf) API
// ---------------------------------------------------------------------------

export interface MotifOut {
  motif: string
  role: string
  squares: number[]
  pv: string[]
  severity: number
}

export interface VerdictOut {
  move_number: number
  side: 'white' | 'black'
  move_notation: string
  fen_before: string
  fen_after: string
  score_before: number
  score_after: number
  delta_winchance: number
  verdict: 'brilliant' | 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'forced' | 'book'
  is_forced: boolean
  phase: 'opening' | 'middlegame' | 'endgame'
  motifs: MotifOut[]
  material_balance: number | null
  hanging_pieces_white: number[]
  hanging_pieces_black: number[]
  isolated_pawns_white: number[]
  isolated_pawns_black: number[]
  backward_pawns_white: number[]
  backward_pawns_black: number[]
  holes_white: number[]
  holes_black: number[]
  outposts_white: number[]
  outposts_black: number[]
  formations: string[]
  threatened_captures_white: ThreatenedCaptureOut[]
  threatened_captures_black: ThreatenedCaptureOut[]
}

export interface ThreatenedCaptureOut {
  path: number[]
  captures: number[]
}

export interface PedagogyAnalysis {
  game_id: string
  verdicts: VerdictOut[]
  summary: {
    total_half_moves: number
    blunders: number
    mistakes: number
    average_accuracy: number
    user_side: string
  }
}

export async function analyzeGamePedagogy(
  gameId: string,
  userSide: 'white' | 'black',
  lang: string = 'fr',
): Promise<PedagogyAnalysis> {
  const res = await api.post<PedagogyAnalysis>(
    '/pedagogy/analyze-game',
    { game_id: gameId, user_side: userSide, lang },
    { timeout: 180000 },
  )
  return res.data
}

export async function getGameAnalysis(gameId: string): Promise<PedagogyAnalysis> {
  const res = await api.get<PedagogyAnalysis>(`/pedagogy/game/${gameId}/analysis`)
  return res.data
}

export interface MotifDebug {
  games_count: number
  games_with_verdicts: number
  verdicts_total: number
  verdicts_with_motifs: number
  by_motif_role: Record<string, number>
  by_motif: Record<string, number>
  missed_threshold: number
  weakness_score: Record<string, number>
  would_be_weakness: string[]
}

export async function getMotifDebug(): Promise<MotifDebug> {
  const res = await api.get<MotifDebug>('/pedagogy/profile/me/motif-debug')
  return res.data
}

export interface ResetAnalysesResult {
  verdicts_deleted: number
  games_cleared: number
}

export async function resetMyAnalyses(): Promise<ResetAnalysesResult> {
  const res = await api.post<ResetAnalysesResult>('/auth/me/analyses/reset')
  return res.data
}

/**
 * Discriminated result from `/pedagogy/explain-move`. Callers need to
 * distinguish "the game wasn't analyzed yet" (a recoverable user state)
 * from a transport / server error so they can show the right message.
 */
export type ExplainResult =
  | { kind: 'ok'; text: string }
  | { kind: 'not-analyzed' }
  | { kind: 'error' }

export async function explainMovePedagogy(
  gameId: string,
  moveNumber: number,
  mode: 'template' | 'template+book' | 'claude' = 'template',
  lang: string = 'fr',
): Promise<ExplainResult> {
  try {
    const res = await api.post<{ text: string; mode: string; lang: string; cached: boolean }>(
      '/pedagogy/explain-move',
      { game_id: gameId, move_number: moveNumber, mode, lang },
      { timeout: 15000 },
    )
    return { kind: 'ok', text: res.data.text }
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 404) {
      return { kind: 'not-analyzed' }
    }
    return { kind: 'error' }
  }
}

// ── Profile & weaknesses ────────────────────────────────────────────────────

export interface MotifWeakness {
  motif: string
  missed: number
  suffered: number
  played: number
  threatened: number
  total_severity: number
}

export interface UserProfile {
  user_id: number
  games_count: number
  average_accuracy: number
  strengths: MotifWeakness[]
  weaknesses: MotifWeakness[]
  weakest_phase: string
  recommended_exercise_tags: string[]
}

export interface MotifExercise {
  id: number
  name: string
  description: string | null
  initial_fen: string
  solution_moves: string[]
  difficulty: number
  category: string
  hint: string | null
}

export interface MotifInfo {
  slug: string
  name_fr: string
  name_en: string
  description_fr: string
  description_en: string
  exercises: MotifExercise[]
}

export async function getUserProfile(): Promise<UserProfile> {
  const res = await api.get<UserProfile>('/pedagogy/profile/me')
  return res.data
}

export interface SquareWeaknessCounts {
  isolated: number
  backward: number
  holes: number
  outposts: number
}

export interface HeatmapNarrative {
  top_line: string
  hint: string
}

export interface WeaknessHeatmap {
  by_square: Record<string, SquareWeaknessCounts>
  games_analyzed: number
  half_moves_analyzed: number
  lookback: number
  // Pre-computed by dilf's weakness_heatmap_narrative — one per metric
  // (incl. "all"). Null when the metric has no signal.
  narratives: Record<string, HeatmapNarrative | null>
}

export async function getWeaknessHeatmap(lookback = 30): Promise<WeaknessHeatmap> {
  const res = await api.get<WeaknessHeatmap>('/pedagogy/profile/me/weakness-heatmap', {
    params: { lookback },
  })
  return res.data
}

/** Caption an arbitrary pre-aggregated heatmap. Used by the per-game
 *  view in PedagogyPanel, which aggregates client-side from verdicts.
 *  Returns the same { metric -> HeatmapNarrative | null } shape as the
 *  embedded narratives in the cross-game endpoint. */
export async function narrateHeatmap(
  bySquare: Record<string, SquareWeaknessCounts>,
): Promise<Record<string, HeatmapNarrative | null>> {
  const res = await api.post<{ narratives: Record<string, HeatmapNarrative | null> }>(
    '/pedagogy/narrate-heatmap', { by_square: bySquare },
  )
  return res.data.narratives
}

export async function getMotifInfo(slug: string): Promise<MotifInfo> {
  const res = await api.get<MotifInfo>(`/pedagogy/motifs/${slug}`)
  return res.data
}

// ── Live PvP (J5) ─────────────────────────────────────────────────────────
// Thin REST surface for the challenge queue. The realtime channel (live
// game state, move broadcasts, presence) lives over a WebSocket — see
// `useLiveWS` in src/hooks. Wire shapes mirror backend/live/models.py.

export type PreferredColor = 'white' | 'black' | 'random'
export type LiveChallengeStatus =
  | 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled'

export interface LiveChallenge {
  id: string
  challenger_id: number
  challenger_username: string
  opponent_id: number
  opponent_username: string
  preferred_color: PreferredColor
  status: LiveChallengeStatus
  created_at: string
  resolved_at: string | null
  game_id: string | null
}

export interface PendingChallenges {
  received: LiveChallenge[]
  sent: LiveChallenge[]
}

export async function createLiveChallenge(
  opponentUsername: string,
  preferredColor: PreferredColor = 'random',
): Promise<LiveChallenge> {
  const res = await api.post<LiveChallenge>('/live/challenge', {
    opponent_username: opponentUsername,
    preferred_color: preferredColor,
  })
  return res.data
}

export async function getPendingLiveChallenges(): Promise<PendingChallenges> {
  const res = await api.get<PendingChallenges>('/live/challenges/pending')
  return res.data
}

export async function respondLiveChallenge(
  id: string, accept: boolean,
): Promise<LiveChallenge> {
  const res = await api.post<LiveChallenge>(`/live/challenge/${id}/respond`, { accept })
  return res.data
}

export async function cancelLiveChallenge(id: string): Promise<LiveChallenge> {
  const res = await api.post<LiveChallenge>(`/live/challenge/${id}/cancel`)
  return res.data
}

// Wire shape of the session dict shipped with game_started / move_played /
// game_ended / game_state frames. Source of truth is
// LiveGameSession.to_dict in backend/live/game_session.py.
export interface LiveGameSessionState {
  game_id: string
  white_user_id: number
  black_user_id: number
  turn: 'white' | 'black'
  status: 'in_progress' | 'finished' | 'abandoned_white' | 'abandoned_black' | 'abandoned_server'
  result: 'white' | 'black' | 'draw' | null
  pdn: string
  fen: string
}

// ── Profile / username (J6 follow-up) ─────────────────────────────────────

export async function setMyUsername(username: string): Promise<{
  id: number; email: string; lidraughts_username: string | null; username: string | null
}> {
  const res = await api.post('/auth/me/username', { username })
  return res.data
}

// ── Online players (J6 follow-up) ─────────────────────────────────────────

export interface OnlineUser {
  user_id: number
  username: string
  in_game: boolean
}

export async function getOnlineUsers(): Promise<OnlineUser[]> {
  const res = await api.get<{ users: OnlineUser[] }>('/live/online')
  return res.data.users
}

export async function deleteMyAccount(): Promise<void> {
  await api.delete('/auth/me')
}

export async function getMyActiveGame(): Promise<LiveGameSessionState | null> {
  // 200 with a session, OR 200 with `null` (Pydantic Optional model).
  const res = await api.get<LiveGameSessionState | null>('/live/my-active-game')
  return res.data
}

// ── Per-game narrative (J4: surfaced by <GameNarrativeSummary>) ────────

export interface PhaseSummary {
  phase: 'opening' | 'middlegame' | 'endgame'
  n_half_moves: number
  acpl_user: number
  acpl_opponent: number
  summary: string
}

export interface TurningPoint {
  move_number: number
  side: 'white' | 'black'
  notation: string
  delta_cp: number
  score_before: number
  score_after: number
  verdict: string
  reason: string
}

export interface PersistentWeakness {
  family: 'isolated' | 'backward' | 'holes' | 'outposts'
  square: number
  side: 'white' | 'black'
  duration_half_moves: number
  first_seen: number
  summary: string
}

export interface GameNarrative {
  headline: string
  phase_summary: PhaseSummary[]
  turning_points: TurningPoint[]
  persistent_weaknesses: PersistentWeakness[]
  motifs_played: Record<string, number>
  motifs_missed: Record<string, number>
  strengths: string[]
  recommended_drills: string[]
}

export async function getGameNarrative(
  gameId: string, lang: string = 'fr',
): Promise<GameNarrative> {
  const res = await api.get<GameNarrative>(
    `/pedagogy/game/${encodeURIComponent(gameId)}/narrative`,
    { params: { lang } },
  )
  return res.data
}

// Strategic reading suggested by a game's own weaknesses — a deterministic
// map from the analysis (phase cost, structural weaknesses, missed tactics)
// to the transversal strategy topics, each with its top prose passages.
export interface ReadingRecoPassage {
  passage_id: string
  source: string
  book: string
  page: number
  text: string
  score: number
}

export interface ReadingRecommendation {
  topic_key: string
  label_fr: string
  label_en: string
  reason: string
  passages: ReadingRecoPassage[]
  /** Interactive readers (Bibliothèque entry ids) recommended for this topic. */
  readers?: { id: string; book: string }[]
}

export async function getRecommendedReading(
  gameId: string, lang: string = 'fr',
): Promise<ReadingRecommendation[]> {
  const res = await api.get<{ recommendations: ReadingRecommendation[] }>(
    `/pedagogy/game/${encodeURIComponent(gameId)}/recommended-reading`,
    { params: { lang } },
  )
  return res.data.recommendations
}

// Strategy RAG (/api/strategy/*) — curated topic buttons that surface
// the most representative passages of each system in dilf's prose
// corpus. See backend/strategy/topics.py and CADRAGE_STRATEGIE.md §8.

export interface StrategyTopic {
  key: string
  label_fr: string
  label_en: string
  description_fr: string
  available: boolean
}

export interface StrategyPassage {
  passage_id: string
  score: number
  text: string
  source: string
  book: string
  page: number
  systems: string[]
  phase: string | null
  nature: string | null
}

export interface StrategySearchResult {
  topic_key: string
  top_k: number
  passages: StrategyPassage[]
}

export async function listStrategyTopics(): Promise<StrategyTopic[]> {
  const res = await api.get<StrategyTopic[]>('/strategy/topics')
  return res.data
}

export async function searchStrategyTopic(
  topic: string,
  topK: number = 10,
): Promise<StrategySearchResult> {
  const res = await api.get<StrategySearchResult>('/strategy/search', {
    params: { topic, top_k: topK },
  })
  return res.data
}

// ── Curriculum (structured learning path) ─────────────────────────────
import type {
  CurriculumTree,
  CurriculumModule,
  CurriculumProgress,
} from '../types'

export async function getCurriculum(): Promise<CurriculumTree> {
  const res = await api.get<CurriculumTree>('/curriculum')
  return res.data
}

export async function getCurriculumModule(id: string): Promise<CurriculumModule> {
  const res = await api.get<CurriculumModule>(`/curriculum/module/${id}`)
  return res.data
}

export async function getCurriculumProgress(): Promise<CurriculumProgress> {
  const res = await api.get<CurriculumProgress>('/curriculum/progress')
  return res.data
}
