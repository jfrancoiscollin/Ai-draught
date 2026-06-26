// International draughts (FMJD 10×10) move generator — a faithful TypeScript
// port of backend/game_engine.py, so a manual's boards can be played freely
// (the reader searches for the solution on the board) without any backend call.
//
// Board representation: a length-51 array indexed 1..50 (index 0 unused) of
// piece codes. Squares are the standard FMJD numbering (1 top-left … 50).

export const EMPTY = 0
export const WHITE_MAN = 1
export const WHITE_KING = 2
export const BLACK_MAN = 3
export const BLACK_KING = 4

export type Turn = 'white' | 'black'
export interface EngineMove { path: number[]; captures: number[] }

const DIRS: [number, number][] = [[-1, -1], [-1, 1], [1, -1], [1, 1]]

function sqToRc(sq: number): [number, number] {
  const idx = sq - 1
  const row = Math.floor(idx / 5)
  const colInRow = idx % 5
  const col = colInRow * 2 + (row % 2 === 0 ? 1 : 0)
  return [row, col]
}
function rcToSq(row: number, col: number): number | null {
  if (row < 0 || row > 9 || col < 0 || col > 9) return null
  if ((row + col) % 2 === 0) return null
  const sq = row * 5 + Math.floor(col / 2) + 1
  return sq >= 1 && sq <= 50 ? sq : null
}

const key = (dr: number, dc: number): string => `${dr},${dc}`

// Precomputed adjacency (men) and full diagonals (kings), once.
const NEIGHBORS: Record<number, Record<string, number>> = {}
const EXTENDED: Record<number, Record<string, number[]>> = {}
for (let sq = 1; sq <= 50; sq++) {
  const [r, c] = sqToRc(sq)
  const nbrs: Record<string, number> = {}
  const ext: Record<string, number[]> = {}
  for (const [dr, dc] of DIRS) {
    const n = rcToSq(r + dr, c + dc)
    if (n != null) nbrs[key(dr, dc)] = n
    const line: number[] = []
    let nr = r + dr, nc = c + dc
    while (nr >= 0 && nr <= 9 && nc >= 0 && nc <= 9) {
      const s = rcToSq(nr, nc)
      if (s != null) line.push(s)
      nr += dr; nc += dc
    }
    if (line.length) ext[key(dr, dc)] = line
  }
  NEIGHBORS[sq] = nbrs
  EXTENDED[sq] = ext
}

const MAN_DIRS: Record<Turn, [number, number][]> = {
  white: [[-1, -1], [-1, 1]],
  black: [[1, -1], [1, 1]],
}

const isWhite = (p: number): boolean => p === WHITE_MAN || p === WHITE_KING
const isBlack = (p: number): boolean => p === BLACK_MAN || p === BLACK_KING
export const isKing = (p: number): boolean => p === WHITE_KING || p === BLACK_KING
const isEnemy = (p: number, t: Turn): boolean => (t === 'white' ? isBlack(p) : isWhite(p))
const isFriendly = (p: number, t: Turn): boolean => (t === 'white' ? isWhite(p) : isBlack(p))

function captureSequencesMan(
  sq: number, board: number[], turn: Turn, captured: Set<number>, path: number[],
): EngineMove[] {
  const results: EngineMove[] = []
  for (const [dr, dc] of DIRS) {
    const mid = NEIGHBORS[sq][key(dr, dc)]
    if (mid == null || captured.has(mid) || !isEnemy(board[mid], turn)) continue
    const land = NEIGHBORS[mid]?.[key(dr, dc)]
    if (land == null) continue
    if (board[land] !== EMPTY && land !== path[0]) continue
    const nc = new Set(captured); nc.add(mid)
    const np = [...path, land]
    const sub = captureSequencesMan(land, board, turn, nc, np)
    if (sub.length) results.push(...sub)
    else results.push({ path: np, captures: [...nc] })
  }
  return results
}

function captureSequencesKing(
  sq: number, board: number[], turn: Turn, captured: Set<number>, path: number[],
): EngineMove[] {
  const results: EngineMove[] = []
  for (const [dr, dc] of DIRS) {
    const line = EXTENDED[sq][key(dr, dc)] || []
    let enemySq: number | null = null
    for (const s of line) {
      if (captured.has(s)) break
      const piece = board[s]
      if (isFriendly(piece, turn)) break
      if (isEnemy(piece, turn)) {
        if (enemySq != null) break
        enemySq = s
        continue
      }
      // empty square
      if (enemySq != null) {
        const nc = new Set(captured); nc.add(enemySq)
        const np = [...path, s]
        const sub = captureSequencesKing(s, board, turn, nc, np)
        if (sub.length) results.push(...sub)
        else results.push({ path: np, captures: [...nc] })
      }
    }
  }
  return results
}

function allCaptures(board: number[], turn: Turn): EngineMove[] {
  const moves: EngineMove[] = []
  for (let sq = 1; sq <= 50; sq++) {
    const piece = board[sq]
    if (!isFriendly(piece, turn)) continue
    moves.push(...(isKing(piece)
      ? captureSequencesKing(sq, board, turn, new Set(), [sq])
      : captureSequencesMan(sq, board, turn, new Set(), [sq])))
  }
  return moves
}

function allSimpleMoves(board: number[], turn: Turn): EngineMove[] {
  const moves: EngineMove[] = []
  for (let sq = 1; sq <= 50; sq++) {
    const piece = board[sq]
    if (!isFriendly(piece, turn)) continue
    if (isKing(piece)) {
      for (const [dr, dc] of DIRS) {
        for (const dest of EXTENDED[sq][key(dr, dc)] || []) {
          if (board[dest] !== EMPTY) break
          moves.push({ path: [sq, dest], captures: [] })
        }
      }
    } else {
      for (const [dr, dc] of MAN_DIRS[turn]) {
        const dest = NEIGHBORS[sq][key(dr, dc)]
        if (dest != null && board[dest] === EMPTY) moves.push({ path: [sq, dest], captures: [] })
      }
    }
  }
  return moves
}

/** Legal moves under the strict FMJD maximal-capture rule. */
export function getLegalMoves(board: number[], turn: Turn): EngineMove[] {
  const caps = allCaptures(board, turn)
  if (caps.length) {
    const max = Math.max(...caps.map(m => m.captures.length))
    return caps.filter(m => m.captures.length === max)
  }
  return allSimpleMoves(board, turn)
}

/** Apply a move to a board (returns a new board); promotes a man that lands on
 *  the far rank. Captured pieces are removed. */
export function applyEngineMove(board: number[], move: EngineMove): number[] {
  const nb = board.slice()
  const from = move.path[0]
  const to = move.path[move.path.length - 1]
  const piece = nb[from]
  nb[from] = EMPTY
  nb[to] = piece
  for (const c of move.captures) nb[c] = EMPTY
  if (piece === WHITE_MAN && to >= 1 && to <= 5) nb[to] = WHITE_KING
  else if (piece === BLACK_MAN && to >= 46 && to <= 50) nb[to] = BLACK_KING
  return nb
}
