// A page's layers are read in a fixed set of slices by layer id, each its own query, so no single query has to
// read a whole large page (Convex stops a query after one second). Ids are random, so the slices come out even.

/** Slice boundaries: slice i holds ids with FROM[i] <= id < FROM[i + 1]; together they cover every string. */
const FROM = ['', '8', 'G', 'O', 'W', 'e', 'm', 'u']
const END = '￿'

export interface Shard {
  from: string
  to: string
}

export const NODE_SHARDS: Shard[] = FROM.map((from, i) => ({ from, to: FROM[i + 1] ?? END }))

/** Whether a layer id falls in a slice. */
export const inShard = (s: Shard, id: string) => id >= s.from && id < s.to
